/**
 * Realized exchange gain/loss on settlement (accounting audit phase 24, M6).
 *
 * Before: no realized FX anywhere. An EUR/AUD/CFA receipt or payment at a
 * rate other than its invoice's left a USD residue on the party forever.
 *
 * Now (owner decision: matching = the phase 25 allocations, FIFO by due date,
 * posted to FX_GAIN_LOSS): every open-item allocation (phase 25,
 * `party_open_item_allocations`) between an invoice and a settlement whose
 * party lines are in the SAME foreign currency posts the exchange difference
 * of the native amount it settled, in the allocation's transaction:
 *
 *   u_i, u_p  = USD per unit of the invoice / settlement party lines
 *               (book amount ÷ native amount, as posted);
 *   N         = the native amount settled: allocation (book) ÷ the rate of the
 *               side the allocation consumes completely (the invoice when its
 *               book amount is fully allocated, else the settlement);
 *   D         = N × u_p − N × u_i, in cents.
 *
 * D is the USD residue the two items leave on the party for an amount that is
 * settled in its own currency. `FXREAL` voucher (Journal, central engine,
 * identity `fx-realized-allocation:{allocationId}`, dated on the later of the
 * two documents, or the day after the closed-through date when that is later):
 * the party line on the invoice's side when D > 0, else on the settlement's
 * side, against FX_GAIN_LOSS (registry account, created when missing, never
 * renamed or restored). Its party target is copied from the invoice's party
 * line, so the residue and its correction sit on the same balance. The voucher
 * is a USD voucher: it is never itself matched for FX again.
 *
 * Releasing the allocation (re-allocation, a changed source) reverses the FX
 * voucher (`reverseVoucherTx`, audited) in the release transaction.
 *
 * Integration review: the listener posts automatically only for a company
 * whose Owner enabled the allocation run and a settlement dated on or after
 * that enablement (allocations/allocationEnablement.ts); the FX of earlier
 * settlements is posted only through the reviewed history tool
 * (fx/realizedFxHistory.ts, preview / plan hash / apply).
 *
 * Not computed (decided by default, owner can override): an allocation whose
 * two items are in different currencies (e.g. a USD payment of an EUR
 * invoice), a master opening on either side, and items whose party lines mix
 * currencies — their residue stays visible on the party as before.
 *
 * Hook: phase 25's allocation service calls the listeners of
 * allocationEvents.ts in the allocation's transaction; `registerRealizedFxListener`
 * plugs this module in (registered once at route registration).
 */
import type Decimal from "decimal.js";
import { and, eq, isNull, sql } from "drizzle-orm";
import { voucherEntries, vouchers } from "@shared/schema";

import type { DbTransaction } from "../../../db";
import { HttpError } from "../../../lib/httpError";
import { logger } from "../../../lib/logger";
import { MONEY_DECIMAL_PLACES, MoneyDecimal, toMoney } from "../../../lib/money";
import type { AllocationEvent, AllocationPartyKind } from "../allocations/allocationEvents";
import { registerAllocationListener } from "../allocations/allocationEvents";
import { createDatabasePostingDependencies } from "../databasePostingDependencies";
import { postErpVoucherTx, type ErpVoucherLine } from "../erpVoucherPosting";
import { realizedFxAutoPostingAllowedTx } from "../allocations/allocationEnablement";
import { ensureSystemAccounts } from "../systemAccounts";
import { companyClosedThroughTx, reverseVoucherTx } from "../voucherCorrection";

export const REALIZED_FX_SOURCE_TYPE = "fx-realized-allocation" as const;
export const FX_ACCOUNT_UNAVAILABLE = "FX_ACCOUNT_UNAVAILABLE" as const;

const postingDependencies = createDatabasePostingDependencies();

/** The allocation as phase 25 reports it (book amount in the company's base currency). */
export type RealizedFxAllocation = Pick<
  AllocationEvent,
  "companyId" | "allocationId" | "partyKind" | "partyId" | "invoiceVoucherId" | "paymentVoucherId" | "amount"
> &
  Partial<Pick<AllocationEvent, "currency" | "method">>;

export interface RealizedFxResult {
  posted: boolean;
  reason?:
    | "OPENING_ITEM"
    | "NOT_FOREIGN"
    | "CURRENCY_DIFFERS"
    | "MIXED_CURRENCY"
    | "NO_PARTY_LINE"
    | "SAME_RATE"
    | "BELOW_ONE_CENT"
    | "REPLAYED"
    | "NOT_AUTOMATIC";
  voucherId?: number;
  difference?: string;
  nativeSettled?: string;
  currency?: string;
  /** The date the FX journal is (or would be) dated on. */
  voucherDate?: string;
  /** The later of the two documents' dates. */
  settledOn?: string;
}

