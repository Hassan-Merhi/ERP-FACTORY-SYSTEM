/**
 * Base-currency rounding remainder (accounting audit phase 22 A, D3/M10; owner
 * decision: a ROUNDING account receives rounding remainders).
 *
 * `voucher_entries.debit_amount` / `credit_amount` (2 dp, USD base) are the
 * ledger amounts every balance reader and the balance guard sum. The currency
 * normalization trigger fills them from the 6 dp base of each line
 * (`base_* = ROUND(transaction / rate, 6)`), and the numeric(20,2) column then
 * rounds each line half away from zero. Converting and rounding line by line
 * can leave the voucher a cent or a few cents out in base although it balances
 * in its transaction currency. The central posting engine therefore predicts
 * the 2 dp amount of every line exactly as the trigger stores it and, when the
 * debit and credit sums differ, adds one line on the company's ROUNDING system
 * account (USD, rate 1) with the difference, so every engine voucher balances
 * exactly in its ledger columns. The balance guard checks every non-history
 * voucher with a tolerance of 0 (voucherBalanceGuard.ts v6).
 *
 * The remainder is bounded (half a cent per line, at least one cent): anything
 * larger is a real imbalance and is refused, never plugged.
 */
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import type { DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import type { VoucherEntryInsertFields, VoucherInsertFields } from "./accountingTypes";
import { PostingValidationError } from "./postingValidationError";

export const ROUNDING_ACCOUNT_CODE = "ROUNDING";
/** Narration of the line the engine adds; rebalanceVoucherRoundingTx replaces only lines carrying it. */
export const ENGINE_ROUNDING_NARRATION = "Base currency rounding difference";

const CENT = new Decimal("0.01");
const HALF_CENT = new Decimal("0.005");

function decimalOrZero(value: unknown): Decimal {
  if (value == null || String(value).trim() === "") return new Decimal(0);
  return new Decimal(String(value));
}

function presentText(value: unknown): boolean {
  return value != null && String(value).trim() !== "";
}

/** A numeric(20,2) assignment: half away from zero (the amounts are non-negative). */
export function toLedgerCents(value: Decimal): Decimal {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

function fullyNormalized(entry: VoucherEntryInsertFields): boolean {
  return (
    presentText(entry.transactionCurrency) &&
    presentText(entry.transactionDebitAmount) &&
    presentText(entry.transactionCreditAmount) &&
    presentText(entry.baseDebitAmount) &&
    presentText(entry.baseCreditAmount) &&
    presentText(entry.historicalExchangeRate) &&
    presentText(entry.rateConvention)
  );
}

/**
 * The 2 dp debit and credit the currency normalization trigger
 * (CURRENCY_NORMALIZATION_FUNCTION_DDL, insert path) will store for a line.
 */
export function storedLedgerAmounts(
  voucher: Pick<VoucherInsertFields, "currency" | "exchangeRate">,
  entry: VoucherEntryInsertFields
): { debit: Decimal; credit: Decimal } {
  if (fullyNormalized(entry)) {
    return {
      debit: toLedgerCents(decimalOrZero(entry.baseDebitAmount).toDecimalPlaces(6, Decimal.ROUND_HALF_UP)),
      credit: toLedgerCents(decimalOrZero(entry.baseCreditAmount).toDecimalPlaces(6, Decimal.ROUND_HALF_UP)),
    };
  }
  const currency = String(voucher.currency ?? "USD")
    .trim()
    .toUpperCase();
  const debit = decimalOrZero(entry.debitAmount);
  const credit = decimalOrZero(entry.creditAmount);
  if ((currency === "CFA" || currency === "XOF") && presentText(voucher.exchangeRate)) {
    const rate = new Decimal(String(voucher.exchangeRate));
    if (rate.gt(0)) {
      return {
        debit: toLedgerCents(debit.div(rate).toDecimalPlaces(6, Decimal.ROUND_HALF_UP)),
        credit: toLedgerCents(credit.div(rate).toDecimalPlaces(6, Decimal.ROUND_HALF_UP)),
      };
    }
  }
  // USD (and anything the trigger refuses anyway): the amount as given.
  return { debit: toLedgerCents(debit), credit: toLedgerCents(credit) };
}

/** The largest remainder accepted as rounding: half a cent per line, at least one cent. */
export function maxRoundingRemainder(lineCount: number): Decimal {
  const bound = HALF_CENT.times(Math.max(lineCount, 1)).toDecimalPlaces(2, Decimal.ROUND_UP);
  return Decimal.max(bound, CENT);
}

export interface LedgerTotals {
  debit: Decimal;
  credit: Decimal;
  /** debit − credit of the stored 2 dp amounts. */
  remainder: Decimal;
}

export function predictedLedgerTotals(
  voucher: Pick<VoucherInsertFields, "currency" | "exchangeRate">,
  entries: VoucherEntryInsertFields[]
): LedgerTotals {
  let debit = new Decimal(0);
  let credit = new Decimal(0);
  for (const entry of entries) {
    const stored = storedLedgerAmounts(voucher, entry);
    debit = debit.plus(stored.debit);
    credit = credit.plus(stored.credit);
  }
  return { debit, credit, remainder: debit.minus(credit) };
}

/** The ROUNDING line that cancels `remainder` (debit − credit). */
export function buildRoundingEntry(accountId: number, remainder: Decimal): VoucherEntryInsertFields {
  const amount = remainder.abs().toFixed(2);
  const zero = "0";
  const creditSide = remainder.gt(0);
  return {
    ledgerAccountId: accountId,
    debitAmount: creditSide ? zero : amount,
    creditAmount: creditSide ? amount : zero,
    narration: ENGINE_ROUNDING_NARRATION,
    transactionCurrency: "USD",
    transactionDebitAmount: creditSide ? "0.000000" : new Decimal(amount).toFixed(6),
    transactionCreditAmount: creditSide ? new Decimal(amount).toFixed(6) : "0.000000",
    baseDebitAmount: creditSide ? "0.000000" : new Decimal(amount).toFixed(6),
    baseCreditAmount: creditSide ? new Decimal(amount).toFixed(6) : "0.000000",
    historicalExchangeRate: "1.0000000000",
    rateConvention: "IDENTITY",
  };
}

/**
 * The company's ROUNDING account id, created through the system-account
 * registry when missing (an existing account is never changed). A soft-deleted
 * ROUNDING account is refused rather than revived.
 */
export async function resolveRoundingAccountIdTx(tx: DbTransaction, companyId: number): Promise<number> {
  const existing = resultRows<{ id: number; deleted: boolean }>(
    await tx.execute(sql`
      SELECT id, (deleted_at IS NOT NULL) AS deleted FROM ledger_accounts
       WHERE company_id = ${companyId} AND code = ${ROUNDING_ACCOUNT_CODE}
       ORDER BY id LIMIT 1
    `)
  )[0];
  if (existing && !existing.deleted) return Number(existing.id);
  if (existing?.deleted) {
    throw new PostingValidationError(
      "ROUNDING_ACCOUNT_DELETED",
      "The company's ROUNDING account is deleted; restore it before posting a voucher with a rounding difference"
    );
  }
  // Lazy import: systemAccounts pulls in the shared database client.
  const { ensureSystemAccounts } = await import("./systemAccounts");
  const [status] = await ensureSystemAccounts(tx, companyId, [ROUNDING_ACCOUNT_CODE]);
  if (status && "accountId" in status && status.state !== "deleted") return status.accountId;
  throw new PostingValidationError(
    "ROUNDING_ACCOUNT_MISSING",
    "The company's ROUNDING account could not be provisioned"
  );
}

/** Refuses a remainder too large to be per-line rounding. */
export function assertRoundingRemainder(remainder: Decimal, lineCount: number, voucherLabel: string): void {
  const limit = maxRoundingRemainder(lineCount);
  if (remainder.abs().gt(limit)) {
    throw new PostingValidationError(
      "POSTING_UNBALANCED",
      `Voucher ${voucherLabel} is not balanced in base currency: the difference ${remainder.toFixed(2)} exceeds the rounding limit ${limit.toFixed(2)}`
    );
  }
}

/**
 * For writers that replace the lines of an engine voucher in place (open-period
 * edits; a no-op for history, optional or deleted vouchers): removes the engine's previous ROUNDING line, re-reads the stored 2 dp
 * amounts and adds a new ROUNDING line for any remainder. Call it after the new
 * lines are written, in the same transaction. Returns the remainder posted
 * (0 when the voucher balances on its own).
 */
export async function rebalanceVoucherRoundingTx(
  tx: DbTransaction,
  input: { companyId: number; voucherId: number }
): Promise<string> {
  // History keeps the guard's one-cent tolerance and its lines as written;
  // optional and deleted vouchers are not checked.
  const voucher = resultRows<{ history: boolean; optional: boolean | null; deleted: boolean }>(
    await tx.execute(sql`
      SELECT balance_guard_exempt_history AS history, optional, (deleted_at IS NOT NULL) AS deleted
        FROM vouchers WHERE id = ${input.voucherId} AND company_id = ${input.companyId}
    `)
  )[0];
  if (!voucher || voucher.history || voucher.optional || voucher.deleted) return "0.00";

  const accountRows = resultRows<{ id: number }>(
    await tx.execute(sql`
      SELECT id FROM ledger_accounts WHERE company_id = ${input.companyId} AND code = ${ROUNDING_ACCOUNT_CODE}
    `)
  );
  const roundingIds = accountRows.map((row) => Number(row.id));
  if (roundingIds.length > 0) {
    await tx.execute(sql`
      DELETE FROM voucher_entries
       WHERE voucher_id = ${input.voucherId}
         AND narration = ${ENGINE_ROUNDING_NARRATION}
         AND ledger_account_id IN (${sql.join(
           roundingIds.map((id) => sql`${id}`),
           sql`, `
         )})
    `);
  }
  const totals = resultRows<{ debit: string; credit: string; lines: string | number }>(
    await tx.execute(sql`
      SELECT COALESCE(SUM(ve.debit_amount), 0)::text AS debit, COALESCE(SUM(ve.credit_amount), 0)::text AS credit,
             COUNT(*) AS lines
        FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
       WHERE ve.voucher_id = ${input.voucherId} AND v.company_id = ${input.companyId}
    `)
  )[0];
  if (!totals || Number(totals.lines) === 0) return "0.00";
  const remainder = new Decimal(totals.debit).minus(new Decimal(totals.credit));
  if (remainder.isZero()) return "0.00";
  assertRoundingRemainder(remainder, Number(totals.lines), `#${input.voucherId}`);
  const accountId = await resolveRoundingAccountIdTx(tx, input.companyId);
  const line = buildRoundingEntry(accountId, remainder);
  await tx.execute(sql`
    INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration,
                                 transaction_currency, transaction_debit_amount, transaction_credit_amount,
                                 base_debit_amount, base_credit_amount, historical_exchange_rate, rate_convention)
    VALUES (${input.voucherId}, ${accountId}, ${line.debitAmount}, ${line.creditAmount}, ${line.narration},
            ${line.transactionCurrency}, ${line.transactionDebitAmount}, ${line.transactionCreditAmount},
            ${line.baseDebitAmount}, ${line.baseCreditAmount}, ${line.historicalExchangeRate}, ${line.rateConvention})
  `);
  return remainder.toFixed(2);
}
