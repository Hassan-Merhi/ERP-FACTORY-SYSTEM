/**
 * Phase 22 (B) — the ERP writers' door to the central posting engine.
 *
 * The ERP routes (rental, payroll, POS, credit notes, transfers, intercompany,
 * repairs) used to insert `vouchers` and `voucher_entries` rows themselves,
 * with float arithmetic, `Date.now()` voucher numbers and no posting identity,
 * so a replayed request posted twice. They now describe the voucher here and
 * this module posts it through `postBalancedVoucherTx`:
 *
 *  - amounts are exact Decimals, rounded to cents once, and must balance;
 *  - the number is allocated by the engine (TYPE-YYYY-000001, gapless per
 *    company, type and year) unless the caller re-posts an existing voucher
 *    whose number is kept;
 *  - the posting identity is `<sourceType>:<sourceId>[:<revision>]`, so a
 *    replay of the same source returns the voucher already posted instead of
 *    posting a second one;
 *  - everything runs inside the caller's transaction (company scope, closed
 *    period guard, balance guard and the audit trigger all apply).
 */
import { and, eq } from "drizzle-orm";
import { voucherEntries, vouchers } from "@shared/schema";
import type { DbTransaction } from "../../db";
import { MONEY_DECIMAL_PLACES, MoneyDecimal, toMoney, type MoneyInput } from "../../lib/money";
import type { PostedVoucher, PostedVoucherEntry, VoucherEntryInsertFields } from "./accountingTypes";
import { PostingValidationError, postBalancedVoucherTx } from "./centralPostingEngine";
import { normalizeVoucherEntryAmounts } from "./currencyAmounts";
import { createDatabasePostingDependencies } from "./databasePostingDependencies";
import { isHadiDuplicateLinkedRentExpenseJournal } from "../rental/hadiRentLedgerPolicy";
import { allocateVoucherNumberTx } from "./voucherNumbering";
import {
  TARGET_FIELDS,
  cents,
  type ErpVoucherLine,
  type ErpVoucherPostingInput,
  type ErpPostingResult,
  type ErpEntriesPostingInput,
  type LineTarget,
  type ManualVoucherPostingInput,
} from "./erpVoucherPostingHelpers";
export {
  erpRequestSourceId,
  sessionPostingActor,
  withAuthorizedPostingCompany,
  type ErpVoucherLine,
  type ErpVoucherMetadata,
  type ErpVoucherPostingInput,
  type ErpPostingResult,
  type ErpEntriesPostingInput,
  type ManualVoucherPostingInput,
} from "./erpVoucherPostingHelpers";

const postingDependencies = createDatabasePostingDependencies();

/** The posting identity of a source record (no timestamps, no random parts). */
export function erpPostingSource(source: ErpVoucherPostingInput["source"]) {
  const type = String(source.type ?? "").trim();
  const id = String(source.id ?? "").trim();
  if (!type || !id) {
    throw new PostingValidationError("POSTING_SOURCE_REQUIRED", "A posting source type and id are required");
  }
  const revision = source.revision == null || source.revision === "" ? null : String(source.revision);
  const sourceId = revision ? `${id}:${revision}` : id;
  return { sourceType: type, sourceId, idempotencyKey: `${type}:${sourceId}` };
}

