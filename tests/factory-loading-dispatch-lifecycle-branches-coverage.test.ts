/**
 * End Dispatch / reopen lifecycle routes
 * (server/routes/factory/customer-orders/loadingDispatchLifecycleRoutes.ts)
 * over HTTP in one rolled-back factory company per test, driven through the
 * real truck-dispatch workflow (dispatchFlowFixture): malformed ids, unknown
 * and another company's loadings and trips, every close refusal (role,
 * confirmation, inactive loading, closed trip, changed review, empty trip,
 * supervisor approval and reason) and reopen refusal (role, reason, inactive,
 * open trip, missing closure record), plus the lifecycle and closure reads.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { createTrip, dispatchBase, loadingWithBales, scan } from "./helpers/dispatchFlowFixture";

const url = (orderId: number | string, dispatchId: number | string) =>
  `${dispatchBase(orderId as number)}/${dispatchId}`;
const ZERO_FP = "0".repeat(64);

async function world(w: FactoryWorld) {
  const { orderId, bales } = await loadingWithBales(w, ["10", "12"]);
  const dispatchId = await createTrip(w, orderId);
  const preview = async (agent = w.agent) => (await agent.get(`${url(orderId, dispatchId)}/close-preview`)).body;
  const close = (body: unknown, agent = w.agent) =>
    agent.post(`${url(orderId, dispatchId)}/close`).send(body as object);
  const reopen = (body: unknown, agent = w.agent) =>
    agent.post(`${url(orderId, dispatchId)}/reopen`).send(body as object);
  return { orderId, bales, dispatchId, preview, close, reopen };
}

const code = (res: { body: { code?: string } }) => res.body.code;

describe("dispatch lifecycle refusals", () => {
  it("refuses malformed, unknown and another company's loadings and trips on every route", () =>
    withFactoryWorld(async (w) => {
      const { orderId, dispatchId } = await world(w);
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
        [`${w.tag}O`]
      );
      const foreignCustomer = await w.one(
        `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Foreign') RETURNING id`,
        [other, `${w.tag}FC`]
      );
      const foreignOrder = await w.one(
        `INSERT INTO customer_orders (company_id, customer_id, order_date, status) VALUES ($1, $2, '2026-06-01', 'LOADING') RETURNING id`,
        [other, foreignCustomer]
      );
      const body = { confirm: true, fingerprint: ZERO_FP };
      const reason = { reason: "Reopen for a recount" };
      expect(code(await w.agent.get(`${url("abc", dispatchId)}/close-preview`))).toBe("INVALID_DISPATCH");
      expect(code(await w.agent.get(`${url(orderId, "x")}/lifecycle`))).toBe("INVALID_DISPATCH");
      for (const order of [999999999, foreignOrder]) {
        expect(code(await w.agent.get(`${url(order, dispatchId)}/close-preview`))).toBe("LOADING_NOT_FOUND");
        expect(code(await w.agent.post(`${url(order, dispatchId)}/close`).send(body))).toBe("LOADING_NOT_FOUND");
        expect(code(await w.agent.post(`${url(order, dispatchId)}/reopen`).send(reason))).toBe("LOADING_NOT_FOUND");
        expect(code(await w.agent.get(`${url(order, dispatchId)}/lifecycle`))).toBe("DISPATCH_NOT_FOUND");
      }
      expect(code(await w.agent.get(`${url(orderId, 999999999)}/close-preview`))).toBe("DISPATCH_NOT_FOUND");
      expect(code(await w.agent.post(`${url(orderId, 999999999)}/close`).send(body))).toBe("DISPATCH_NOT_FOUND");
      expect(code(await w.agent.post(`${url(orderId, 999999999)}/reopen`).send(reason))).toBe("DISPATCH_NOT_FOUND");
      expect(code(await w.agent.get(`${url(orderId, dispatchId)}/lifecycle/closures/abc`))).toBe("INVALID_CLOSURE");
      expect(code(await w.agent.get(`${url(orderId, dispatchId)}/lifecycle/closures/999999999`))).toBe(
        "CLOSURE_NOT_FOUND"
      );
      const lifecycle = await w.agent.get(`${url(orderId, dispatchId)}/lifecycle`);
      expect(lifecycle.status).toBe(200);
      expect(lifecycle.body).toMatchObject({ trip: { status: "OPEN" }, closures: [], eventsLimitedTo: 100 });
    }));

  it("refuses unconfirmed, changed, empty and read-only closes and early reopens", () =>
    withFactoryWorld(async (w) => {
      const t = await world(w);
      for (const body of [
        [],
        { confirm: false, fingerprint: ZERO_FP },
        { confirm: true, fingerprint: "abc" },
        { confirm: true },
      ]) {
        expect(code(await t.close(body)), JSON.stringify(body)).toBe("CONFIRMATION_REQUIRED");
      }
      expect(code(await t.close({ confirm: true, fingerprint: ZERO_FP }))).toBe("REVIEW_CHANGED");
      const empty = await t.preview();
      expect(empty.hasAnyScans).toBe(false);
      expect(code(await t.close({ confirm: true, fingerprint: empty.fingerprint }))).toBe("EMPTY_DISPATCH");

      const viewer = await w.agentFor("View Only");
      expect((await t.close({ confirm: true, fingerprint: empty.fingerprint }, viewer)).status).toBe(403);
      const manager = await w.agentFor("Manager");
      expect(code(await t.reopen({ reason: "Reopen for a recount" }, manager))).toBe("SUPERVISOR_ONLY");
      for (const body of [{}, { reason: "short" }, { reason: "x".repeat(1001) }, { reason: 12345678901 }]) {
        expect(code(await t.reopen(body)), JSON.stringify(body)).toBe("REOPEN_REASON_REQUIRED");
      }
      expect(code(await t.reopen({ reason: "Reopen for a recount" }))).toBe("NOT_CLOSED");

      await w.q(`UPDATE customer_orders SET status = 'CANCELLED' WHERE id = $1`, [t.orderId]);
      expect(code(await t.close({ confirm: true, fingerprint: ZERO_FP }))).toBe("LOADING_INACTIVE");
      expect(code(await t.reopen({ reason: "Reopen for a recount" }))).toBe("LOADING_INACTIVE");
      const [trip] = await w.q(`SELECT status FROM factory_loading_dispatches WHERE id = $1`, [t.dispatchId]);
      expect(trip.status).toBe("OPEN");
    }));
});

describe("dispatch lifecycle close and reopen", () => {
  it("requires a supervisor and a reason for discrepancies, then closes, reads and reopens", () =>
    withFactoryWorld(async (w) => {
      const t = await world(w);
      await scan(w, t.orderId, t.dispatchId, t.bales[0].reference);
      // A verified bale later taken out of the loading is an unexpected scan.
      await w.q(`DELETE FROM customer_order_bales WHERE id = $1`, [t.bales[0].orderBaleId]);
      const review = await t.preview();
      expect(review).toMatchObject({ needsApproval: true, hasAnyScans: true });
      const body = { confirm: true, fingerprint: review.fingerprint };
      const manager = await w.agentFor("Manager");
      expect(code(await t.close(body, manager))).toBe("SUPERVISOR_APPROVAL_REQUIRED");
      expect(code(await t.close({ ...body, discrepancyReason: "too short" }))).toBe("REASON_REQUIRED");
      const closed = await t.close({ ...body, discrepancyReason: "  One bale follows on the next truck  " });
      expect(closed.status).toBe(200);
      expect(closed.body).toMatchObject({ status: "CLOSED", revision: 1, approvedWithDiscrepancies: true });
      expect(code(await t.close(body))).toBe("ALREADY_CLOSED");

      const lifecycle = await w.agent.get(`${url(t.orderId, t.dispatchId)}/lifecycle`);
      expect(lifecycle.body.closures).toHaveLength(1);
      expect(lifecycle.body.closures[0].discrepancyReason).toBe("One bale follows on the next truck");
      const snapshot = await w.agent.get(`${url(t.orderId, t.dispatchId)}/lifecycle/closures/${closed.body.closureId}`);
      expect(snapshot.status).toBe(200);
      expect(snapshot.body).toMatchObject({ revision: 1, fingerprint: review.fingerprint });

      const reopened = await t.reopen({ reason: "Recount the second bale" });
      expect(reopened.status).toBe(200);
      expect(reopened.body).toMatchObject({ status: "OPEN", revision: 1 });

      // A CLOSED trip with no open closure record cannot be reopened.
      await w.q(`UPDATE factory_loading_dispatches SET status = 'CLOSED' WHERE id = $1`, [t.dispatchId]);
      expect(code(await t.reopen({ reason: "Recount the second bale" }))).toBe("CLOSURE_NOT_FOUND");
    }));

  it("lets a writer close a clean dispatch without approval and numbers the next revision", () =>
    withFactoryWorld(async (w) => {
      const t = await world(w);
      for (const bale of t.bales) await scan(w, t.orderId, t.dispatchId, bale.reference);
      const manager = await w.agentFor("Manager");
      const review = await t.preview(manager);
      expect(review).toMatchObject({ needsApproval: false, canCloseClean: true });
      const first = await t.close({ confirm: true, fingerprint: review.fingerprint }, manager);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ revision: 1, approvedWithDiscrepancies: false, issues: [] });
      expect((await t.reopen({ reason: "Driver changed trucks" })).status).toBe(200);
      const again = await t.preview(manager);
      const second = await t.close({ confirm: true, fingerprint: again.fingerprint }, manager);
      expect(second.body.revision).toBe(2);
      const events = await w.q(
        `SELECT event_type FROM factory_loading_dispatch_events WHERE dispatch_id = $1 AND event_type LIKE 'DISPATCH_%' ORDER BY id`,
        [t.dispatchId]
      );
      expect(events.map((e) => e.event_type).filter((e) => e !== "DISPATCH_SCAN")).toEqual(
        expect.arrayContaining(["DISPATCH_CLOSED", "DISPATCH_REOPENED"])
      );
    }));
});
