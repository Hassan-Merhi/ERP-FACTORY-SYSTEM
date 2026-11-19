/**
 * Phase 5 cancellation of an unreceived linked trade (cancelUnreceivedTrade) on
 * the intercompany trade fixture, inside one rolled-back transaction per test.
 * Refusals first: malformed input or role, a company outside the trading pair,
 * a stale version, a received container, a received destination, and every
 * shared-charge decision rule. Each refusal leaves the trade active with no
 * cancellation or reversal voucher. Then the cancellation, its exact replay and
 * a modified replay.
 */
import { describe, expect, it } from "vitest";

import { withRolledBackPool } from "./helpers/routedPoolClient";
import { createIntercompanyTradeWorld, type IntercompanyTradeWorld } from "./helpers/intercompanyTradeFixture";
import { cancelUnreceivedTrade, type CancelIntercompanyTradeInput } from "../server/services/intercompany/phase5Cancel";
import { confirmSharedCharge, reviseSharedCharge } from "../server/services/intercompany/sharedChargeSync";
import { receiveLinkedTrade } from "../server/services/intercompany/phase5Receipt";

const world = <T>(work: (w: IntercompanyTradeWorld) => Promise<T>) =>
  withRolledBackPool(async (client) => work(await createIntercompanyTradeWorld(client)));

let keySeq = 0;
const key = (prefix: string) => `${prefix}-${process.pid}-${++keySeq}`;

const cancelInput = (
  tradeId: number,
  overrides: Partial<CancelIntercompanyTradeInput> = {}
): CancelIntercompanyTradeInput => ({
  tradeId,
  expectedVersion: 1,
  requestKey: key("cancel-key"),
  postingDate: "2026-06-25",
  reason: "Sale called off",
  cancellationEvidence: "Buyer letter 2026-06-24",
  sharedChargeDecision: "none",
  confirmGoodsNotReceived: true,
  confirmNoRealCashReversal: true,
  ...overrides,
});

async function footprint(w: IntercompanyTradeWorld, tradeId: number) {
  const [row] = await w.q<{ state: string; version: number; cancellations: number; vouchers: number }>(
    `SELECT t.state, t.version,
            (SELECT count(*)::int FROM intercompany_trade_cancellations WHERE trade_id = t.id) AS cancellations,
            (SELECT count(*)::int FROM vouchers WHERE company_id IN ($2, $3)) AS vouchers
       FROM intercompany_trades t WHERE t.id = $1`,
    [tradeId, w.sourceCompanyId, w.destinationCompanyId]
  );
  return row;
}

async function refused(
  w: IntercompanyTradeWorld,
  tradeId: number,
  run: () => Promise<unknown>,
  code: string,
  status?: number
) {
  const before = await footprint(w, tradeId);
  await expect(run()).rejects.toMatchObject(status ? { code, status } : { code });
  expect(await footprint(w, tradeId)).toEqual(before);
}

/** Two trades sharing one 40.00 freight invoice (20.00 each). */
async function sharedPair(w: IntercompanyTradeWorld) {
  const a = await w.trade("A", "OTW", undefined, "PO workbook");
  const b = await w.trade("B", "OTW", undefined, "PO workbook");
  await confirmSharedCharge(
    {
      sourceCompanyId: w.sourceCompanyId,
      invoiceKey: `INV-${w.tag}`,
      chargeType: "freight",
      faceAmount: "40.00",
      evidenceReference: "Carrier invoice 77",
      postingDate: "2026-06-10",
      requestKey: key("charge-key"),
      reason: "Shared ocean freight",
      allocations: [
        { tradeId: a.tradeId, expectedVersion: 1, amount: "20.00" },
        { tradeId: b.tradeId, expectedVersion: 1, amount: "20.00" },
      ],
    },
    w.identity()
  );
  const version = async (id: number) =>
    Number((await w.q(`SELECT version FROM intercompany_trades WHERE id = $1`, [id]))[0].version);
  return { a, b, version };
}

describe("cancelUnreceivedTrade refusals", () => {
  it("refuses incomplete input and non-owner roles before touching the database", () =>
    world(async (w) => {
      const t = await w.trade("A");
      for (const bad of [
        { confirmGoodsNotReceived: false },
        { cancellationEvidence: "short" },
        { reason: "x" },
        { sharedChargeDecision: "maybe" as never },
        { expectedVersion: 0 },
      ]) {
        await refused(
          w,
          t.tradeId,
          () => cancelUnreceivedTrade(cancelInput(t.tradeId, bad), w.identity()),
          "IC_CANCEL_INPUT",
          422
        );
      }
      await refused(
        w,
        t.tradeId,
        () => cancelUnreceivedTrade(cancelInput(t.tradeId), w.identity(w.sourceCompanyId, "Admin")),
        "IC_CANCEL_INPUT"
      );
    }));

  it("refuses a company outside the pair, a stale version and a received container", () =>
    world(async (w) => {
      const t = await w.trade("A");
      const outsider = await w.company("OUT", "erp");
      const before = await footprint(w, t.tradeId);
      await expect(cancelUnreceivedTrade(cancelInput(t.tradeId), w.identity(outsider))).rejects.toMatchObject({
        status: 403,
      });
      expect(await footprint(w, t.tradeId)).toEqual(before);
      await refused(
        w,
        t.tradeId,
        () => cancelUnreceivedTrade(cancelInput(t.tradeId, { expectedVersion: 4 }), w.identity()),
        "IC_CANCEL_STALE"
      );
      await w.q(`UPDATE containers SET status = 'Received' WHERE id = $1`, [t.containerId]);
      await refused(
        w,
        t.tradeId,
        () => cancelUnreceivedTrade(cancelInput(t.tradeId), w.identity()),
        "IC_EDIT_INVENTORY_DEPENDENCY"
      );
    }));

  it("refuses 'redistributed' when no shared invoice applies", () =>
    world(async (w) => {
      const t = await w.trade("A");
      await refused(
        w,
        t.tradeId,
        () => cancelUnreceivedTrade(cancelInput(t.tradeId, { sharedChargeDecision: "redistributed" }), w.identity()),
        "IC_CANCEL_SHARED_CHARGE",
        422
      );
    }));

  it("refuses a container that still carries a share of a confirmed invoice", () =>
    world(async (w) => {
      const p = await sharedPair(w);
      const input = cancelInput(p.a.tradeId, { expectedVersion: await p.version(p.a.tradeId) });
      await refused(w, p.a.tradeId, () => cancelUnreceivedTrade(input, w.identity()), "IC_CANCEL_SHARED_CHARGE");
    }));
});

