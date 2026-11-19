/**
 * Financial posting and reversal of a closed truck trip, driven through the
 * real dispatch workflow (scan -> End Dispatch -> preview -> finalize) against
 * PostgreSQL in one rolled-back transaction per test.
 *
 * Pinned: the journal posted for a trip (receivable / clearing / charges), the
 * idempotent replay, and every refusal before any voucher is written.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import {
  addCharge,
  closeBooks,
  closedTrip,
  dispatchBase,
  financialPreview,
  finalizeTrip,
  ledger,
  loadingWithBales,
  postedTrip,
} from "./helpers/dispatchFlowFixture";

const tripVouchers = (w: FactoryWorld) =>
  w.q(
    `SELECT v.id, v.voucher_number, SUM(e.debit_amount)::text AS debit, SUM(e.credit_amount)::text AS credit
       FROM vouchers v JOIN voucher_entries e ON e.voucher_id = v.id
      WHERE v.company_id = $1 AND v.voucher_number LIKE 'FDT%' GROUP BY v.id ORDER BY v.id`,
    [w.companyId]
  );

const reverse = (w: FactoryWorld, orderId: number, dispatchId: number, reason: unknown) =>
  w.agent.post(`${dispatchBase(orderId)}/${dispatchId}/financial-reverse`).send({ confirm: true, reason });

describe("trip financial finalization", () => {
  it("posts a balanced receivable/clearing journal with billable, discount and internal charges", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["100.00", "50.00"]);
      const dispatchId = await closedTrip(
        w,
        orderId,
        bales.map((b) => b.reference)
      );
      const income = await ledger(w, "FRT", "Income");
      const contra = await ledger(w, "DSC", "Expense");
      const expense = await ledger(w, "HAUL", "Expense");
      const payable = await ledger(w, "PAY", "Liability");
      for (const charge of [
        { name: "Freight", kind: "BILLABLE", amount: "20.00", ledgerAccountId: income },
        { name: "Volume discount", kind: "DISCOUNT", amount: "5.00", ledgerAccountId: contra },
        {
          name: "Haulage",
          kind: "INTERNAL",
          amount: "12.50",
          ledgerAccountId: expense,
          offsetLedgerAccountId: payable,
        },
      ]) {
        const added = await addCharge(w, orderId, dispatchId, charge);
        expect(added.status).toBe(201);
      }
      const preview = await financialPreview(w, orderId, dispatchId);
      const res = await finalizeTrip(w, orderId, dispatchId, {
        confirm: true,
        sourceFingerprint: preview.source!.sourceFingerprint,
        chargeFingerprint: preview.chargeFingerprint,
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: "POSTED",
        revision: 1,
        goodsSubtotal: "150.00",
        billableChargesTotal: "20.00",
        discountTotal: "5.00",
        customerTotal: "165.00",
        internalExpenseTotal: "12.50",
        replayed: false,
      });
      expect(res.body.voucherIds).toHaveLength(2);
      const vouchers = await tripVouchers(w);
      expect(vouchers.map((v) => [v.debit, v.credit])).toEqual([
        ["170.00", "170.00"],
        ["12.50", "12.50"],
      ]);
      const locked = await w.q(
        `SELECT kind, locked_at IS NOT NULL AS locked, posted_voucher_id FROM factory_dispatch_trip_charges WHERE dispatch_id = $1 ORDER BY id`,
        [dispatchId]
      );
      expect(locked.every((c) => c.locked)).toBe(true);
      expect(locked[0].posted_voucher_id).toBe(res.body.voucherIds[0]);
      const frozen = await w.q(
        `SELECT COUNT(*)::int AS n FROM factory_dispatch_trip_financial_bales WHERE dispatch_id = $1`,
        [dispatchId]
      );
      expect(frozen[0].n).toBe(2);

      // Same signed source: an idempotent replay, no new voucher.
      const replay = await finalizeTrip(w, orderId, dispatchId, {
        confirm: true,
        sourceFingerprint: preview.source!.sourceFingerprint,
        chargeFingerprint: preview.chargeFingerprint,
      });
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({ replayed: true, customerTotal: "165.00", internalExpenseTotal: "12.50" });
      expect(await tripVouchers(w)).toHaveLength(2);

      // A different fingerprint on a posted trip is refused.
      const other = await finalizeTrip(w, orderId, dispatchId, {
        confirm: true,
        sourceFingerprint: "b".repeat(64),
        chargeFingerprint: preview.chargeFingerprint,
      });
      expect(other.status).toBe(409);
      expect(other.body.code).toBe("TRIP_ALREADY_POSTED_DIFFERENT_SOURCE");

      const history = await w.agent.get(`${dispatchBase(orderId)}/${dispatchId}/financial-history`);
      expect(history.body.financial.status).toBe("POSTED");
      expect(history.body.postings).toHaveLength(1);
    });
  });

  it("refuses stale source or charge fingerprints and leaves no journal", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["10.00"]);
      const dispatchId = await closedTrip(w, orderId, [bales[0].reference]);
      const preview = await financialPreview(w, orderId, dispatchId);
      const source = await finalizeTrip(w, orderId, dispatchId, {
        confirm: true,
        sourceFingerprint: "c".repeat(64),
        chargeFingerprint: preview.chargeFingerprint,
      });
      expect(source.status).toBe(409);
      expect(source.body.code).toBe("TRIP_SOURCE_CHANGED");
      const charges = await finalizeTrip(w, orderId, dispatchId, {
        confirm: true,
        sourceFingerprint: preview.source!.sourceFingerprint,
        chargeFingerprint: "d".repeat(64),
      });
      expect(charges.body.code).toBe("TRIP_CHARGES_CHANGED");
      expect(await tripVouchers(w)).toHaveLength(0);
      const fin = await w.q(`SELECT id FROM factory_dispatch_trip_financials WHERE dispatch_id = $1`, [dispatchId]);
      expect(fin).toHaveLength(0);
    });
  });

  it("refuses an order that already owns an invoice number, a non-USD draft and a consolidated trip", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["10.00", "20.00", "30.00"]);
      const first = await closedTrip(w, orderId, [bales[0].reference]);
      const preview = await financialPreview(w, orderId, first);
      const body = {
        confirm: true,
        sourceFingerprint: preview.source!.sourceFingerprint,
        chargeFingerprint: preview.chargeFingerprint,
      };
      await w.q(`UPDATE customer_orders SET invoice_number = $1 WHERE id = $2`, [`INV-${w.tag}`, orderId]);
      const invoiced = await finalizeTrip(w, orderId, first, body);
      expect(invoiced.status).toBe(409);
      expect(invoiced.body.code).toBe("TRIP_ORDER_ALREADY_INVOICED");
      await w.q(`UPDATE customer_orders SET invoice_number = NULL WHERE id = $1`, [orderId]);

      await w.q(
        `INSERT INTO factory_dispatch_trip_financials (company_id, order_id, dispatch_id, status, currency) VALUES ($1, $2, $3, 'DRAFT', 'EUR')`,
        [w.companyId, orderId, first]
      );
      const currency = await finalizeTrip(w, orderId, first, body);
      expect(currency.body.code).toBe("TRIP_CURRENCY_UNSUPPORTED");

      expect(await tripVouchers(w)).toHaveLength(0);

      const { dispatchId: second } = await postedTrip(w, orderId, [bales[1].reference]);
      await w.q(`UPDATE factory_dispatch_trip_financials SET status = 'CONSOLIDATED' WHERE dispatch_id = $1`, [second]);
      const consolidated = await finalizeTrip(w, orderId, second, body);
      expect(consolidated.body.code).toBe("TRIP_ALREADY_CONSOLIDATED");
    });
  });

  it("refuses an open trip, bad confirmation, non-supervisors and an invalid clearing account", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["10.00", "20.00"]);
      const open = Number((await w.agent.post(dispatchBase(orderId)).send({})).body.id);
      const fp = { confirm: true, sourceFingerprint: "a".repeat(64), chargeFingerprint: "a".repeat(64) };
      const notClosed = await finalizeTrip(w, orderId, open, fp);
      expect(notClosed.status).toBe(409);
      expect(notClosed.body.code).toBe("TRIP_NOT_CLOSED");
      expect((await finalizeTrip(w, orderId, open, { confirm: false })).body.code).toBe(
        "TRIP_POSTING_CONFIRM_REQUIRED"
      );
      const array = await w.agent.post(`${dispatchBase(orderId)}/${open}/financial-finalize`).send([1]);
      expect(array.body.code).toBe("INVALID_BODY");
      const badId = await w.agent.post(`${dispatchBase(orderId)}/x/financial-finalize`).send(fp);
      expect(badId.status).toBe(400);
      const manager = await w.agentFor("Manager");
      const role = await manager.post(`${dispatchBase(orderId)}/${open}/financial-finalize`).send(fp);
      expect(role.status).toBe(403);
      expect(role.body.code).toBe("TRIP_ACCOUNTING_ROLE_REQUIRED");

      const closed = await closedTrip(
        w,
        orderId,
        bales.map((b) => b.reference)
      );
      const preview = await financialPreview(w, orderId, closed);
      await w.q(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, active)
         VALUES ($1, 'FACTORY_DISPATCH_CLEARING', 'Dispatch Clearing', 'Expense', '0', TRUE)`,
        [w.companyId]
      );
      const clearing = await finalizeTrip(w, orderId, closed, {
        confirm: true,
        sourceFingerprint: preview.source!.sourceFingerprint,
        chargeFingerprint: preview.chargeFingerprint,
      });
      expect(clearing.status).toBe(409);
      expect(clearing.body.code).toBe("TRIP_CLEARING_ACCOUNT_INVALID");
      expect(await tripVouchers(w)).toHaveLength(0);
    });
  });

  it("refuses posting into a closed fiscal period", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["10.00"]);
      const dispatchId = await closedTrip(w, orderId, [bales[0].reference]);
      const preview = await financialPreview(w, orderId, dispatchId);
      await closeBooks(w, "2100-12-31");
      const res = await finalizeTrip(w, orderId, dispatchId, {
        confirm: true,
        sourceFingerprint: preview.source!.sourceFingerprint,
        chargeFingerprint: preview.chargeFingerprint,
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("ACCOUNTING_PERIOD_CLOSED");
      const fin = await w.q(`SELECT id FROM factory_dispatch_trip_financials WHERE dispatch_id = $1`, [dispatchId]);
      expect(fin).toHaveLength(0);
      expect(await tripVouchers(w)).toHaveLength(0);
    });
  });
});

describe("trip financial reversal", () => {
  it("mirrors every posted voucher once, records the reversal and allows a later re-post", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["40.00"]);
      const { dispatchId, posting, preview } = await postedTrip(w, orderId, [bales[0].reference]);
      const res = await reverse(w, orderId, dispatchId, "  Customer refused this truck at the gate  ");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("REVERSED");
      expect(res.body.reversedVoucherIds).toHaveLength(posting.voucherIds.length);
      const [mirror] = await w.q(
        `SELECT e.debit_amount::text AS debit, e.credit_amount::text AS credit FROM voucher_entries e
          WHERE e.voucher_id = $1 ORDER BY e.id`,
        [res.body.reversedVoucherIds[0]]
      );
      expect([mirror.debit, mirror.credit]).toEqual(["0.00", "40.00"]);
      const [fin] = await w.q(`SELECT status FROM factory_dispatch_trip_financials WHERE dispatch_id = $1`, [
        dispatchId,
      ]);
      expect(fin.status).toBe("REVERSED");

      const again = await reverse(w, orderId, dispatchId, "second reversal attempt");
      expect(again.status).toBe(409);
      expect(again.body.code).toBe("TRIP_NOT_POSTED");

      const repost = await finalizeTrip(w, orderId, dispatchId, {
        confirm: true,
        sourceFingerprint: preview.source!.sourceFingerprint,
        chargeFingerprint: preview.chargeFingerprint,
      });
      expect(repost.status).toBe(200);
      expect(repost.body.revision).toBe(2);
    });
  });

  it("refuses short reasons, exported trips, settled orders and later customer credits", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, customerId, bales } = await loadingWithBales(w, ["40.00"]);
      const { dispatchId } = await postedTrip(w, orderId, [bales[0].reference]);
      expect((await reverse(w, orderId, dispatchId, "short")).body.code).toBe("TRIP_REVERSAL_CONFIRM_REQUIRED");

      const [fin] = await w.q(`SELECT id FROM factory_dispatch_trip_financials WHERE dispatch_id = $1`, [dispatchId]);
      await w.q(`SAVEPOINT exported`);
      await w.q(
        `INSERT INTO factory_dispatch_trip_exports (financial_id, company_id, order_id, dispatch_id, snapshot_revision,
           export_fingerprint, source_fingerprint, exported_by_user_id, erp_container_number, po_number, supplier_code)
         VALUES ($1, $2, $3, $4, 1, $5, $5, $6, $7, 'PO-1', 'SUP')`,
        [fin.id, w.companyId, orderId, dispatchId, "e".repeat(64), w.userId, `${w.tag}CNT`]
      );
      const exported = await reverse(w, orderId, dispatchId, "Exported trip reversal");
      expect(exported.body.code).toBe("TRIP_EXPORTED_LOCKED");
      await w.q(`ROLLBACK TO SAVEPOINT exported`);

      await w.q(`SAVEPOINT settled`);
      await w.q(
        `INSERT INTO customer_balances (company_id, customer_id, transaction_type, reference_type, reference_id, amount, balance, transaction_date)
         VALUES ($1, $2, 'PAYMENT', 'INVOICE', $3, 10, 0, '2026-06-02')`,
        [w.companyId, customerId, orderId]
      );
      const settled = await reverse(w, orderId, dispatchId, "Settled trip reversal");
      expect(settled.body.code).toBe("TRIP_SETTLEMENT_LOCKED");
      await w.q(`ROLLBACK TO SAVEPOINT settled`);

      const [ledgerRow] = await w.q(`SELECT ledger_account_id FROM voucher_entries WHERE customer_id = $1 LIMIT 1`, [
        customerId,
      ]);
      const cash = await ledger(w, "CASH", "Cash");
      const receipt = await w.one(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
         VALUES ($1, $2, 'Receipt', '2100-01-01', 5) RETURNING id`,
        [w.companyId, `${w.tag}RCPT`]
      );
      await w.q(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, customer_id, debit_amount, credit_amount)
         VALUES ($1, $2, $3, 0, 5), ($1, $4, NULL, 5, 0)`,
        [receipt, ledgerRow.ledger_account_id, customerId, cash]
      );
      const credited = await reverse(w, orderId, dispatchId, "Credited trip reversal");
      expect(credited.body.code).toBe("TRIP_CUSTOMER_CREDIT_RECONCILIATION_REQUIRED");
      const [still] = await w.q(`SELECT status FROM factory_dispatch_trip_financials WHERE dispatch_id = $1`, [
        dispatchId,
      ]);
      expect(still.status).toBe("POSTED");
    });
  });
});
