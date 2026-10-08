/**
 * A customer's ledger statement on the one balance engine (accounting audit
 * wave 10).
 *
 * The lines are the ones the engine attributes to the customer
 * (partyLineRules.ts): its owned linked ledger plus its customer-tagged lines
 * that name no other target, from posted vouchers of the company dated
 * COALESCE(effective_date, voucher_date). The pre-period figure is the
 * engine's carried-forward movement, so opening + pre-period + the listed
 * lines equals the engine's closing and the trial balance's customer row.
 *
 * Amounts that never reached the ledger (factory invoices before the
 * perpetual cut-over, factory POS credit sales and deposits, other
 * cache-only customer_balances rows) are returned in a separate
 * `notInLedger` section, flagged `notInLedger: true`, and never added to the
 * ledger rows, the pre-period figure or the closing.
 */
import { and, eq, sql } from "drizzle-orm";
import { voucherEntries, vouchers } from "@shared/schema";

import type { DatabaseOrTransaction } from "../../../db";
import type { AccountStatementEntryRow } from "../../../storage/accounting/vouchers";
import { toMoney } from "../../../lib/money";
import { getPartyBalance } from "./ledgerBalanceEngine";
import { customerOwnedLineSql, liveVoucherInCompany, voucherBookedOnSql } from "./partyLineRules";
import { loadPartyMemoLines, memoTotal, type PartyBalanceMemoLine } from "./unpostedMemo";

export interface CustomerStatementWindow {
  companyId: number;
  customerId: number;
  /** Inclusive start; omitted for opening-to-date. */
  from?: string | null;
  /** Inclusive end; omitted for everything posted. */
  to?: string | null;
}

/** The customer's ledger lines in the window, oldest first. */
export async function loadCustomerLedgerLines(executor: DatabaseOrTransaction, window: CustomerStatementWindow) {
  const conditions = [
    liveVoucherInCompany(window.companyId),
    customerOwnedLineSql(window.companyId, window.customerId),
    ...(window.from ? [sql`${voucherBookedOnSql} >= ${window.from}`] : []),
    ...(window.to ? [sql`${voucherBookedOnSql} <= ${window.to}`] : []),
  ];
  const lines = await executor
    .select({
      id: voucherEntries.id,
      voucherId: voucherEntries.voucherId,
      voucherNumber: vouchers.voucherNumber,
      voucherType: vouchers.voucherType,
      voucherDate: sql<string>`${voucherBookedOnSql}::text`,
      voucherDescription: vouchers.description,
      narration: voucherEntries.narration,
      debitAmount: voucherEntries.debitAmount,
      creditAmount: voucherEntries.creditAmount,
      transactionCurrency: voucherEntries.transactionCurrency,
      transactionDebitAmount: voucherEntries.transactionDebitAmount,
      transactionCreditAmount: voucherEntries.transactionCreditAmount,
      baseDebitAmount: voucherEntries.baseDebitAmount,
      baseCreditAmount: voucherEntries.baseCreditAmount,
      historicalExchangeRate: voucherEntries.historicalExchangeRate,
      rateConvention: voucherEntries.rateConvention,
      currency: vouchers.currency,
    })
    .from(voucherEntries)
    .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
    .where(and(...conditions))
    .orderBy(voucherBookedOnSql, voucherEntries.id);
  return lines.map((line) => ({
    ...line,
    voucherDescription: line.voucherDescription || "",
    narration: line.narration || line.voucherDescription || "",
  }));
}

/** The customer's ledger lines in the account-statement export row shape. */
export async function loadCustomerLedgerEntryRows(
  executor: DatabaseOrTransaction,
  window: CustomerStatementWindow
): Promise<AccountStatementEntryRow[]> {
  const lines = await loadCustomerLedgerLines(executor, window);
  return lines.map((line) => ({
    voucherId: line.voucherId,
    entryId: line.id,
    debitAmount: line.debitAmount ?? "0",
    creditAmount: line.creditAmount ?? "0",
    transactionDebitAmount: line.transactionDebitAmount ?? line.debitAmount ?? "0",
    transactionCreditAmount: line.transactionCreditAmount ?? line.creditAmount ?? "0",
    baseDebitAmount: line.baseDebitAmount,
    baseCreditAmount: line.baseCreditAmount,
    transactionCurrency: line.transactionCurrency,
    historicalExchangeRate: line.historicalExchangeRate,
    rateConvention: line.rateConvention,
    narration: line.narration,
    voucherNumber: line.voucherNumber,
    voucherType: line.voucherType,
    voucherDate: line.voucherDate,
    voucherDescription: line.voucherDescription,
    currency: line.currency,
    companyId: window.companyId,
  }));
}

/** Net (debit positive) of the customer's ledger lines dated before `before`; 0 without it. */
export async function customerLedgerNetBefore(
  executor: DatabaseOrTransaction,
  companyId: number,
  customerId: number,
  before: string | null | undefined
): Promise<number> {
  if (!before) return 0;
  const party = await getPartyBalance(executor, { companyId, kind: "customer", id: customerId, from: before });
  return toMoney(party?.carriedForward).toNumber();
}

/** A memo line in the shape of a statement row, flagged as outside the ledger. */
export function memoStatementRow(line: PartyBalanceMemoLine) {
  const amount = toMoney(line.amount ?? line.nativeAmount);
  return {
    id: `memo-${line.source}-${line.sourceId}`,
    voucherId: null,
    voucherNumber: line.reference ?? "",
    voucherType: line.source,
    voucherDate: line.date,
    voucherDescription: line.label,
    narration: line.label,
    debitAmount: amount.greaterThan(0) ? amount.toFixed(2) : "0.00",
    creditAmount: amount.isNegative() ? amount.negated().toFixed(2) : "0.00",
    currency: line.currency,
    amountUsd: line.amount,
    memoSource: line.source,
    notInLedger: true as const,
  };
}

export interface NotInLedgerSection {
  label: string;
  /** USD total of the rows in the window (debit positive); rows with no rate are left out. */
  total: string;
  /** USD total of memo lines dated before the window's start (0 without a start). */
  prePeriodTotal: string;
  rows: ReturnType<typeof memoStatementRow>[];
}

export const NOT_IN_LEDGER_LABEL =
  "Not yet in the ledger — operational amounts shown for information, not part of the ledger balance";

/** The customer's memo lines in the window (and the total before it). */
export async function loadCustomerNotInLedger(
  executor: DatabaseOrTransaction,
  window: CustomerStatementWindow
): Promise<NotInLedgerSection> {
  const memo = await loadPartyMemoLines(executor, {
    companyId: window.companyId,
    kind: "customer",
    ids: [window.customerId],
    asOf: window.to,
  });
  const lines = memo.get(window.customerId) ?? [];
  const inWindow = lines.filter((line) => !window.from || line.date >= window.from);
  return {
    label: NOT_IN_LEDGER_LABEL,
    total: memoTotal(inWindow).toFixed(2),
    prePeriodTotal: window.from ? memoTotal(lines, window.from).toFixed(2) : "0.00",
    rows: inWindow.map(memoStatementRow),
  };
}