/** Engine entry rows for the lines; zero lines are dropped, sides checked. */
export function buildErpVoucherEntries(lines: readonly ErpVoucherLine[]): VoucherEntryInsertFields[] {
  const entries: VoucherEntryInsertFields[] = [];
  for (const [index, line] of lines.entries()) {
    const debit = cents(line.debit);
    const credit = cents(line.credit);
    if (debit.isNegative() || credit.isNegative()) {
      throw new PostingValidationError("POSTING_AMOUNT_INVALID", `Line ${index + 1} has a negative amount`);
    }
    if (debit.isZero() && credit.isZero()) continue;
    if (!debit.isZero() && !credit.isZero()) {
      throw new PostingValidationError(
        "POSTING_ENTRY_SIDE_INVALID",
        `Line ${index + 1} must contain either a debit or a credit, but not both`
      );
    }
    const isDebit = !debit.isZero();
    const transaction = line.transaction;
    let entry: VoucherEntryInsertFields;
    if (transaction && transaction.currency && transaction.currency.toUpperCase() !== "USD") {
      const native = toMoney(transaction.amount).toDecimalPlaces(MONEY_DECIMAL_PLACES).toFixed(MONEY_DECIMAL_PLACES);
      const normalized = normalizeVoucherEntryAmounts({
        transactionCurrency: transaction.currency,
        baseCurrency: "USD",
        transactionDebitAmount: isDebit ? native : "0",
        transactionCreditAmount: isDebit ? "0" : native,
        historicalRate: toMoney(transaction.rate).toFixed(),
      });
      entry = {
        debitAmount: normalized.baseDebitAmount,
        creditAmount: normalized.baseCreditAmount,
        narration: line.narration ?? null,
        transactionCurrency: normalized.transactionCurrency,
        transactionDebitAmount: normalized.transactionDebitAmount,
        transactionCreditAmount: normalized.transactionCreditAmount,
        baseDebitAmount: normalized.baseDebitAmount,
        baseCreditAmount: normalized.baseCreditAmount,
        historicalExchangeRate: normalized.historicalExchangeRate,
        rateConvention: normalized.rateConvention,
      };
    } else {
      const baseText = (isDebit ? debit : credit).toFixed(MONEY_DECIMAL_PLACES);
      entry = {
        debitAmount: isDebit ? baseText : "0",
        creditAmount: isDebit ? "0" : baseText,
        narration: line.narration ?? null,
        transactionCurrency: "USD",
        transactionDebitAmount: isDebit ? baseText : "0",
        transactionCreditAmount: isDebit ? "0" : baseText,
        baseDebitAmount: isDebit ? baseText : "0",
        baseCreditAmount: isDebit ? "0" : baseText,
        historicalExchangeRate: "1.0000000000",
        rateConvention: "IDENTITY",
      };
    }
    for (const field of TARGET_FIELDS) {
      const id = line[field];
      if (id != null) entry[field] = id;
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * Posts already-built engine entries (callers that carry their own
 * dual-currency fields). The total is the exact debit total.
 */
export async function postErpEntriesTx(tx: DbTransaction, input: ErpEntriesPostingInput): Promise<ErpPostingResult> {
  // Guard the precise historic HADI/Properties double-expensing pattern before
  // voucher numbering or inserting any lines. The legitimate monthly accrual
  // (Dr expense / Cr payable) and payment (Dr payable / Cr owner) still work.
  if (isHadiDuplicateLinkedRentExpenseJournal(input.companyId, input.voucherType, input.entries)) {
    throw new PostingValidationError(
      "HADI_LINKED_RENT_DUPLICATE_EXPENSE_BLOCKED",
      "HADI rent credited to the Properties owner/settlement account must not debit Rent Expense again. " +
        "Reconcile the original rent accrual first and settle the valid Accrued Rent Payable entry instead."
    );
  }
  const total = input.entries.reduce((sum, entry) => sum.plus(toMoney(entry.debitAmount)), new MoneyDecimal(0));
  const exchangeRate =
    input.exchangeRate == null || input.exchangeRate === "" ? null : toMoney(input.exchangeRate).toFixed();
  const result = await postBalancedVoucherTx(
    tx,
    {
      voucher: {
        companyId: input.companyId,
        voucherNumber: input.voucherNumber,
        voucherType: input.voucherType,
        voucherDate: input.voucherDate,
        // Exact: USD lines are in cents; a non-USD line's USD amount has 6
        // places (the column keeps the total in cents).
        totalAmount:
          total.decimalPlaces() <= MONEY_DECIMAL_PLACES ? total.toFixed(MONEY_DECIMAL_PLACES) : total.toFixed(),
        description: input.description ?? null,
        locationId: input.locationId ?? null,
        optional: input.optional ?? false,
        currency: input.currency ?? "USD",
        exchangeRate,
        effectiveDate: input.effectiveDate ?? null,
        sourceModule: input.sourceModule ?? "ERP",
      },
      entries: input.entries,
      source: erpPostingSource(input.source),
      actor: input.actor,
    },
    postingDependencies
  );
  if (!result.replayed && input.metadata && Object.keys(input.metadata).length > 0) {
    const [voucher] = await tx
      .update(vouchers)
      .set(input.metadata)
      .where(and(eq(vouchers.id, result.voucher.id), eq(vouchers.companyId, input.companyId)))
      .returning();
    if (voucher) return { ...result, voucher };
  }
  return result;
}

/**
 * Posts one ERP voucher through the central engine inside `tx`. Returns the
 * engine result; `replayed` is true when the source was already posted.
 */
export async function postErpVoucherTx(tx: DbTransaction, input: ErpVoucherPostingInput): Promise<ErpPostingResult> {
  const { lines, ...rest } = input;
  const voucherCurrency = String(input.currency ?? "USD").toUpperCase();
  if (voucherCurrency !== "USD" && lines.some((line) => !line.transaction)) {
    // The base amount of a non-USD line is only known with its native amount
    // and rate; a line without them would be stored as if it were USD.
    throw new PostingValidationError(
      "POSTING_TRANSACTION_AMOUNT_REQUIRED",
      `A ${voucherCurrency} voucher needs each line's ${voucherCurrency} amount and rate`
    );
  }
  return postErpEntriesTx(tx, { ...rest, entries: buildErpVoucherEntries(lines) });
}

/** Dr `debit` / Cr `credit` for one amount (the common two-line voucher). */
export function pairLines(
  debit: LineTarget,
  credit: LineTarget,
  amount: MoneyInput,
  narration: string | null,
  creditNarration: string | null = narration
): ErpVoucherLine[] {
  return [
    { ...debit, debit: amount, narration },
    { ...credit, credit: amount, narration: creditNarration },
  ];
}

/**
 * The legacy voucher forms (optional vouchers, old clients without a request
 * id): an active voucher posts through the engine; an OPTIONAL one is off the
 * ledger and may be unbalanced, which the engine refuses, so it keeps a direct
 * insert — with an allocated gapless number instead of a Date.now() one.
 */
export async function postManualVoucherTx(
  tx: DbTransaction,
  input: ManualVoucherPostingInput
): Promise<{ voucher: PostedVoucher; entries: PostedVoucherEntry[]; replayed: boolean }> {
  const { optional, optionalTotalAmount, ...rest } = input;
  if (!optional) {
    return postErpEntriesTx(tx, {
      ...rest,
      entries: rest.entries.map((entry) => ({
        ...entry,
        debitAmount: String(entry.baseDebitAmount ?? entry.debitAmount ?? "0"),
        creditAmount: String(entry.baseCreditAmount ?? entry.creditAmount ?? "0"),
      })),
    });
  }
  const [voucher] = await tx
    .insert(vouchers)
    .values({
      companyId: input.companyId,
      voucherNumber: await allocateVoucherNumberTx(tx, {
        companyId: input.companyId,
        voucherType: input.voucherType,
        voucherDate: input.voucherDate,
      }),
      voucherType: input.voucherType,
      voucherDate: input.voucherDate,
      description: input.description ?? null,
      locationId: input.locationId ?? null,
      totalAmount: optionalTotalAmount,
      optional: true,
      currency: input.currency ?? "USD",
      exchangeRate:
        input.exchangeRate == null || input.exchangeRate === "" ? null : toMoney(input.exchangeRate).toFixed(),
      effectiveDate: input.effectiveDate ?? null,
      sourceModule: input.sourceModule ?? "ERP",
    })
    .returning();
  const entries =
    input.entries.length === 0
      ? []
      : await tx
          .insert(voucherEntries)
          .values(input.entries.map((entry) => ({ voucherId: voucher.id, ...entry })))
          .returning();
  return { voucher, entries, replayed: false };
}
