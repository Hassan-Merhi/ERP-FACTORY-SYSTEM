import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const registrations: Array<{ path: string; handlers: Array<(...args: any[]) => any> }> = [];
  const selectResults: unknown[][] = [];
  const executeResults: unknown[] = [];
  const poolResults: unknown[] = [];

  const db = {
    execute: vi.fn(async () => executeResults.shift() ?? { rows: [] }),
    select: vi.fn(() => {
      const result = selectResults.shift() ?? [];
      const builder: any = {
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject),
      };
      return builder;
    }),
  };
  const pool = { query: vi.fn(async () => poolResults.shift() ?? { rows: [] }) };

  return { registrations, selectResults, executeResults, poolResults, db, pool };
});

vi.mock("../server/db", () => ({ db: harness.db, pool: harness.pool }));
vi.mock("../server/auth", () => ({ requireAuth: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("../server/lib/logger", () => ({ logger: { error: vi.fn() } }));

import { registerV5StockAllocationRoutes } from "../server/routes/factory/stock-allocation-v5/allocation";

function register() {
  harness.registrations.splice(0);
  const app = {
    get: (path: string, ...handlers: Array<(...args: any[]) => any>) => {
      harness.registrations.push({ path, handlers });
    },
  } as any;
  registerV5StockAllocationRoutes(app);
}

function responseDouble() {
  const res: any = { statusCode: 200, body: undefined, headers: {} };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res;
  });
  res.set = vi.fn((key: string, value: string) => {
    res.headers[key] = value;
    return res;
  });
  return res;
}

async function invoke(path: string, req: any) {
  const route = harness.registrations.find((entry) => entry.path === path)!;
  const res = responseDouble();
  await route.handlers.at(-1)!(req, res, () => undefined);
  return res;
}

describe("Phase 33 3C V5 stock allocation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.selectResults.splice(0);
    harness.executeResults.splice(0);
    harness.poolResults.splice(0);
    register();
  });

  it("rejects allocation reads when no company is selected", async () => {
    const res = await invoke("/api/factory/v5/stock-allocation", { session: {}, query: {} });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "No company selected" });
    expect(harness.db.execute).not.toHaveBeenCalled();
  });

  it("returns a stable empty allocation model without inventing stock", async () => {
    harness.poolResults.push({ rows: [] }, { rows: [] });
    harness.executeResults.push({ rows: [] }, { rows: [] });
    harness.selectResults.push([]);

    const res = await invoke("/api/factory/v5/stock-allocation", {
      session: { factoryCompanyId: 7 },
      query: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["Cache-Control"]).toBe("private, max-age=60");
    expect(res.body).toEqual({
      rows: [],
      totals: {
        stockAvailable: 0,
        totalLoaded: 0,
        expectedToLoad: 0,
        freeToPromise: 0,
        totalKg: 0,
        shortageCount: 0,
      },
      productNames: {},
    });
  });

  it("paginates the empty model deterministically when page is requested", async () => {
    harness.poolResults.push({ rows: [] }, { rows: [] });
    harness.executeResults.push({ rows: [] }, { rows: [] });
    harness.selectResults.push([]);

    const res = await invoke("/api/factory/v5/stock-allocation", {
      session: { currentCompanyId: 7 },
      query: { page: "2", limit: "999" },
    });

    expect(res.body).toMatchObject({ rows: [], total: 0, page: 2, limit: 250, totalPages: 1 });
  });

  it("computes the compact summary from stock, loading, and expected quantities", async () => {
    harness.executeResults.push(
      { rows: [{ count: 120 }] },
      { rows: [{ count: 18 }] },
      { rows: [{ qty: 35 }] }
    );

    const res = await invoke("/api/factory/v5/stock-allocation/summary", {
      session: { currentCompanyId: 7 },
      query: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      stockAvailable: 120,
      totalLoaded: 18,
      expectedToLoad: 35,
      freeToPromise: 67,
    });
    expect(res.headers["Cache-Control"]).toBe("private, max-age=60");
  });
});
