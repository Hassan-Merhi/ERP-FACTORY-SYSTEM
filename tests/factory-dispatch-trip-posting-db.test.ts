/**
 * Posting a closed Factory truck to the books, against the real database
 * (server/services/factory/dispatchTripFinancialPosting.ts).
 *
 * Every case builds its own company, customer, loading, signed closure and
 * charges inside one transaction and rolls it back at the end, so the
 * immutable posting rows the guards protect never outlive the test.
 *
 * What is pinned:
 *   - the receivable journal: Dr customer / Cr dispatch clearing for goods,
 *     Cr income for billable charges, Dr contra for discounts;
 *   - one separate voucher per internal expense, Dr expense / Cr payable;
 *   - a replay with the same signed source returns the same vouchers;
 *   - refusals for a changed source, changed charges, an open truck, an
 *     invoiced order and a bad date, before anything is written;
 *   - reversal posts mirror vouchers, never deletes, and frees the trip for
 *     a second revision.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db, type DbTransaction } from "../server/db";
import { resultRows } from "../server/lib/queryResult";
import { tripChargeFingerprint } from "../server/routes/factory/customer-orders/loadingDispatchFinancialChargeModel";
import { readCharges } from "../server/services/factory/assertHardenedFinancialSchemaTx";
import {
  postDispatchTripFinancialTx,
  reverseDispatchTripFinancialTx,
  TripFinancialPostingError,
  type DispatchPostingScope,
} from "../server/services/factory/dispatchTripFinancialPosting";
import { loadDispatchTripFinancialSource } from "../server/services/factory/dispatchTripFinancialSource";

class RolledBack extends Error {}

/** Runs `work` in a transaction that is always rolled back. */
async function inRolledBackTransaction(work: (tx: DbTransaction) => Promise<void>) {
  try {
    await db.transaction(async (tx) => {
      await work(tx as DbTransaction);
      throw new RolledBack();
    });
  } catch (error) {
    if (!(error instanceof RolledBack)) throw error;
    return;
  }
  throw new Error("the fixture transaction was not rolled back");
}

const all = async (tx: DbTransaction, query: ReturnType<typeof sql>) => resultRows(await tx.execute(query));
const one = async (tx: DbTransaction, query: ReturnType<typeof sql>) => (await all(tx, query))[0];
const id = async (tx: DbTransaction, query: ReturnType<typeof sql>) => Number((await one(tx, query)).id);

type Bale = { code: string; weight: string; price: string };

