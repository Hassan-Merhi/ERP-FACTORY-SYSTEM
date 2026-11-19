/**
 * All-trucks reconciliation of a multi-truck loading: removing unshipped
 * bales back to stock and the supervisor sign-off, driven through the real
 * dispatch workflow in one rolled-back transaction per test.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { closedTrip, createTrip, dispatchBase, loadingWithBales, postedTrip } from "./helpers/dispatchFlowFixture";

const recon = (orderId: number | string) => `${dispatchBase(orderId as number)}/order-reconciliation`;
const reason = "All trucks counted at the gate by the supervisor";

async function snapshot(w: FactoryWorld, orderId: number, agent = w.agent) {
  const res = await agent.get(recon(orderId));
  expect(res.status).toBe(200);
  return res.body;
}

/** Three loaded bales; two shipped on one posted trip, one left unshipped. */
async function partlyShipped(w: FactoryWorld) {
  const loading = await loadingWithBales(w, ["30.00", "20.00", "10.00"]);
  const { dispatchId } = await postedTrip(w, loading.orderId, [loading.bales[0].reference, loading.bales[1].reference]);
  return { ...loading, dispatchId, unshipped: loading.bales[2] };
}

const remove = (w: FactoryWorld, orderId: number, body: Record<string, unknown>, agent = w.agent) =>
  agent.post(`${recon(orderId)}/remove-unshipped`).send(body);
const approve = (w: FactoryWorld, orderId: number, body: Record<string, unknown>, agent = w.agent) =>
  agent.post(`${recon(orderId)}/approve`).send(body);

