/**
 * Phase 5: as-of foreign-currency monetary account valuation.
 * Cash and Bank only — never revalues invoice history, inventory/COGS,
 * production, sales, expense postings or management-style supplier exposures.
 *
 * The cash/bank target ownership agrees with Phase 4. A linked bank combines
 * its master opening and its linked bank ledger opening, but every live entry
 * enters exactly one native currency bucket.
 *
 * No journal is created; compare the historic base to the dated translation.
 */
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { loadCashBankAccountTx, type CashBankKind } from "./cashBankReconciliationService";
import { datedMonetaryRateTx, fxDay, fxCurrency, translateMonetaryAmount, type MonetaryRate } from "./monetaryFxRates";

interface AccountBalanceRow extends Record<string, unknown> {
  id: number;
  opening_balance: string | null;
  opening_balance_side: string | null;
  opening_balance_native_amount: string | null;
  opening_balance_currency: string | null;
  opening_balance_base_amount: string | null;
}
interface MonetaryEntryRow extends Record<string, unknown> {
  entry_id: number;
  voucher_id: number;
  voucher_number: string;
  effective_on: string;
  voucher_currency: string;
  transaction_currency: string | null;
  native_debit: string | null;
  native_credit: string | null;
  base_debit: string | null;
  base_credit: string | null;
  legacy_debit: string | null;
  legacy_credit: string | null;
}
const dec = (v: unknown) => new Decimal(String(v ?? "0"));
const fmt = (v: Decimal) => v.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toFixed(6);
export interface FxAccountBucket {
  currency: string;
  nativeBalance: string;
  historicalUsdBasis: string;
  rate: MonetaryRate | null;
  translatedUsd: string | null;
  unrealizedDifferenceUsd: string | null;
  verified: boolean;
  issues: string[];
  journalTreatment: "REPORT_ONLY_NO_AUTO_REVALUATION";
}
export interface FxMonetaryAccountReport {
  companyId: number;
  asOfDate: string;
  accountKind: CashBankKind;
  accountId: number;
  accountName: string;
  accountedBase: "USD";
  buckets: FxAccountBucket[];
  totals: {
    historicalUsd: string;
    translatedUsd: string | null;
    unrealizedDifferenceUsd: string | null;
    unresolvedCurrencies: string[];
    posting: "REPORT_ONLY";
  };
}
function openingRow(
  row: AccountBalanceRow,
  buckets: Map<string, { native: Decimal; historical: Decimal; issues: string[] }>
) {
  const raw = dec(row.opening_balance ?? 0);
  const native = row.opening_balance_native_amount !== null ? dec(row.opening_balance_native_amount) : null;
  const code = row.opening_balance_currency ? fxCurrency(row.opening_balance_currency) : null;
  const base = row.opening_balance_base_amount !== null ? dec(row.opening_balance_base_amount) : null;
  const debitSign = row.opening_balance_side === "Cr" ? -1 : 1;
  if (native && code && base) {
    const b = buckets.get(code) ?? { native: new Decimal(0), historical: new Decimal(0), issues: [] };
    b.native = b.native.plus(native.times(debitSign));
    b.historical = b.historical.plus(base.times(debitSign));
    buckets.set(code, b);
    return;
  }
  if (raw.isZero()) return;
  // Old bank/ledger openings are not assumed to be USD when currency
  // metadata are absent. A missing original currency blocks certification.
  const k = "UNRESOLVED";
  const b = buckets.get(k) ?? { native: new Decimal(0), historical: new Decimal(0), issues: [] };
  b.issues.push(`Opening amount on account #${row.id} has no verified native currency/base basis`);
  buckets.set(k, b);
}
export async function monetaryAccountValuationTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    accountKind: CashBankKind;
    accountId: number;
    asOfDate: string;
  }
): Promise<FxMonetaryAccountReport> {
  const date = fxDay(input.asOfDate);
  const account = await loadCashBankAccountTx(tx, input);
  const kinds =
    account.accountKind === "bank"
      ? [
          { table: "bank_accounts", id: account.accountId },
          ...(account.linkedLedgerId === null ? [] : [{ table: "ledger_accounts", id: account.linkedLedgerId }]),
        ]
      : [{ table: "ledger_accounts", id: account.accountId }];
  const accounts: AccountBalanceRow[] = [];
  for (const k of kinds) {
    const a = resultRows<AccountBalanceRow>(
      await tx.execute(sql`
      SELECT id,opening_balance::text,opening_balance_side,
       opening_balance_native_amount::text,opening_balance_currency,
       opening_balance_base_amount::text
      FROM ${sql.raw(k.table)} WHERE id=${k.id} AND company_id=${input.companyId}
    `)
    )[0];
    if (a) accounts.push(a);
  }
  const where =
    account.accountKind === "bank"
      ? sql`((e.bank_account_id=${account.accountId} AND e.ledger_account_id IS NULL)
       OR (${account.linkedLedgerId}::integer IS NOT NULL AND e.ledger_account_id=${account.linkedLedgerId}))`
      : sql`e.ledger_account_id=${account.accountId}`;
  const entries = resultRows<MonetaryEntryRow>(
    await tx.execute(sql`
    SELECT e.id AS entry_id,v.id AS voucher_id,v.voucher_number,
      COALESCE(v.effective_date,v.voucher_date)::text AS effective_on,
      v.currency AS voucher_currency,e.transaction_currency,
      e.transaction_debit_amount::text AS native_debit,
      e.transaction_credit_amount::text AS native_credit,
      e.base_debit_amount::text AS base_debit,
      e.base_credit_amount::text AS base_credit,
      e.debit_amount::text AS legacy_debit,e.credit_amount::text AS legacy_credit
    FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id
    WHERE v.company_id=${input.companyId} AND v.deleted_at IS NULL
      AND v.optional=false
      AND COALESCE(v.effective_date,v.voucher_date)<=${date}::date
      AND ${where}
    ORDER BY COALESCE(v.effective_date,v.voucher_date),e.id
  `)
  );
  const buckets = new Map<string, { native: Decimal; historical: Decimal; issues: string[] }>();
  for (const a of accounts) openingRow(a, buckets);
  for (const e of entries) {
    const original = e.transaction_currency ? fxCurrency(e.transaction_currency) : null;
    const voucher = fxCurrency(e.voucher_currency || "USD");
    const complete =
      e.native_debit !== null &&
      e.native_credit !== null &&
      e.base_debit !== null &&
      e.base_credit !== null &&
      !!original;
    // A USD voucher header is not sufficient evidence for a partially
    // populated foreign-currency line. Mark it unresolved rather than
    // silently treating mixed columns as a historical USD transaction.
    if (!complete && (voucher !== "USD" || (original !== null && original !== "USD"))) {
      const b = buckets.get("UNRESOLVED") ?? {
        native: new Decimal(0),
        historical: new Decimal(0),
        issues: [],
      };
      b.issues.push(`Voucher ${e.voucher_number} (#${e.voucher_id}) lacks verified currency/base columns`);
      buckets.set("UNRESOLVED", b);
      continue;
    }
    const code = complete ? original! : "USD";
    const b = buckets.get(code) ?? { native: new Decimal(0), historical: new Decimal(0), issues: [] };
    const native = complete
      ? dec(e.native_debit).minus(dec(e.native_credit))
      : dec(e.legacy_debit).minus(dec(e.legacy_credit));
    const historical = complete
      ? dec(e.base_debit).minus(dec(e.base_credit))
      : dec(e.legacy_debit).minus(dec(e.legacy_credit));
    b.native = b.native.plus(native);
    b.historical = b.historical.plus(historical);
    buckets.set(code, b);
  }
  const result: FxAccountBucket[] = [];
  for (const [code, entry] of [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const rate = code === "UNRESOLVED" ? null : await datedMonetaryRateTx(tx, input.companyId, code, date);
    const issues = [...entry.issues];
    if (!rate && code !== "UNRESOLVED") issues.push(`No company rate for USD/${code} on or before ${date}`);
    if (code === "UNRESOLVED" && !issues.length) issues.push("Original monetary currency cannot be established");
    const verified = !!rate && issues.length === 0;
    // Preserve the exact stored USD->foreign rate: never multiply by a
    // presentation-rounded reciprocal for large CFA/CDF balances.
    const translated = verified ? dec(translateMonetaryAmount(entry.native.toFixed(), rate!)) : null;
    result.push({
      currency: code,
      nativeBalance: fmt(entry.native),
      historicalUsdBasis: fmt(entry.historical),
      rate,
      translatedUsd: translated === null ? null : fmt(translated),
      unrealizedDifferenceUsd: translated === null ? null : fmt(translated.minus(entry.historical)),
      verified,
      issues,
      journalTreatment: "REPORT_ONLY_NO_AUTO_REVALUATION",
    });
  }
  const historical = result.reduce((sum, b) => sum.plus(b.historicalUsdBasis), new Decimal(0));
  const allVerified = result.every((b) => b.verified);
  const current = allVerified ? result.reduce((sum, b) => sum.plus(b.translatedUsd ?? 0), new Decimal(0)) : null;
  return {
    companyId: input.companyId,
    asOfDate: date,
    accountKind: account.accountKind,
    accountId: account.accountId,
    accountName: account.name,
    accountedBase: "USD",
    buckets: result,
    totals: {
      historicalUsd: fmt(historical),
      translatedUsd: current ? fmt(current) : null,
      unrealizedDifferenceUsd: current ? fmt(current.minus(historical)) : null,
      unresolvedCurrencies: result.filter((b) => !b.verified).map((b) => b.currency),
      posting: "REPORT_ONLY",
    },
  };
}
