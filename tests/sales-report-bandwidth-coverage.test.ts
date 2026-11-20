/**
 * server/routes/stats/salesReportBandwidthRoutes.ts over HTTP against
 * PostgreSQL, one rolled-back company per test.
 *
 * Pinned: the summary groups daily, monthly or yearly, keeps cash and credit
 * buckets apart unless merged, filters by dates, location ids (ignoring
 * malformed ones), stock group ids, stock group names (JSON array, or the
 * comma-separated fallback) and a search across item and location names, and
 * splits groups by profit sign. The all-company summary and the comparison
 * are limited to the user's accessible companies and the company-code
 * filter; a filter that matches nothing returns no rows; another company the
 * user does not belong to never appears.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { nextSeq, otherCompany } from "./helpers/voucherReadFixture";

async function seedSales(w: FactoryWorld) {
  const group = await w.one(
    `INSERT INTO stock_groups (company_id, code, name) VALUES ($1, $2, 'Shirts') RETURNING id`,
    [w.companyId, `${w.tag}G`]
  );
  const shirt = await w.one(
    `INSERT INTO stock_items (company_id, code, name, uom, stock_group_id, selling_price)
     VALUES ($1, $2, 'Blue Shirt', 'PCS', $3, 12) RETURNING id`,
    [w.companyId, `${w.tag}SH`, group]
  );
  const sock = await w.one(
    `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Wool Sock', 'PCS') RETURNING id`,
    [w.companyId, `${w.tag}SO`]
  );
  const shop = await w.one(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Main Shop') RETURNING id`, [
    w.companyId,
    `${w.tag}SHOP`,
  ]);
  const sale = async (item: number, date: string, total: string, cost: string, credit = false, location = shop) => {
    const v = await w.one(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, location_id, is_credit_sale)
       VALUES ($1, $2, 'Sales', $3, $4, $5, $6) RETURNING id`,
      [w.companyId, `${w.tag}V${nextSeq()}`, date, total, location, credit]
    );
    await w.q(
      `INSERT INTO sales_items (voucher_id, stock_item_id, quantity, selling_price, total_sales, cost_price, total_cost, profit)
       VALUES ($1, $2, 1, $3, $3, $4, $4, $3::numeric - $4::numeric)`,
      [v, item, total, cost]
    );
  };
  await sale(shirt, "2026-03-01", "10", "4");
  await sale(shirt, "2026-03-01", "20", "5", true);
  await sale(sock, "2026-03-02", "3", "9", false, w.locationId);
  await sale(sock, "2025-12-31", "7", "1");
  return { group, shop };
}

const summary = (w: FactoryWorld, params: Record<string, string>) =>
  w.agent.get("/api/sales-report/summary").query({ ...params });

describe("sales report summary", () => {
  it("groups by day, month and year with separate or merged credit buckets", () =>
    withFactoryWorld(async (w) => {
      await seedSales(w);
      const daily = await summary(w, { startDate: "2026-01-01", endDate: "2026-12-31" });
      expect(daily.status).toBe(200);
      expect(daily.body.groups.map((g: { date: string }) => g.date)).toEqual([
        "2026-03-02",
        "2026-03-01-credit",
        "2026-03-01",
      ]);
      expect(daily.body.totals).toMatchObject({ itemCount: 3, totalSales: 33, totalCost: 18, costProfit: 15 });

      const monthly = await summary(w, { grouping: "monthly", mergeView: "true" });
      expect(
        monthly.body.groups.map((g: { date: string; hasMixedSales: boolean }) => [g.date, g.hasMixedSales])
      ).toEqual([
        ["2026-03", true],
        ["2025-12", false],
      ]);
      const yearly = await summary(w, { grouping: "yearly", mergeView: "1" });
      expect(yearly.body.groups.map((g: { date: string }) => g.date)).toEqual(["2026", "2025"]);
      const unknown = await summary(w, { grouping: "weekly", mergeView: "no" });
      expect(unknown.body.groups).toHaveLength(4);
    }));

  it("filters by location, stock group, search and profit sign", () =>
    withFactoryWorld(async (w) => {
      const { group, shop } = await seedSales(w);
      const ids = (res: { body: { totals: { totalSales: number } } }) => res.body.totals.totalSales;
      expect(ids(await summary(w, { locationIds: `${shop}, x, -4, 0` }))).toBe(37);
      expect(ids(await summary(w, { locationIds: " " }))).toBe(40);
      expect(ids(await summary(w, { stockGroupIds: String(group) }))).toBe(30);
      expect(ids(await summary(w, { stockGroupNames: JSON.stringify(["Shirts", " "]) }))).toBe(30);
      expect(ids(await summary(w, { stockGroupNames: "Shirts, Other" }))).toBe(30);
      expect(ids(await summary(w, { stockGroupNames: '{"name":"Shirts"}' }))).toBe(0);
      expect(ids(await summary(w, { search: "  wool " }))).toBe(10);
      expect(ids(await summary(w, { search: "mainshop" }))).toBe(37);
      const positive = await summary(w, { profitFilter: "positive", mergeView: "true" });
      expect(positive.body.groups.map((g: { date: string }) => g.date)).toEqual(["2026-03-01", "2025-12-31"]);
      const negative = await summary(w, { profitFilter: "negative" });
      expect(negative.body.groups.map((g: { date: string }) => g.date)).toEqual(["2026-03-02"]);
      expect(negative.body.totals.costProfit).toBe(-6);
    }));
});

describe("all-company sales report and comparison", () => {
  it("limits rows to accessible companies and the company-code filter", () =>
    withFactoryWorld(async (w) => {
      await seedSales(w);
      const other = await otherCompany(w);
      const foreignItem = await w.one(
        `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Foreign', 'PCS') RETURNING id`,
        [other, `${w.tag}FI`]
      );
      const fv = await w.one(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
         VALUES ($1, $2, 'Sales', '2026-03-01', 500) RETURNING id`,
        [other, `${w.tag}FV`]
      );
      await w.q(
        `INSERT INTO sales_items (voucher_id, stock_item_id, quantity, selling_price, total_sales, cost_price, total_cost, profit)
         VALUES ($1, $2, 1, 500, 500, 1, 1, 499)`,
        [fv, foreignItem]
      );

      const all = await w.agent.get("/api/dashboard/sales-report-all/summary").query({ mergeView: "true" });
      expect(all.status).toBe(200);
      expect(all.body.totals.totalSales).toBe(40);
      expect(all.body.companies).toEqual([{ code: w.tag, name: w.tag }]);
      const none = await w.agent.get("/api/dashboard/sales-report-all/summary").query({ companyFilter: "NOPE" });
      expect(none.body.groups).toEqual([]);
      const own = await w.agent.get("/api/dashboard/sales-report-all/summary").query({ companyFilter: ` ${w.tag} ,` });
      expect(own.body.totals.totalSales).toBe(40);

      const comparison = await w.agent
        .get("/api/dashboard/sales-report-comparison")
        .query({ startDate: "2026-01-01", endDate: "2026-12-31" });
      expect(comparison.status).toBe(200);
      expect(
        comparison.body.map((r: { stockItemName: string; stockGroupName: string | null; totalSales: string }) => [
          r.stockItemName,
          r.stockGroupName,
          Number(r.totalSales),
        ])
      ).toEqual([
        ["Blue Shirt", "Shirts", 30],
        ["Wool Sock", null, 3],
      ]);
      expect(comparison.body[0]).toMatchObject({ companyCode: w.tag, companyName: w.tag });
      const undated = await w.agent.get("/api/dashboard/sales-report-comparison");
      expect(
        Number(undated.body.find((r: { stockItemName: string }) => r.stockItemName === "Wool Sock").totalSales)
      ).toBe(10);
      const filtered = await w.agent.get("/api/dashboard/sales-report-comparison").query({ companyFilter: "NOPE" });
      expect(filtered.body).toEqual([]);
    }));
});
