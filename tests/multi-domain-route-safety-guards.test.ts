import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  registrations: [] as Array<{
    method: string;
    path: string;
    handlers: Array<(...args: any[]) => any>;
  }>,
}));

vi.mock("../server/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireNonPOS: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("multer", () => {
  const multerMock = Object.assign(
    () => ({
      single: () => (_req: unknown, _res: unknown, callback: (error?: unknown) => unknown) => callback(),
    }),
    { memoryStorage: () => ({}) }
  );
  return { default: multerMock };
});

import { registerBalesReimportRoutes } from "../server/routes/factory/bales/balesReimportRoutes";
import { registerContainerFreightWriteRoutes } from "../server/routes/containers/containerFreightWriteRoutes";
import { registerContainerCostingRoutes } from "../server/routes/containers/accounting/costing";
import { registerFactoryLocationInventoryRoutes } from "../server/routes/factory/stock/locationInventoryRoutes";

function fakeApp() {
  const register = (method: string) => (path: string, ...handlers: Array<(...args: any[]) => any>) => {
    harness.registrations.push({ method, path, handlers });
  };
  return {
    get: register("GET"),
    post: register("POST"),
    patch: register("PATCH"),
    put: register("PUT"),
    delete: register("DELETE"),
  } as any;
}

function responseDouble() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = vi.fn((statusCode: number) => {
    res.statusCode = statusCode;
    return res;
  });
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res;
  });
  res.send = res.json;
  res.set = vi.fn(() => res);
  res.header = vi.fn(() => res);
  return res;
}

async function invoke(method: string, path: string, req: any) {
  const route = harness.registrations.find((entry) => entry.method === method && entry.path === path);
  expect(route, `${method} ${path} must be registered`).toBeTruthy();
  const res = responseDouble();
  await route!.handlers.at(-1)!(req, res, () => undefined);
  await Promise.resolve();
  await Promise.resolve();
  return res;
}

describe("Phase 33 3C route safety guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.registrations.splice(0);
    const app = fakeApp();
    registerBalesReimportRoutes(app);
    registerContainerFreightWriteRoutes(app);
    registerContainerCostingRoutes(app);
    registerFactoryLocationInventoryRoutes(app);
  });

  it("rejects bale reimport before parsing when no file is uploaded", async () => {
    const res = await invoke("POST", "/api/factory/bales/reimport", {
      session: { currentCompanyId: 7 },
      body: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "No file uploaded" });
  });

  it("rejects malformed purchase-order ids before storage/accounting work", async () => {
    const res = await invoke("PATCH", "/api/purchase-orders/:id", {
      params: { id: "not-a-number" },
      session: { currentCompanyId: 7, currentRole: "Admin" },
      body: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "Invalid id" });
  });

  it("requires a selected company before sync-all container costing", async () => {
    const res = await invoke("POST", "/api/containers/sync-all-vouchers", {
      session: {},
      body: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "No company selected" });
  });

  it("requires a company for factory location inventory", async () => {
    const res = await invoke("GET", "/api/factory/location-inventory/:locationId", {
      params: { locationId: "1" },
      session: {},
      query: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "No company selected" });
  });

  it("rejects an invalid factory location id before querying inventory", async () => {
    const res = await invoke("GET", "/api/factory/location-inventory/:locationId", {
      params: { locationId: "bad-id" },
      session: { factoryCompanyId: 7 },
      query: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "Invalid id" });
  });
});
