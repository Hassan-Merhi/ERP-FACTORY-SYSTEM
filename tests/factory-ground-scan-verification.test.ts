import express, { type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../server/db", () => ({ pool: { query } }));
vi.mock("../server/auth", () => ({
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import { registerFactoryGroundScanRoutes } from "../server/routes/factory/factoryGroundScanRoutes";

function appWithFactorySession() {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    Object.assign(req, { session: { factoryCompanyId: 12, currentCompanyId: 12, userId: "test-user" } });
    next();
  });
  registerFactoryGroundScanRoutes(app);
  return app;
}

describe("Ground Scan physical verification", () => {
  beforeEach(() => query.mockReset());

  it("accepts a valid factory reference even when its product is in the non-bale priority category", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id FROM factory_ground_scan_items"))
        return { rowCount: 0, rows: [] };
      if (sql.includes("INSERT INTO factory_ground_scan_items"))
        return { rowCount: 1, rows: [{ id: 1, reference_number: "REF308630" }] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const res = await request(appWithFactorySession()).post("/api/factory/ground-scan-items").send({
      locationId: "19",
      referenceNumber: "ref308630",
      articleCode: "HMD12011",
      productName: "TEST PRODUCT",
      weightKg: 40,
      status: "IN_STOCK",
    });

    expect(res.status).toBe(201);
    expect(res.body.reference_number).toBe("REF308630");
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.every(([sql]) => !String(sql).includes("factory_settings"))).toBe(true);
  });

  it("still rejects duplicate scans for the same company and location", async () => {
    query.mockResolvedValue({ rowCount: 1, rows: [{ id: 1 }] });
    const res = await request(appWithFactorySession()).post("/api/factory/ground-scan-items").send({
      locationId: "19",
      referenceNumber: "REF308630",
    });
    expect(res.status).toBe(409);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("accepts the same reference in legacy bulk uploads without classifying it as a production bale", async () => {
    query.mockResolvedValue({ rowCount: 1, rows: [] });
    const res = await request(appWithFactorySession()).post("/api/factory/ground-scan-items/bulk").send({
      locationId: "19",
      items: [{ refCode: "ref308630", articleCode: "HMD12011", weightKg: 40 }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ inserted: 1, skipped: 0 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0][0])).toContain("factory_ground_scan_items");
  });
});
