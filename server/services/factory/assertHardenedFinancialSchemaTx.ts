// Extracted from ./dispatchTripFinancialPosting.ts to keep that module under the source-size cap.
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { MoneyDecimal } from "../../lib/money";
import {
  accountAcceptsCharge,
  accountAcceptsOffset,
  type ErpChargeType,
  type TripChargeKind,
  type TripChargeRow,
} from "../../routes/factory/customer-orders/loadingDispatchFinancialChargeModel";

export class TripFinancialPostingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409
  ) {
    super(message);
    this.name = "TripFinancialPostingError";
  }
}

// Explicitly typed so TypeScript narrows after a refusal (an inferred arrow type does not).
export const refuse: (code: string, message: string, status?: number) => never = (code, message, status = 409) => {
  throw new TripFinancialPostingError(code, message, status);
};

export const rows = async (tx: DbTransaction, q: ReturnType<typeof sql>) => resultRows(await tx.execute(q));

export const numberId = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) refuse("FINANCIAL_ID_INVALID", "Stored financial identifier is invalid");
  return n;
};

export const money = (value: string) => new MoneyDecimal(value);

export const keyOf = (companyId: number, dispatchId: number, revision: number, part: string) =>
  `factory-dispatch:${companyId}:${dispatchId}:${revision}:${part}`;

export interface DispatchPostingScope {
  companyId: number;
  orderId: number;
  dispatchId: number;
  userId: string;
  username: string;
}

export interface DispatchPostingRequest {
  sourceFingerprint: string;
  chargeFingerprint: string;
  postingDate: string;
}

export interface DispatchPostingResult {
  financialId: number;
  status: "POSTED";
  revision: number;
  goodsSubtotal: string;
  billableChargesTotal: string;
  discountTotal: string;
  internalExpenseTotal: string;
  customerTotal: string;
  voucherIds: number[];
  replayed: boolean;
}

export async function readFinancial(tx: DbTransaction, scope: DispatchPostingScope) {
  const r = (
    await rows(
      tx,
      sql`
    SELECT id, status, posting_revision AS "postingRevision",
           snapshot_revision AS "snapshotRevision",
           source_fingerprint AS "sourceFingerprint", currency,
           goods_subtotal::text AS "goodsSubtotal",
           billable_charges_total::text AS "billableChargesTotal",
           discount_total::text AS "discountTotal",
           customer_total::text AS "customerTotal"
      FROM factory_dispatch_trip_financials
     WHERE company_id = ${scope.companyId} AND order_id = ${scope.orderId}
       AND dispatch_id = ${scope.dispatchId} FOR UPDATE
  `
    )
  )[0];
  return r
    ? {
        id: numberId(r.id),
        status: String(r.status),
        postingRevision: Number(r.postingRevision),
        snapshotRevision: Number(r.snapshotRevision),
        sourceFingerprint: r.sourceFingerprint == null ? null : String(r.sourceFingerprint),
        currency: String(r.currency),
        goodsSubtotal: String(r.goodsSubtotal),
        billableChargesTotal: String(r.billableChargesTotal),
        discountTotal: String(r.discountTotal),
        customerTotal: String(r.customerTotal),
      }
    : null;
}

export async function readCharges(
  tx: DbTransaction,
  financialId: number,
  revision: number,
  scope: DispatchPostingScope
): Promise<TripChargeRow[]> {
  const found = await rows(
    tx,
    sql`
    SELECT id, name, kind, amount::text, currency, revision,
           ledger_account_id AS "ledgerAccountId",
           offset_ledger_account_id AS "offsetLedgerAccountId",
           erp_charge_type AS "erpChargeType", notes, locked_at AS "lockedAt"
      FROM factory_dispatch_trip_charges
     WHERE financial_id = ${financialId} AND company_id = ${scope.companyId}
       AND order_id = ${scope.orderId} AND dispatch_id = ${scope.dispatchId}
       AND revision = ${revision} ORDER BY id FOR UPDATE
  `
  );
  return found.map((r) => ({
    id: numberId(r.id),
    name: String(r.name),
    kind: String(r.kind) as TripChargeKind,
    amount: String(r.amount),
    currency: String(r.currency),
    revision: Number(r.revision),
    ledgerAccountId: numberId(r.ledgerAccountId),
    offsetLedgerAccountId: r.offsetLedgerAccountId == null ? null : numberId(r.offsetLedgerAccountId),
    erpChargeType: (r.erpChargeType ?? null) as ErpChargeType,
    notes: r.notes == null ? null : String(r.notes),
    lockedAt: r.lockedAt == null ? null : String(r.lockedAt),
  }));
}

export async function assertChargeAccounts(tx: DbTransaction, companyId: number, charges: TripChargeRow[]) {
  if (!charges.length) return;
  const ids = Array.from(
    new Set(charges.flatMap((c) => [c.ledgerAccountId, ...(c.offsetLedgerAccountId ? [c.offsetLedgerAccountId] : [])]))
  );
  const accounts = await rows(
    tx,
    sql`
    SELECT id, account_type AS "accountType", active, is_hidden AS "hidden", deleted_at AS "deletedAt"
      FROM ledger_accounts WHERE company_id = ${companyId} AND id IN (${sql.join(
        ids.map((i) => sql`${i}`),
        sql`,`
      )})
  `
  );
  const byId = new Map(accounts.map((a) => [Number(a.id), a]));
  for (const charge of charges) {
    const a = byId.get(charge.ledgerAccountId);
    if (!a || !a.active || a.deletedAt || a.hidden || !accountAcceptsCharge(charge.kind, String(a.accountType))) {
      refuse("TRIP_CHARGE_ACCOUNT_INVALID", `Charge "${charge.name}" has no valid active company-owned account`);
    }
    if (charge.currency !== "USD" || charge.lockedAt)
      refuse("TRIP_CHARGE_CURRENCY_OR_LOCKED", "Only unlocked USD charge drafts can be posted");
    if (charge.kind === "INTERNAL") {
      const offset = charge.offsetLedgerAccountId ? byId.get(charge.offsetLedgerAccountId) : null;
      if (
        !offset ||
        !offset.active ||
        offset.deletedAt ||
        offset.hidden ||
        !accountAcceptsOffset(String(offset.accountType)) ||
        charge.ledgerAccountId === charge.offsetLedgerAccountId
      ) {
        refuse(
          "TRIP_CHARGE_OFFSET_INVALID",
          `Internal expense "${charge.name}" requires a valid company offset account`
        );
      }
    } else if (charge.offsetLedgerAccountId !== null) {
      refuse("TRIP_CHARGE_OFFSET_INVALID", "Only internal expenses may have a separate offset account");
    }
  }
}