describe("order reconciliation: remove unshipped bales", () => {
  it("returns the unshipped bale to stock, records the removal and makes the order ready", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, unshipped } = await partlyShipped(w);
      const before = await snapshot(w, orderId);
      expect(before.ready).toBe(false);
      expect(before.canApprove).toBe(false);
      expect(before.missingBales.map((b: any) => b.baleId)).toEqual([unshipped.baleId]);

      const res = await remove(w, orderId, {
        confirm: true,
        expectedFingerprint: before.fingerprint,
        reason,
        orderBaleIds: [unshipped.orderBaleId],
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ removed: 1, remainingUnshipped: 0, ready: true });
      const [bale] = await w.q(`SELECT status FROM factory_bales WHERE id = $1`, [unshipped.baleId]);
      expect(bale.status).toBe("IN_STOCK");
      const removals = await w.q(`SELECT reference_number FROM customer_order_bale_removals WHERE order_id = $1`, [
        orderId,
      ]);
      expect(removals.map((r) => r.reference_number)).toEqual([unshipped.reference]);
      const [event] = await w.q(
        `SELECT event_type, reason FROM factory_dispatch_financial_events WHERE order_id = $1 AND dispatch_id IS NULL`,
        [orderId]
      );
      expect(event).toMatchObject({ event_type: "ORDER_UNSHIPPED_BALES_REMOVED", reason });
      const after = await snapshot(w, orderId);
      expect(after).toMatchObject({ ready: true, canApprove: true, approval: null });
    });
  });

  it("refuses bad input, non-supervisors, stale previews and bales that are not unshipped", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, unshipped, bales } = await partlyShipped(w);
      const fp = (await snapshot(w, orderId)).fingerprint;
      const good = { confirm: true, expectedFingerprint: fp, reason, orderBaleIds: [unshipped.orderBaleId] };
      // The global privileged-maintenance guard admits only Admin (and Developer)
      // to reconciliation mutations, before the route's own supervisor check.
      const manager = await w.agentFor("Manager");
      const denied = await remove(w, orderId, good, manager);
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe("PRIVILEGED_MAINTENANCE_ROLE_REQUIRED");
      expect((await remove(w, orderId, { ...good, expectedFingerprint: "x" })).body.code).toBe(
        "RECONCILIATION_PREVIEW_REQUIRED"
      );
      expect((await remove(w, orderId, { ...good, reason: "short" })).body.code).toBe("RECONCILIATION_REASON_REQUIRED");
      for (const bad of [{ confirm: false }, { orderBaleIds: [] }, { orderBaleIds: "1" }]) {
        const res = await remove(w, orderId, { ...good, ...bad });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe("RECONCILIATION_SELECTION_INVALID");
      }
      const dup = await remove(w, orderId, { ...good, orderBaleIds: [unshipped.orderBaleId, unshipped.orderBaleId] });
      expect(dup.body.message).toMatch(/Duplicate or invalid/);
      expect((await remove(w, orderId, { ...good, orderBaleIds: [0] })).status).toBe(400);
      expect((await remove(w, "abc" as never, good)).body.code).toBe("INVALID_ORDER_ID");

      const stale = await remove(w, orderId, { ...good, expectedFingerprint: "f".repeat(64) });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe("RECONCILIATION_CHANGED");
      const shipped = await remove(w, orderId, { ...good, orderBaleIds: [bales[0].orderBaleId] });
      expect(shipped.body.code).toBe("RECONCILIATION_BALE_NOT_MISSING");

      await w.q(`UPDATE factory_bales SET status = 'SOLD' WHERE id = $1`, [unshipped.baleId]);
      const sold = await remove(w, orderId, good);
      expect(sold.body.code).toBe("RECONCILIATION_STOCK_OWNERSHIP_CHANGED");
      await w.q(`UPDATE factory_bales SET status = 'RESERVED_FOR_ORDER' WHERE id = $1`, [unshipped.baleId]);

      const other = await loadingWithBales(w, []);
      await w.q(
        `INSERT INTO customer_order_bales (order_id, bale_id, bale_reference, location_id, weight, price_used, article_code, bale_name)
         VALUES ($1, $2, $3, $4, 25, 1, 'ART-A', 'Mixed Rags')`,
        [other.orderId, unshipped.baleId, unshipped.reference, w.locationId]
      );
      const shared = await remove(w, orderId, good);
      expect(shared.body.code).toBe("RECONCILIATION_BALE_SHARED_WITH_OTHER_LOADING");
      const links = await w.q(`SELECT id FROM customer_order_bales WHERE id = $1`, [unshipped.orderBaleId]);
      expect(links).toHaveLength(1);
    });
  });

  it("refuses while a trip is still open, on a finalized loading and on an unknown loading", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, unshipped } = await partlyShipped(w);
      await createTrip(w, orderId);
      const fp = (await snapshot(w, orderId)).fingerprint;
      const body = { confirm: true, expectedFingerprint: fp, reason, orderBaleIds: [unshipped.orderBaleId] };
      const open = await remove(w, orderId, body);
      expect(open.body.code).toBe("RECONCILIATION_TRIPS_UNRESOLVED");

      const done = await loadingWithBales(w, ["5.00"], "FINALIZED");
      const finalized = await remove(w, done.orderId, { ...body, orderBaleIds: [done.bales[0].orderBaleId] });
      expect(finalized.body.code).toBe("RECONCILIATION_ORDER_NOT_OPEN");
      const missing = await remove(w, 999999999, body);
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe("ORDER_NOT_FOUND");
    });
  });

  it("removes an unnamed bale on a proforma loading and refuses a bale moved to another company", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, customerId, unshipped, bales } = await partlyShipped(w);
      const proformaId = await w.one(
        `INSERT INTO customer_proformas (company_id, customer_id, name, is_active) VALUES ($1, $2, 'PF', true) RETURNING id`,
        [w.companyId, customerId]
      );
      await w.q(`UPDATE customer_orders SET proforma_id_used = $1 WHERE id = $2`, [proformaId, orderId]);
      await w.q(`UPDATE factory_bales SET article_code = NULL, product_name = NULL WHERE id = $1`, [unshipped.baleId]);
      const fp = (await snapshot(w, orderId)).fingerprint;
      const body = { confirm: true, expectedFingerprint: fp, reason, orderBaleIds: [unshipped.orderBaleId] };

      await w.q(`SAVEPOINT moved`);
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
        [`${w.tag}M`]
      );
      await w.q(`UPDATE factory_bales SET company_id = $1 WHERE id = $2`, [other, unshipped.baleId]);
      const moved = await remove(w, orderId, body);
      expect(moved.body.code).toBe("RECONCILIATION_BALE_STOCK_MISSING");
      await w.q(`ROLLBACK TO SAVEPOINT moved`);

      const res = await remove(w, orderId, body);
      expect(res.status).toBe(200);
      const [removal] = await w.q(
        `SELECT article_code, product_name FROM customer_order_bale_removals WHERE order_id = $1`,
        [orderId]
      );
      expect(removal).toEqual({ article_code: null, product_name: null });
      const kept = await w.q(`SELECT bale_id FROM customer_order_bales WHERE order_id = $1 ORDER BY bale_id`, [
        orderId,
      ]);
      expect(kept.map((k) => k.bale_id)).toEqual([bales[0].baleId, bales[1].baleId]);
    });
  });

  it("is disabled while a required database safeguard is not installed", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, unshipped } = await partlyShipped(w);
      const fp = (await snapshot(w, orderId)).fingerprint;
      // Transactional DDL: rolled back with the rest of the world.
      await w.q(`ALTER TABLE factory_dispatch_trip_financials DISABLE TRIGGER factory_dispatch_signed_financial_guard`);
      const res = await remove(w, orderId, {
        confirm: true,
        expectedFingerprint: fp,
        reason,
        orderBaleIds: [unshipped.orderBaleId],
      });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("FACTORY_DISPATCH_TABLEPLUS_GUARDS_PENDING");
      expect(res.body.missing).toContain("trigger:factory_dispatch_signed_financial_guard");
      const approval = await approve(w, orderId, { confirm: true, expectedFingerprint: fp, reason });
      expect(approval.status).toBe(503);
      const links = await w.q(`SELECT id FROM customer_order_bales WHERE id = $1`, [unshipped.orderBaleId]);
      expect(links).toHaveLength(1);
    });
  });
});

