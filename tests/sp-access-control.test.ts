import { EventEmitter } from "node:events";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  db: {
    execute: vi.fn(),
  },
  requireSpCompany: vi.fn(),
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("../server/db", () => ({ db: harness.db }));
vi.mock("../server/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../server/routes/sp/spHelpers", () => ({
  requireSpCompany: harness.requireSpCompany,
}));
vi.mock("../server/lib/logger", () => ({ logger: harness.logger }));

import {
  SP_PERMISSIONS,
  classifyPermission,
  ensureSpAccessControlStorage,
  registerSpAccessControl,
} from "../server/routes/sp/spAccessControl";

function fakeApp() {
  const registrations: Array<{
    path: string;
    handlers: Array<(...args: any[]) => any>;
  }> = [];
  return {
    registrations,
    app: {
      use: vi.fn((path: string, ...handlers: Array<(...args: any[]) => any>) => {
        registrations.push({ path, handlers });
      }),
    } as any,
  };
}

function responseDouble() {
  const emitter = new EventEmitter();
  const res: any = emitter;
  res.statusCode = 200;
  res.body = undefined;
  res.status = vi.fn((statusCode: number) => {
    res.statusCode = statusCode;
    return res;
  });
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res;
  });
  return res;
}

function request(
  input: {
    path?: string;
    method?: string;
    role?: string;
    userId?: string;
    body?: Record<string, unknown>;
    params?: Record<string, string>;
    idempotencyKey?: string;
  } = {}
) {
  const path = input.path ?? "/sales";
  const method = input.method ?? "GET";
  return {
    path,
    method,
    originalUrl: `/api/sp${path}`,
    body: input.body ?? {},
    params: input.params ?? {},
    session: {
      userId: input.userId ?? "user-1",
      username: "User One",
      currentCompanyId: 7,
      currentRole: input.role ?? "Admin",
    },
    user: {
      id: input.userId ?? "user-1",
      role: input.role ?? "Admin",
    },
    header: vi.fn((name: string) => (name === "Idempotency-Key" ? input.idempotencyKey : undefined)),
  } as any;
}

async function settleAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function invoke(req: any) {
  const { app, registrations } = fakeApp();
  registerSpAccessControl(app);
  const registration = registrations.find((entry) => entry.path === "/api/sp");
  expect(registration).toBeTruthy();
  const middleware = registration!.handlers.at(-1)!;
  const res = responseDouble();
  const next = vi.fn();
  middleware(req, res, next);
  await settleAsyncWork();
  return { res, next };
}

beforeAll(async () => {
  harness.db.execute.mockResolvedValue({ rows: [] });
  await ensureSpAccessControlStorage();
});

describe("Phase 33E Supplier Partner permission classification", () => {
  it("keeps all declared permissions unique", () => {
    expect(new Set(SP_PERMISSIONS).size).toBe(SP_PERMISSIONS.length);
  });

  it("classifies migration/setup/opening-stock/report and mutation families before generic fallbacks", () => {
    expect(classifyPermission({ path: "/migration/run", method: "POST" } as any)).toBe("sp_migration");
    expect(classifyPermission({ path: "/production/evidence", method: "POST" } as any)).toBe("sp_migration");
    expect(classifyPermission({ path: "/setup", method: "GET" } as any)).toBe("sp_setup");
    expect(classifyPermission({ path: "/opening-stock", method: "POST" } as any)).toBe("sp_opening_stock");
    expect(classifyPermission({ path: "/report/daily", method: "GET" } as any)).toBe("sp_reports");
    expect(classifyPermission({ path: "/sales/12/reverse", method: "POST" } as any)).toBe("sp_sales_reverse");
    expect(classifyPermission({ path: "/offload/12/reverse", method: "POST" } as any)).toBe("sp_offload_reverse");
    expect(classifyPermission({ path: "/offload", method: "POST" } as any)).toBe("sp_offload");
    expect(classifyPermission({ path: "/containers/12", method: "PATCH" } as any)).toBe("sp_container_manage");
    expect(classifyPermission({ path: "/sales", method: "POST" } as any)).toBe("sp_sales_create");
    expect(classifyPermission({ path: "/containers/12", method: "GET" } as any)).toBe("sp_view");
  });
});

