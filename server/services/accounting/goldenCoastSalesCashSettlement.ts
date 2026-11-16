import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import type { CentralPostingRequest, PostingActor } from "./centralPostingEngine";
import { buildGenericVoucherPostingRequest } from "./genericVoucherPosting";
import { GOLDEN_COAST_CUTOVER_DATE } from "./goldenCoastCutoverFifo";
import {
  gcSalesCashPayableAfterPayment,
  gcSalesCashPayableBalance,
  gcSalesCashSettleablePayable,
} from "./goldenCoastSalesCashPayable";

/**
 * Phase 10 is the direct-Golden-Coast alternative to the HADI settlement flow:
 * Golden Coast pays Fresh Start from one of its own Cash/Bank accounts.
 *
 * GC Sales Cash is an operational payable tracker. Fresh Start itself is the
 * residual equity formula in Net Position, so this payment reduces the tracker
 * and a real asset; it does not post directly to the Fresh Start equity ledger.
 *
 * The tracker is credit-normal, so the raw debit-minus-credit ledger figure is
 * the negative of what is still owed; `goldenCoastSalesCashPayable` owns that
 * conversion for every caller. A payment may also carry a transfer fee, which
 * is an expense rather than a reduction of the debt: the payable falls by the
 * settlement alone while the fee is booked to Shared Charges.
 */
export const GOLDEN_COAST_PHASE10_SOURCE_TYPE = "golden-coast-phase10-sales-cash-settlement";
export const GOLDEN_COAST_PHASE10_MAX_REQUEST_ID_LENGTH = 64;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONEY_SCALE = 2;

export type GoldenCoastPhase10ErrorCode =
  | "GC_PHASE10_INPUT_INVALID"
  | "GC_PHASE10_PRE_CUTOVER_DATE"
  | "GC_PHASE10_SETTLEMENT_EXCEEDS_BALANCE"
  | "GC_PHASE10_BALANCE_INVALID";

export class GoldenCoastPhase10SettlementError extends Error {
  readonly code: GoldenCoastPhase10ErrorCode;

  constructor(message: string, code: GoldenCoastPhase10ErrorCode = "GC_PHASE10_INPUT_INVALID") {
    super(releaseDebtEnglish(message));
    this.name = "GoldenCoastPhase10SettlementError";
    this.code = code;
  }
}

export interface GoldenCoastPhase10CashAccount {
  kind: "ledger" | "bank";
  id: number;
}

export interface GoldenCoastPhase10SettlementInput {
  companyId: number;
  settlementDate: string;
  /** Amount applied against the payable. The payable falls by this in full. */
  amountUsd: string;
  /**
   * Bank or transfer fee paid on top of the settlement. It is an expense, never
   * a reduction of what Fresh Start is owed, so it leaves the paying account
   * alongside `amountUsd` and lands in Shared Charges.
   */
  transferFeeUsd: string;
  clientRequestId: string;
  paymentAccount: GoldenCoastPhase10CashAccount;
  reference: string | null;
}

export interface GoldenCoastPhase10SettlementPlan extends GoldenCoastPhase10SettlementInput {
  gcSalesCashDebitBalanceBeforeUsd: string;
  gcSalesCashDebitBalanceAfterUsd: string;
  /** Outstanding payable (credit-normal) before this payment. */
  gcSalesCashPayableBeforeUsd: string;
  /** Outstanding payable after this payment is posted. */
  gcSalesCashPayableAfterUsd: string;
  /** Total leaving the paying cash/bank account: settlement plus fee. */
  cashOutflowUsd: string;
}

function positiveId(value: unknown, field: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new GoldenCoastPhase10SettlementError(`${field} must be a positive integer`);
  }
  return id;
}

