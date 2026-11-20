/**
 * POST /api/factory/customer-orders/:id/bales, the locked part
 * (server/routes/factory/customer-orders/bale-scanning/handlePostFactoryCustomerOrdersIdBalesStep2.ts):
 * bale not found, reserved in this or another order, an in-stock bale
 * already on this or another active order, legacy reservation with name
 * fallbacks, and proforma pricing (per bale, per kg, loading override) with
 * the not-in-proforma and overload confirmations. Rolled back per test.
 */
import { describe, expect, it } from "vitest";

import { loadingWithBales } from "./helpers/dispatchFlowFixture";
import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const scanUrl = (orderId: number) => `/api/factory/customer-orders/${orderId}/bales`;

const inStock = (
  w: FactoryWorld,
  reference: string,
  fields: { article?: string | null; product?: string | null; weight?: string; productId?: number | null } = {}
) =>
  w.one(
    `INSERT INTO factory_bales (company_id, bale_code, reference_number, article_code, product_name, weight_kg, cost_per_kg, total_cost, status, erp_location_id, product_id)
     VALUES ($1, $2, $2, $3, $4, $5, 0.1, 1, 'IN_STOCK', $6, $7) RETURNING id`,
    [
      w.companyId,
      reference,
      fields.article === undefined ? "ART-A" : fields.article,
      fields.product ?? null,
      fields.weight ?? "30",
      w.locationId,
      fields.productId ?? null,
    ]
  );

