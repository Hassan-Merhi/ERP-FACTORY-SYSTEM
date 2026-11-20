/**
 * POST /api/factory/customer-orders/:id/bales/exchange and
 * GET /api/factory/customer-orders/:id/bale-removals through the real app in
 * one rolled-back transaction: input, id, company and status refusals, a
 * missing source row, unavailable or already linked replacement bales, the
 * linked proforma's article and quantity limits (rolled back on refusal), and
 * a successful swap that keeps the price and moves the bale statuses.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { loadingWithBales } from "./helpers/dispatchFlowFixture";

const exchange = (w: FactoryWorld, orderId: number | string, body: Record<string, unknown>) =>
  w.agent.post(`/api/factory/customer-orders/${orderId}/bales/exchange`).send(body);

let seq = 0;
async function stockBale(
  w: FactoryWorld,
  articleCode: string | null,
  productId: number | null = null,
  status = "IN_STOCK"
) {
  const reference = `${w.tag}-X${++seq}`;
  const id = await w.one(
    `INSERT INTO factory_bales (company_id, bale_code, reference_number, article_code, product_name, product_id,
       weight_kg, cost_per_kg, total_cost, status, erp_location_id)
     VALUES ($1, $2, $2, $3, 'Loose', $4, 30, 0.1, 3, $5, $6) RETURNING id`,
    [w.companyId, reference, articleCode, productId, status, w.locationId]
  );
  return { id, reference };
}

/**
 * A completed loading whose loaded bales are still IN_STOCK (as V5 loadings
 * keep them). Only then can the exchange restore the old bale: see the pinned
 * BALE_ON_COMPLETED_ORDER bug below.
 */
async function completedLoading(w: FactoryWorld, prices: string[], status = "FINALIZED") {
  const loading = await loadingWithBales(w, prices, "LOADING");
  await w.q(`UPDATE factory_bales SET status = 'IN_STOCK' WHERE id = ANY($1::int[])`, [
    loading.bales.map((b) => b.baleId),
  ]);
  await w.q(`UPDATE customer_orders SET status = $1 WHERE id = $2`, [status, loading.orderId]);
  return loading;
}

async function snapshot(w: FactoryWorld, orderId: number) {
  return {
    lines: await w.q(`SELECT bale_id, price_used::text FROM customer_order_bales WHERE order_id = $1 ORDER BY id`, [
      orderId,
    ]),
    statuses: await w.q(`SELECT id, status FROM factory_bales WHERE company_id = $1 ORDER BY id`, [w.companyId]),
  };
}