describe("order reconciliation: supervisor approval", () => {
  it("signs a ready order once, replays the same fingerprint and blocks later removals", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["30.00", "20.00"]);
      await postedTrip(w, orderId, [bales[0].reference]);
      await postedTrip(w, orderId, [bales[1].reference]);
      const before = await snapshot(w, orderId);
      expect(before).toMatchObject({ ready: true, canApprove: true });
      expect(before.summary).toMatchObject({ tripCount: 2, postedTrips: 2, goodsSubtotal: "50.00" });

      const res = await approve(w, orderId, { confirm: true, expectedFingerprint: before.fingerprint, reason });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ approved: true, replayed: false });
      expect(res.body.approval.fingerprint).toBe(before.fingerprint);
      const [row] = await w.q(
        `SELECT status, customer_total::text AS total FROM factory_dispatch_order_consolidations WHERE order_id = $1`,
        [orderId]
      );
      expect(row).toEqual({ status: "DRAFT", total: "50.00" });

      const replay = await approve(w, orderId, { confirm: true, expectedFingerprint: before.fingerprint, reason });
      expect(replay.body).toMatchObject({ approved: true, replayed: true });
      const after = await snapshot(w, orderId);
      expect(after).toMatchObject({ approvalCurrent: true, canApprove: false });

      const signed = await remove(w, orderId, {
        confirm: true,
        expectedFingerprint: before.fingerprint,
        reason,
        orderBaleIds: [bales[0].orderBaleId],
      });
      expect(signed.body.code).toBe("RECONCILIATION_ALREADY_SIGNED");
    });
  });

  it("refuses an unready order, a stale preview, missing confirmation and an existing consolidation", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, unshipped } = await partlyShipped(w);
      const fp = (await snapshot(w, orderId)).fingerprint;
      expect((await approve(w, orderId, { expectedFingerprint: fp, reason })).body.code).toBe(
        "RECONCILIATION_CONFIRM_REQUIRED"
      );
      const owner = await w.agentFor("Owner");
      expect((await approve(w, orderId, { confirm: true, expectedFingerprint: fp, reason }, owner)).status).toBe(403);
      const unready = await approve(w, orderId, { confirm: true, expectedFingerprint: fp, reason });
      expect(unready.status).toBe(409);
      expect(unready.body.code).toBe("RECONCILIATION_UNRESOLVED");
      expect(unready.body.message).toMatch(/unshipped/);
      const stale = await approve(w, orderId, { confirm: true, expectedFingerprint: "0".repeat(64), reason });
      expect(stale.body.code).toBe("RECONCILIATION_CHANGED");

      await remove(w, orderId, {
        confirm: true,
        expectedFingerprint: fp,
        reason,
        orderBaleIds: [unshipped.orderBaleId],
      });
      const ready = (await snapshot(w, orderId)).fingerprint;
      await w.q(
        `INSERT INTO factory_dispatch_order_consolidations (company_id, order_id, status, goods_subtotal, billable_charges_total, discount_total, customer_total)
         VALUES ($1, $2, 'REVERSED', 0, 0, 0, 0)`,
        [w.companyId, orderId]
      );
      const consolidated = await approve(w, orderId, { confirm: true, expectedFingerprint: ready, reason });
      expect(consolidated.body.code).toBe("RECONCILIATION_ALREADY_CONSOLIDATED");
      const events = await w.q(
        `SELECT 1 FROM factory_dispatch_financial_events WHERE order_id = $1 AND event_type = 'ORDER_DISPATCH_RECONCILIATION_APPROVED'`,
        [orderId]
      );
      expect(events).toHaveLength(0);
    });
  });

  it("reports a closed but unposted trip as blocking and denies non-factory sessions", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["30.00"]);
      await closedTrip(w, orderId, [bales[0].reference]);
      const view = await snapshot(w, orderId);
      expect(view.ready).toBe(false);
      expect(view.blockingReasons.join(" ")).toMatch(/financial POST/);
      expect((await w.agent.get(recon("x"))).status).toBe(400);
    });
  });
});
