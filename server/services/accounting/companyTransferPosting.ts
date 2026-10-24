import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import type { VoucherEntryInsertFields } from "./accountingTypes";
import { normalizeVoucherEntryAmounts } from "./currencyAmounts";
import { PostingValidationError, type CentralPostingRequest, type PostingActor } from "./centralPostingEngine";
import { resolveManualJournalClientRequestId } from "./manualJournalPosting";

export type CompanyTransferVoucherType = "Payment" | "Receipt";
export type CompanyTransferSide = "from" | "to";

export interface BuildCompanyTransferPostingInput {
  companyId: number;
  voucherNumber: string;
  voucherType: CompanyTransferVoucherType;
  voucherDate: string;
  description?: string | null;
  debitNarration?: string | null;
  creditNarration?: string | null;
  amount: string | number;
  /** ZMW transfer amount is native Kwacha on its Zambia leg only. */
  transactionCurrency?: "USD" | "ZMW";
  historicalExchangeRate?: string | null;
  debitLedgerAccountId: number;
  creditLedgerAccountId: number;
  clientRequestId?: unknown;
  sourceType: "simple-company-transfer" | "inter-company-transfer";
  sourceSide: CompanyTransferSide;
  actor?: PostingActor;
}

export interface BuiltCompanyTransferPosting {
  request: CentralPostingRequest;
  clientRequestId: string;
  amount: string;
}

function positiveId(value: unknown, field: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new PostingValidationError("POSTING_TARGET_ID_INVALID", `${field} must be a positive integer`);
  }
  return id;
}

function positiveAmount(value: unknown): Decimal {
  let amount: Decimal;
  try {
    amount = new Decimal(String(value ?? ""));
  } catch {
    throw new PostingValidationError("POSTING_AMOUNT_INVALID", "Transfer amount is invalid");
  }
  if (!amount.isFinite() || amount.lte(0)) {
    throw new PostingValidationError("POSTING_AMOUNT_INVALID", "Transfer amount must be positive");
  }
  return amount;
}

function fingerprint(input: {
  companyId: number;
  voucherType: CompanyTransferVoucherType;
  voucherDate: string;
  description: string | null;
  amount: string;
  debitLedgerAccountId: number;
  creditLedgerAccountId: number;
  sourceType: string;
  sourceSide: CompanyTransferSide;
  transactionCurrency?: "ZMW";
  nativeAmount?: string;
  historicalExchangeRate?: string;
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function buildCompanyTransferPostingRequest(
  input: BuildCompanyTransferPostingInput
): BuiltCompanyTransferPosting {
  const nativeAmount = positiveAmount(input.amount).toFixed();
  const isZmw = input.transactionCurrency === "ZMW";
  if (input.transactionCurrency && input.transactionCurrency !== "USD" && !isZmw) {
    throw new PostingValidationError("POSTING_CURRENCY_INVALID", "Unsupported transfer currency");
  }
  if (isZmw && !input.historicalExchangeRate) {
    throw new PostingValidationError("POSTING_RATE_INVALID", "ZMW transfer needs an approved locked USD/ZMW rate");
  }
  const debitNative = isZmw
    ? normalizeVoucherEntryAmounts({
        transactionCurrency: "ZMW",
        baseCurrency: "USD",
        transactionDebitAmount: nativeAmount,
        transactionCreditAmount: "0",
        historicalRate: input.historicalExchangeRate,
      })
    : null;
  const creditNative = isZmw
    ? normalizeVoucherEntryAmounts({
        transactionCurrency: "ZMW",
        baseCurrency: "USD",
        transactionDebitAmount: "0",
        transactionCreditAmount: nativeAmount,
        historicalRate: input.historicalExchangeRate,
      })
    : null;
  const amount = debitNative?.baseDebitAmount ?? nativeAmount;
  const debitLedgerAccountId = positiveId(input.debitLedgerAccountId, "debitLedgerAccountId");
  const creditLedgerAccountId = positiveId(input.creditLedgerAccountId, "creditLedgerAccountId");
  if (debitLedgerAccountId === creditLedgerAccountId) {
    throw new PostingValidationError("POSTING_TARGET_INVALID", "Transfer debit and credit accounts must be different");
  }

  const clientRequestId = resolveManualJournalClientRequestId(input.clientRequestId);
  const description = input.description?.trim() || null;
  const debitNarration = input.debitNarration?.trim() || description;
  const creditNarration = input.creditNarration?.trim() || description;
  const entries: VoucherEntryInsertFields[] = [
    {
      ledgerAccountId: debitLedgerAccountId,
      debitAmount: amount,
      creditAmount: "0",
      narration: debitNarration,
      ...(debitNative
        ? {
            transactionCurrency: debitNative.transactionCurrency,
            transactionDebitAmount: debitNative.transactionDebitAmount,
            transactionCreditAmount: debitNative.transactionCreditAmount,
            baseDebitAmount: debitNative.baseDebitAmount,
            baseCreditAmount: debitNative.baseCreditAmount,
            historicalExchangeRate: debitNative.historicalExchangeRate,
            rateConvention: debitNative.rateConvention,
          }
        : {}),
    },
    {
      ledgerAccountId: creditLedgerAccountId,
      debitAmount: "0",
      creditAmount: amount,
      narration: creditNarration,
      ...(creditNative
        ? {
            transactionCurrency: creditNative.transactionCurrency,
            transactionDebitAmount: creditNative.transactionDebitAmount,
            transactionCreditAmount: creditNative.transactionCreditAmount,
            baseDebitAmount: creditNative.baseDebitAmount,
            baseCreditAmount: creditNative.baseCreditAmount,
            historicalExchangeRate: creditNative.historicalExchangeRate,
            rateConvention: creditNative.rateConvention,
          }
        : {}),
    },
  ];
  const payloadFingerprint = fingerprint({
    companyId: input.companyId,
    voucherType: input.voucherType,
    voucherDate: input.voucherDate,
    description,
    amount,
    debitLedgerAccountId,
    creditLedgerAccountId,
    sourceType: input.sourceType,
    sourceSide: input.sourceSide,
    ...(isZmw
      ? {
          transactionCurrency: "ZMW" as const,
          nativeAmount,
          historicalExchangeRate: String(input.historicalExchangeRate),
        }
      : {}),
  });

  return {
    clientRequestId,
    amount,
    request: {
      voucher: {
        companyId: input.companyId,
        voucherNumber: input.voucherNumber,
        voucherType: input.voucherType,
        voucherDate: input.voucherDate,
        description,
        totalAmount: amount,
        optional: false,
        ...(isZmw ? { currency: "ZMW", exchangeRate: String(input.historicalExchangeRate) } : {}),
      },
      entries,
      source: {
        sourceType: input.sourceType,
        sourceId: `${clientRequestId}:${input.sourceSide}`,
        // ZMW retries reuse one stable key; a changed amount/rate is then
        // a fingerprint conflict, never a second intercompany posting.
        // Legacy USD/CFA identities retain their exact original format.
        idempotencyKey: isZmw
          ? `${input.sourceType}:${clientRequestId}:${input.sourceSide}:ZMW`
          : `${input.sourceType}:${clientRequestId}:${input.sourceSide}:${payloadFingerprint.slice(0, 32)}`,
      },
      actor: input.actor,
    },
  };
}
