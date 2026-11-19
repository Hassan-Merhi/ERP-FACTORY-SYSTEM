/**
 * GET /api/factory/v5/stock-allocation, step 1 aggregation
 * (server/routes/factory/stock-allocation-v5/handleGetFactoryV5StockAllocationStep1.ts)
 * against real rows in one rolled-back transaction per test.
 *
 * Pinned: stock, loading and per-container expected quantities per article;
 * DRAFT and LOADING containers reserve stock, finalized and cancelled ones do
 * not; the expected-line backfill; the name fallbacks (catalogue code, proforma
 * line, bale product name); wiper/garbage flags; and the proforma date range.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const URL = "/api/factory/v5/stock-allocation";

interface Row {
  articleCode: string;
  productName: string;
  categoryName: string;
  stockAvailable: number;
  totalLoaded: number;
  expectedToLoad: number;
  freeToPromise: number;
  totalKg: number;
  isGarbageOrWipers: boolean;
  proformaDetails: Array<{
    proformaName: string;
    customerName: string;
    lineQty: number;
    totalExpected: number;
    containers: Array<{
      containerName: string;
      status: string;
      expectedQty: number;
      loadedQty: number;
      remainingQty: number;
    }>;
  }>;
}

let seq = 0;
async function bale(
  w: FactoryWorld,
  articleCode: string,
  status = "IN_STOCK",
  productName: string | null = "Bale name"
) {
  const ref = `${w.tag}-${++seq}`;
  return w.one(
    `INSERT INTO factory_bales (company_id, bale_code, reference_number, article_code, product_name, weight_kg, status)
     VALUES ($1, $2, $2, $3, $4, 25, $5) RETURNING id`,
    [w.companyId, ref, articleCode, productName, status]
  );
}

async function seedWorld(w: FactoryWorld) {
  const wiperCat = await w.one(`INSERT INTO factory_categories (company_id, name) VALUES ($1, 'Wipers') RETURNING id`, [
    w.companyId,
  ]);
  await w.q(
    `INSERT INTO factory_bale_products (company_id, code, article_code, name, weight_per_bale_kg, category_id) VALUES
       ($1, 'A1', 'ART-A', 'Alpha Rags', 40, NULL),
       ($1, 'W1', 'ART-W', 'Wiper Pack', 0, $2),
       ($1, 'G1', 'ART-G', 'Garbage Mix', NULL, NULL),
       ($1, 'LEGACY', 'ART-L', 'Legacy Coded', 30, NULL)`,
    [w.companyId, wiperCat]
  );
  for (let i = 0; i < 5; i++) await bale(w, "ART-A");
  await bale(w, "LEGACY");
  await bale(w, "UNKNOWN", "IN_STOCK", "From bale table");
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
       ($1, 'ART-A', 'Alpha (line)', 3, 10), ($1, 'ART-P', 'Proforma only', 2, 10)`,
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
  const finalized = await order("FINALIZED", "MSCU0000002");
  await order("CANCELLED", "MSCU0000003");
  // The LOADING container already has one ART-A bale scanned and a locked expected qty of 2.
  const loaded = await bale(w, "ART-A", "RESERVED_FOR_ORDER");
  await w.q(
    `INSERT INTO customer_order_bales (order_id, bale_id, bale_reference, location_id, weight, price_used, article_code, bale_name)
     VALUES ($1, $2, 'x', $3, 25, 10, 'ART-A', 'Alpha')`,
    [loading, loaded, w.locationId]
  );
  await w.q(
    `INSERT INTO customer_order_expected_lines (company_id, order_id, proforma_id, article_code, product_name, expected_qty)
     VALUES ($1, $2, $3, 'ART-A', 'Alpha', 2)`,
    [w.companyId, loading, proforma]
  );
  return { draft, loading, finalized, proforma };
}

const fetchRows = async (w: FactoryWorld, filters: Record<string, string> = {}) => {
  // No page/limit: the paginated SQL route (registered first) only answers
  // paginated requests, so this reaches the legacy step-1 aggregation.
  const res = await w.agent.get(URL).query({ ...filters });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.rows as Row[];
};

describe("V5 stock allocation aggregation", () => {
  it("aggregates stock, loading and expected quantities per article", async () => {
    await withFactoryWorld(async (w) => {
      const { draft } = await seedWorld(w);
      const rows = await fetchRows(w);
      const byCode = Object.fromEntries(rows.map((r) => [r.articleCode, r]));
      expect(Object.keys(byCode).sort()).toEqual(["ART-A", "ART-G", "ART-L", "ART-P", "ART-W", "LEGACY", "UNKNOWN"]);

      // ART-A: 5 in stock, 1 scanned into LOADING, expected 3 (DRAFT, backfilled) + max(2-1,0) (LOADING).
      // ART-P is backfilled for both the DRAFT and the LOADING container (2 + 2).
      expect(byCode["ART-A"]).toMatchObject({
        productName: "Alpha Rags",
        stockAvailable: 5,
        totalLoaded: 1,
        expectedToLoad: 4,
        freeToPromise: 0,
        totalKg: 200,
        isGarbageOrWipers: false,
      });
      const detail = byCode["ART-A"].proformaDetails[0];
      expect(detail).toMatchObject({ proformaName: "Spring PF", customerName: "Allocation Buyer", lineQty: 3 });
      expect(
        detail.containers.map((c) => [c.containerName, c.status, c.expectedQty, c.loadedQty, c.remainingQty])
      ).toEqual([
        [`Order #${draft}`, "DRAFT", 3, 0, 3],
        ["MSCU0000001", "LOADING", 2, 1, 1],
        ["MSCU0000002", "FINALIZED", 3, 0, 3],
      ]);
      expect(detail.totalExpected).toBe(8);

      expect(byCode["ART-W"]).toMatchObject({ isGarbageOrWipers: true, categoryName: "Wipers", totalKg: 0 });
      expect(byCode["ART-G"]).toMatchObject({ isGarbageOrWipers: true, stockAvailable: 0 });
      // A bale stored under the catalogue's raw code is named by the code match.
      expect(byCode.LEGACY.productName).toBe("Legacy Coded");
      // Pinned quirk: the CASE in the name lookup prefers `code`, so the same
      // catalogue row is not also mapped under its article code, and the
      // zero-stock article row falls back to showing the bare code.
      expect(byCode["ART-L"]).toMatchObject({ productName: "ART-L", stockAvailable: 0 });
      expect(byCode["ART-P"]).toMatchObject({ productName: "Proforma only", expectedToLoad: 4, freeToPromise: -4 });
      expect(byCode.UNKNOWN.productName).toBe("From bale table");

      const backfilled = await w.q(
        `SELECT article_code, expected_qty FROM customer_order_expected_lines WHERE order_id = $1 ORDER BY article_code`,
        [draft]
      );
      expect(backfilled).toEqual([
        { article_code: "ART-A", expected_qty: 3 },
        { article_code: "ART-P", expected_qty: 2 },
      ]);
      // Idempotent on the next read.
      await fetchRows(w);
      const again = await w.q(`SELECT COUNT(*)::int AS n FROM customer_order_expected_lines WHERE order_id = $1`, [
        draft,
      ]);
      expect(again[0].n).toBe(2);
    });
  });

  it("filters proformas by creation date and ignores unparseable dates", async () => {
    await withFactoryWorld(async (w) => {
      await seedWorld(w);
      const ignored = await fetchRows(w, { fromDate: "not-a-date", toDate: "also-not" });
      expect(ignored.find((r) => r.articleCode === "ART-P")).toBeDefined();
      const future = await fetchRows(w, { fromDate: "2999-01-01" });
      expect(future.find((r) => r.articleCode === "ART-P")).toBeUndefined();
      const window = await fetchRows(w, { fromDate: "2000-01-01", toDate: "2999-12-31" });
      expect(window.find((r) => r.articleCode === "ART-P")).toBeDefined();
      expect(future.find((r) => r.articleCode === "ART-A")?.proformaDetails).toEqual([]);
      const past = await fetchRows(w, { toDate: "2000-01-01" });
      expect(past.find((r) => r.articleCode === "ART-A")?.expectedToLoad).toBe(0);
    });
  });

  it("returns an empty allocation for a company with no data", async () => {
    await withFactoryWorld(async (w) => {
      expect(await fetchRows(w)).toEqual([]);
    });
  });
});