/** A closed truck with signed scans for `bales`, ready to post. */
async function closedTrip(tx: DbTransaction, bales: Bale[], options: { closed?: boolean } = {}) {
  const suffix = `${process.pid}${Math.floor(Math.random() * 1e9)}`;
  const companyId = await id(
    tx,
    sql`INSERT INTO companies (code, name, company_type)
        VALUES (${"FDT" + suffix}, ${"Dispatch posting " + suffix}, 'factory') RETURNING id`
  );
  const customerId = await id(
    tx,
    sql`INSERT INTO customers (company_id, code, legal_name)
        VALUES (${companyId}, ${"C" + suffix}, 'Truck Customer') RETURNING id`
  );
  const locationId = await id(
    tx,
    sql`INSERT INTO locations (company_id, code, name) VALUES (${companyId}, ${"L" + suffix}, 'Yard') RETURNING id`
  );
  const orderId = await id(
    tx,
    sql`INSERT INTO customer_orders (company_id, customer_id, order_date, status, location_id)
        VALUES (${companyId}, ${customerId}, '2026-11-01', 'LOADING', ${locationId}) RETURNING id`
  );
  const dispatchId = await id(
    tx,
    sql`INSERT INTO factory_loading_dispatches
          (company_id, order_id, dispatch_number, status, created_by_user_id, created_by_username)
        VALUES (${companyId}, ${orderId}, 1, 'OPEN', 'u1', 'tester') RETURNING id`
  );

  const manifest: Record<string, unknown>[] = [];
  for (const [index, bale] of bales.entries()) {
    const reference = `${bale.code}-${suffix}-${index}`;
    const baleId = await id(
      tx,
      sql`INSERT INTO factory_bales (company_id, bale_code, reference_number, weight_kg, status, article_code)
          VALUES (${companyId}, ${reference}, ${reference}, ${bale.weight}, 'IN_STOCK', ${bale.code}) RETURNING id`
    );
    await tx.execute(
      sql`INSERT INTO customer_order_bales
            (order_id, bale_id, bale_reference, location_id, weight, price_used, article_code, bale_name)
          VALUES (${orderId}, ${baleId}, ${reference}, ${locationId}, ${bale.weight}, ${bale.price},
                  ${bale.code}, ${"Product " + bale.code})`
    );
    const scanId = await id(
      tx,
      sql`INSERT INTO factory_loading_dispatch_scans
            (company_id, order_id, dispatch_id, bale_id, bale_reference, article_code, product_name,
             weight_kg, scanned_by_user_id, scanned_by_username)
          VALUES (${companyId}, ${orderId}, ${dispatchId}, ${baleId}, ${reference}, ${bale.code},
                  ${"Product " + bale.code}, ${bale.weight}, 'u1', 'tester') RETURNING id`
    );
    manifest.push({
      scanId: String(scanId),
      baleId,
      baleReference: reference,
      articleCode: bale.code,
      weightKg: bale.weight,
    });
  }

  if (options.closed !== false) {
    await tx.execute(
      sql`UPDATE factory_loading_dispatches SET status = 'CLOSED', closed_at = NOW(), closed_by_user_id = 'u1'
          WHERE id = ${dispatchId}`
    );
    await tx.execute(
      sql`INSERT INTO factory_loading_dispatch_closure_history
            (company_id, order_id, dispatch_id, revision, close_fingerprint, closed_by_user_id, closed_by_username,
             comparison_snapshot, summary_snapshot, manifest_snapshot)
          VALUES (${companyId}, ${orderId}, ${dispatchId}, 1,
                  ${createHash("sha256").update(JSON.stringify(manifest)).digest("hex")}, 'u1', 'tester',
                  '{}'::jsonb, '{}'::jsonb, ${JSON.stringify(manifest)}::jsonb)`
    );
  }

  const scope: DispatchPostingScope = { companyId, orderId, dispatchId, userId: "u1", username: "tester" };
  return { companyId, customerId, orderId, dispatchId, scope };
}

async function account(tx: DbTransaction, companyId: number, code: string, type: string) {
  return id(
    tx,
    sql`INSERT INTO ledger_accounts (company_id, code, name, account_type, active)
        VALUES (${companyId}, ${code}, ${code}, ${type}, true) RETURNING id`
  );
}

type ChargeDraft = {
  name: string;
  kind: "BILLABLE" | "DISCOUNT" | "INTERNAL";
  amount: string;
  ledger: number;
  offset?: number;
};

/** Saves draft charges on a fresh DRAFT financial row for revision 1. */
async function draftCharges(tx: DbTransaction, scope: DispatchPostingScope, charges: ChargeDraft[]) {
  const financialId = await id(
    tx,
    sql`INSERT INTO factory_dispatch_trip_financials (company_id, order_id, dispatch_id, status, currency)
        VALUES (${scope.companyId}, ${scope.orderId}, ${scope.dispatchId}, 'DRAFT', 'USD') RETURNING id`
  );
  for (const charge of charges) {
    await tx.execute(
      sql`INSERT INTO factory_dispatch_trip_charges
            (financial_id, company_id, order_id, dispatch_id, name, kind, amount, ledger_account_id,
             offset_ledger_account_id, revision)
          VALUES (${financialId}, ${scope.companyId}, ${scope.orderId}, ${scope.dispatchId}, ${charge.name},
                  ${charge.kind}, ${charge.amount}, ${charge.ledger}, ${charge.offset ?? null}, 1)`
    );
  }
  return financialId;
}

/** The request the preview screen would sign: current source and charge fingerprints. */
async function signedRequest(tx: DbTransaction, scope: DispatchPostingScope, financialId: number | null, revision = 1) {
  const source = await loadDispatchTripFinancialSource(tx, scope.companyId, scope.orderId, scope.dispatchId);
  const charges = financialId === null ? [] : await readCharges(tx, financialId, revision, scope);
  return {
    sourceFingerprint: source.sourceFingerprint,
    chargeFingerprint: tripChargeFingerprint(charges),
    postingDate: "2026-11-05",
  };
}