/**
 * `post` (default): post the difference (the history tool and direct callers).
 * `automatic`: the allocation-event listener — posts only when the company's
 * automatic allocation is enabled and the settlement is dated on or after it
 * (allocations/allocationEnablement.ts), else `NOT_AUTOMATIC`.
 * `dryRun`: compute only (the history tool's plan).
 */
export type RealizedFxMode = "post" | "automatic" | "dryRun";

interface PartyItem {
  voucherId: number;
  date: string;
  currency: string | null;
  mixed: boolean;
  /** Net book amount (debit − credit) of the party's lines on the voucher. */
  book: Decimal;
  /** Net native amount (debit − credit) in `currency`. */
  native: Decimal;
  target: Pick<ErpVoucherLine, "ledgerAccountId" | "customerId" | "supplierId" | "employeeId" | "factorySupplierId">;
}

function partyColumn(kind: AllocationPartyKind) {
  switch (kind) {
    case "customer":
      return voucherEntries.customerId;
    case "supplier":
      return voucherEntries.supplierId;
    case "employee":
      return voucherEntries.employeeId;
    case "factorySupplier":
      return voucherEntries.factorySupplierId;
  }
}

function normalizedCurrency(code: string | null): string {
  const upper = String(code || "USD")
    .trim()
    .toUpperCase();
  return upper === "XOF" ? "CFA" : upper;
}

async function loadPartyItemTx(
  tx: DbTransaction,
  companyId: number,
  kind: AllocationPartyKind,
  partyId: number,
  voucherId: number
): Promise<PartyItem | null> {
  const rows = await tx
    .select({
      ledgerAccountId: voucherEntries.ledgerAccountId,
      customerId: voucherEntries.customerId,
      supplierId: voucherEntries.supplierId,
      employeeId: voucherEntries.employeeId,
      factorySupplierId: voucherEntries.factorySupplierId,
      debit: voucherEntries.debitAmount,
      credit: voucherEntries.creditAmount,
      currency: voucherEntries.transactionCurrency,
      nativeDebit: voucherEntries.transactionDebitAmount,
      nativeCredit: voucherEntries.transactionCreditAmount,
      voucherDate: vouchers.voucherDate,
      effectiveDate: vouchers.effectiveDate,
    })
    .from(voucherEntries)
    .innerJoin(vouchers, eq(vouchers.id, voucherEntries.voucherId))
    .where(
      and(
        eq(voucherEntries.voucherId, voucherId),
        eq(vouchers.companyId, companyId),
        isNull(vouchers.deletedAt),
        eq(partyColumn(kind), partyId)
      )
    )
    .orderBy(voucherEntries.id);
  if (rows.length === 0) return null;
  const currencies = new Set(rows.map((row) => normalizedCurrency(row.currency)));
  let book = new MoneyDecimal(0);
  let native = new MoneyDecimal(0);
  for (const row of rows) {
    book = book.plus(toMoney(row.debit)).minus(toMoney(row.credit));
    native = native.plus(toMoney(row.nativeDebit ?? row.debit)).minus(toMoney(row.nativeCredit ?? row.credit));
  }
  const first = rows[0];
  return {
    voucherId,
    date: String(first.effectiveDate ?? first.voucherDate),
    currency: currencies.size === 1 ? [...currencies][0] : null,
    mixed: currencies.size > 1,
    book,
    native,
    target: {
      ledgerAccountId: first.ledgerAccountId,
      customerId: first.customerId,
      supplierId: first.supplierId,
      employeeId: first.employeeId,
      factorySupplierId: first.factorySupplierId,
    },
  };
}

/** Book amount of the live allocations of a voucher in one role (invoice or settlement) for the party. */
async function allocatedTx(
  tx: DbTransaction,
  allocation: RealizedFxAllocation,
  role: "invoice" | "payment",
  voucherId: number
): Promise<Decimal> {
  const column = role === "invoice" ? sql`invoice_voucher_id` : sql`payment_voucher_id`;
  const result = await tx.execute<{ total: string | null } & Record<string, unknown>>(sql`
    SELECT COALESCE(SUM(amount), 0)::text AS total
      FROM party_open_item_allocations
     WHERE company_id = ${allocation.companyId}
       AND party_kind = ${allocation.partyKind}
       AND party_id = ${allocation.partyId}
       AND released_at IS NULL
       AND ${column} = ${voucherId}
  `);
  return toMoney(result.rows[0]?.total ?? "0");
}