export async function lockTripOrder(tx: DbTransaction, scope: DispatchPostingScope) {
  const [o] = await rows(
    tx,
    sql`
    SELECT o.id, o.status, o.deleted_at AS "deletedAt",
           COALESCE(b.currency, 'USD') AS currency
      FROM customer_orders o
      LEFT JOIN customer_dispatch_batches b
        ON b.id=o.dispatch_batch_id AND b.company_id=o.company_id
     WHERE o.company_id = ${scope.companyId} AND o.id = ${scope.orderId}
     FOR UPDATE OF o
  `
  );
  if (!o || o.deletedAt || !["LOADING", "PENDING_VERIFICATION", "VERIFIED"].includes(String(o.status))) {
    refuse("TRIP_LOADING_INACTIVE", "Only an active unfinalized loading can financially finalize a truck");
  }
  if (
    String(o.currency || "USD")
      .trim()
      .toUpperCase() !== "USD"
  ) {
    refuse(
      "TRIP_CURRENCY_UNSUPPORTED",
      "Multi-currency dispatch financial posting is not yet supported. No USD-only journal will be created for this order."
    );
  }
  const [trip] = await rows(
    tx,
    sql`
    SELECT id, status FROM factory_loading_dispatches
     WHERE company_id = ${scope.companyId} AND order_id = ${scope.orderId}
       AND id = ${scope.dispatchId} FOR UPDATE
  `
  );
  if (!trip || trip.status !== "CLOSED")
    refuse("TRIP_NOT_CLOSED", "End Dispatch before financially finalizing its charges");
}

export async function writeAudit(
  tx: DbTransaction,
  scope: DispatchPostingScope,
  financialId: number,
  event: string,
  details: object,
  reason: string | null = null
) {
  await tx.execute(sql`
    INSERT INTO factory_dispatch_financial_events
      (company_id,order_id,dispatch_id,financial_id,event_type,details,reason,actor_user_id,actor_username)
    VALUES (${scope.companyId},${scope.orderId},${scope.dispatchId},${financialId},
            ${event},${JSON.stringify(details)}::jsonb,${reason},${scope.userId},${scope.username})
  `);
}

export function requireDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(date + "T12:00:00Z").getTime())) {
    refuse("TRIP_POSTING_DATE_INVALID", "Provide a valid company business date before posting");
  }
}

/** Posting stays disabled until BOTH manual TablePlus SQL files are applied. */
export async function assertHardenedFinancialSchemaTx(tx: DbTransaction): Promise<void> {
  const [ready] = await rows(
    tx,
    sql`
    SELECT
      (SELECT relforcerowsecurity FROM pg_class
        WHERE oid=to_regclass('public.factory_dispatch_trip_financials')) AS "financialRls",
      (SELECT relforcerowsecurity FROM pg_class
        WHERE oid=to_regclass('public.factory_dispatch_trip_postings')) AS "postingsRls",
      EXISTS(
        SELECT 1 FROM pg_trigger
         WHERE tgrelid=to_regclass('public.factory_loading_dispatches')
           AND tgname='factory_dispatch_physical_posted_guard'
           AND tgenabled <> 'D'
      ) AS "physicalGuard",
      EXISTS(
        SELECT 1 FROM pg_trigger
         WHERE tgrelid=to_regclass('public.customer_order_bales')
           AND tgname='factory_dispatch_order_bale_financial_guard'
           AND tgenabled <> 'D'
      ) AS "baleGuard",
      EXISTS(
        SELECT 1 FROM pg_trigger
         WHERE tgrelid=to_regclass('public.vouchers')
           AND tgname='factory_dispatch_source_voucher_guard'
           AND tgenabled <> 'D'
      ) AS "voucherGuard",
      EXISTS(
        SELECT 1 FROM pg_trigger
         WHERE tgrelid=to_regclass('public.voucher_entries')
           AND tgname='factory_dispatch_source_voucher_entries_guard'
           AND tgenabled <> 'D'
      ) AS "voucherEntriesGuard",
      EXISTS(
        SELECT 1 FROM pg_trigger
         WHERE tgrelid=to_regclass('public.accounting_posting_requests')
           AND tgname='factory_dispatch_source_posting_identity_guard'
           AND tgenabled <> 'D'
      ) AS "postingIdentityGuard"
  `
  );
  if (
    !ready?.financialRls ||
    !ready?.postingsRls ||
    !ready?.physicalGuard ||
    !ready?.baleGuard ||
    !ready?.voucherGuard ||
    !ready?.voucherEntriesGuard ||
    !ready?.postingIdentityGuard
  ) {
    refuse(
      "TRIP_FINANCIAL_SQL_PENDING",
      "Trip financial posting is disabled until the final Phase 2 and Phase 4 TablePlus SQL has been installed.",
      503
    );
  }
}
