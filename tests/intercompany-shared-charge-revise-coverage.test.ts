/**
 * Revision of a confirmed HP-borne shared invoice (reviseSharedCharge) on the
 * intercompany trade fixture, inside one rolled-back transaction per test.
 * Refusals first (unknown invoice, a company outside the trading pair, a role
 * without a grant, participant changes, stale versions, received containers,
 * no change), each leaving the allocations and invoice version unchanged; then
 * the reallocation that moves cost between two linked containers.
 */
import { describe, expect, it } from "vitest";

import { withRolledBackPool } from "./helpers/routedPoolClient";
import { createIntercompanyTradeWorld, type IntercompanyTradeWorld } from "./helpers/intercompanyTradeFixture";
import {
  confirmSharedCharge,
  reviseSharedCharge,
  type ReviseSharedChargeInput,
} from "../server/services/intercompany/sharedChargeSync";
import { withGrantedInvoiceScope } from "../server/services/intercompany/sharedChargeSyncHelpers";
import { applyCostDeltasTx } from "../server/services/intercompany/tradeSyncApplyCostDeltasTx";
import { IntercompanyEditError } from "../server/services/intercompany/tradeSyncLoadTradeTx";
import { MoneyDecimal } from "../server/lib/money";
import { runWithCompanyRequestRuntimeContext } from "../server/services/security/companyRequestRuntimeContext";

const world = <T>(work: (w: IntercompanyTradeWorld) => Promise<T>) =>
  withRolledBackPool(async (client) => work(await createIntercompanyTradeWorld(client)));

let keySeq = 0;
const key = () => `charge-key-${process.pid}-${++keySeq}`;

const confirmInput = (w: IntercompanyTradeWorld, tradeIds: number[]) => ({
  sourceCompanyId: w.sourceCompanyId,
  invoiceKey: `INV-${w.tag}`,
  chargeType: "freight" as const,
  faceAmount: "40.00",
  evidenceReference: "Carrier invoice 77",
  postingDate: "2026-06-10",
  requestKey: key(),
  reason: "Shared ocean freight",
  allocations: tradeIds.map((tradeId) => ({ tradeId, expectedVersion: 1, amount: (40 / tradeIds.length).toFixed(2) })),
});

/** Two linked containers sharing one confirmed 40.00 freight invoice (20.00 each). */
async function confirmed(w: IntercompanyTradeWorld) {
  // Imports that recorded charge evidence (the database requires it once charges are confirmed).
  const a = await w.trade("A", "OTW", undefined, "PO workbook");
  const b = await w.trade("B", "OTW", undefined, "PO workbook");
  const result = await confirmSharedCharge(
    {
      sourceCompanyId: w.sourceCompanyId,
      invoiceKey: `INV-${w.tag}`,
      chargeType: "freight",
      faceAmount: "40.00",
      evidenceReference: "Carrier invoice 77",
      postingDate: "2026-06-10",
      requestKey: key(),
      reason: "Shared ocean freight",
      allocations: [
        { tradeId: a.tradeId, expectedVersion: 1, amount: "20.00" },
        { tradeId: b.tradeId, expectedVersion: 1, amount: "20.00" },
      ],
    },
    w.identity()
  );
  const [invoice] = await w.q<{ id: number; version: number }>(
    `SELECT id::int AS id, version FROM intercompany_shared_charge_invoices WHERE external_invoice_key = $1`,
    [`INV-${w.tag}`]
  );
  return { a, b, invoice, result };
}

async function tradeVersion(w: IntercompanyTradeWorld, tradeId: number) {
  return Number((await w.q(`SELECT version FROM intercompany_trades WHERE id = $1`, [tradeId]))[0].version);
}

async function state(w: IntercompanyTradeWorld, invoiceId: number) {
  const allocations = await w.q(
    `SELECT trade_id, amount::text FROM intercompany_shared_charge_allocations WHERE invoice_id = $1 ORDER BY trade_id`,
    [invoiceId]
  );
  const [invoice] = await w.q(`SELECT version FROM intercompany_shared_charge_invoices WHERE id = $1`, [invoiceId]);
  return { allocations, version: invoice.version };
}

async function revision(
  w: IntercompanyTradeWorld,
  c: Awaited<ReturnType<typeof confirmed>>,
  amounts: [string, string],
  overrides: Partial<ReviseSharedChargeInput> = {}
): Promise<ReviseSharedChargeInput> {
  return {
    invoiceId: c.invoice.id,
    expectedInvoiceVersion: c.invoice.version,
    postingDate: "2026-06-12",
    requestKey: key(),
    reason: "Carrier corrected the split",
    allocations: [
      { tradeId: c.a.tradeId, expectedVersion: await tradeVersion(w, c.a.tradeId), amount: amounts[0] },
      { tradeId: c.b.tradeId, expectedVersion: await tradeVersion(w, c.b.tradeId), amount: amounts[1] },
    ],
    ...overrides,
  };
}