async function fxAccountIdTx(tx: DbTransaction, companyId: number, code: "FX_GAIN_LOSS" | "UNREALIZED_FX") {
  const [status] = await ensureSystemAccounts(tx, companyId, [code]);
  if (status && "accountId" in status && status.state !== "deleted") return status.accountId;
  throw new HttpError(
    409,
    `The ${code} account is deleted. Restore it or choose another account before exchange differences can be posted.`
  );
}

/** The date a correcting voucher is posted at: `date`, or the day after the closed-through date when that is later. */
export async function openPostingDateTx(tx: DbTransaction, companyId: number, date: string): Promise<string> {
  const closedThrough = await companyClosedThroughTx(tx, companyId);
  if (!closedThrough || date > closedThrough) return date;
  const next = new Date(`${closedThrough}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/** Posts the realized FX difference of one allocation (in its transaction). */
export async function postRealizedFxForAllocationTx(
  tx: DbTransaction,
  allocation: RealizedFxAllocation,
  mode: RealizedFxMode = "post"
): Promise<RealizedFxResult> {
  if (allocation.invoiceVoucherId == null || allocation.paymentVoucherId == null) {
    return { posted: false, reason: "OPENING_ITEM" };
  }
  const invoice = await loadPartyItemTx(
    tx,
    allocation.companyId,
    allocation.partyKind,
    allocation.partyId,
    allocation.invoiceVoucherId
  );
  const payment = await loadPartyItemTx(
    tx,
    allocation.companyId,
    allocation.partyKind,
    allocation.partyId,
    allocation.paymentVoucherId
  );
  if (!invoice || !payment) return { posted: false, reason: "NO_PARTY_LINE" };
  if (invoice.mixed || payment.mixed) return { posted: false, reason: "MIXED_CURRENCY" };
  if (invoice.currency === "USD" || payment.currency === "USD") return { posted: false, reason: "NOT_FOREIGN" };
  if (invoice.currency !== payment.currency) return { posted: false, reason: "CURRENCY_DIFFERS" };
  if (invoice.native.isZero() || payment.native.isZero()) return { posted: false, reason: "NO_PARTY_LINE" };

  const currency = invoice.currency!;
  const usdPerUnitInvoice = invoice.book.div(invoice.native).abs();
  const usdPerUnitPayment = payment.book.div(payment.native).abs();
  if (usdPerUnitInvoice.eq(usdPerUnitPayment)) return { posted: false, reason: "SAME_RATE" };

  const amount = toMoney(allocation.amount);
  const invoiceConsumed = (await allocatedTx(tx, allocation, "invoice", invoice.voucherId)).gte(invoice.book.abs());
  const native = amount.div(invoiceConsumed ? usdPerUnitInvoice : usdPerUnitPayment);
  const difference = native
    .times(usdPerUnitPayment)
    .minus(native.times(usdPerUnitInvoice))
    .toDecimalPlaces(MONEY_DECIMAL_PLACES, MoneyDecimal.ROUND_HALF_UP);
  if (difference.isZero()) return { posted: false, reason: "BELOW_ONE_CENT", currency };

  const invoiceIsDebit = invoice.book.gt(0);
  // D > 0: the settlement booked more USD than the invoice for the same native
  // amount; the party line goes on the invoice's side.
  const partyOnDebit = difference.gt(0) ? invoiceIsDebit : !invoiceIsDebit;
  const magnitude = difference.abs();
  const settledDate = invoice.date > payment.date ? invoice.date : payment.date;
  if (mode === "automatic" && !(await realizedFxAutoPostingAllowedTx(tx, allocation.companyId, settledDate))) {
    return {
      posted: false,
      reason: "NOT_AUTOMATIC",
      difference: difference.toFixed(2),
      currency,
      settledOn: settledDate,
    };
  }
  const voucherDate = await openPostingDateTx(tx, allocation.companyId, settledDate);
  if (mode === "dryRun") {
    const existing = await realizedFxVoucherIdTx(tx, allocation.companyId, allocation.allocationId);
    return {
      posted: false,
      reason: existing == null ? undefined : "REPLAYED",
      voucherId: existing ?? undefined,
      difference: difference.toFixed(2),
      nativeSettled: native.abs().toFixed(6),
      currency,
      voucherDate,
      settledOn: settledDate,
    };
  }
  const fxAccountId = await fxAccountIdTx(tx, allocation.companyId, "FX_GAIN_LOSS");
  const narration = `Realized exchange difference, ${native.abs().toDecimalPlaces(2).toFixed(2)} ${currency} settled (allocation ${allocation.allocationId})`;
  const partyLine: ErpVoucherLine = {
    ...allocationTarget(invoice.target),
    debit: partyOnDebit ? magnitude : 0,
    credit: partyOnDebit ? 0 : magnitude,
    narration,
  };
  const fxLine: ErpVoucherLine = {
    ledgerAccountId: fxAccountId,
    debit: partyOnDebit ? 0 : magnitude,
    credit: partyOnDebit ? magnitude : 0,
    narration,
  };
  const posted = await postErpVoucherTx(tx, {
    companyId: allocation.companyId,
    voucherType: "Journal",
    voucherDate,
    description: narration,
    currency: "USD",
    lines: [partyLine, fxLine],
    source: { type: REALIZED_FX_SOURCE_TYPE, id: allocation.allocationId },
    actor: { reason: "Realized exchange difference on settlement" },
  });
  return {
    posted: !posted.replayed,
    reason: posted.replayed ? "REPLAYED" : undefined,
    voucherId: posted.voucher.id,
    difference: difference.toFixed(2),
    nativeSettled: native.abs().toFixed(6),
    currency,
    voucherDate,
    settledOn: settledDate,
  };
}

function allocationTarget(target: PartyItem["target"]): PartyItem["target"] {
  const out: PartyItem["target"] = {};
  for (const key of ["ledgerAccountId", "customerId", "supplierId", "employeeId", "factorySupplierId"] as const) {
    if (target[key] != null) out[key] = target[key];
  }
  return out;
}

/** The live realized-FX voucher of an allocation, or null. */
export async function realizedFxVoucherIdTx(
  tx: DbTransaction,
  companyId: number,
  allocationId: number
): Promise<number | null> {
  const result = await tx.execute<{ voucher_id: number } & Record<string, unknown>>(sql`
    SELECT r.voucher_id
      FROM accounting_posting_requests r
      JOIN vouchers v ON v.id = r.voucher_id
     WHERE r.company_id = ${companyId}
       AND r.source_type = ${REALIZED_FX_SOURCE_TYPE}
       AND r.source_id = ${String(allocationId)}
       AND v.deleted_at IS NULL
     LIMIT 1
  `);
  const id = result.rows[0]?.voucher_id;
  return id == null ? null : Number(id);
}

/** Reverses the realized FX voucher of a released allocation (in the release transaction). */
export async function reverseRealizedFxForAllocationTx(
  tx: DbTransaction,
  allocation: Pick<AllocationEvent, "companyId" | "allocationId"> & { releaseReason?: string }
): Promise<{ reversed: boolean; reversalVoucherId?: number }> {
  const voucherId = await realizedFxVoucherIdTx(tx, allocation.companyId, allocation.allocationId);
  if (voucherId == null) return { reversed: false };
  const live = await tx.execute<{ id: number } & Record<string, unknown>>(sql`
    SELECT id FROM vouchers WHERE company_id = ${allocation.companyId} AND reversal_of_voucher_id = ${voucherId}
       AND deleted_at IS NULL LIMIT 1
  `);
  if (live.rows.length > 0) return { reversed: false };
  const [original] = await tx
    .select({ voucherDate: vouchers.voucherDate })
    .from(vouchers)
    .where(eq(vouchers.id, voucherId))
    .limit(1);
  const reversalDate = await openPostingDateTx(tx, allocation.companyId, String(original?.voucherDate));
  const result = await reverseVoucherTx(
    tx,
    {
      voucherId,
      companyId: allocation.companyId,
      reversalDate,
      reason: `Allocation ${allocation.allocationId} released${allocation.releaseReason ? `: ${allocation.releaseReason}` : ""}`,
      actor: { reason: "Realized exchange difference reversed with its allocation" },
    },
    postingDependencies
  );
  return { reversed: true, reversalVoucherId: result.reversal.id };
}

let unregister: (() => void) | null = null;

/** Plugs realized FX into the phase 25 allocation events (idempotent). */
export function registerRealizedFxListener(): void {
  if (unregister) return;
  unregister = registerAllocationListener({
    posted: async (tx, event) => {
      // Integration review: only for an enabled company and a settlement on or after the enablement.
      const result = await postRealizedFxForAllocationTx(tx, event, "automatic");
      if (result.posted) {
        logger.info("[fx] Realized exchange difference posted", {
          companyId: event.companyId,
          allocationId: event.allocationId,
          voucherId: result.voucherId,
          difference: result.difference,
          currency: result.currency,
        });
      }
    },
    released: async (tx, event) => {
      await reverseRealizedFxForAllocationTx(tx, event);
    },
  });
}

/** Tests: removes the listener. */
export function unregisterRealizedFxListenerForTests(): void {
  unregister?.();
  unregister = null;
}