async function voucherLines(tx: DbTransaction, voucherId: number) {
  return all(
    tx,
    sql`SELECT ve.ledger_account_id AS "ledgerAccountId", ve.customer_id AS "customerId",
               ve.debit_amount::text AS debit, ve.credit_amount::text AS credit
          FROM voucher_entries ve WHERE ve.voucher_id = ${voucherId} ORDER BY ve.id`
  );
}

async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof TripFinancialPostingError) return error.code;
    throw error;
  }
  throw new Error("expected a refusal");
}

const BALES: Bale[] = [
  { code: "ART-A", weight: "45.500", price: "100.00" },
  { code: "ART-B", weight: "50.000", price: "50.40" },
];

describe("postDispatchTripFinancialTx", () => {
  it("posts goods to the dispatch clearing account and the receivable to the customer", async () => {
    await inRolledBackTransaction(async (tx) => {
      const trip = await closedTrip(tx, BALES);
      const result = await postDispatchTripFinancialTx(tx, trip.scope, await signedRequest(tx, trip.scope, null));

      expect(result).toMatchObject({
        status: "POSTED",
        revision: 1,
        goodsSubtotal: "150.40",
        customerTotal: "150.40",
        replayed: false,
      });
      expect(result.voucherIds).toHaveLength(1);

      const clearing = await one(
        tx,
        sql`SELECT id, account_type AS type FROM ledger_accounts
            WHERE company_id = ${trip.companyId} AND code = 'FACTORY_DISPATCH_CLEARING'`
      );
      const customer = await one(tx, sql`SELECT ledger_account_id AS id FROM customers WHERE id = ${trip.customerId}`);
      expect(await voucherLines(tx, result.voucherIds[0])).toEqual([
        { ledgerAccountId: Number(customer.id), customerId: trip.customerId, debit: "150.40", credit: "0.00" },
        { ledgerAccountId: Number(clearing.id), customerId: null, debit: "0.00", credit: "150.40" },
      ]);

      const voucher = await one(
        tx,
        sql`SELECT voucher_number AS number FROM vouchers WHERE id = ${result.voucherIds[0]}`
      );
      expect(voucher.number).toBe(`FDTR-${trip.companyId}-${trip.dispatchId}-1`);

      const financial = await one(
        tx,
        sql`SELECT status, posting_revision AS revision, customer_total::text AS total
            FROM factory_dispatch_trip_financials WHERE id = ${result.financialId}`
      );
      expect(financial).toEqual({ status: "POSTED", revision: 1, total: "150.40" });

      const frozen = await all(
        tx,
        sql`SELECT article_code AS code, line_total::text AS total FROM factory_dispatch_trip_financial_bales
            WHERE financial_id = ${result.financialId} ORDER BY bale_id`
      );
      expect(frozen).toEqual([
        { code: "ART-A", total: "100.00" },
        { code: "ART-B", total: "50.40" },
      ]);

      const events = await all(
        tx,
        sql`SELECT event_type AS type FROM factory_dispatch_financial_events WHERE financial_id = ${result.financialId}`
      );
      expect(events.map((event) => event.type)).toContain("TRIP_FINANCIALLY_POSTED");
    });
  });

  it("adds billable charges to the receivable, takes discounts off it, and posts internal expenses separately", async () => {
    await inRolledBackTransaction(async (tx) => {
      const trip = await closedTrip(tx, BALES);
      const income = await account(tx, trip.companyId, "FREIGHT-INCOME", "Income");
      const contra = await account(tx, trip.companyId, "DISCOUNTS", "Expense");
      const expense = await account(tx, trip.companyId, "TRUCK-HIRE", "Expense");
      const payable = await account(tx, trip.companyId, "TRUCK-PAYABLE", "Liability");
      const financialId = await draftCharges(tx, trip.scope, [
        { name: "Freight", kind: "BILLABLE", amount: "7.25", ledger: income },
        { name: "Loyalty", kind: "DISCOUNT", amount: "2.10", ledger: contra },
        { name: "Truck hire", kind: "INTERNAL", amount: "19.30", ledger: expense, offset: payable },
      ]);

      const result = await postDispatchTripFinancialTx(
        tx,
        trip.scope,
        await signedRequest(tx, trip.scope, financialId)
      );
      expect(result).toMatchObject({
        financialId,
        goodsSubtotal: "150.40",
        billableChargesTotal: "7.25",
        discountTotal: "2.10",
        internalExpenseTotal: "19.30",
        customerTotal: "155.55",
      });
      expect(result.voucherIds).toHaveLength(2);

      const receivable = await voucherLines(tx, result.voucherIds[0]);
      const debit = receivable.reduce((sum, line) => sum + Number(line.debit), 0);
      const credit = receivable.reduce((sum, line) => sum + Number(line.credit), 0);
      expect(debit.toFixed(2)).toBe("157.65");
      expect(credit.toFixed(2)).toBe("157.65");
      expect(receivable).toContainEqual(expect.objectContaining({ ledgerAccountId: income, credit: "7.25" }));
      expect(receivable).toContainEqual(expect.objectContaining({ ledgerAccountId: contra, debit: "2.10" }));

      expect(await voucherLines(tx, result.voucherIds[1])).toEqual([
        { ledgerAccountId: expense, customerId: null, debit: "19.30", credit: "0.00" },
        { ledgerAccountId: payable, customerId: null, debit: "0.00", credit: "19.30" },
      ]);

      const charges = await all(
        tx,
        sql`SELECT kind, posted_voucher_id AS voucher, locked_at IS NOT NULL AS locked
            FROM factory_dispatch_trip_charges WHERE financial_id = ${financialId} ORDER BY id`
      );
      expect(charges).toEqual([
        { kind: "BILLABLE", voucher: result.voucherIds[0], locked: true },
        { kind: "DISCOUNT", voucher: result.voucherIds[0], locked: true },
        { kind: "INTERNAL", voucher: result.voucherIds[1], locked: true },
      ]);
    });
  });

  it("returns the original vouchers when the same signed source is posted again", async () => {
    await inRolledBackTransaction(async (tx) => {
      const trip = await closedTrip(tx, BALES);
      const request = await signedRequest(tx, trip.scope, null);
      const first = await postDispatchTripFinancialTx(tx, trip.scope, request);
      const again = await postDispatchTripFinancialTx(tx, trip.scope, request);

      expect(again).toMatchObject({ financialId: first.financialId, voucherIds: first.voucherIds, replayed: true });
      const count = await one(
        tx,
        sql`SELECT COUNT(*)::int AS n FROM vouchers WHERE company_id = ${trip.companyId} AND deleted_at IS NULL`
      );
      expect(count.n).toBe(1);

      expect(
        await refusal(postDispatchTripFinancialTx(tx, trip.scope, { ...request, sourceFingerprint: "0".repeat(64) }))
      ).toBe("TRIP_ALREADY_POSTED_DIFFERENT_SOURCE");
    });
  });

  it("refuses when the signed barcodes or the charge drafts changed since the preview", async () => {
    await inRolledBackTransaction(async (tx) => {
      const trip = await closedTrip(tx, BALES);
      const request = await signedRequest(tx, trip.scope, null);
      expect(
        await refusal(postDispatchTripFinancialTx(tx, trip.scope, { ...request, sourceFingerprint: "f".repeat(64) }))
      ).toBe("TRIP_SOURCE_CHANGED");
      expect(
        await refusal(postDispatchTripFinancialTx(tx, trip.scope, { ...request, chargeFingerprint: "stale" }))
      ).toBe("TRIP_CHARGES_CHANGED");

      const vouchers = await one(tx, sql`SELECT COUNT(*)::int AS n FROM vouchers WHERE company_id = ${trip.companyId}`);
      expect(vouchers.n).toBe(0);
    });
  });

  it("refuses an internal expense whose offset is not a payable", async () => {
    await inRolledBackTransaction(async (tx) => {
      const trip = await closedTrip(tx, BALES);
      const expense = await account(tx, trip.companyId, "TRUCK-HIRE", "Expense");
      const bank = await account(tx, trip.companyId, "BANK", "Asset");
      const financialId = await draftCharges(tx, trip.scope, [
        { name: "Truck hire", kind: "INTERNAL", amount: "19.30", ledger: expense, offset: bank },
      ]);
      expect(
        await refusal(postDispatchTripFinancialTx(tx, trip.scope, await signedRequest(tx, trip.scope, financialId)))
      ).toBe("TRIP_CHARGE_OFFSET_INVALID");
    });
  });

  it("refuses an open truck, an invoiced loading and an invalid date", async () => {
    await inRolledBackTransaction(async (tx) => {
      const open = await closedTrip(tx, BALES, { closed: false });
      expect(
        await refusal(
          postDispatchTripFinancialTx(tx, open.scope, {
            sourceFingerprint: "x",
            chargeFingerprint: "y",
            postingDate: "2026-11-05",
          })
        )
      ).toBe("TRIP_NOT_CLOSED");

      const trip = await closedTrip(tx, BALES);
      const request = await signedRequest(tx, trip.scope, null);
      expect(
        await refusal(postDispatchTripFinancialTx(tx, trip.scope, { ...request, postingDate: "05/11/2026" }))
      ).toBe("TRIP_POSTING_DATE_INVALID");

      await tx.execute(sql`UPDATE customer_orders SET invoice_number = 'INV-1' WHERE id = ${trip.orderId}`);
      expect(await refusal(postDispatchTripFinancialTx(tx, trip.scope, request))).toBe("TRIP_ORDER_ALREADY_INVOICED");
    });
  });
});