async function order(
  w: FactoryWorld,
  status = "LOADING",
  proformaId: number | null = null,
  invoice: string | null = null
) {
  const customerId = await w.one(
    `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Scan Customer') RETURNING id`,
    [w.companyId, `${w.tag}C${Math.floor(Math.random() * 1e6)}`]
  );
  return w.one(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status, location_id, proforma_id_used, invoice_number)
     VALUES ($1, $2, '2026-06-01', $3, $4, $5, $6) RETURNING id`,
    [w.companyId, customerId, status, w.locationId, proformaId, invoice]
  );
}

async function proforma(
  w: FactoryWorld,
  lines: Array<{ code: string; qty: number; mode?: string; perKg?: string; perBale?: string }>
) {
  const customerId = await w.one(
    `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'PF Customer') RETURNING id`,
    [w.companyId, `${w.tag}PF`]
  );
  const proformaId = await w.one(
    `INSERT INTO customer_proformas (company_id, customer_id, name, is_active) VALUES ($1, $2, 'PF', true) RETURNING id`,
    [w.companyId, customerId]
  );
  for (const line of lines) {
    await w.q(
      `INSERT INTO customer_proforma_lines (proforma_id, article_code, product_name, quantity, price_per_bale, pricing_mode, price_per_kg)
       VALUES ($1, $2::varchar, $2::text, $3, $4, $5, $6)`,
      [proformaId, line.code, line.qty, line.perBale ?? "10", line.mode ?? "per_bale", line.perKg ?? null]
    );
  }
  return proformaId;
}

const scan = (w: FactoryWorld, orderId: number, scanCode: string, extra: Record<string, unknown> = {}) =>
  w.agent.post(scanUrl(orderId)).send({ scanCode, locationId: w.locationId, ...extra });

describe("order bale scan, locked step", () => {
  it("refuses unknown, reserved and already-loaded bales", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["10"]);
      const other = await loadingWithBales(w, ["11"]);
      expect((await scan(w, orderId, "NO-SUCH-BALE")).status).toBe(404);
      // reservedInThisOrder correlates on the outer factory_bales.id, so a bale
      // already reserved in this order is reported as such, not as another order's.
      expect((await scan(w, orderId, bales[0].reference)).body.message).toBe(
        `${bales[0].reference} is already loaded in this order`
      );
      expect((await scan(w, orderId, other.bales[0].reference)).body.message).toMatch(
        /reserved for another loading order/
      );

      // V5 bales stay IN_STOCK while loaded, so the active-order lookup catches them.
      const here = await inStock(w, `${w.tag}-HERE`);
      await w.q(
        `INSERT INTO customer_order_bales (order_id, bale_id, bale_reference, location_id, weight, price_used) VALUES ($1, $2, $3, $4, 30, 1)`,
        [orderId, here, `${w.tag}-HERE`, w.locationId]
      );
      expect((await scan(w, orderId, `${w.tag}-HERE`)).body.message).toBe("Bale already added to this order");

      const invoiced = await order(w, "FINALIZED", null, "INV-77");
      const elsewhere = await inStock(w, `${w.tag}-ELSE`);
      await w.q(
        `INSERT INTO customer_order_bales (order_id, bale_id, bale_reference, location_id, weight, price_used) VALUES ($1, $2, $3, $4, 30, 1)`,
        [invoiced, elsewhere, `${w.tag}-ELSE`, w.locationId]
      );
      expect((await scan(w, orderId, `${w.tag}-ELSE`)).body.message).toMatch(/already in invoice INV-77 \(FINALIZED\)/);
      await w.q(`UPDATE customer_orders SET invoice_number = NULL, status = 'DRAFT' WHERE id = $1`, [invoiced]);
      expect((await scan(w, orderId, `${w.tag}-ELSE`)).body.message).toMatch(
        new RegExp(`already in loading #${invoiced} \\(DRAFT\\)`)
      );
    });
  });

  it("reserves a legacy bale and names it from the product, the article or the bale code", async () => {
    await withFactoryWorld(async (w) => {
      const orderId = await order(w, "DRAFT");
      const productId = await w.one(
        `INSERT INTO factory_bale_products (company_id, code, name, name_ar, article_code, selling_price) VALUES ($1, 'P1', 'Canon Shirts', 'قمصان', 'ART-P', 12) RETURNING id`,
        [w.companyId]
      );
      const canonical = await inStock(w, `${w.tag}-P`, { article: null, productId });
      const res = await scan(w, orderId, `${w.tag}-P`);
      expect(res.status).toBe(200);
      const [line] = await w.q(
        `SELECT bale_name, bale_name_ar, article_code, price_used::text FROM customer_order_bales WHERE bale_id = $1`,
        [canonical]
      );
      expect(line).toEqual({
        bale_name: "Canon Shirts",
        bale_name_ar: "قمصان",
        article_code: "ART-P",
        price_used: "12.00",
      });
      const [status] = await w.q(`SELECT status FROM factory_bales WHERE id = $1`, [canonical]);
      expect(status.status).toBe("RESERVED_FOR_ORDER");

      await inStock(w, `${w.tag}-A`, { article: "ART-Z" });
      await inStock(w, `${w.tag}-N`, { article: null });
      expect((await scan(w, orderId, `${w.tag}-A`)).status).toBe(200);
      expect((await scan(w, orderId, `${w.tag}-N`)).status).toBe(200);
      const names = await w.q(
        `SELECT bale_reference, bale_name, price_used::text FROM customer_order_bales WHERE order_id = $1 ORDER BY id`,
        [orderId]
      );
      expect(names.slice(1)).toEqual([
        { bale_reference: `${w.tag}-A`, bale_name: "ART-Z", price_used: "0.00" },
        { bale_reference: `${w.tag}-N`, bale_name: `${w.tag}-N`, price_used: "0.00" },
      ]);
    });
  });

  it("prices proforma scans per bale, per kg and by a loading override, and asks before off-proforma or overloaded scans", async () => {
    await withFactoryWorld(async (w) => {
      const proformaId = await proforma(w, [
        { code: "ART-A", qty: 1, perBale: "15" },
        { code: "ART-K", qty: 5, mode: "per_kg", perKg: "1.115" },
        { code: "ART-O", qty: 5 },
      ]);
      const orderId = await order(w, "LOADING", proformaId);
      await inStock(w, `${w.tag}-A1`);
      await inStock(w, `${w.tag}-A2`);
      await inStock(w, `${w.tag}-K`, { article: "ART-K", weight: "3" });
      await inStock(w, `${w.tag}-O`, { article: "ART-O" });
      await inStock(w, `${w.tag}-X`, { article: "ART-X" });
      await w.q(
        `INSERT INTO customer_order_extra_expected_lines (company_id, order_id, article_code, product_name, expected_qty, price_per_bale) VALUES ($1, $2, 'art-o', 'O', 1, 21)`,
        [w.companyId, orderId]
      );

      expect((await scan(w, orderId, `${w.tag}-A1`)).status).toBe(200);
      expect((await scan(w, orderId, `${w.tag}-K`)).status).toBe(200);
      expect((await scan(w, orderId, `${w.tag}-O`)).status).toBe(200);
      const prices = await w.q(
        `SELECT bale_reference, price_used::text FROM customer_order_bales WHERE order_id = $1 ORDER BY id`,
        [orderId]
      );
      expect(prices.map((p) => p.price_used)).toEqual(["15.00", "3.35", "21.00"]);

      const overload = await scan(w, orderId, `${w.tag}-A2`);
      expect(overload.status).toBe(400);
      expect(overload.body).toMatchObject({ confirmationRequired: true, confirmationType: "overload" });
      expect((await scan(w, orderId, `${w.tag}-A2`, { allowBypassOverload: true })).status).toBe(200);

      const offProforma = await scan(w, orderId, `${w.tag}-X`);
      expect(offProforma.body).toMatchObject({ confirmationType: "not_in_proforma", notInProforma: true });
      const bypass = await scan(w, orderId, `${w.tag}-X`, { allowBypassProforma: true });
      expect(bypass.status).toBe(200);
      const [x] = await w.q(`SELECT price_used::text FROM customer_order_bales WHERE bale_reference = $1`, [
        `${w.tag}-X`,
      ]);
      expect(x.price_used).toBe("0.00");
      const statuses = await w.q(`SELECT DISTINCT status FROM factory_bales WHERE company_id = $1`, [w.companyId]);
      expect(statuses).toEqual([{ status: "IN_STOCK" }]);
    });
  });

  it("re-adds a bale removed from this order without the overload confirmation", async () => {
    await withFactoryWorld(async (w) => {
      const proformaId = await proforma(w, [{ code: "ART-A", qty: 1 }]);
      const orderId = await order(w, "LOADING", proformaId);
      await inStock(w, `${w.tag}-R1`);
      const removedBale = await inStock(w, `${w.tag}-R2`);
      const otherBale = await inStock(w, `${w.tag}-R3`);
      expect((await scan(w, orderId, `${w.tag}-R1`)).status).toBe(200);
      // The removal row's own id is far from any bale id, so only the outer
      // factory_bales.id can make the EXISTS check match.
      await w.q(
        `INSERT INTO customer_order_bale_removals (id, order_id, bale_id, reference_number, article_code)
         VALUES ($1, $2, $3, $4, 'ART-A')`,
        [2_000_000_000 + Math.floor(Math.random() * 100_000_000), orderId, removedBale, `${w.tag}-R2`]
      );

      const overload = await scan(w, orderId, `${w.tag}-R3`);
      expect(overload.status).toBe(400);
      expect(overload.body).toMatchObject({ confirmationRequired: true, confirmationType: "overload" });

      expect((await scan(w, orderId, `${w.tag}-R2`)).status).toBe(200);
      const rows = await w.q(`SELECT bale_id FROM customer_order_bales WHERE order_id = $1 ORDER BY id`, [orderId]);
      expect(rows.map((r) => r.bale_id)).not.toContain(otherBale);
      expect(rows.map((r) => r.bale_id)).toContain(removedBale);
    });
  });
});