describe("Phase 33E Supplier Partner access middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.db.execute.mockResolvedValue({ rows: [] });
    harness.requireSpCompany.mockResolvedValue(7);
  });

  it("stops immediately when the selected company is not Supplier Partner", async () => {
    harness.requireSpCompany.mockResolvedValue(null);
    const { res, next } = await invoke(request());

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(harness.db.execute).not.toHaveBeenCalled();
  });

  it("uses role defaults to deny POS setup access and records the denial", async () => {
    const { res, next } = await invoke(request({ path: "/setup", method: "GET", role: "POS" }));

    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: "SP_PERMISSION_DENIED" });
    expect(next).not.toHaveBeenCalled();
    expect(harness.db.execute).toHaveBeenCalledTimes(2);
  });

  it("lets an explicit false grant override even Admin defaults", async () => {
    harness.db.execute.mockResolvedValueOnce({ rows: [{ enabled: false }] }).mockResolvedValue({ rows: [] });

    const { res, next } = await invoke(request({ path: "/report/daily", method: "GET", role: "Admin" }));

    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: "SP_PERMISSION_DENIED" });
    expect(next).not.toHaveBeenCalled();
  });

  it("lets an explicit true grant add a permission missing from the role default", async () => {
    harness.db.execute.mockResolvedValueOnce({ rows: [{ enabled: true }] });

    const { res, next } = await invoke(request({ path: "/setup", method: "GET", role: "POS" }));

    expect(res.statusCode).toBe(200);
    expect(next).toHaveBeenCalledOnce();
    res.emit("finish");
    await settleAsyncWork();
    expect(harness.db.execute).toHaveBeenCalledTimes(2);
  });

  it("requires the exact confirmation before any sensitive reverse-sale write", async () => {
    const { res, next } = await invoke(
      request({
        path: "/sales/12/reverse",
        method: "POST",
        role: "Admin",
        body: { reason: "customer correction", confirmation: "reverse it" },
        idempotencyKey: "reverse-12",
      })
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: "SP_EXACT_CONFIRMATION_REQUIRED" });
    expect(next).not.toHaveBeenCalled();
    expect(harness.db.execute).toHaveBeenCalledTimes(1);
  });

  it("requires a meaningful reason after the exact confirmation", async () => {
    const { res } = await invoke(
      request({
        path: "/sales/12/reverse",
        method: "POST",
        body: { reason: "no", confirmation: "REVERSE SP SALE" },
        idempotencyKey: "reverse-12",
      })
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: "SP_REASON_REQUIRED" });
  });

  it("requires an idempotency key after confirmation and reason validation", async () => {
    const { res } = await invoke(
      request({
        path: "/sales/12/reverse",
        method: "POST",
        body: { reason: "customer correction", confirmation: "REVERSE SP SALE" },
      })
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: "SP_IDEMPOTENCY_KEY_REQUIRED" });
  });

  it("maps duplicate sensitive requests to the stable 409 contract", async () => {
    const duplicate = Object.assign(new Error("duplicate key"), { code: "23505" });
    harness.db.execute.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(duplicate);

    const { res, next } = await invoke(
      request({
        path: "/sales/12/reverse",
        method: "POST",
        body: { reason: "customer correction", confirmation: "REVERSE SP SALE" },
        idempotencyKey: "reverse-12",
      })
    );

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: "SP_DUPLICATE_REQUEST" });
    expect(next).not.toHaveBeenCalled();
  });

  it("lets a validated sensitive request through and audits the final successful response", async () => {
    const { res, next } = await invoke(
      request({
        path: "/sales/12/reverse",
        method: "POST",
        body: {
          reason: "customer correction",
          confirmation: "REVERSE SP SALE",
          token: "must not change authorization",
        },
        idempotencyKey: "reverse-success",
      })
    );

    expect(next).toHaveBeenCalledOnce();
    expect(harness.db.execute).toHaveBeenCalledTimes(2);
    res.statusCode = 200;
    res.emit("finish");
    await settleAsyncWork();
    expect(harness.db.execute).toHaveBeenCalledTimes(3);
    expect(harness.logger.error).not.toHaveBeenCalled();
  });

  it("releases the idempotency key when the downstream sensitive action fails", async () => {
    const { res, next } = await invoke(
      request({
        path: "/opening-stock",
        method: "POST",
        body: { reason: "opening correction", confirmation: "POST SP OPENING STOCK" },
        idempotencyKey: "opening-retryable",
      })
    );

    expect(next).toHaveBeenCalledOnce();
    expect(harness.db.execute).toHaveBeenCalledTimes(2);
    res.statusCode = 422;
    res.emit("finish");
    await settleAsyncWork();
    expect(harness.db.execute).toHaveBeenCalledTimes(4);
  });

  it("audits ordinary reads without creating an idempotency record", async () => {
    const { res, next } = await invoke(request({ path: "/containers", method: "GET", role: "View Only" }));

    expect(next).toHaveBeenCalledOnce();
    expect(harness.db.execute).toHaveBeenCalledTimes(1);
    res.emit("finish");
    await settleAsyncWork();
    expect(harness.db.execute).toHaveBeenCalledTimes(2);
  });

  it("returns the shared 500 contract for unexpected access-control failures", async () => {
    harness.requireSpCompany.mockRejectedValue(new Error("company lookup failed"));

    const { res, next } = await invoke(request());

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ message: "company lookup failed" });
    expect(next).not.toHaveBeenCalled();
  });
});