function decimal(value: unknown, field: string): Decimal {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new GoldenCoastPhase10SettlementError(`${field} must be a number or numeric string`);
  }
  try {
    const parsed = new Decimal(value);
    if (!parsed.isFinite()) throw new Error("not finite");
    return parsed;
  } catch {
    throw new GoldenCoastPhase10SettlementError(`${field} must be a finite number`);
  }
}

function money(value: Decimal): string {
  return value.toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP).toFixed(MONEY_SCALE);
}

function positiveMoney(value: unknown, field: string): Decimal {
  const parsed = decimal(value, field);
  if (!parsed.greaterThan(0)) {
    throw new GoldenCoastPhase10SettlementError(`${field} must be greater than zero`);
  }
  if (parsed.decimalPlaces() > MONEY_SCALE) {
    throw new GoldenCoastPhase10SettlementError(`${field} supports at most ${MONEY_SCALE} decimal places`);
  }
  return parsed;
}

function nonNegativeMoney(value: unknown, field: string): Decimal {
  const parsed = decimal(value, field);
  if (parsed.lessThan(0)) {
    throw new GoldenCoastPhase10SettlementError(`${field} cannot be negative`);
  }
  if (parsed.decimalPlaces() > MONEY_SCALE) {
    throw new GoldenCoastPhase10SettlementError(`${field} supports at most ${MONEY_SCALE} decimal places`);
  }
  return parsed;
}

function balanceMoney(value: unknown, field: string): Decimal {
  const parsed = decimal(value, field);
  if (parsed.decimalPlaces() > 6) {
    throw new GoldenCoastPhase10SettlementError(`${field} has unsupported precision`, "GC_PHASE10_BALANCE_INVALID");
  }
  return parsed;
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new GoldenCoastPhase10SettlementError(`${field} is required`);
  if (text.length > maxLength) {
    throw new GoldenCoastPhase10SettlementError(`${field} must be at most ${maxLength} characters`);
  }
  return text;
}

function optionalText(value: unknown, field: string, maxLength: number): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new GoldenCoastPhase10SettlementError(`${field} must be a string`);
  const text = value.trim();
  if (!text) return null;
  if (text.length > maxLength) {
    throw new GoldenCoastPhase10SettlementError(`${field} must be at most ${maxLength} characters`);
  }
  return text;
}

function settlementDate(value: unknown): string {
  const text = requiredText(value, "settlementDate", 10);
  if (!ISO_DATE_PATTERN.test(text)) {
    throw new GoldenCoastPhase10SettlementError("settlementDate must be an ISO calendar date (YYYY-MM-DD)");
  }
  const [year, month, day] = text.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new GoldenCoastPhase10SettlementError("settlementDate must be an ISO calendar date (YYYY-MM-DD)");
  }
  if (text < GOLDEN_COAST_CUTOVER_DATE) {
    throw new GoldenCoastPhase10SettlementError(
      `settlementDate cannot be earlier than the Golden Coast cutover date ${GOLDEN_COAST_CUTOVER_DATE}`,
      "GC_PHASE10_PRE_CUTOVER_DATE"
    );
  }
  return text;
}

function clientRequestId(value: unknown): string {
  const text = requiredText(value, "clientRequestId", GOLDEN_COAST_PHASE10_MAX_REQUEST_ID_LENGTH);
  if (!REQUEST_ID_PATTERN.test(text)) {
    throw new GoldenCoastPhase10SettlementError("clientRequestId contains unsupported characters");
  }
  return text;
}

function cashAccount(value: unknown): GoldenCoastPhase10CashAccount {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GoldenCoastPhase10SettlementError("paymentAccount is required");
  }
  const input = value as Record<string, unknown>;
  if (input.kind !== "ledger" && input.kind !== "bank") {
    throw new GoldenCoastPhase10SettlementError('paymentAccount.kind must be "ledger" or "bank"');
  }
  return { kind: input.kind, id: positiveId(input.id, "paymentAccount.id") };
}