describe("exchange a bale on a finalized order", () => {
  it("refuses bad input, ids, other companies, open orders and unknown source rows", () =>
    withFactoryWorld(async (w) => {
      const { orderId, bales, customerId } = await loadingWithBales(w, ["10.00"], "LOADING");
      const replacement = await stockBale(w, "ART-A");
      expect((await exchange(w, orderId, { orderBaleId: bales[0].orderBaleId })).status).toBe(400);
      expect((await exchange(w, orderId, { orderBaleId: bales[0].orderBaleId, newBaleReference: "  " })).status).toBe(
        400
      );
      expect((await exchange(w, "abc", { orderBaleId: 1, newBaleReference: "x" })).status).toBe(400);
      const open = await exchange(w, orderId, {
        orderBaleId: bales[0].orderBaleId,
        newBaleReference: replacement.reference,
      });
      expect([open.status, open.body.message]).toEqual([
        500,
        "Bale exchange is only allowed on FINALIZED or VERIFIED orders",
      ]);
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}O`,
      ]);
      const foreign = await w.one(
        `INSERT INTO customer_orders (company_id, customer_id, order_date, status) VALUES ($1, $2, '2026-06-01', 'FINALIZED') RETURNING id`,
        [other, customerId]
      );
      const cross = await exchange(w, foreign, { orderBaleId: 1, newBaleReference: replacement.reference });
      expect(cross.body.message).toBe("Order not found");
      await w.q(`UPDATE customer_orders SET status = 'FINALIZED' WHERE id = $1`, [orderId]);
      const missing = await exchange(w, orderId, { orderBaleId: 2147483000, newBaleReference: replacement.reference });
      expect(missing.body.message).toBe("Bale not found in this order");
    }));

  it("refuses replacement bales that are not in stock or already linked to an active order", () =>
    withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["10.00"], "FINALIZED");
      const other = await loadingWithBales(w, ["9.00"], "LOADING");
      await w.q(`UPDATE factory_bales SET status = 'IN_STOCK' WHERE id = $1`, [other.bales[0].baleId]);
      const sold = await stockBale(w, "ART-A", null, "SOLD");
      const before = await snapshot(w, orderId);
      const notStock = await exchange(w, orderId, {
        orderBaleId: bales[0].orderBaleId,
        newBaleReference: sold.reference,
      });
      expect(notStock.body.message).toMatch(/not found in stock or not available/);
      const linked = await exchange(w, orderId, {
        orderBaleId: bales[0].orderBaleId,
        newBaleReference: other.bales[0].reference,
      });
      expect(linked.body.message).toMatch(/already linked to another active loading/);
      expect(await snapshot(w, orderId)).toEqual(before);
    }));

  it("swaps the bale, keeps its price, uses the product name and recalculates the order", () =>
    withFactoryWorld(async (w) => {
      const { orderId, bales } = await completedLoading(w, ["10.00", "12.00"], "VERIFIED");
      const productId = await w.one(
        `INSERT INTO factory_bale_products (company_id, code, name) VALUES ($1, $2, 'Premium Mix') RETURNING id`,
        [w.companyId, `${w.tag}-P`]
      );
      const replacement = await stockBale(w, null, productId);
      const res = await exchange(w, orderId, {
        orderBaleId: bales[0].orderBaleId,
        newBaleReference: ` ${replacement.reference} `,
      });
      expect(res.status).toBe(200);
      const swapped = res.body.bales.find((b: { baleId: number }) => b.baleId === replacement.id);
      expect(swapped).toMatchObject({
        articleCode: "ART-A",
        baleName: "Premium Mix",
        baleReference: replacement.reference,
      });
      expect(Number(swapped.priceUsed)).toBe(10);
      expect(res.body.bales).toHaveLength(2);
      const statuses = await w.q<{ id: number; status: string }>(
        `SELECT id, status FROM factory_bales WHERE id = ANY($1::int[]) ORDER BY id`,
        [[bales[0].baleId, replacement.id]]
      );
      expect(statuses.map((s) => s.status)).toEqual(["IN_STOCK", "SOLD"]);
    }));

  it("enforces the linked proforma's articles and quantities and rolls back the removal", () =>
    withFactoryWorld(async (w) => {
      const { orderId, bales, customerId } = await completedLoading(w, ["10.00", "11.00"]);
      const proformaId = await w.one(
        `INSERT INTO customer_proformas (company_id, customer_id, name, destination, is_active)
         VALUES ($1, $2, 'Swap PF', 'MALI', TRUE) RETURNING id`,
        [w.companyId, customerId]
      );
      await w.q(
        `INSERT INTO customer_proforma_lines (proforma_id, article_code, product_name, quantity, price_per_bale)
         VALUES ($1, 'ART-A', 'ART-A', 2, '10.00'), ($1, 'ART-C', 'ART-C', 0, '10.00')`,
        [proformaId]
      );
      await w.q(`UPDATE customer_orders SET proforma_id_used = $1 WHERE id = $2`, [proformaId, orderId]);
      const offList = await stockBale(w, "ART-Z");
      const full = await stockBale(w, "ART-C");
      const before = await snapshot(w, orderId);
      const notOn = await exchange(w, orderId, {
        orderBaleId: bales[0].orderBaleId,
        newBaleReference: offList.reference,
      });
      expect(notOn.body.message).toMatch(/Replacement article ART-Z is not requested on the linked proforma/);
      const over = await exchange(w, orderId, { orderBaleId: bales[0].orderBaleId, newBaleReference: full.reference });
      expect(over.body.message).toMatch(/Replacement article ART-C (exceeds proforma quantity|is not requested)/);
      expect(await snapshot(w, orderId)).toEqual(before);
      const same = await stockBale(w, "ART-A");
      await w.q(`UPDATE customer_proforma_lines SET quantity = 1 WHERE proforma_id = $1 AND article_code = 'ART-A'`, [
        proformaId,
      ]);
      const exceeds = await exchange(w, orderId, {
        orderBaleId: bales[0].orderBaleId,
        newBaleReference: same.reference,
      });
      expect(exceeds.body.message).toMatch(/^Replacement article ART-A exceeds proforma quantity \(\d+\/1\)$/);
      await w.q(`UPDATE customer_proforma_lines SET quantity = 2 WHERE proforma_id = $1 AND article_code = 'ART-A'`, [
        proformaId,
      ]);
      const ok = await exchange(w, orderId, { orderBaleId: bales[0].orderBaleId, newBaleReference: same.reference });
      expect(ok.status).toBe(200);
    }));
});

describe("exchange on a sold bale (pinned bug)", () => {
  // BUG: exchange.ts restores the old bale to IN_STOCK (line ~119) before it
  // deletes the customer_order_bales row, so factory_bale_completed_order_stock_guard
  // sees the bale still on a FINALIZED/VERIFIED order and rejects the swap. Any
  // order whose bales were marked SOLD can never be exchanged.
  it("is rejected by the completed-order stock guard and changes nothing", () =>
    withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["10.00"], "FINALIZED");
      await w.q(`UPDATE factory_bales SET status = 'SOLD' WHERE id = $1`, [bales[0].baleId]);
      const replacement = await stockBale(w, "ART-A");
      const before = await snapshot(w, orderId);
      const res = await exchange(w, orderId, {
        orderBaleId: bales[0].orderBaleId,
        newBaleReference: replacement.reference,
      });
      expect(res.status).toBe(500);
      expect(res.body.message).toMatch(/update "factory_bales"/);
      expect(await snapshot(w, orderId)).toEqual(before);
    }));
});

describe("bale removal log", () => {
  it("refuses bad ids and other companies, lists removals and the scan audit", () =>
    withFactoryWorld(async (w) => {
      const { orderId, bales, customerId } = await loadingWithBales(w, ["10.00"], "LOADING");
      const log = (id: number | string, query = "") =>
        w.agent.get(`/api/factory/customer-orders/${id}/bale-removals${query}`);
      expect((await log("abc")).status).toBe(400);
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}R`,
      ]);
      const foreign = await w.one(
        `INSERT INTO customer_orders (company_id, customer_id, order_date, status) VALUES ($1, $2, '2026-06-01', 'LOADING') RETURNING id`,
        [other, customerId]
      );
      expect((await log(foreign)).status).toBe(404);
      const empty = await log(orderId);
      expect([empty.status, empty.body]).toEqual([200, []]);
      const audit = await log(orderId, "?includeScanAudit=1");
      expect(audit.body.scanAudit).toEqual([{ id: bales[0].orderBaleId, scannedBy: null, scannedAt: null }]);
    }));
});