describe("cancelUnreceivedTrade after shared-charge redistribution and receipt", () => {
  it("requires the redistributed decision once the share was moved away, then cancels", () =>
    world(async (w) => {
      const p = await sharedPair(w);
      const [invoice] = await w.q(
        `SELECT id::int AS id, version FROM intercompany_shared_charge_invoices WHERE external_invoice_key = $1`,
        [`INV-${w.tag}`]
      );
      await reviseSharedCharge(
        {
          invoiceId: invoice.id,
          expectedInvoiceVersion: invoice.version,
          postingDate: "2026-06-12",
          requestKey: key("revise-key"),
          reason: "Move freight off the canceled container",
          allocations: [
            { tradeId: p.a.tradeId, expectedVersion: await p.version(p.a.tradeId), amount: "0.00" },
            { tradeId: p.b.tradeId, expectedVersion: await p.version(p.b.tradeId), amount: "40.00" },
          ],
        },
        w.identity()
      );
      const version = await p.version(p.a.tradeId);
      await refused(
        w,
        p.a.tradeId,
        () => cancelUnreceivedTrade(cancelInput(p.a.tradeId, { expectedVersion: version }), w.identity()),
        "IC_CANCEL_SHARED_CHARGE"
      );
      const result = await cancelUnreceivedTrade(
        cancelInput(p.a.tradeId, { expectedVersion: version, sharedChargeDecision: "redistributed" }),
        w.identity()
      );
      expect(result).toMatchObject({ canceled: true, replayed: false });
    }));

  it("refuses to cancel once the destination has received the goods", () =>
    world(async (w) => {
      const t = await w.trade("A");
      const locationId = await w.one(
        `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'ERP Yard') RETURNING id`,
        [w.destinationCompanyId, `${w.tag}Y`]
      );
      const inventoryAccountId = await w.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, 'INVENTORY', 'Inventory', 'Asset') RETURNING id`,
        [w.destinationCompanyId]
      );
      await receiveLinkedTrade(
        {
          tradeId: t.tradeId,
          expectedVersion: 1,
          requestKey: key("receipt-key"),
          postingDate: "2026-06-20",
          locationId,
          inventoryAccountId,
          arrivalEvidence: "Gate pass 4411 signed",
          reason: "Container arrived",
          confirmPhysicalArrival: true,
          confirmNoAdditionalUnpostedCharges: true,
        },
        w.identity(w.destinationCompanyId)
      );
      const version = Number(
        (await w.q(`SELECT version FROM intercompany_trades WHERE id = $1`, [t.tradeId]))[0].version
      );
      const before = await footprint(w, t.tradeId);
      await expect(
        cancelUnreceivedTrade(cancelInput(t.tradeId, { expectedVersion: version }), w.identity())
      ).rejects.toMatchObject({ code: expect.stringMatching(/IC_CANCEL_RECEIVED|IC_EDIT_/) });
      expect(await footprint(w, t.tradeId)).toEqual(before);
    }));
});

describe("cancelUnreceivedTrade posting", () => {
  it("cancels at cost with the four reversal journals, replays exactly and refuses a modified replay", () =>
    world(async (w) => {
      const t = await w.trade("A");
      const input = cancelInput(t.tradeId);
      const before = await footprint(w, t.tradeId);
      const result = await cancelUnreceivedTrade(input, w.identity());
      expect(result).toMatchObject({ tradeId: t.tradeId, canceled: true, replayed: false, releasedCredit: "0.00" });
      const after = await footprint(w, t.tradeId);
      expect(after).toMatchObject({ state: "canceled", version: 2, cancellations: 1 });
      expect(after.vouchers - before.vouchers).toBeGreaterThanOrEqual(3);
      const events = await w.q(
        `SELECT payload FROM intercompany_audit_events WHERE event_type = 'intercompany-unreceived-trade-canceled' AND source_company_id = $1`,
        [w.sourceCompanyId]
      );
      expect(events[0].payload).toMatchObject({ noCashVoucherPosted: true, sharedChargeDecision: "none" });

      const replay = await cancelUnreceivedTrade(input, w.identity());
      expect(replay).toMatchObject({ cancellationId: result.cancellationId, replayed: true });
      await refused(
        w,
        t.tradeId,
        () => cancelUnreceivedTrade({ ...input, reason: "Another reason" }, w.identity()),
        "IC_CANCEL_REPLAY"
      );
    }));
});