/** Parse immutable request data before any mutable balance check. */
export function parseGoldenCoastPhase10SettlementInput(input: {
  companyId: number;
  body: unknown;
}): GoldenCoastPhase10SettlementInput {
  const companyId = positiveId(input.companyId, "companyId");
  if (!input.body || typeof input.body !== "object" || Array.isArray(input.body)) {
    throw new GoldenCoastPhase10SettlementError("A Phase 10 Fresh Start payment request body is required");
  }
  const raw = input.body as Record<string, unknown>;
  return {
    companyId,
    settlementDate: settlementDate(raw.settlementDate),
    amountUsd: money(positiveMoney(raw.amountUsd, "amountUsd")),
    transferFeeUsd: money(nonNegativeMoney(raw.transferFeeUsd ?? "0", "transferFeeUsd")),
    clientRequestId: clientRequestId(raw.clientRequestId),
    // receiptAccount is accepted as a compatibility alias for older clients,
    // but all new UI calls use the correct paymentAccount name.
    paymentAccount: cashAccount(raw.paymentAccount ?? raw.receiptAccount),
    reference: optionalText(raw.reference, "reference", 200),
  };
}

/**
 * GC Sales Cash is credit-normal here: a negative Dr-minus-Cr balance is the
 * amount still payable to Fresh Start. A payment moves the signed balance
 * toward zero by debiting GC Sales Cash. It may be partial, but never clears
 * more than the outstanding payable, and a transfer fee never widens that cap.
 */
export function planGoldenCoastPhase10Settlement(input: {
  settlement: GoldenCoastPhase10SettlementInput;
  gcSalesCashDebitBalanceUsd: string | number;
}): GoldenCoastPhase10SettlementPlan {
  const amount = positiveMoney(input.settlement.amountUsd, "amountUsd");
  const balance = balanceMoney(input.gcSalesCashDebitBalanceUsd, "gcSalesCashDebitBalanceUsd");
  const payable = new Decimal(gcSalesCashSettleablePayable(gcSalesCashPayableBalance(balance.toFixed())));
  if (amount.greaterThan(payable)) {
    throw new GoldenCoastPhase10SettlementError(
      `Payment ${money(amount)} exceeds the current GC Sales Cash payable ${money(payable)}`,
      "GC_PHASE10_SETTLEMENT_EXCEEDS_BALANCE"
    );
  }
  const fee = nonNegativeMoney(input.settlement.transferFeeUsd, "transferFeeUsd");
  return {
    ...input.settlement,
    gcSalesCashDebitBalanceBeforeUsd: money(balance),
    // Only the settlement moves the ledger; the fee funds Shared Charges.
    gcSalesCashDebitBalanceAfterUsd: money(balance.plus(amount)),
    gcSalesCashPayableBeforeUsd: money(payable),
    gcSalesCashPayableAfterUsd: gcSalesCashPayableAfterPayment(payable.toFixed(), amount.toFixed()),
    cashOutflowUsd: money(amount.plus(fee)),
  };
}

export function goldenCoastPhase10SettlementDigest(input: {
  settlement: GoldenCoastPhase10SettlementInput;
  gcSalesCashAccountId: number;
  /** Required whenever the settlement carries a transfer fee. */
  sharedChargesAccountId?: number | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        companyId: input.settlement.companyId,
        settlementDate: input.settlement.settlementDate,
        amountUsd: money(positiveMoney(input.settlement.amountUsd, "amountUsd")),
        transferFeeUsd: money(nonNegativeMoney(input.settlement.transferFeeUsd, "transferFeeUsd")),
        clientRequestId: input.settlement.clientRequestId,
        paymentAccount: input.settlement.paymentAccount,
        reference: input.settlement.reference,
        gcSalesCashAccountId: positiveId(input.gcSalesCashAccountId, "gcSalesCashAccountId"),
        sharedChargesAccountId: input.sharedChargesAccountId ?? null,
      })
    )
    .digest("hex")
    .slice(0, 32);
}

