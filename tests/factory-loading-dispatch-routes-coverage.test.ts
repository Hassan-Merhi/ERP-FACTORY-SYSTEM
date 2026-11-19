/**
 * Truck dispatch trip create / read / edit / delete routes against a real
 * database (one rolled-back transaction per test).
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const base = (orderId: number | string) => `/api/factory/customer-orders/${orderId}/loading-dispatches`;

async function order(w: FactoryWorld, status = "LOADING", extra: { container?: string; invoice?: string } = {}) {
  const customerId = await w.one(
    `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Dispatch Customer') RETURNING id`,
    [w.companyId, `${w.tag}C${Math.random().toString(36).slice(2, 6)}`]
  );
  return w.one(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status, container_number, invoice_number)
     VALUES ($1, $2, '2026-06-01', $3, $4, $5) RETURNING id`,
    [w.companyId, customerId, status, extra.container ?? "CONT-1", extra.invoice ?? null]
  );
}

describe("loading dispatch trips: create", () => {
  it("numbers trips per loading, records the event and lists only live trips", async () => {
    await withFactoryWorld(async (w) => {
      const orderId = await order(w);
      const first = await w.agent.post(base(orderId)).send({ notes: "  first truck  " });
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ dispatchNumber: 1, status: "OPEN", notes: "first truck" });
      expect(first.body.containerNumberSnapshot).toBe("CONT-1");
      const second = await w.agent.post(base(orderId)).send({});
      expect(second.body.dispatchNumber).toBe(2);
      const chosen = await w.agent.post(base(orderId)).send({ tripNumber: "7" });
      expect(chosen.body.dispatchNumber).toBe(7);

      const events = await w.q(`SELECT event_type FROM factory_loading_dispatch_events WHERE order_id = $1`, [orderId]);
      expect(events.map((e) => e.event_type)).toEqual(["CREATED", "CREATED", "CREATED"]);

      await w.q(`UPDATE factory_loading_dispatches SET status = 'CANCELLED' WHERE id = $1`, [second.body.id]);
      const list = await w.agent.get(base(orderId));
      expect(list.status).toBe(200);
      expect(list.headers["x-factory-dispatch-api"]).toBe("v1");
      expect(list.body.containerNumber).toBe("CONT-1");
      expect(list.body.dispatches.map((d: any) => d.dispatchNumber)).toEqual([7, 1]);
      expect(list.body.dispatches[0]).toMatchObject({ scannedBales: 0, scannedWeightKg: "0" });
    });
  });

  it("refuses duplicate, malformed and out-of-range trip numbers and bad notes", async () => {
    await withFactoryWorld(async (w) => {
      const orderId = await order(w);
      expect((await w.agent.post(base(orderId)).send({ tripNumber: 3 })).status).toBe(201);
      const dup = await w.agent.post(base(orderId)).send({ tripNumber: 3 });
      expect(dup.status).toBe(409);
      expect(dup.body.message).toMatch(/already exists/);
      for (const tripNumber of ["0", "-1", "1.5", "abc", null, 99999999999]) {
        const res = await w.agent.post(base(orderId)).send({ tripNumber });
        expect(res.status).toBe(400);
      }
      expect((await w.agent.post(base(orderId)).send({ tripNumber: "2147483648" })).body.message).toMatch(/between/);
      expect((await w.agent.post(base(orderId)).send({ notes: 5 })).body.message).toMatch(/notes must be text/);
      expect((await w.agent.post(base(orderId)).send({ notes: "x".repeat(3001) })).body.message).toMatch(/at most/);
      const count = await w.q(`SELECT COUNT(*)::int AS n FROM factory_loading_dispatches WHERE order_id = $1`, [
        orderId,
      ]);
      expect(count[0].n).toBe(1);
    });
  });

  it("refuses inactive loadings, unknown or foreign orders and read-only roles", async () => {
    await withFactoryWorld(async (w) => {
      const finalized = await order(w, "FINALIZED");
      expect((await w.agent.post(base(finalized)).send({})).status).toBe(409);
      const deleted = await order(w);
      await w.q(`UPDATE customer_orders SET deleted_at = now() WHERE id = $1`, [deleted]);
      expect((await w.agent.post(base(deleted)).send({})).status).toBe(404);
      expect((await w.agent.post(base("abc")).send({})).status).toBe(400);
      expect((await w.agent.post(base(999999999)).send({})).status).toBe(404);

      const otherCompany = await w.one(
        `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
        [`${w.tag}X`]
      );
      const otherCustomer = await w.one(
        `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, 'OC', 'Other') RETURNING id`,
        [otherCompany]
      );
      const foreign = await w.one(
        `INSERT INTO customer_orders (company_id, customer_id, order_date, status) VALUES ($1, $2, '2026-06-01', 'LOADING') RETURNING id`,
        [otherCompany, otherCustomer]
      );
      expect((await w.agent.get(base(foreign))).status).toBe(404);

      const viewer = await w.agentFor("View Only");
      const open = await order(w);
      const refused = await viewer.post(base(open)).send({});
      expect(refused.status).toBe(403);
      const rows = await w.q(`SELECT id FROM factory_loading_dispatches WHERE order_id = $1`, [open]);
      expect(rows).toHaveLength(0);
    });
  });
});

describe("loading dispatch trips: read and edit", () => {
  it("reads one trip scoped to its loading and refuses bad or foreign ids", async () => {
    await withFactoryWorld(async (w) => {
      const orderId = await order(w);
      const otherOrder = await order(w);
      const trip = (await w.agent.post(base(orderId)).send({ notes: "n" })).body;
      const read = await w.agent.get(`${base(orderId)}/${trip.id}`);
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ id: trip.id, dispatchNumber: 1, containerNumber: "CONT-1" });
      expect((await w.agent.get(`${base(orderId)}/zz`)).status).toBe(400);
      expect((await w.agent.get(`${base(otherOrder)}/${trip.id}`)).status).toBe(404);
      expect((await w.agent.get(`${base("0")}/${trip.id}`)).status).toBe(400);
    });
  });

  it("updates trip number and notes with an audit event and keeps a no-op silent", async () => {
    await withFactoryWorld(async (w) => {
      const orderId = await order(w);
      const trip = (await w.agent.post(base(orderId)).send({ notes: "old" })).body;
      const res = await w.agent.patch(`${base(orderId)}/${trip.id}`).send({ tripNumber: 4, notes: "new" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ dispatchNumber: 4, notes: "new" });
      const noop = await w.agent.patch(`${base(orderId)}/${trip.id}`).send({ tripNumber: "4", notes: "new" });
      expect(noop.status).toBe(200);
      const cleared = await w.agent.patch(`${base(orderId)}/${trip.id}`).send({ notes: "" });
      expect(cleared.body.notes).toBeNull();
      const events = await w.q(
        `SELECT event_data FROM factory_loading_dispatch_events WHERE dispatch_id = $1 AND event_type = 'DETAILS_UPDATED' ORDER BY id`,
        [trip.id]
      );
      expect(events).toHaveLength(2);
      expect(events[0].event_data).toEqual({ tripNumber: { old: 1, new: 4 }, notes: { old: "old", new: "new" } });
    });
  });

  it("refuses invalid edits, collisions, closed trips and read-only roles", async () => {
    await withFactoryWorld(async (w) => {
      const orderId = await order(w);
      const a = (await w.agent.post(base(orderId)).send({})).body;
      const b = (await w.agent.post(base(orderId)).send({})).body;
      const url = `${base(orderId)}/${a.id}`;
      expect((await w.agent.patch(url).send({})).status).toBe(400);
      expect((await w.agent.patch(url).send({ status: "CLOSED" })).status).toBe(400);
      expect((await w.agent.patch(url).send([1])).status).toBe(400);
      expect((await w.agent.patch(url).send({ tripNumber: "x" })).status).toBe(400);
      expect((await w.agent.patch(`${base(orderId)}/nope`).send({ notes: "a" })).status).toBe(400);
      expect((await w.agent.patch(`${base(orderId)}/999999999`).send({ notes: "a" })).status).toBe(404);
      const collision = await w.agent.patch(url).send({ tripNumber: b.dispatchNumber });
      expect(collision.status).toBe(409);
      await w.q(`UPDATE factory_loading_dispatches SET status = 'CLOSED' WHERE id = $1`, [a.id]);
      const closed = await w.agent.patch(url).send({ notes: "late" });
      expect(closed.status).toBe(409);
      expect(closed.body.message).toMatch(/Only open/);
      const viewer = await w.agentFor("Create Only");
      expect((await viewer.patch(`${base(orderId)}/${b.id}`).send({ notes: "x" })).status).toBe(403);
      const row = await w.q(`SELECT notes, dispatch_number FROM factory_loading_dispatches WHERE id = $1`, [b.id]);
      expect(row[0]).toMatchObject({ notes: null, dispatch_number: 2 });
    });
  });
});

describe("loading dispatch trips: delete (cancel)", () => {
  it("archives an open trip, releasing its scans, expected bales and article targets", async () => {
    await withFactoryWorld(async (w) => {
      const orderId = await order(w);
      const trip = (await w.agent.post(base(orderId)).send({})).body;
      const baleId = await w.one(
        `INSERT INTO factory_bales (company_id, bale_code, reference_number, weight_kg, status) VALUES ($1, $2, $2, 20, 'IN_STOCK') RETURNING id`,
        [w.companyId, `${w.tag}B1`]
      );
      await w.q(
        `INSERT INTO factory_loading_dispatch_scans (company_id, order_id, dispatch_id, bale_id, bale_reference, weight_kg, scanned_by_user_id, scanned_by_username)
         VALUES ($1, $2, $3, $4, 'R1', 20, $5, 'u')`,
        [w.companyId, orderId, trip.id, baleId, w.userId]
      );
      const res = await w.agent.post(`${base(orderId)}/${trip.id}/cancel`).send({ reason: "  wrong truck  " });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, removedScans: 1 });
      const [scan] = await w.q(
        `SELECT removed_at, removal_reason FROM factory_loading_dispatch_scans WHERE dispatch_id = $1`,
        [trip.id]
      );
      expect(scan.removed_at).not.toBeNull();
      expect(scan.removal_reason).toBe("Dispatch deleted: wrong truck");
      const [row] = await w.q(`SELECT status FROM factory_loading_dispatches WHERE id = $1`, [trip.id]);
      expect(row.status).toBe("CANCELLED");
      expect((await w.agent.get(`${base(orderId)}/${trip.id}`)).status).toBe(404);
      const again = await w.agent.post(`${base(orderId)}/${trip.id}/cancel`).send({ reason: "again please" });
      expect(again.status).toBe(409);
    });
  });

  it("refuses non-supervisors, bad input, finalized loadings, closure history and financial records", async () => {
    await withFactoryWorld(async (w) => {
      const orderId = await order(w);
      const trip = (await w.agent.post(base(orderId)).send({})).body;
      const url = `${base(orderId)}/${trip.id}/cancel`;
      const manager = await w.agentFor("Manager");
      expect((await manager.post(url).send({ reason: "manager try" })).status).toBe(403);
      expect((await w.agent.post(url).send({ reason: "no" })).status).toBe(400);
      expect((await w.agent.post(url).send({ reason: "x".repeat(501) })).status).toBe(400);
      expect((await w.agent.post(`${base(orderId)}/bad/cancel`).send({ reason: "valid reason" })).status).toBe(400);
      expect((await w.agent.post(`${base(orderId)}/999999999/cancel`).send({ reason: "valid reason" })).status).toBe(
        404
      );

      await w.q(
        `INSERT INTO factory_loading_dispatch_closure_history (company_id, order_id, dispatch_id, revision, close_fingerprint, comparison_snapshot, summary_snapshot, closed_by_user_id, closed_by_username)
         VALUES ($1, $2, $3, 1, $4, '{}', '{}', $5, 'u')`,
        [w.companyId, orderId, trip.id, "a".repeat(64), w.userId]
      );
      const signed = await w.agent.post(url).send({ reason: "valid reason" });
      expect(signed.status).toBe(409);
      expect(signed.body.message).toMatch(/Reopen this completed dispatch before deleting it/);
      // Once a supervisor has reopened the closure, the OPEN trip may be archived.
      await w.q(
        `UPDATE factory_loading_dispatch_closure_history
            SET reopened_at = now(), reopen_reason = 'supervised reopen', reopened_by_user_id = $2, reopened_by_username = 'u'
          WHERE dispatch_id = $1`,
        [trip.id, w.userId]
      );
      expect((await w.agent.post(url).send({ reason: "valid reason" })).status).toBe(200);

      const trip2 = (await w.agent.post(base(orderId)).send({})).body;
      await w.q(
        `INSERT INTO factory_dispatch_trip_financials (company_id, order_id, dispatch_id, status) VALUES ($1, $2, $3, 'DRAFT')`,
        [w.companyId, orderId, trip2.id]
      );
      const financial = await w.agent.post(`${base(orderId)}/${trip2.id}/cancel`).send({ reason: "valid reason" });
      expect(financial.status).toBe(409);
      expect(financial.body.message).toMatch(/financial records/);

      const invoiced = await order(w, "LOADING", { invoice: `INV-${w.tag}` });
      const trip3 = (await w.agent.post(base(invoiced)).send({})).body;
      const final = await w.agent.post(`${base(invoiced)}/${trip3.id}/cancel`).send({ reason: "valid reason" });
      expect(final.status).toBe(409);
      expect(final.body.message).toMatch(/finalized or inactive/);
      const statuses = await w.q(`SELECT id, status FROM factory_loading_dispatches WHERE order_id IN ($1, $2)`, [
        orderId,
        invoiced,
      ]);
      const refused = statuses.filter((s) => Number(s.id) !== Number(trip.id));
      expect(refused.length).toBe(2);
      expect(refused.every((s) => s.status === "OPEN")).toBe(true);
      expect(statuses.find((s) => Number(s.id) === Number(trip.id))?.status).not.toBe("OPEN");
    });
  });
});
