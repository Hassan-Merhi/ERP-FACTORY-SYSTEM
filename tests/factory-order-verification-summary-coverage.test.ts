/**
 * GET /api/factory/customer-orders/:id/verification-summary
 * (server/routes/factory/customer-orders/verify-recover/registerOrderVerificationSummaryRoutes.ts)
 * against real rows in one rolled-back transaction per test.
 *
 * Pinned: invalid and foreign orders are refused; the order-line fallback when
 * bale rows are missing; each comparison status; the saved plan versus the live
 * master proforma; container supplements; catalogue names; and location-scoped
 * stock net of bales already scanned into other LOADING orders.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const url = (id: number | string) => `/api/factory/customer-orders/${id}/verification-summary`;

let seq = 0;
async function customer(w: FactoryWorld, companyId = w.companyId) {
  return w.one(`INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Verify Buyer') RETURNING id`, [
    companyId,
    `${w.tag}V${++seq}`,
  ]);
}

async function order(
  w: FactoryWorld,
  fields: { status?: string; proforma?: number | null; total?: number; location?: number | null }
) {
  return w.one(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status, proforma_id_used, total_qty_bales, location_id)
     VALUES ($1, $2, '2026-06-01', $3, $4, $5, $6) RETURNING id`,
    [
      w.companyId,
      await customer(w),
      fields.status ?? "LOADING",
      fields.proforma ?? null,
      fields.total ?? 0,
      fields.location ?? null,
    ]
  );
}

async function bale(w: FactoryWorld, articleCode: string, status = "IN_STOCK", location: number | null = null) {
  const ref = `${w.tag}-VB${++seq}`;
  return w.one(
    `INSERT INTO factory_bales (company_id, bale_code, reference_number, article_code, product_name, weight_kg, status, erp_location_id)
     VALUES ($1, $2, $2, $3, 'Stored', 25, $4, $5) RETURNING id`,
    [w.companyId, ref, articleCode, status, location]
  );
}

async function scanned(w: FactoryWorld, orderId: number, articleCode: string, price = "10", name = "") {
  const baleId = await bale(w, articleCode, "IN_STOCK", w.locationId);
  await w.q(
    `INSERT INTO customer_order_bales (order_id, bale_id, bale_reference, location_id, weight, price_used, article_code, bale_name)
     VALUES ($1, $2, 'r', $3, 25, $4, $5, $6)`,
    [orderId, baleId, w.locationId, price, articleCode, name]
  );
}

async function proforma(w: FactoryWorld, lines: Array<[string, number, string?]>) {
  const id = await w.one(
    `INSERT INTO customer_proformas (company_id, customer_id, name, is_active) VALUES ($1, $2, 'Verify PF', true) RETURNING id`,
    [w.companyId, await customer(w)]
  );
  for (const [code, qty, mode] of lines) {
    await w.q(
      `INSERT INTO customer_proforma_lines (proforma_id, article_code, product_name, quantity, price_per_bale, pricing_mode, price_per_kg)
       VALUES ($1, $2::varchar, $2::text, $3, 12, $4, $5)`,
      [id, code, qty, mode ?? "per_bale", mode === "per_kg" ? 0.5 : null]
    );
  }
  return id;
}

const statuses = (body: { comparison: Array<{ articleCode: string; status: string }> }) =>
  Object.fromEntries(body.comparison.map((c) => [c.articleCode, c.status]));

describe("verification summary refusals", () => {
  it("rejects an invalid id and another company's order", async () => {
    await withFactoryWorld(async (w) => {
      expect((await w.agent.get(url("abc"))).status).toBe(400);
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
        [`${w.tag}O`]
      );
      const foreign = await w.one(
        `INSERT INTO customer_orders (company_id, customer_id, order_date, status) VALUES ($1, $2, '2026-06-01', 'LOADING') RETURNING id`,
        [other, await customer(w, other)]
      );
      const res = await w.agent.get(url(foreign));
      expect(res.status).toBe(404);
      expect(res.body.message).toBe("Order not found");
    });
  });
});

describe("verification summary without a proforma", () => {
  it("rebuilds loaded articles from order lines when bale rows are missing", async () => {
    await withFactoryWorld(async (w) => {
      const id = await order(w, { status: "FINALIZED", total: 3 });
      await w.q(
        `INSERT INTO customer_order_lines (order_id, article_code, bale_name, qty, weight_per_bale, total_weight, price_per_bale, total_price)
         VALUES ($1, 'ART-L', 'Line bale', 3, 25, 75.01, 10, 30.01), ($1, 'ART-Z', 'Zero', 0, 0, 0, 0, 0)`,
        [id]
      );
      const res = await w.agent.get(url(id));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ dataSource: "order_lines", totalLoadedBales: 3 });
      expect(res.body.loadedItems).toEqual([
        expect.objectContaining({
          articleCode: "ART-L",
          productName: "Line bale",
          qty: 3,
          totalWeight: 75.01,
          totalPrice: 30.01,
        }),
      ]);
      expect(statuses(res.body)).toEqual({ "ART-L": "LOADED_NOT_IN_PROFORMA" });
    });
  });

  it("keeps bale rows as the source when the order lines are all empty", async () => {
    await withFactoryWorld(async (w) => {
      const id = await order(w, { status: "FINALIZED", total: 2 });
      await w.q(
        `INSERT INTO customer_order_lines (order_id, article_code, bale_name, qty, weight_per_bale, total_weight, price_per_bale, total_price)
         VALUES ($1, 'ART-Z', 'Zero', 0, 0, 0, 0, 0)`,
        [id]
      );
      const res = await w.agent.get(url(id));
      expect(res.body).toMatchObject({ dataSource: "bale_rows", totalLoadedBales: 0, comparison: [] });
    });
  });
});

describe("verification summary against a proforma", () => {
  it("compares a live master proforma, applies supplements, catalogue names and net stock", async () => {
    await withFactoryWorld(async (w) => {
      await w.q(
        `INSERT INTO factory_bale_products (company_id, code, article_code, name) VALUES ($1, 'CAT-A', 'ART-A', 'Catalogue A')`,
        [w.companyId]
      );
      const pf = await proforma(w, [
        ["ART-A", 2],
        ["ART-B", 1, "per_kg"],
        ["ART-C", 1],
        ["ART-D", 0],
        ["ART-M", 2],
      ]);
      const id = await order(w, { status: "LOADING", proforma: pf, location: w.locationId });
      await w.q(
        `INSERT INTO factory_daybook_entries (company_id, tx_date, tx_type, reference_id, reference_table, description)
         VALUES ($1, '2026-06-01', 'LOADING_CREATED', $2, 'customer_orders', 'Loading started for customer: Verify Buyer')`,
        [w.companyId, id]
      );
      await w.q(
        `INSERT INTO customer_order_extra_expected_lines (company_id, order_id, article_code, product_name, expected_qty, price_per_bale)
         VALUES ($1, $2, 'ART-C', 'Extra C', 1, 15), ($1, $2, 'ART-E', 'Extra only', 1, 9)`,
        [w.companyId, id]
      );
      await scanned(w, id, "ART-A");
      await scanned(w, id, "ART-B");
      await scanned(w, id, "ART-B");
      await scanned(w, id, "ART-C");
      await scanned(w, id, "ART-C");
      await scanned(w, id, "ART-D");
      await scanned(w, id, "ART-X", "5", "ART-X");
      await scanned(w, id, "", "1");
      // Stock: two free ART-A bales here, one elsewhere; the scanned ones are deducted.
      await bale(w, "ART-A", "IN_STOCK", w.locationId);
      await bale(w, "ART-A", "IN_STOCK", w.locationId);
      await bale(w, "ART-A");

      const res = await w.agent.get(url(id));
      expect(res.status).toBe(200);
      expect(statuses(res.body)).toEqual({
        "ART-A": "UNDER_LOADED",
        "ART-B": "OVER_LOADED",
        "ART-C": "MATCH",
        "ART-D": "MATCH",
        "ART-X": "LOADED_NOT_IN_PROFORMA",
        UNKNOWN: "LOADED_NOT_IN_PROFORMA",
        "ART-E": "MISSING_FROM_LOADED",
        "ART-M": "MISSING_FROM_LOADED",
      });
      const byCode = Object.fromEntries(res.body.comparison.map((c: { articleCode: string }) => [c.articleCode, c]));
      expect(byCode["ART-A"]).toMatchObject({ productName: "Catalogue A", stockQty: 2, expectedQty: 2, loadedQty: 1 });
      expect(byCode["ART-C"]).toMatchObject({ expectedQty: 2, pricePerBale: "15.0000" });
      const loadedB = res.body.loadedItems.find((l: { articleCode: string }) => l.articleCode === "ART-B");
      expect(loadedB).toMatchObject({ pricingMode: "per_kg", pricePerKg: 0.5 });
      expect(res.body.totalLoadedBales).toBe(8);
    });
  });

  it("uses the saved expected plan of a verified loading and merges in no new articles", async () => {
    await withFactoryWorld(async (w) => {
      const pf = await proforma(w, [
        ["ART-A", 5],
        ["ART-N", 4],
      ]);
      const id = await order(w, { status: "VERIFIED", proforma: pf });
      const [line] = await w.q(
        `SELECT id FROM customer_proforma_lines WHERE proforma_id = $1 AND article_code = 'ART-A'`,
        [pf]
      );
      await w.q(
        `INSERT INTO customer_order_expected_lines (company_id, order_id, proforma_id, proforma_line_id, article_code, product_name, expected_qty)
         VALUES ($1, $2, $3, $4, 'ART-A', NULL, 1), ($1, $2, $3, NULL, 'art-n ', 'Saved N', 2)`,
        [w.companyId, id, pf, line.id]
      );
      await scanned(w, id, "ART-A");
      const res = await w.agent.get(url(id));
      expect(res.status).toBe(200);
      const byCode = Object.fromEntries(res.body.comparison.map((c: { articleCode: string }) => [c.articleCode, c]));
      expect(byCode["ART-A"]).toMatchObject({ status: "MATCH", expectedQty: 1, pricePerBale: "12.00" });
      expect(
        res.body.proformaLines.map((l: { articleCode: string; expectedQty: number }) => [l.articleCode, l.expectedQty])
      ).toEqual(expect.arrayContaining([["ART-A", 1]]));
    });
  });
});