export function goldenCoastPhase10IdempotencyKey(companyId: number, requestId: string): string {
  return `${GOLDEN_COAST_PHASE10_SOURCE_TYPE}:${positiveId(companyId, "companyId")}:${clientRequestId(requestId)}`;
}

export function goldenCoastPhase10SourceId(settlementDigest: string): string {
  const digest = requiredText(settlementDigest, "settlementDigest", 64);
  return `settlement:${digest}`;
}

function cashTarget(account: GoldenCoastPhase10CashAccount): Record<string, number> {
  return account.kind === "bank" ? { bankAccountId: account.id } : { ledgerAccountId: account.id };
}

/**
 * Dr canonical GC Sales Cash / Cr selected Golden Coast Cash/Bank: paying the
 * liability down reduces both the payable and the cash that settles it.
 *
 * A transfer fee never shrinks what Fresh Start is owed, so the payable is
 * still relieved by the full settlement amount and the fee is debited
 * separately to Shared Charges; the paying account carries both:
 *
 *   Dr GC Sales Cash   amountUsd
 *   Dr Shared Charges  transferFeeUsd   (omitted when the fee is zero)
 *   Cr Cash/Bank       amountUsd + transferFeeUsd
 */
export function buildGoldenCoastPhase10SettlementPosting(input: {
  plan: GoldenCoastPhase10SettlementPlan;
  gcSalesCashAccountId: number;
  /** Required whenever the plan carries a non-zero transfer fee. */
  sharedChargesAccountId?: number | null;
  settlementDigest: string;
  exchangeRate?: string | null;
  actor?: PostingActor;
}): CentralPostingRequest {
  const gcSalesCashAccountId = positiveId(input.gcSalesCashAccountId, "gcSalesCashAccountId");
  const fee = nonNegativeMoney(input.plan.transferFeeUsd, "transferFeeUsd");
  const description = releaseDebtEnglish(
    `Fresh Start payment from Golden Coast${input.plan.reference ? ` — ${input.plan.reference}` : ""}`
  );
  const entries: Array<Record<string, unknown>> = [
    {
      ledgerAccountId: gcSalesCashAccountId,
      debitAmount: input.plan.amountUsd,
      creditAmount: "0",
      narration: description,
    },
  ];
  if (fee.greaterThan(0)) {
    const sharedChargesAccountId = positiveId(input.sharedChargesAccountId, "sharedChargesAccountId");
    if (sharedChargesAccountId === gcSalesCashAccountId) {
      throw new GoldenCoastPhase10SettlementError("Shared Charges and GC Sales Cash must resolve to distinct accounts");
    }
    entries.push({
      ledgerAccountId: sharedChargesAccountId,
      debitAmount: input.plan.transferFeeUsd,
      creditAmount: "0",
      narration: releaseDebtEnglish(`Transfer fee on ${description}`),
    });
  }
  entries.push({
    ...cashTarget(input.plan.paymentAccount),
    debitAmount: "0",
    creditAmount: input.plan.cashOutflowUsd,
    narration: description,
  });

  const posting = buildGenericVoucherPostingRequest({
    companyId: input.plan.companyId,
    clientRequestId: input.plan.clientRequestId,
    voucher: {
      voucherNumber: `GC-SCS-C${input.plan.companyId}-${input.plan.clientRequestId}`,
      voucherType: "Payment",
      voucherDate: input.plan.settlementDate,
      description,
      currency: "USD",
    },
    entries,
    exchangeRate: input.exchangeRate ?? null,
    actor: input.actor,
  });

  return {
    ...posting.request,
    source: {
      sourceType: GOLDEN_COAST_PHASE10_SOURCE_TYPE,
      sourceId: goldenCoastPhase10SourceId(input.settlementDigest),
      idempotencyKey: goldenCoastPhase10IdempotencyKey(input.plan.companyId, input.plan.clientRequestId),
    },
  };
}
