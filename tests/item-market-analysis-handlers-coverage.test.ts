/**
 * Item Market Analysis handler branches that HTTP cannot reach, against
 * PostgreSQL in one rolled-back transaction per test.
 *
 * Over HTTP the admin company scope guard refuses any `companyId` query that
 * differs from the active company (see item-market-analysis-routes-coverage),
 * so the sale-price drill-down's checks for another company never run there,
 * and requireAuth always supplies an active company. Here the registered
 * handlers are invoked directly with a session: a missing active company,
 * another company that is inaccessible, inactive, non-ERP, held as POS, held
 * as a Manager without Sales Report access, held as a permitted Manager, or
 * held as Developer.
 */
import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";

import type { FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { item } from "./helpers/voucherReadFixture";
import { denySalesReport, erpWorld, secondCompany } from "./helpers/itemMarketFixture";
import { registerItemMarketAnalysisRoutes } from "../server/routes/stats/registerItemMarketAnalysisRoutes";

type Handler = (req: Request, res: Response) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const record =
  (method: string) =>
  (path: string, ...chain: unknown[]) =>
    handlers.set(`${method} ${path}`, chain[chain.length - 1] as Handler);
registerItemMarketAnalysisRoutes({ get: record("GET"), post: record("POST") } as never);

async function invoke(
  route: string,
  w: FactoryWorld,
  input: { query?: Record<string, unknown>; body?: unknown; role?: string; companyId?: number | null }
) {
  let status = 200;
  let payload: any;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(value: unknown) {
      payload = value;
      return res;
    },
    setHeader: () => res,
  };
  const session = {
    currentCompanyId: input.companyId === undefined ? w.companyId : input.companyId,
    userId: w.userId,
    currentRole: input.role ?? "Admin",
  };
  await handlers.get(route)!(
    { query: input.query ?? {}, body: input.body ?? {}, session } as unknown as Request,
    res as unknown as Response
  );
  return { status, body: payload };
}

const PRICES = "GET /api/reports/item-market-analysis/sale-prices";

describe("item market handlers without an active company", () => {
  it("refuses each handler with 400", async () => {
    await erpWorld(async (w) => {
      for (const route of [
        PRICES,
        "POST /api/reports/item-market-analysis/export-sale-prices",
        "GET /api/reports/item-market-analysis",
      ]) {
        const res = await invoke(route, w, { companyId: null });
        expect([res.status, res.body.message]).toEqual([400, "An active company session is required"]);
      }
    });
  });
});

describe("sale-price drill-down for another company", () => {
  it("refuses inaccessible, inactive, non-ERP, POS and unpermitted companies", async () => {
    await erpWorld(async (w) => {
      const query = (companyId: number) => ({ query: { companyId: String(companyId), stockItemId: "1" } });
      const denied = await invoke(PRICES, w, query(2147483000));
      expect([denied.status, denied.body.code]).toEqual([403, "COMPANY_ACCESS_DENIED"]);
      const inactive = await secondCompany(w, "Admin");
      await w.q(`UPDATE companies SET active = false WHERE id = $1`, [inactive]);
      expect((await invoke(PRICES, w, query(inactive))).status).toBe(404);
      const factory = await secondCompany(w, "Admin", "factory");
      expect((await invoke(PRICES, w, query(factory))).status).toBe(403);
      const pos = await secondCompany(w, "POS");
      const posRes = await invoke(PRICES, w, query(pos));
      expect([posRes.status, posRes.body.code]).toEqual([403, "COMPANY_REPORT_ACCESS_DENIED"]);
      const manager = await secondCompany(w, "Manager");
      await denySalesReport(w, manager, "Manager");
      expect((await invoke(PRICES, w, query(manager))).body.message).toMatch(/Sales Report access/);
    });
  });

  it("returns the breakdown for a permitted Manager and a Developer, and refuses a company without membership", async () => {
    await erpWorld(async (w) => {
      const coat = await item(w, "Coat");
      const manager = await secondCompany(w, "Manager");
      const res = await invoke(PRICES, w, { query: { companyId: String(manager), stockItemId: String(coat) } });
      expect(res.status).toBe(200);
      const unassigned = await secondCompany(w, null);
      const asAdmin = await invoke(PRICES, w, { query: { companyId: String(unassigned), stockItemId: "1" } });
      expect([asAdmin.status, asAdmin.body.code]).toEqual([403, "COMPANY_ACCESS_DENIED"]);
      await w.q(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, 'Developer')`, [
        w.userId,
        unassigned,
      ]);
      const dev = await invoke(PRICES, w, {
        role: "Developer",
        query: { companyId: String(unassigned), stockItemId: "1" },
      });
      expect(dev.status).toBe(200);
    });
  });
});
