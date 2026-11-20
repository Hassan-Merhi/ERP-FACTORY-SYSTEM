/**
 * Draft trip financial charges (create / edit / remove) and the financial
 * preview of a truck trip, driven through the real dispatch workflow against
 * PostgreSQL in one rolled-back transaction per test.
 *
 * Pinned: every refusal (role, ids, body, charge validation, order and trip
 * state, stale fingerprints, foreign or unsuitable accounts, posted or
 * non-USD financials, missing charges) leaves the charge table unchanged, and
 * another company's order or ledger account is refused.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import {
  addCharge,
  closedTrip,
  createTrip,
  dispatchBase,
  financialPreview,
  ledger,
  loadingWithBales,
  postedTrip,
} from "./helpers/dispatchFlowFixture";

const chargeCount = async (w: FactoryWorld) =>
  Number(
    (await w.q(`SELECT COUNT(*)::int AS n FROM factory_dispatch_trip_charges WHERE company_id = $1`, [w.companyId]))[0]
      .n
  );

async function closedWorld(w: FactoryWorld) {
  const { orderId, bales } = await loadingWithBales(w, ["100.00"]);
  const dispatchId = await closedTrip(
    w,
    orderId,
    bales.map((bale) => bale.reference)
  );
  const revenue = await ledger(w, "REV", "Income");
  const payable = await ledger(w, "AP", "Current Liability");
  return { orderId, dispatchId, revenue, payable, url: `${dispatchBase(orderId)}/${dispatchId}` };
}

async function fingerprints(w: FactoryWorld, orderId: number, dispatchId: number) {
  const preview = await financialPreview(w, orderId, dispatchId);
  return {
    expectedSourceFingerprint: preview.source?.sourceFingerprint,
    expectedChargeFingerprint: preview.chargeFingerprint,
  };
}

describe("trip charge creation", () => {
  it("creates a draft financial on the first charge and reuses it for the next", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, dispatchId, revenue, payable } = await closedWorld(w);
      const first = await addCharge(w, orderId, dispatchId, {
        name: "Freight",
        kind: "BILLABLE",
        amount: "10.00",
        ledgerAccountId: revenue,
        erpChargeType: "freight",
      });
      expect(first.status).toBe(201);
      const second = await addCharge(w, orderId, dispatchId, {
        name: "Fuel",
        kind: "INTERNAL",
        amount: "4.00",
        ledgerAccountId: revenue,
        offsetLedgerAccountId: payable,
        notes: "diesel",
      });
      expect(second.status).toBe(201);
      const financials = await w.q(`SELECT status FROM factory_dispatch_trip_financials WHERE company_id = $1`, [
        w.companyId,
      ]);
      expect(financials).toEqual([{ status: "DRAFT" }]);
      expect(await chargeCount(w)).toBe(2);
      const events = await w.q(
        `SELECT event_type FROM factory_dispatch_financial_events WHERE company_id = $1 ORDER BY id`,
        [w.companyId]
      );
      expect(events.map((row) => row.event_type)).toEqual(["TRIP_CHARGE_CREATED", "TRIP_CHARGE_CREATED"]);

      const preview = await w.agent.get(`${dispatchBase(orderId)}/${dispatchId}/financial-preview`);
      expect(preview.body).toMatchObject({ status: "DRAFT", revision: 1, canEdit: true, postingEnabled: false });
      expect(preview.body.charges).toHaveLength(2);
      expect(preview.headers["cache-control"]).toBe("private, no-store");
    });
  });

  it("refuses bad input, foreign or unsuitable accounts and stale fingerprints without writing", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, dispatchId, revenue, payable, url } = await closedWorld(w);
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
        [`${w.tag}X`]
      );
      const foreignLedger = await w.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, active)
         VALUES ($1, $2, 'Foreign', 'Income', '0', TRUE) RETURNING id`,
        [other, `${w.tag}F`]
      );
      const prints = await fingerprints(w, orderId, dispatchId);
      const post = (body: unknown) => w.agent.post(`${url}/financial-charges`).send(body as object);
      const cases: Array<[unknown, number, string]> = [
        [[1, 2], 400, "INVALID_BODY"],
        [
          { ...prints, charge: { name: "", kind: "BILLABLE", amount: "1", ledgerAccountId: revenue } },
          400,
          "INVALID_TRIP_CHARGE",
        ],
        [
          { ...prints, charge: { name: "X", kind: "BILLABLE", amount: "1", ledgerAccountId: foreignLedger } },
          400,
          "LEDGER_ACCOUNT_INVALID",
        ],
        [
          {
            ...prints,
            charge: {
              name: "X",
              kind: "INTERNAL",
              amount: "1",
              ledgerAccountId: payable,
              offsetLedgerAccountId: revenue,
            },
          },
          400,
          "OFFSET_ACCOUNT_INVALID",
        ],
        [
          {
            ...prints,
            charge: {
              name: "X",
              kind: "INTERNAL",
              amount: "1",
              ledgerAccountId: revenue,
              offsetLedgerAccountId: foreignLedger,
            },
          },
          400,
          "OFFSET_ACCOUNT_INVALID",
        ],
        [
          {
            ...prints,
            expectedChargeFingerprint: "stale",
            charge: { name: "X", kind: "BILLABLE", amount: "1", ledgerAccountId: revenue },
          },
          409,
          "FINANCIAL_PREVIEW_CHANGED",
        ],
        [
          {
            ...prints,
            expectedSourceFingerprint: "stale",
            charge: { name: "X", kind: "BILLABLE", amount: "1", ledgerAccountId: revenue },
          },
          409,
          "FINANCIAL_PREVIEW_CHANGED",
        ],
      ];
      for (const [body, status, code] of cases) {
        const res = await post(body);
        expect([res.status, res.body.code]).toEqual([status, code]);
      }
      expect(await chargeCount(w)).toBe(0);
    });
  });

  it("refuses non-supervisors, bad ids, another company's order, open trips and inactive orders", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, dispatchId, revenue, url } = await closedWorld(w);
      const charge = { name: "Freight", kind: "BILLABLE", amount: "1", ledgerAccountId: revenue };
      const manager = await w.agentFor("Manager");
      const denied = await manager.post(`${url}/financial-charges`).send({ charge });
      expect([denied.status, denied.body.code]).toEqual([403, "FINANCIAL_ACCESS_REQUIRED"]);
      const badId = await w.agent.post(`${dispatchBase(orderId)}/abc/financial-charges`).send({ charge });
      expect([badId.status, badId.body.code]).toEqual([400, "INVALID_ID"]);

      const otherCompany = await w.one(
        `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
        [`${w.tag}Y`]
      );
      const foreignCustomer = await w.one(
        `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Far') RETURNING id`,
        [otherCompany, `${w.tag}FC`]
      );
      const foreignOrder = await w.one(
        `INSERT INTO customer_orders (company_id, customer_id, order_date, status) VALUES ($1, $2, '2026-06-01', 'LOADING') RETURNING id`,
        [otherCompany, foreignCustomer]
      );
      const foreign = await w.agent
        .post(`${dispatchBase(foreignOrder)}/${dispatchId}/financial-charges`)
        .send({ charge });
      expect([foreign.status, foreign.body.code]).toEqual([409, "ORDER_NOT_ACTIVE"]);
      const missingTrip = await w.agent
        .post(`${dispatchBase(orderId)}/${dispatchId + 100000}/financial-charges`)
        .send({ charge });
      expect([missingTrip.status, missingTrip.body.code]).toEqual([404, "DISPATCH_NOT_FOUND"]);

      const open = await createTrip(w, orderId);
      const openRes = await w.agent.post(`${dispatchBase(orderId)}/${open}/financial-charges`).send({ charge });
      expect([openRes.status, openRes.body.code]).toEqual([409, "DISPATCH_NOT_CLOSED"]);
      const openPreview = await w.agent.get(`${dispatchBase(orderId)}/${open}/financial-preview`);
      expect(openPreview.status).toBe(200);
      expect(openPreview.body).toMatchObject({
        source: null,
        totals: null,
        canEdit: false,
        status: "DRAFT",
        revision: 1,
      });
      expect(openPreview.body.sourceError).toMatchObject({ code: expect.any(String) });

      await w.q(`UPDATE customer_orders SET status = 'CANCELLED' WHERE id = $1`, [orderId]);
      const inactive = await w.agent.post(`${url}/financial-charges`).send({ charge });
      expect([inactive.status, inactive.body.code]).toEqual([409, "ORDER_NOT_ACTIVE"]);
      expect(await chargeCount(w)).toBe(0);
    });
  });

  it("refuses edits on a posted or non-USD financial", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["100.00"]);
      const revenue = await ledger(w, "REV", "Income");
      const { dispatchId } = await postedTrip(w, orderId, [bales[0].reference]);
      const posted = await addCharge(w, orderId, dispatchId, {
        name: "Late",
        kind: "BILLABLE",
        amount: "1",
        ledgerAccountId: revenue,
      });
      expect([posted.status, posted.body.code]).toEqual([409, "FINANCIAL_LOCKED"]);
      const preview = await w.agent.get(`${dispatchBase(orderId)}/${dispatchId}/financial-preview`);
      expect(preview.body).toMatchObject({ status: "POSTED", canEdit: false });

      await w.q(
        `UPDATE factory_dispatch_trip_financials SET status = 'DRAFT', currency = 'EUR' WHERE company_id = $1`,
        [w.companyId]
      );
      const euro = await addCharge(w, orderId, dispatchId, {
        name: "Late",
        kind: "BILLABLE",
        amount: "1",
        ledgerAccountId: revenue,
      });
      expect([euro.status, euro.body.code]).toEqual([409, "CURRENCY_UNSUPPORTED"]);
    });
  });
});

describe("trip charge edit and removal", () => {
  it("edits and removes a draft charge, refusing unknown charges and trips without a draft", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, dispatchId, revenue, url } = await closedWorld(w);
      const charge = { name: "Freight", kind: "BILLABLE", amount: "10.00", ledgerAccountId: revenue };

      const noDraftPatch = await w.agent
        .patch(`${url}/financial-charges/1`)
        .send({ ...(await fingerprints(w, orderId, dispatchId)), charge });
      expect([noDraftPatch.status, noDraftPatch.body.code]).toEqual([404, "CHARGE_NOT_FOUND"]);
      const noDraftDelete = await w.agent
        .delete(`${url}/financial-charges/1`)
        .send(await fingerprints(w, orderId, dispatchId));
      expect([noDraftDelete.status, noDraftDelete.body.code]).toEqual([404, "CHARGE_NOT_FOUND"]);

      const created = await addCharge(w, orderId, dispatchId, charge);
      const chargeId = Number(created.body.chargeId);

      const badId = await w.agent.patch(`${url}/financial-charges/0`).send({ charge });
      expect([badId.status, badId.body.code]).toEqual([400, "INVALID_ID"]);
      const unknown = await w.agent
        .patch(`${url}/financial-charges/${chargeId + 1}`)
        .send({ ...(await fingerprints(w, orderId, dispatchId)), charge });
      expect([unknown.status, unknown.body.code]).toEqual([404, "CHARGE_NOT_EDITABLE"]);
      const stale = await w.agent
        .patch(`${url}/financial-charges/${chargeId}`)
        .send({ ...(await fingerprints(w, orderId, dispatchId)), expectedChargeFingerprint: "x", charge });
      expect([stale.status, stale.body.code]).toEqual([409, "FINANCIAL_PREVIEW_CHANGED"]);

      const edited = await w.agent
        .patch(`${url}/financial-charges/${chargeId}`)
        .send({
          ...(await fingerprints(w, orderId, dispatchId)),
          charge: { ...charge, amount: "12.50", notes: "updated" },
        });
      expect(edited.status).toBe(200);
      expect(edited.body).toEqual({ updated: true });
      const [row] = await w.q(`SELECT amount::text AS amount, notes FROM factory_dispatch_trip_charges WHERE id = $1`, [
        chargeId,
      ]);
      expect(row).toEqual({ amount: "12.50", notes: "updated" });

      const unknownDelete = await w.agent
        .delete(`${url}/financial-charges/${chargeId + 1}`)
        .send(await fingerprints(w, orderId, dispatchId));
      expect([unknownDelete.status, unknownDelete.body.code]).toEqual([404, "CHARGE_NOT_EDITABLE"]);
      const removed = await w.agent
        .delete(`${url}/financial-charges/${chargeId}`)
        .send(await fingerprints(w, orderId, dispatchId));
      expect(removed.body).toEqual({ deleted: true });
      expect(await chargeCount(w)).toBe(0);
      const events = await w.q(
        `SELECT event_type FROM factory_dispatch_financial_events WHERE company_id = $1 ORDER BY id`,
        [w.companyId]
      );
      expect(events.map((event) => event.event_type)).toEqual([
        "TRIP_CHARGE_CREATED",
        "TRIP_CHARGE_UPDATED",
        "TRIP_CHARGE_REMOVED",
      ]);
    });
  });

  it("refuses a non-supervisor preview and a malformed preview id", async () => {
    await withFactoryWorld(async (w) => {
      const { url, orderId } = await closedWorld(w);
      const manager = await w.agentFor("Manager");
      expect((await manager.get(`${url}/financial-preview`)).body.code).toBe("FINANCIAL_ACCESS_REQUIRED");
      const bad = await w.agent.get(`${dispatchBase(orderId)}/x/financial-preview`);
      expect([bad.status, bad.body.code]).toEqual([400, "INVALID_ID"]);
    });
  });
});
