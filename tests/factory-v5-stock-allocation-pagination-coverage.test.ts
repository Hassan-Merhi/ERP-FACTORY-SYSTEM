/**
 * GET /api/factory/v5/stock-allocation in its paginated SQL form
 * (server/routes/factory/registerFactoryStockAllocationV5PaginationRoutes.ts)
 * against real rows in one rolled-back transaction per test.
 *
 * Pinned: page/offset paging and headers, totals over the filtered set,
 * each filter (product/search, customer, proforma, container, status, hide
 * zero, proforma date range), the expected-line backfill and the per-article
 * proforma/container details.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const URL = "/api/factory/v5/stock-allocation";
let seq = 0;

async function bale(w: FactoryWorld, articleCode: string, status = "IN_STOCK") {
  const ref = `${w.tag}-${++seq}`;
  return w.one(
    `INSERT INTO factory_bales (company_id, bale_code, reference_number, article_code, product_name, weight_kg, status)
     VALUES ($1, $2, $2, $3, 'Bale name', 25, $4) RETURNING id`,
    [w.companyId, ref, articleCode, status]
  );
}

async function seed(w: FactoryWorld) {
  const wipers = await w.one(`INSERT INTO factory_categories (company_id, name) VALUES ($1, 'Wipers') RETURNING id`, [
    w.companyId,
  ]);
  await w.q(
    `INSERT INTO factory_bale_products (company_id, code, article_code, name, weight_per_bale_kg, category_id) VALUES
       ($1, 'A1', 'ART-A', 'Alpha Rags', 40, NULL),
       ($1, 'W1', 'ART-W', 'Wiper Pack', 10, $2),
       ($1, 'Z1', 'ART-Z', 'Zero Stock', 10, NULL)`,
    [w.companyId, wipers]
  );
  for (let i = 0; i < 4; i++) await bale(w, "ART-A");
  await bale(w, "ART-W");
  const customer = await w.one(
    `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Allocation Buyer') RETURNING id`,
    [w.companyId, `${w.tag}C`]
  );
  const proforma = await w.one(
    `INSERT INTO customer_proformas (company_id, customer_id, name, is_active) VALUES ($1, $2, 'Spring PF', true) RETURNING id`,
    [w.companyId, customer]
  );
  await w.q(
    `INSERT INTO customer_proforma_lines (proforma_id, article_code, product_name, quantity, price_per_bale) VALUES
       ($1, 'ART-A', 'Alpha (line)', 6, 10), ($1, 'ART-P', 'Proforma only', 2, 10)`,
    [proforma]
  );
  const order = (status: string, container: string | null) =>
    w.one(
      `INSERT INTO customer_orders (company_id, customer_id, order_date, status, proforma_id_used, container_number)
       VALUES ($1, $2, '2026-06-01', $3, $4, $5) RETURNING id`,
      [w.companyId, customer, status, proforma, container]
    );
  const draft = await order("DRAFT", null);
  const loading = await order("LOADING", "MSCU0000001");
  const loaded = await bale(w, "ART-A", "RESERVED_FOR_ORDER");
  await w.q(
    `INSERT INTO customer_order_bales (order_id, bale_id, bale_reference, location_id, weight, price_used, article_code, bale_name)
     VALUES ($1, $2, 'x', $3, 25, 10, 'ART-A', 'Alpha')`,
    [loading, loaded, w.locationId]
  );
  return { draft, loading, proforma };
}

const page = async (w: FactoryWorld, query: Record<string, string>) => {
  const res = await w.agent.get(URL).query({ pagination: "1", ...query });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res;
};
const codes = (res: { body: { rows: Array<{ articleCode: string }> } }) => res.body.rows.map((r) => r.articleCode);

describe("V5 stock allocation pagination", () => {
  it("pages the article list with totals, headers and per-article container details", async () => {
    await withFactoryWorld(async (w) => {
      const { draft } = await seed(w);
      const first = await page(w, { limit: "2", page: "1" });
      expect(first.body).toMatchObject({ total: 4, page: 1, limit: 2, totalPages: 2, hasNextPage: true });
      expect(first.headers["x-total-count"]).toBe("4");
      expect(first.headers["x-total-pages"]).toBe("2");
      expect(codes(first)).toEqual(["ART-A", "ART-P"]);
      const alpha = first.body.rows[0];
      expect(alpha).toMatchObject({ productName: "Alpha Rags", stockAvailable: 4, totalLoaded: 1, totalKg: 160 });
      // The backfill wrote the DRAFT and LOADING containers' expected lines.
      expect(alpha.expectedToLoad).toBe(6 + 5);
      expect(alpha.freeToPromise).toBe(4 - 11 - 1);
      const containers = alpha.proformaDetails[0].containers;
      expect(alpha.proformaDetails[0]).toMatchObject({ proformaName: "Spring PF", customerName: "Allocation Buyer" });
      expect(containers.map((c: { containerName: string }) => c.containerName)).toEqual([
        `Order #${draft}`,
        "MSCU0000001",
      ]);
      expect(containers[1]).toMatchObject({ expectedQty: 6, loadedQty: 1, remainingQty: 5 });
      expect(first.body.totals).toMatchObject({ stockAvailable: 5, shortageCount: 2 });

      const second = await page(w, { pageSize: "2", offset: "2" });
      expect(second.body).toMatchObject({ page: 2, hasNextPage: false, hasPreviousPage: true });
      expect(codes(second)).toEqual(["ART-W", "ART-Z"]);
      expect(second.body.rows[0]).toMatchObject({ isGarbageOrWipers: true, categoryName: "Wipers" });
    });
  });

  it("applies the product, customer, proforma, container, status and hide-zero filters", async () => {
    await withFactoryWorld(async (w) => {
      await seed(w);
      expect(codes(await page(w, { productFilter: "alpha rags" }))).toEqual(["ART-A"]);
      expect(codes(await page(w, { search: "WIPERPACK" }))).toEqual(["ART-W"]);
      expect(codes(await page(w, { customerFilter: "allocationbuyer" }))).toEqual(["ART-A", "ART-P"]);
      expect(codes(await page(w, { customerFilter: "nobody" }))).toEqual([]);
      expect(codes(await page(w, { proformaFilter: "spring" }))).toEqual(["ART-A", "ART-P"]);
      expect(codes(await page(w, { containerFilter: "mscu0000001" }))).toEqual(["ART-A", "ART-P"]);
      expect(codes(await page(w, { containerFilter: "order #" }))).toEqual(["ART-A", "ART-P"]);
      expect(codes(await page(w, { statusFilter: "loading" }))).toEqual(["ART-A", "ART-P"]);
      expect(codes(await page(w, { statusFilter: "finalized" }))).toEqual([]);
      expect(codes(await page(w, { hideZero: "true" }))).toEqual(["ART-A", "ART-P", "ART-W"]);
      const empty = await page(w, { productFilter: "nothing-matches" });
      expect(empty.body).toMatchObject({ total: 0, totalPages: 0, hasPreviousPage: false, productNames: {} });
    });
  });

  it("restricts proformas by creation date", async () => {
    await withFactoryWorld(async (w) => {
      const { proforma } = await seed(w);
      await w.q(`UPDATE customer_proformas SET created_at = '2026-01-15' WHERE id = $1`, [proforma]);
      const inRange = await page(w, { fromDate: "2026-01-01", toDate: "2026-01-31" });
      expect(codes(inRange)).toContain("ART-P");
      expect(inRange.body.rows[0].proformaDetails).toHaveLength(1);
      const outOfRange = await page(w, { fromDate: "2026-02-01", toDate: "2026-02-28" });
      expect(codes(outOfRange)).toEqual(["ART-A", "ART-W", "ART-Z"]);
      expect(outOfRange.body.rows[0]).toMatchObject({ expectedToLoad: 0, proformaDetails: [] });
    });
  });
});