describe("reverseDispatchTripFinancialTx", () => {
  it("mirrors every posted voucher, keeps the originals, and lets the trip post again as revision 2", async () => {
    await inRolledBackTransaction(async (tx) => {
      const trip = await closedTrip(tx, BALES);
      const posted = await postDispatchTripFinancialTx(tx, trip.scope, await signedRequest(tx, trip.scope, null));

      expect(
        await refusal(reverseDispatchTripFinancialTx(tx, trip.scope, { date: "2026-11-06", reason: "short" }))
      ).toBe("TRIP_REVERSAL_REASON_REQUIRED");

      const reversed = await reverseDispatchTripFinancialTx(tx, trip.scope, {
        date: "2026-11-06",
        reason: "Wrong customer selected on this truck",
      });
      expect(reversed).toMatchObject({ status: "REVERSED", revision: 1 });
      expect(reversed.reversedVoucherIds).toHaveLength(1);

      const original = await voucherLines(tx, posted.voucherIds[0]);
      const mirror = await voucherLines(tx, reversed.reversedVoucherIds[0]);
      expect(mirror).toEqual(original.map((line) => ({ ...line, debit: line.credit, credit: line.debit })));

      const live = await one(
        tx,
        sql`SELECT COUNT(*)::int AS n FROM vouchers WHERE id = ${posted.voucherIds[0]} AND deleted_at IS NULL`
      );
      expect(live.n).toBe(1);

      expect(
        await refusal(
          reverseDispatchTripFinancialTx(tx, trip.scope, { date: "2026-11-06", reason: "Second reversal attempt" })
        )
      ).toBe("TRIP_NOT_POSTED");

      const second = await postDispatchTripFinancialTx(
        tx,
        trip.scope,
        await signedRequest(tx, trip.scope, posted.financialId, 2)
      );
      expect(second).toMatchObject({ financialId: posted.financialId, revision: 2, replayed: false });
      const number = await one(tx, sql`SELECT voucher_number AS n FROM vouchers WHERE id = ${second.voucherIds[0]}`);
      expect(number.n).toBe(`FDTR-${trip.companyId}-${trip.dispatchId}-2`);
    });
  });

  it("refuses once a customer payment is recorded against the loading", async () => {
    await inRolledBackTransaction(async (tx) => {
      const trip = await closedTrip(tx, BALES);
      await postDispatchTripFinancialTx(tx, trip.scope, await signedRequest(tx, trip.scope, null));
      await tx.execute(
        sql`INSERT INTO customer_balances (company_id, customer_id, transaction_type, reference_type, reference_id, amount, balance,
               transaction_date)
            VALUES (${trip.companyId}, ${trip.customerId}, 'PAYMENT', 'INVOICE', ${trip.orderId}, '10.00', '-10.00',
                    '2026-11-06')`
      );
      expect(
        await refusal(
          reverseDispatchTripFinancialTx(tx, trip.scope, { date: "2026-11-06", reason: "Customer asked to cancel" })
        )
      ).toBe("TRIP_SETTLEMENT_LOCKED");
    });
  });
});
