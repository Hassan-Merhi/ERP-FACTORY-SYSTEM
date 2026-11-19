/**
 * Truck dispatch barcode scans and supervisor corrections against a real
 * database (one rolled-back transaction per test): exact-barcode matching,
 * duplicate and ambiguous scans, closed trips, role refusals and the audited
 * single and bulk removal paths. Refusals never write scans or events.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { closedTrip, createTrip, dispatchBase, loadingWithBales, scan } from "./helpers/dispatchFlowFixture";

const scans = (orderId: number | string, dispatchId: number | string) =>
  `${dispatchBase(orderId as number)}/${dispatchId}/scans`;
const reason = "Scanned onto the wrong truck";

async function counts(w: FactoryWorld, orderId: number) {
  const [row] = await w.q<{ active: number; removed: number; events: number }>(
    `SELECT count(*) FILTER (WHERE removed_at IS NULL)::int AS active,
            count(*) FILTER (WHERE removed_at IS NOT NULL)::int AS removed,
            (SELECT count(*)::int FROM factory_loading_dispatch_events
              WHERE order_id = $1 AND event_type LIKE 'BALE_SCAN%') AS events
       FROM factory_loading_dispatch_scans WHERE order_id = $1`,
    [orderId]
  );
  return row;
}

describe("dispatch scans: record", () => {
  it("records an exact (case-insensitive) barcode once and lists the history", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["10.00", "12.00"]);
      const tripId = await createTrip(w, orderId);
      const first = await w.agent
        .post(scans(orderId, tripId))
        .send({ scanCode: `  ${bales[0].reference.toLowerCase()} ` });
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ status: "VERIFIED", baleReference: bales[0].reference });

      const dup = await w.agent.post(scans(orderId, tripId)).send({ scanCode: bales[0].reference });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe("DISPATCH_DUPLICATE");
      expect(dup.body.previous).toMatchObject({ dispatchNumber: 1, baleReference: bales[0].reference });

      const list = await w.agent.get(scans(orderId, tripId));
      expect(list.status).toBe(200);
      expect(list.body).toMatchObject({ status: "OPEN", activeCount: 1, activeWeightKg: 25 });
      expect(list.body.scans[0]).toMatchObject({ stillInLoading: true, removedAt: null });
      expect(await counts(w, orderId)).toEqual({ active: 1, removed: 0, events: 1 });
    });
  });

  it("refuses invalid barcodes, unknown bales, ambiguous barcodes and read-only roles", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["10.00", "12.00"]);
      const tripId = await createTrip(w, orderId);
      for (const scanCode of ["", "   ", 42, "x".repeat(121)]) {
        const res = await w.agent.post(scans(orderId, tripId)).send({ scanCode });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe("INVALID_BARCODE");
      }
      const unknown = await w.agent.post(scans(orderId, tripId)).send({ scanCode: "NOT-LOADED" });
      expect(unknown.status).toBe(422);
      expect(unknown.body.code).toBe("DISPATCH_NOT_IN_LOADING");

      // The second bale's bale_code equals the first bale's reference.
      await w.q(`UPDATE factory_bales SET bale_code = $1 WHERE id = $2`, [bales[0].reference, bales[1].baleId]);
      const ambiguous = await w.agent.post(scans(orderId, tripId)).send({ scanCode: bales[0].reference });
      expect(ambiguous.status).toBe(422);
      expect(ambiguous.body.code).toBe("DISPATCH_AMBIGUOUS_BARCODE");

      const viewer = await w.agentFor("View Only");
      const denied = await viewer.post(scans(orderId, tripId)).send({ scanCode: bales[1].reference });
      expect(denied.status).toBe(403);
      expect(await counts(w, orderId)).toEqual({ active: 0, removed: 0, events: 0 });
    });
  });

  it("refuses unknown trips, closed trips and cancelled loadings", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["10.00", "12.00"]);
      expect((await w.agent.get(scans("abc", 1))).status).toBe(400);
      expect((await w.agent.get(scans(orderId, 999999999))).status).toBe(404);
      const missing = await w.agent.post(scans(orderId, 999999999)).send({ scanCode: bales[0].reference });
      expect(missing.body.code).toBe("DISPATCH_NOT_FOUND");

      const closed = await closedTrip(w, orderId, [bales[0].reference]);
      const late = await w.agent.post(scans(orderId, closed)).send({ scanCode: bales[1].reference });
      expect(late.status).toBe(409);
      expect(late.body.code).toBe("DISPATCH_NOT_OPEN");

      const open = await createTrip(w, orderId);
      await w.q(`UPDATE customer_orders SET status = 'CANCELLED' WHERE id = $1`, [orderId]);
      const cancelled = await w.agent.post(scans(orderId, open)).send({ scanCode: bales[1].reference });
      expect(cancelled.status).toBe(409);
      expect(cancelled.body.code).toBe("LOADING_INACTIVE");
      expect(await counts(w, orderId)).toMatchObject({ active: 1, removed: 0 });
    });
  });
});

describe("dispatch scans: single correction", () => {
  it("lets a supervisor remove one active scan with a reason and keeps the history", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["10.00"]);
      const tripId = await createTrip(w, orderId);
      await scan(w, orderId, tripId, bales[0].reference);
      const [{ id }] = await w.q(`SELECT id FROM factory_loading_dispatch_scans WHERE order_id = $1`, [orderId]);
      const url = `${scans(orderId, tripId)}/${id}/remove`;

      const manager = await w.agentFor("Manager");
      expect((await manager.post(url).send({ reason })).status).toBe(403);
      expect((await w.agent.post(`${scans(orderId, tripId)}/abc/remove`).send({ reason })).status).toBe(400);
      expect((await w.agent.post(url).send({ reason: "no" })).status).toBe(400);
      expect((await w.agent.post(`${scans(orderId, 999999999)}/${id}/remove`).send({ reason })).status).toBe(404);
      expect(await counts(w, orderId)).toEqual({ active: 1, removed: 0, events: 1 });

      const removed = await w.agent.post(url).send({ reason });
      expect(removed.status).toBe(200);
      expect(removed.body.scan).toMatchObject({ baleReference: bales[0].reference });
      const again = await w.agent.post(url).send({ reason });
      expect(again.status).toBe(404);
      expect(await counts(w, orderId)).toEqual({ active: 0, removed: 1, events: 2 });
      const list = await w.agent.get(scans(orderId, tripId));
      expect(list.body).toMatchObject({ activeCount: 0, activeWeightKg: 0 });
      expect(list.body.scans[0].removalReason).toBe(reason);
    });
  });

  it("refuses to correct a closed trip", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["10.00"]);
      const tripId = await closedTrip(w, orderId, [bales[0].reference]);
      const [{ id }] = await w.q(`SELECT id FROM factory_loading_dispatch_scans WHERE order_id = $1`, [orderId]);
      const res = await w.agent.post(`${scans(orderId, tripId)}/${id}/remove`).send({ reason });
      expect(res.status).toBe(409);
      const bulk = await w.agent.post(`${scans(orderId, tripId)}/bulk-remove`).send({ reason, all: true });
      expect(bulk.status).toBe(409);
      expect(await counts(w, orderId)).toMatchObject({ active: 1, removed: 0 });
    });
  });
});

describe("dispatch scans: bulk correction", () => {
  it("validates the request before locking anything", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId } = await loadingWithBales(w, ["10.00"]);
      const tripId = await createTrip(w, orderId);
      const url = `${scans(orderId, tripId)}/bulk-remove`;
      const manager = await w.agentFor("Manager");
      expect((await manager.post(url).send({ reason, all: true })).status).toBe(403);
      for (const body of [
        { reason: "x", all: true },
        { reason },
        { reason, scanIds: [] },
        { reason, all: true, scanIds: [1] },
        { reason, scanIds: ["0"] },
        { reason, scanIds: [5, 5] },
      ]) {
        expect((await w.agent.post(url).send(body)).status).toBe(400);
      }
      expect(
        (await w.agent.post(`${dispatchBase(999999999)}/${tripId}/scans/bulk-remove`).send({ reason, all: true }))
          .status
      ).toBe(404);
      expect((await w.agent.post(`${scans(orderId, 999999999)}/bulk-remove`).send({ reason, all: true })).status).toBe(
        404
      );
      const none = await w.agent.post(url).send({ reason, all: true });
      expect(none.status).toBe(409);
      expect(none.body.message).toMatch(/no matching active scans/);
    });
  });

  it("removes selected scans atomically, refuses a stale selection and removes all remaining", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["10.00", "11.00", "12.00"]);
      const tripId = await createTrip(w, orderId);
      for (const bale of bales) await scan(w, orderId, tripId, bale.reference);
      const ids = (
        await w.q(`SELECT id::text FROM factory_loading_dispatch_scans WHERE order_id = $1 ORDER BY id`, [orderId])
      ).map((r) => r.id as string);
      const url = `${scans(orderId, tripId)}/bulk-remove`;

      const stale = await w.agent.post(url).send({ reason, scanIds: [ids[0], "999999999"] });
      expect(stale.status).toBe(409);
      expect(stale.body.message).toMatch(/changed/);
      expect(await counts(w, orderId)).toEqual({ active: 3, removed: 0, events: 3 });

      const selected = await w.agent.post(url).send({ reason, scanIds: [ids[0]] });
      expect(selected.body).toEqual({ success: true, count: 1, scanIds: [ids[0]] });
      const rest = await w.agent.post(url).send({ reason, all: true });
      expect(rest.body).toEqual({ success: true, count: 2, scanIds: [ids[1], ids[2]] });
      expect(await counts(w, orderId)).toEqual({ active: 0, removed: 3, events: 5 });
      const [event] = await w.q(
        `SELECT event_data FROM factory_loading_dispatch_events WHERE order_id = $1 AND event_type = 'BALE_SCANS_BULK_REMOVED'
          ORDER BY id DESC LIMIT 1`,
        [orderId]
      );
      expect(event.event_data).toMatchObject({ reason, all: true, scanIds: [ids[1], ids[2]] });
    });
  });
});
