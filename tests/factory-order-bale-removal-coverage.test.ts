/**
 * DELETE /api/factory/customer-orders/:id/bales/:baleId
 * (registerOrderBaleRemovalRoutesPart2) through the real app and the real
 * truck-dispatch workflow inside one rolled-back transaction: the retired
 * per-bale reconciliation path, id/company/status checks, bales scanned on an
 * open trip, posted trips (shipped bales, stale items, changed stock
 * ownership, closed loadings), and plain removals with their audit row.
 * Every refusal leaves the loading and the bale unchanged.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { createTrip, loadingWithBales, postedTrip, scan } from "./helpers/dispatchFlowFixture";

const remove = (w: FactoryWorld, orderId: number | string, orderBaleId: number | string, query = "") =>
  w.agent.delete(`/api/factory/customer-orders/${orderId}/bales/${orderBaleId}${query}`);

async function snapshot(w: FactoryWorld, orderId: number) {
  return {
    lines: await w.q(`SELECT id FROM customer_order_bales WHERE order_id = $1 ORDER BY id`, [orderId]),
    bales: await w.q(
      `SELECT b.id, b.status FROM factory_bales b
        WHERE b.id IN (SELECT bale_id FROM customer_order_bales WHERE order_id = $1) ORDER BY b.id`,
      [orderId]
    ),
    removals: await w.q(`SELECT count(*)::int AS n FROM customer_order_bale_removals WHERE order_id = $1`, [orderId]),
  };
}

describe("remove a bale from a loading", () => {
  it("refuses the retired reconciliation path, bad ids, other companies and cancelled orders", () =>
    withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["10.00"]);
      const before = await snapshot(w, orderId);
      const recon = await remove(w, orderId, bales[0].orderBaleId, "?source=dispatch-reconciliation");
      expect(recon.status).toBe(409);
      expect(recon.body.code).toBe("USE_ATOMIC_DISPATCH_RECONCILIATION");
      expect((await remove(w, "abc", 1)).status).toBe(400);
      expect((await remove(w, orderId, "abc")).status).toBe(400);
      expect((await remove(w, 2147483000, 1)).status).toBe(404);

      await w.q(`UPDATE customer_orders SET status = 'CANCELLED' WHERE id = $1`, [orderId]);
      const cancelled = await remove(w, orderId, bales[0].orderBaleId);
      expect(cancelled.status).toBe(400);
      expect(cancelled.body.message).toMatch(/not yet cancelled/);
      expect(await snapshot(w, orderId)).toEqual(before);

      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}O`,
      ]);
      const otherCustomer = await w.one(
        `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Other') RETURNING id`,
        [other, `${w.tag}OC`]
      );
      const foreign = await w.one(
        `INSERT INTO customer_orders (company_id, customer_id, order_date, status)
         VALUES ($1, $2, '2026-06-01', 'LOADING') RETURNING id`,
        [other, otherCustomer]
      );
      expect((await remove(w, foreign, 1)).status).toBe(404);
    }));

  it("refuses a bale scanned on an open trip", () =>
    withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["10.00", "12.00"]);
      const trip = await createTrip(w, orderId);
      await scan(w, orderId, trip, bales[0].reference);
      const before = await snapshot(w, orderId);
      const res = await remove(w, orderId, bales[0].orderBaleId);
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/scanned on a dispatch trip/);
      expect(await snapshot(w, orderId)).toEqual(before);
    }));

  it("protects posted trips but releases a still-unshipped bale", () =>
    withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["10.00", "12.00", "14.00"]);
      await postedTrip(w, orderId, [bales[0].reference]);
      const before = await snapshot(w, orderId);

      const shipped = await remove(w, orderId, bales[0].orderBaleId);
      expect(shipped.status).toBe(409);
      expect(shipped.body.message).toMatch(/financially posted truck|scanned on a dispatch trip/);
      const gone = await remove(w, orderId, 2147483000);
      expect(gone.status).toBe(409);
      expect(gone.body.message).toMatch(/no longer in the loading/);
      await w.q(`UPDATE factory_bales SET status = 'SOLD' WHERE id = $1`, [bales[2].baleId]);
      const sold = await remove(w, orderId, bales[2].orderBaleId);
      expect(sold.status).toBe(409);
      expect(sold.body.message).toMatch(/stock ownership has changed/);
      await w.q(`UPDATE factory_bales SET status = 'RESERVED_FOR_ORDER' WHERE id = $1`, [bales[2].baleId]);
      expect(await snapshot(w, orderId)).toEqual(before);

      const ok = await remove(w, orderId, bales[1].orderBaleId);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.bales.map((b: { id: number }) => b.id)).not.toContain(bales[1].orderBaleId);
      const [bale] = await w.q(`SELECT status FROM factory_bales WHERE id = $1`, [bales[1].baleId]);
      expect(bale.status).toBe("IN_STOCK");

      await w.q(`UPDATE customer_orders SET status = 'FINALIZED' WHERE id = $1`, [orderId]);
      const closed = await remove(w, orderId, bales[2].orderBaleId);
      expect(closed.status).toBe(409);
      expect(closed.body.message).toMatch(/no longer open/);
    }));

  it("removes a loaded bale back to stock with a removal record", () =>
    withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["10.00", "12.00"]);
      const res = await remove(w, orderId, bales[0].orderBaleId);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.bales).toHaveLength(1);
      const [removal] = await w.q(
        `SELECT reference_number, removed_by_username FROM customer_order_bale_removals WHERE order_id = $1`,
        [orderId]
      );
      expect(removal).toEqual({ reference_number: bales[0].reference, removed_by_username: w.username });
      const [bale] = await w.q(`SELECT status FROM factory_bales WHERE id = $1`, [bales[0].baleId]);
      expect(bale.status).toBe("IN_STOCK");

      // An item id that is not on the loading only recalculates.
      const noop = await remove(w, orderId, 2147483000);
      expect(noop.status).toBe(200);
      expect(noop.body.bales).toHaveLength(1);
    }));

  it("removes a proforma loading's item whose bale belongs to another company without a removal record", () =>
    withFactoryWorld(async (w) => {
      const { orderId, customerId, bales } = await loadingWithBales(w, ["10.00", "12.00"]);
      const proforma = await w.one(
        `INSERT INTO customer_proformas (company_id, customer_id, name) VALUES ($1, $2, 'PF') RETURNING id`,
        [w.companyId, customerId]
      );
      await w.q(`UPDATE customer_orders SET proforma_id_used = $1 WHERE id = $2`, [proforma, orderId]);
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}F`,
      ]);
      await w.q(`UPDATE factory_bales SET company_id = $1 WHERE id = $2`, [other, bales[0].baleId]);
      const res = await remove(w, orderId, bales[0].orderBaleId);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await snapshot(w, orderId)).removals).toEqual([{ n: 0 }]);
    }));
});