async function refused(
  w: IntercompanyTradeWorld,
  invoiceId: number,
  run: () => Promise<unknown>,
  code: string,
  status?: number
) {
  const before = await state(w, invoiceId);
  await expect(run()).rejects.toMatchObject(status ? { code, status } : { code });
  expect(await state(w, invoiceId)).toEqual(before);
}

describe("reviseSharedCharge refusals", () => {
  it("refuses an unknown invoice and bad inputs before reading anything", () =>
    world(async (w) => {
      const c = await confirmed(w);
      const input = await revision(w, c, ["25.00", "15.00"]);
      await refused(
        w,
        c.invoice.id,
        () => reviseSharedCharge({ ...input, invoiceId: 999999999 }, w.identity()),
        "IC_CHARGE_NOT_FOUND",
        404
      );
      await refused(
        w,
        c.invoice.id,
        () => reviseSharedCharge({ ...input, reason: "x" }, w.identity()),
        "IC_CHARGE_REASON"
      );
    }));

  it("refuses a company outside the trading pair and a role without a grant", () =>
    world(async (w) => {
      const c = await confirmed(w);
      const input = await revision(w, c, ["25.00", "15.00"]);
      const outsider = await w.company("OUT", "erp");
      await refused(w, c.invoice.id, () => reviseSharedCharge(input, w.identity(outsider)), "IC_CHARGE_FORBIDDEN", 403);
      const manager = await w.otherUser([[w.destinationCompanyId, "Manager"]]);
      await refused(
        w,
        c.invoice.id,
        () => reviseSharedCharge(input, w.identity(w.destinationCompanyId, "Manager", manager)),
        "IC_CHARGE_FORBIDDEN"
      );
    }));

  it("refuses totals off the face amount and added or removed containers", () =>
    world(async (w) => {
      const c = await confirmed(w);
      await refused(
        w,
        c.invoice.id,
        async () => reviseSharedCharge(await revision(w, c, ["25.00", "16.00"]), w.identity()),
        "IC_CHARGE_TOTAL_MISMATCH"
      );
      const extra = await w.trade("C");
      const input = await revision(w, c, ["20.00", "20.00"]);
      const swapped = {
        ...input,
        allocations: [input.allocations[0], { ...input.allocations[1], tradeId: extra.tradeId }],
      };
      await refused(w, c.invoice.id, () => reviseSharedCharge(swapped, w.identity()), "IC_CHARGE_PARTICIPANTS", 409);
      const single = { ...input, allocations: [{ ...input.allocations[0], amount: "40.00" }] };
      await refused(w, c.invoice.id, () => reviseSharedCharge(single, w.identity()), "IC_CHARGE_PARTICIPANTS");
    }));

  it("refuses stale invoice or trade versions and an unchanged split", () =>
    world(async (w) => {
      const c = await confirmed(w);
      const input = await revision(w, c, ["25.00", "15.00"]);
      await refused(
        w,
        c.invoice.id,
        () => reviseSharedCharge({ ...input, expectedInvoiceVersion: c.invoice.version + 5 }, w.identity()),
        "IC_CHARGE_STALE"
      );
      const staleTrade = {
        ...input,
        allocations: [{ ...input.allocations[0], expectedVersion: 99 }, input.allocations[1]],
      };
      await refused(w, c.invoice.id, () => reviseSharedCharge(staleTrade, w.identity()), "IC_CHARGE_STALE");
      await refused(
        w,
        c.invoice.id,
        async () => reviseSharedCharge(await revision(w, c, ["20.00", "20.00"]), w.identity()),
        "IC_CHARGE_NO_CHANGE",
        422
      );
    }));

  it("refuses when the session company differs from the initiating company", () =>
    world(async (w) => {
      const c = await confirmed(w);
      const input = await revision(w, c, ["25.00", "15.00"]);
      await refused(
        w,
        c.invoice.id,
        () =>
          runWithCompanyRequestRuntimeContext(
            {
              userId: w.userId,
              companyId: w.destinationCompanyId,
              role: "Owner",
              method: "POST",
              path: "/x",
              developerBypass: false,
            },
            () => reviseSharedCharge(input, w.identity())
          ),
        "IC_CHARGE_SCOPE",
        403
      );
      const widened = await runWithCompanyRequestRuntimeContext(
        {
          userId: w.userId,
          companyId: w.sourceCompanyId,
          role: "Owner",
          method: "GET",
          path: "/x",
          developerBypass: false,
        },
        () => withGrantedInvoiceScope(w.identity(), [w.destinationCompanyId], async () => "ran")
      );
      expect(widened).toBe("ran");
    }));
});

