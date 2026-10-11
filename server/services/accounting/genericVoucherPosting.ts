import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import type { VoucherEntryInsertFields } from "./accountingTypes";
import { PostingValidationError, type CentralPostingRequest, type PostingActor } from "./centralPostingEngine";
import { normalizeVoucherEntryAmounts } from "./currencyAmounts";

const TARGET_FIELDS = [
  "ledgerAccountId",
  "bankAccountId",
  "fixedAssetId",
  "supplierId",
  "employeeId",
  "customerId",
  "factorySupplierId",
] as const;

const DUAL_CURRENCY_FIELDS = [
  "transactionCurrency",
  "transactionDebitAmount",
  "transactionCreditAmount",
  "baseDebitAmount",
  "baseCreditAmount",
  "historicalExchangeRate",
  "rateConvention",
] as const;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const MAX_REQUEST_ID_LENGTH = 128;

export interface GenericVoucherInput {
  companyId: number;
  clientRequestId: unknown;
  voucher: Record<string, unknown>;
  entries: Array<Record<string, unknown>>;
  exchangeRate: string | null;
  actor?: PostingActor;
}

export interface BuiltGenericVoucherPosting {
  request: CentralPostingRequest;
  clientRequestId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function decimalAmount(value: unknown, field: string, index: number): Decimal {
  let parsed: Decimal;
  try {
    parsed = new Decimal(value == null || value === "" ? 0 : (value as Decimal.Value));
  } catch {
    throw new PostingValidationError("POSTING_AMOUNT_INVALID", `Entry ${index + 1} has an invalid ${field}`);
  }

  if (!parsed.isFinite() || parsed.isNegative()) {
    throw new PostingValidationError(
      "POSTING_AMOUNT_INVALID",
      `Entry ${index + 1} ${field} must be a finite non-negative amount`
    );
  }
  return parsed;
}

function resolveClientRequestId(value: unknown): string {
  const requestId = typeof value === "string" ? value.trim() : "";
  if (!requestId) {
    throw new PostingValidationError(
      "POSTING_REQUEST_ID_REQUIRED",
      "clientRequestId is required for protected generic voucher creation"
    );
  }
  if (requestId.length > MAX_REQUEST_ID_LENGTH || !REQUEST_ID_PATTERN.test(requestId)) {
    throw new PostingValidationError("POSTING_REQUEST_ID_INVALID", "clientRequestId contains unsupported characters");
  }
  return requestId;
}

function positiveTargetId(value: unknown, field: string): number | null {
  if (value == null || value === "") return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new PostingValidationError("POSTING_TARGET_ID_INVALID", `${field} must be a positive integer`);
  }
  return id;
}

function voucherText(value: unknown, field: string): string {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new PostingValidationError("POSTING_SOURCE_REQUIRED", `${field} is required`);
  }
  return text;
}

export function supportsCentralGenericVoucher(input: unknown): boolean {
  if (!isRecord(input) || !isRecord(input.voucher) || !Array.isArray(input.entries)) return false;
  if (input.voucher.optional === true) return false;
  if (typeof input.clientRequestId !== "string" || !input.clientRequestId.trim()) return false;

  const currency = String(input.voucher.currency ?? "USD")
    .trim()
    .toUpperCase();
  if (currency !== "USD") return false;

  return (
    input.entries.length >= 2 &&
    input.entries.every((rawEntry) => {
      if (!isRecord(rawEntry)) return false;
      if (DUAL_CURRENCY_FIELDS.some((field) => rawEntry[field] != null)) return false;
      try {
        const debit = new Decimal(
          rawEntry.debitAmount == null || rawEntry.debitAmount === "" ? 0 : (rawEntry.debitAmount as Decimal.Value)
        );
        const credit = new Decimal(
          rawEntry.creditAmount == null || rawEntry.creditAmount === "" ? 0 : (rawEntry.creditAmount as Decimal.Value)
        );
        return (
          debit.isFinite() &&
          credit.isFinite() &&
          debit.gte(0) &&
          credit.gte(0) &&
          debit.decimalPlaces() <= 2 &&
          credit.decimalPlaces() <= 2
        );
      } catch {
        return true;
      }
    })
  );
}

function fingerprint(input: {
  companyId: number;
  voucher: CentralPostingRequest["voucher"];
  entries: VoucherEntryInsertFields[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        companyId: input.companyId,
        voucher: input.voucher,
        entries: input.entries.map((entry) => ({
          ledgerAccountId: entry.ledgerAccountId ?? null,
          bankAccountId: entry.bankAccountId ?? null,
          fixedAssetId: entry.fixedAssetId ?? null,
          supplierId: entry.supplierId ?? null,
          employeeId: entry.employeeId ?? null,
          customerId: entry.customerId ?? null,
          factorySupplierId: entry.factorySupplierId ?? null,
          debitAmount: entry.debitAmount,
          creditAmount: entry.creditAmount,
          narration: entry.narration ?? null,
        })),
      })
    )
    .digest("hex");
}

