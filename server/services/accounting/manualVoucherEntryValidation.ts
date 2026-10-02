import Decimal from "decimal.js";

import { PostingValidationError } from "./centralPostingEngine";

/**
 * Amount validation for manual vouchers that the central generic posting
 * engine does not take (optional vouchers, CFA vouchers, requests that only
 * carry an X-Idempotency-Key header, callers that pre-compute dual-currency
 * fields). Those payloads fall through to the compatibility creator in
 * voucherCreateRoutes.ts, which previously summed floats, accepted negative
 * amounts, lines carrying both a debit and a credit, single-line "balanced"
 * vouchers and up to 0.0099 of imbalance.
 *
 * The per-line rules are the central engine's (validateCentralPostingRequest):
 * finite, non-negative, at most two decimals (the column scale, so nothing is
 * silently rounded away after the balance check), exactly one side per line.
 * Active vouchers must additionally have at least two lines and balance
 * exactly. Optional vouchers keep their existing exemption from the balance
 * rule; they are excluded from posted balances.
 *
 * When a caller supplies dual-currency fields, the transaction-currency amount
 * is what the normalization trigger posts, so that is the amount validated.
 */

const AMOUNT_SCALE = 2;

export interface ManualVoucherEntryAmountInput {
  debitAmount?: unknown;
  creditAmount?: unknown;
  transactionCurrency?: unknown;
  transactionDebitAmount?: unknown;
  transactionCreditAmount?: unknown;
}

export interface ValidatedManualVoucherTotals {
  debitTotal: Decimal;
  creditTotal: Decimal;
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function parseAmount(value: unknown, field: string, index: number): Decimal {
  if (!isPresent(value)) return new Decimal(0);
  if (typeof value !== "string" && typeof value !== "number") {
    throw new PostingValidationError("POSTING_AMOUNT_INVALID", `Entry ${index + 1} has an invalid ${field}`);
  }
  let parsed: Decimal;
  try {
    parsed = new Decimal(typeof value === "string" ? value.trim() : value);
  } catch {
    throw new PostingValidationError("POSTING_AMOUNT_INVALID", `Entry ${index + 1} has an invalid ${field}`);
  }
  if (!parsed.isFinite() || parsed.isNegative()) {
    throw new PostingValidationError(
      "POSTING_AMOUNT_INVALID",
      `Entry ${index + 1} ${field} must be a finite non-negative amount`
    );
  }
  if (parsed.decimalPlaces() > AMOUNT_SCALE) {
    throw new PostingValidationError(
      "POSTING_AMOUNT_PRECISION",
      `Entry ${index + 1} ${field} must have at most ${AMOUNT_SCALE} decimal places`
    );
  }
  return parsed;
}

export function validateManualVoucherEntryAmounts(
  entries: readonly ManualVoucherEntryAmountInput[],
  options: { optional: boolean }
): ValidatedManualVoucherTotals {
  if (!options.optional && entries.length < 2) {
    throw new PostingValidationError("POSTING_ENTRIES_REQUIRED", "A balanced voucher requires at least two entries");
  }

  let debitTotal = new Decimal(0);
  let creditTotal = new Decimal(0);

  entries.forEach((entry, index) => {
    const usesTransactionAmounts = isPresent(entry.transactionCurrency);
    const debitField = usesTransactionAmounts ? "transactionDebitAmount" : "debitAmount";
    const creditField = usesTransactionAmounts ? "transactionCreditAmount" : "creditAmount";
    const debit = parseAmount(
      usesTransactionAmounts ? entry.transactionDebitAmount : entry.debitAmount,
      debitField,
      index
    );
    const credit = parseAmount(
      usesTransactionAmounts ? entry.transactionCreditAmount : entry.creditAmount,
      creditField,
      index
    );

    if (debit.isZero() === credit.isZero()) {
      throw new PostingValidationError(
        "POSTING_ENTRY_SIDE_INVALID",
        `Entry ${index + 1} must contain either a debit or a credit, but not both`
      );
    }

    debitTotal = debitTotal.plus(debit);
    creditTotal = creditTotal.plus(credit);
  });

  if (!options.optional && (debitTotal.isZero() || !debitTotal.equals(creditTotal))) {
    throw new PostingValidationError(
      "POSTING_UNBALANCED",
      `Total debits must equal total credits for active vouchers (debit=${debitTotal.toFixed()} credit=${creditTotal.toFixed()})`
    );
  }

  return { debitTotal, creditTotal };
}