describe("charge evidence on containers imported without confirmed charges", () => {
  it("confirms the invoice and records its evidence on the import row", () =>
    world(async (w) => {
      const a = await w.trade("A");
      const result = await confirmSharedCharge(confirmInput(w, [a.tradeId]), w.identity());
      expect(result.allocations).toHaveLength(1);
      const rows = await w.q(
        `SELECT charges_confirmed, charge_evidence_reference FROM intercompany_import_batch_containers WHERE trade_id = $1`,
        [a.tradeId]
      );
      expect(rows).toEqual([{ charges_confirmed: true, charge_evidence_reference: "Carrier invoice 77" }]);
    }));

  it("keeps the import's own charge evidence when it already has one", () =>
    world(async (w) => {
      const a = await w.trade("A", "OTW", undefined, "PO workbook");
      await confirmSharedCharge(confirmInput(w, [a.tradeId]), w.identity());
      const rows = await w.q(
        `SELECT charge_evidence_reference FROM intercompany_import_batch_containers WHERE trade_id = $1`,
        [a.tradeId]
      );
      expect(rows[0].charge_evidence_reference).toBe("PO workbook");
    }));

  it("refuses a charge change with no evidence at all before writing anything", async () => {
    const data = {
      trade: { id: -1 },
      policy: {},
      source: [],
      destination: {
        po: {
          itemsTotal: "100.00",
          freight: "0",
          surcharge: "0",
          fumigation: "0",
          documentCharges: "0",
          discount: "0",
          otherCharges: "0",
        },
      },
      imported: { chargeEvidenceReference: null },
    } as unknown as Parameters<typeof applyCostDeltasTx>[1];
    const tx = {} as Parameters<typeof applyCostDeltasTx>[0];
    const error = await applyCostDeltasTx(tx, data, {
      revisionId: 1,
      postingDate: "2026-06-10",
      reason: "x",
      actorUserId: "u",
      chargeEvidenceReference: "  ",
      poDeltas: [{ poId: 1, goods: new MoneyDecimal(0), charge: new MoneyDecimal(5), chargeField: "freight" }],
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(IntercompanyEditError);
    expect(error).toMatchObject({ code: "IC_CHARGE_EVIDENCE_REQUIRED", status: 422 });
  });
});

describe("reviseSharedCharge reallocation", () => {
  it("moves cost between the two containers, bumps versions and records the audit event", () =>
    world(async (w) => {
      const c = await confirmed(w);
      const before = { a: await tradeVersion(w, c.a.tradeId), b: await tradeVersion(w, c.b.tradeId) };
      const result = await reviseSharedCharge(await revision(w, c, ["30.00", "10.00"]), w.identity());
      expect(result).toMatchObject({ invoiceId: c.invoice.id, version: c.invoice.version + 1, faceAmount: "40.00" });
      expect(result.changed.map((x) => x.amount)).toEqual(["30.00", "10.00"]);
      const after = await state(w, c.invoice.id);
      expect(after.allocations.map((a) => a.amount)).toEqual(["30.00", "10.00"]);
      expect(await tradeVersion(w, c.a.tradeId)).toBe(before.a + 1);
      expect(await tradeVersion(w, c.b.tradeId)).toBe(before.b + 1);
      const charges = await w.q(
        `SELECT amount::text FROM container_charges WHERE container_id = $1 AND charge_type = 'Freight'`,
        [c.a.containerId]
      );
      expect(charges.map((x) => x.amount)).toContain("30.00");
      const events = await w.q(
        `SELECT payload FROM intercompany_audit_events WHERE event_type = 'shared-charge-allocation-revised' AND source_company_id = $1`,
        [w.sourceCompanyId]
      );
      expect(events).toHaveLength(1);
      expect(events[0].payload.originalInvoicePreserved).toBe(true);
    }));

  it("refuses a revision once a container is received", () =>
    world(async (w) => {
      const c = await confirmed(w);
      await w.q(`UPDATE containers SET status = 'Received' WHERE id = $1`, [c.a.containerId]);
      await refused(
        w,
        c.invoice.id,
        async () => reviseSharedCharge(await revision(w, c, ["30.00", "10.00"]), w.identity()),
        "IC_EDIT_INVENTORY_DEPENDENCY"
      );
    }));
});