export function buildGenericVoucherPostingRequest(input: GenericVoucherInput): BuiltGenericVoucherPosting {
  if (!Number.isInteger(input.companyId) || input.companyId <= 0) {
    throw new PostingValidationError("POSTING_COMPANY_INVALID", "A valid companyId is required");
  }
  if (!isRecord(input.voucher) || !Array.isArray(input.entries) || input.entries.length < 2) {
    throw new PostingValidationError(
      "POSTING_ENTRIES_REQUIRED",
      "A generic active voucher requires at least two entries"
    );
  }

  const clientRequestId = resolveClientRequestId(input.clientRequestId);
  const voucherCurrency = String(input.voucher.currency ?? "USD")
    .trim()
    .toUpperCase();
  if (voucherCurrency !== "USD") {
    throw new PostingValidationError(
      "POSTING_CURRENCY_INVALID",
      "This protected generic voucher path currently supports USD only"
    );
  }

  let debitTotal = new Decimal(0);
  let creditTotal = new Decimal(0);
  const entries: VoucherEntryInsertFields[] = input.entries.map((rawEntry, index) => {
    const debit = decimalAmount(rawEntry.debitAmount, "debitAmount", index);
    const credit = decimalAmount(rawEntry.creditAmount, "creditAmount", index);
    if (debit.decimalPlaces() > 2 || credit.decimalPlaces() > 2) {
      throw new PostingValidationError(
        "POSTING_COMPATIBILITY_UNSUPPORTED",
        "Generic central posting currently supports amounts with at most two decimal places"
      );
    }
    if (debit.isZero() === credit.isZero()) {
      throw new PostingValidationError(
        "POSTING_ENTRY_SIDE_INVALID",
        `Entry ${index + 1} must contain either a debit or a credit, but not both`
      );
    }

    debitTotal = debitTotal.plus(debit);
    creditTotal = creditTotal.plus(credit);

    const normalized = normalizeVoucherEntryAmounts({
      transactionCurrency: "USD",
      baseCurrency: "USD",
      transactionDebitAmount: debit.toFixed(),
      transactionCreditAmount: credit.toFixed(),
      historicalRate: null,
    });

    const entry: VoucherEntryInsertFields = {
      debitAmount: debit.toFixed(),
      creditAmount: credit.toFixed(),
      transactionCurrency: normalized.transactionCurrency,
      transactionDebitAmount: normalized.transactionDebitAmount,
      transactionCreditAmount: normalized.transactionCreditAmount,
      baseDebitAmount: normalized.baseDebitAmount,
      baseCreditAmount: normalized.baseCreditAmount,
      historicalExchangeRate: normalized.historicalExchangeRate,
      rateConvention: normalized.rateConvention,
      narration: typeof rawEntry.narration === "string" && rawEntry.narration.trim() ? rawEntry.narration.trim() : null,
    };

    for (const field of TARGET_FIELDS) {
      const id = positiveTargetId(rawEntry[field], field);
      if (id != null) entry[field] = id;
    }

    return entry;
  });

  if (debitTotal.isZero() || !debitTotal.equals(creditTotal)) {
    throw new PostingValidationError(
      "POSTING_UNBALANCED",
      `Voucher is not balanced: debit=${debitTotal.toFixed()} credit=${creditTotal.toFixed()}`
    );
  }

  const voucher: CentralPostingRequest["voucher"] = {
    companyId: input.companyId,
    locationId: positiveTargetId(input.voucher.locationId, "locationId"),
    // Phase 22 (B): an omitted number is allocated by the engine; a caller's
    // deterministic family number (Golden Coast settlements) is kept.
    voucherNumber:
      input.voucher.voucherNumber == null || String(input.voucher.voucherNumber).trim() === ""
        ? undefined
        : voucherText(input.voucher.voucherNumber, "voucherNumber"),
    voucherType: voucherText(input.voucher.voucherType, "voucherType"),
    voucherDate: voucherText(input.voucher.voucherDate, "voucherDate"),
    description:
      typeof input.voucher.description === "string" && input.voucher.description.trim()
        ? input.voucher.description.trim()
        : null,
    totalAmount: debitTotal.toDecimalPlaces(2).toFixed(2),
    optional: false,
    currency: "USD",
    exchangeRate: input.exchangeRate,
  };

  const payloadFingerprint = fingerprint({ companyId: input.companyId, voucher, entries });
  return {
    clientRequestId,
    request: {
      voucher,
      entries,
      source: {
        sourceType: "generic-voucher",
        sourceId: clientRequestId,
        idempotencyKey: `generic-voucher:${clientRequestId}:${payloadFingerprint.slice(0, 32)}`,
      },
      actor: input.actor,
    },
  };
}
