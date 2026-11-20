/**
 * GET /api/factory/monthly-production-matrix/export-bales: paged bale rows for
 * the Monthly Production workbook. Input validation, page access, company
 * isolation, product fallback by article code and status exclusions.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const URL = "/api/factory/monthly-production-matrix/export-bales";

async function product(w: FactoryWorld, code: string, companyId = w.companyId) {
  return w.one(
    `INSERT INTO factory_bale_products (company_id, code, name, article_code, active) VALUES ($1, $2, $2, $2, true) RETURNING id`,
    [companyId, `${w.tag}${code}`]
  );
}

async function bale(
  w: FactoryWorld,
  b: {
    productId?: number | null;
    article?: string;
    status?: string;
    date?: string;
    workerId?: number | null;
    workerName?: string | null;
    companyId?: number;
  }
) {
  return w.one(
    `INSERT INTO factory_bales (company_id, reference_number, bale_code, product_id, article_code, status, stock_entry_date,
       weight_kg, finalized_by, worker_name, erp_location_id)
     VALUES ($1, $2, $2, $3, $4, $5, $6::date, 25, $7, $8, $9) RETURNING id`,
    [
      b.companyId ?? w.companyId,
      `${w.tag}-${Math.floor(Math.random() * 1e9)}`,
      b.productId ?? null,
      b.article ?? null,
      b.status ?? "IN_STOCK",
      b.date ?? "2026-03-10",
      b.workerId ?? null,
      b.workerName ?? null,
      b.companyId ? null : w.locationId,
    ]
  );
}

describe("monthly production export bales", () => {
  it("validates product ids, months and page", async () => {
    await withFactoryWorld(async (w) => {
      const bad: Array<Record<string, string>> = [
        { months: "2026-03", page: "1" },
        { productIds: "1,x", months: "2026-03", page: "1" },
        { productIds: "0", months: "2026-03", page: "1" },
        { productIds: "1", months: "2026-13", page: "1" },
        { productIds: "1", page: "1" },
        { productIds: "1", months: "2026-03" },
        { productIds: "1", months: "2026-03", page: "0" },
        { productIds: "1".repeat(16001), months: "2026-03", page: "1" },
        { productIds: "99999999999999999999", months: "2026-03", page: "1" },
      ];
      for (const params of bad) {
        const res = await w.agent.get(URL).query({ ...params });
        expect(res.status, JSON.stringify(params).slice(0, 80)).toBe(400);
      }
      const range = await w.agent.get(URL).query({ productIds: "1", months: "2026-03", page: "201" });
      expect(range.status).toBe(400);
      expect(range.body.message).toBe("Export page is out of range");
    });
  });

  it("returns this company's bales with fallbacks and excludes deleted statuses and other companies", async () => {
    await withFactoryWorld(async (w) => {
      const p1 = await product(w, "P1");
      const p2 = await product(w, "P2");
      const worker = await w.one(
        `INSERT INTO factory_workers (company_id, full_name) VALUES ($1, 'Asha') RETURNING id`,
        [w.companyId]
      );
      const named = await bale(w, { productId: p1, workerId: worker });
      const unassigned = await bale(w, { productId: p1 });
      const unknown = await bale(w, { productId: p1, workerId: 2147480000, workerName: "" });
      const byArticle = await bale(w, { article: `${w.tag}P2`, workerName: "Typed Name" });
      await bale(w, { productId: p1, status: "DELETED" });
      await bale(w, { productId: p1, date: "2026-04-01" });
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}X`,
      ]);
      const otherProduct = await product(w, "OP", other);
      await bale(w, { productId: otherProduct, companyId: other });

      const res = await w.agent
        .get(URL)
        .query({ productIds: `${p1},${p2},${otherProduct},${p1}`, months: "2026-03,2026-03", page: "1" });
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
      expect(res.body.page).toBe(1);
      expect(res.body.hasMore).toBe(false);
      const byId = Object.fromEntries(res.body.bales.map((row: { baleId: number }) => [row.baleId, row]));
      expect(Object.keys(byId).map(Number).sort()).toEqual([named, unassigned, unknown, byArticle].sort());
      expect(byId[named]).toMatchObject({
        workerName: "Asha",
        workerId: worker,
        month: "2026-03",
        locationName: "Yard",
      });
      expect(byId[unassigned]).toMatchObject({ workerName: "Unassigned", workerId: 0 });
      expect(byId[unknown].workerName).toBe("Unknown worker");
      expect(byId[byArticle]).toMatchObject({ productId: p2, workerName: "Typed Name", weightKg: "25.000" });

      const page2 = await w.agent.get(URL).query({ productIds: `${p1}`, months: "2026-03", page: "2" });
      expect(page2.body).toEqual({ page: 2, hasMore: false, bales: [] });
    });
  });

  it("refuses roles without the Factory page", async () => {
    await withFactoryWorld(async (w) => {
      const manager = await w.agentFor("Manager");
      await w.q(
        `INSERT INTO factory_user_profiles (user_id, company_id, display_name, has_factory_access)
         SELECT id, $2, 'No Factory', false FROM users WHERE username = $1`,
        [`${w.tag.toLowerCase()}_u1`, w.companyId]
      );
      const res = await manager.get(URL).query({ productIds: "1", months: "2026-03", page: "1" });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("FACTORY_ACCESS_DISABLED");
    });
  });
});
