/**
 * The Item Market Analysis routes (report, sale-price drill-down and Excel
 * sale-price export) against PostgreSQL in one rolled-back transaction per
 * test: filter validation, date order, company access, ERP-only companies,
 * inactive companies, and the per-company role rules for a second company
 * (POS refused, a Manager without Sales Report access refused, Developer and
 * permitted roles allowed).
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { item } from "./helpers/voucherReadFixture";
import { denySalesReport, erpWorld, secondCompany } from "./helpers/itemMarketFixture";

const REPORT = "/api/reports/item-market-analysis";

describe("GET /api/reports/item-market-analysis", () => {
  it("validates filters, dates, company ids and stock group names", async () => {
    await erpWorld(async (w) => {
      expect((await w.agent.get(REPORT).query({ startDate: "2026-02-30" })).status).toBe(400);
      const order = await w.agent.get(REPORT).query({ startDate: "2026-03-02", endDate: "2026-03-01" });
      expect(order.body.message).toBe("Start date cannot be after end date");
      expect((await w.agent.get(REPORT).query({ companyIds: "1,abc" })).status).toBe(400);
      const names = Array.from({ length: 51 }, (_, i) => `g${i}`).join(",");
      expect((await w.agent.get(REPORT).query({ stockGroupNames: names })).status).toBe(400);
      expect((await w.agent.get(REPORT).query({ companyIds: "2147483000" })).status).toBe(403);
    });
  });

  it("reports the active ERP company with stock group names and summaries", async () => {
    await erpWorld(async (w) => {
      const groupId = await w.one(
        `INSERT INTO stock_groups (company_id, code, name) VALUES ($1, $2, ' Coats ') RETURNING id`,
        [w.companyId, `${w.tag}G`]
      );
      const coat = await item(w, "Coat");
      await w.q(`UPDATE stock_items SET stock_group_id = $1 WHERE id = $2`, [groupId, coat]);
      const res = await w.agent
        .get(REPORT)
        .query({ startDate: "2026-01-01", endDate: "2026-12-31", stockGroupId: groupId, stockGroupName: "Coats" });
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
      expect(res.body.stockGroups).toEqual(["Coats"]);
      expect(res.body.companySummaries).toEqual([expect.objectContaining({ companyId: w.companyId })]);
      expect(res.body.summary).toMatchObject({ revenue: 0, profit: 0 });
    });
  });

  it("refuses factory companies, inactive companies and second companies without report access", async () => {
    await erpWorld(async (w) => {
      const factory = await secondCompany(w, "Admin", "factory");
      const notErp = await w.agent.get(REPORT).query({ companyIds: `${w.companyId},${factory}` });
      expect([notErp.status, notErp.body.message]).toEqual([
        403,
        "Item Market Analysis can only compare ERP companies",
      ]);
      const inactive = await secondCompany(w, "Admin");
      await w.q(`UPDATE companies SET active = false WHERE id = $1`, [inactive]);
      expect((await w.agent.get(REPORT).query({ companyIds: `${inactive}` })).status).toBe(404);
      const pos = await secondCompany(w, "POS");
      const posRes = await w.agent.get(REPORT).query({ companyIds: `${w.companyId},${pos}` });
      expect([posRes.status, posRes.body.code]).toEqual([403, "COMPANY_REPORT_ACCESS_DENIED"]);
      const manager = await secondCompany(w, "Manager");
      await denySalesReport(w, manager, "Manager");
      const managerRes = await w.agent.get(REPORT).query({ companyIds: `${manager}` });
      expect(managerRes.body.message).toMatch(/Sales Report access/);
    });
  });

  it("compares the active company with a second company where the user may report", async () => {
    await erpWorld(async (w) => {
      const other = await secondCompany(w, "Owner");
      const res = await w.agent.get(REPORT).query({ companyIds: `${w.companyId},${other}` });
      expect(res.status).toBe(200);
      expect(res.body.companySummaries.map((s: { companyId: number }) => s.companyId)).toEqual([w.companyId, other]);
    });
  });
});

describe("GET /api/reports/item-market-analysis/sale-prices", () => {
  const prices = (w: FactoryWorld, query: Record<string, unknown>) => w.agent.get(`${REPORT}/sale-prices`).query(query);

  it("refuses another company's id before the handler (admin company scope guard)", async () => {
    await erpWorld(async (w) => {
      const other = await secondCompany(w, "Admin");
      const res = await prices(w, { companyId: other, stockItemId: 1 });
      expect([res.status, res.body.code]).toEqual([403, "CROSS_COMPANY_ACCESS_DENIED"]);
    });
  });

  it("validates the filters and refuses a non-ERP active company", async () => {
    await withFactoryWorld(async (w) => {
      expect((await prices(w, { companyId: w.companyId, stockItemId: "x" })).status).toBe(400);
      const order = await prices(w, {
        companyId: w.companyId,
        stockItemId: 1,
        startDate: "2026-02-02",
        endDate: "2026-02-01",
      });
      expect([order.status, order.body.message]).toEqual([400, "Start date cannot be after end date"]);
      const factory = await prices(w, { companyId: w.companyId, stockItemId: 1 });
      expect([factory.status, factory.body.message]).toEqual([
        403,
        "Item Market Analysis is available for ERP companies only",
      ]);
    });
  });

  it("returns the breakdown to Admin and to a Manager with Sales Report access", async () => {
    await erpWorld(async (w) => {
      const coat = await item(w, "Coat");
      const query = { companyId: w.companyId, stockItemId: coat, startDate: "2026-01-01", endDate: "2026-02-01" };
      const own = await prices(w, query);
      expect(own.status).toBe(200);
      expect(own.headers["cache-control"]).toBe("private, no-store");
      const manager = await w.agentFor("Manager");
      expect((await manager.get(`${REPORT}/sale-prices`).query(query)).status).toBe(200);
    });
  });
});

describe("POST /api/reports/item-market-analysis/export-sale-prices", () => {
  const exportPrices = (w: FactoryWorld, body: Record<string, unknown>) =>
    w.agent.post(`${REPORT}/export-sale-prices`).send(body);

  it("validates the body, date order, repeated companies and item limits", async () => {
    await erpWorld(async (w) => {
      expect((await exportPrices(w, { companyItems: [] })).status).toBe(400);
      const order = await exportPrices(w, {
        startDate: "2026-02-02",
        endDate: "2026-02-01",
        companyItems: [{ companyId: w.companyId, stockItemIds: [1] }],
      });
      expect(order.body.message).toBe("Start date cannot be after end date");
      const repeated = await exportPrices(w, {
        companyItems: [
          { companyId: w.companyId, stockItemIds: [1] },
          { companyId: w.companyId, stockItemIds: [2] },
        ],
      });
      expect(repeated.body.message).toBe("Invalid or repeated companies or too many item IDs");
      const big = Array.from({ length: 5000 }, (_, i) => i + 1);
      const many = await exportPrices(w, {
        companyItems: [0, 1, 2].map((n) => ({ companyId: w.companyId + n * 100000, stockItemIds: big })),
      });
      expect(many.status).toBe(400);
    });
  });

  it("refuses inaccessible, inactive, non-ERP and unpermitted companies", async () => {
    await erpWorld(async (w) => {
      const items = (companyId: number) => ({ companyItems: [{ companyId, stockItemIds: [1] }] });
      expect((await exportPrices(w, items(2147483000))).status).toBe(403);
      const factory = await secondCompany(w, "Admin", "factory");
      expect((await exportPrices(w, items(factory))).status).toBe(403);
      const inactive = await secondCompany(w, "Admin");
      await w.q(`UPDATE companies SET active = false WHERE id = $1`, [inactive]);
      expect((await exportPrices(w, items(inactive))).status).toBe(404);
      const pos = await secondCompany(w, "POS");
      expect((await exportPrices(w, items(pos))).body.code).toBe("COMPANY_REPORT_ACCESS_DENIED");
      const manager = await secondCompany(w, "Manager");
      await denySalesReport(w, manager, "Manager");
      expect((await exportPrices(w, items(manager))).body.message).toMatch(/Sales Report access/);
    });
  });

  it("exports rows for the active company and a permitted second company", async () => {
    await erpWorld(async (w) => {
      const coat = await item(w, "Coat");
      const other = await secondCompany(w, "Owner");
      const res = await exportPrices(w, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        companyItems: [
          { companyId: w.companyId, stockItemIds: [coat, coat] },
          { companyId: other, stockItemIds: [coat] },
        ],
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.rows)).toBe(true);
    });
  });
});
