import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import type { CentralPostingRequest, PostingActor } from "./centralPostingEngine";
import { buildGenericVoucherPostingRequest } from "./genericVoucherPosting";
import { GOLDEN_COAST_CUTOVER_DATE } from "./goldenCoastCutoverFifo";

export const GOLDEN_COAST_PHASE9_SOURCE_TYPE = "golden-coast-phase9-hassan-savings-withdrawal";
export const GOLDEN_COAST_PHASE9_CONFIRMATION = "WITHDRAW HASSAN SAVINGS";
export const GOLDEN_COAST_PHASE9_MAX_REQUEST_ID_LENGTH = 64;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONEY_SCALE = 2;

export type GoldenCoastPhase9ErrorCode =
  | "GC_PHASE9_INPUT_INVALID"
  | "GC_PHASE9_PRE_CUTOVER_DATE"
  | "GC_PHASE9_WITHDRAWAL_EXCEEDS_SAVINGS"
  | "GC_PHASE9_BALANCE_INVALID";

export class GoldenCoastPhase9WithdrawalError extends Error {
  readonly code: GoldenCoastPhase9ErrorCode;

  constructor(message: string, code: GoldenCoastPhase9ErrorCode = "GC_PHASE9_INPUT_INVALID") {
    super(releaseDebtEnglish(message));
    this.name = "GoldenCoastPhase9WithdrawalError";
    this.code = code;
  }
}

export interface GoldenCoastPhase9CashAccount {
  kind: "ledger" | "bank";
  id: number;
}

export interface GoldenCoastPhase9WithdrawalInput {
  companyId: number;
  withdrawalDate: string;
  amountUsd: string;
  clientRequestId: string;
  paymentAccount: GoldenCoastPhase9CashAccount;
  reference: string | null;
  reason: string;
  confirmation: typeof GOLDEN_COAST_PHASE9_CONFIRMATION;
}

export interface GoldenCoastPhase9WithdrawalPlan extends GoldenCoastPhase9WithdrawalInput {
  savingsBalanceBeforeUsd: string;
  savingsBalanceAfterUsd: string;
}

function positiveId(value: unknown, field: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new GoldenCoastPhase9WithdrawalError(`${field} must be a positive integer`);
  }
  return id;
}

function decimal(value: unknown, field: string): Decimal {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new GoldenCoastPhase9WithdrawalError(`${field} must be a number or numeric string`);
  }
  try {
    const parsed = new Decimal(value);
    if (!parsed.isFinite()) throw new Error("not finite");
    return parsed;
  } catch {
    throw new GoldenCoastPhase9WithdrawalError(`${field} must be a finite number`);
  }
}

function money(value: Decimal): string {
  return value.toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP).toFixed(MONEY_SCALE);
}

function positiveMoney(value: unknown, field: string): Decimal {
  const parsed = decimal(value, field);
  if (!parsed.greaterThan(0)) {
    throw new GoldenCoastPhase9WithdrawalError(`${field} must be greater than zero`);
  }
  if (parsed.decimalPlaces() > MONEY_SCALE) {
    throw new GoldenCoastPhase9WithdrawalError(`${field} supports at most ${MONEY_SCALE} decimal places`);
  }
  return parsed;
}

function balanceMoney(value: unknown, field: string): Decimal {
  const parsed = decimal(value, field);
  if (parsed.decimalPlaces() > 6) {
    throw new GoldenCoastPhase9WithdrawalError(`${field} has unsupported precision`, "GC_PHASE9_BALANCE_INVALID");
  }
  return parsed;
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new GoldenCoastPhase9WithdrawalError(`${field} is required`);
  if (text.length > maxLength) {
    throw new GoldenCoastPhase9WithdrawalError(`${field} must be at most ${maxLength} characters`);
  }
  return text;
}

function optionalText(value: unknown, field: string, maxLength: number): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new GoldenCoastPhase9WithdrawalError(`${field} must be a string`);
  const text = value.trim();
  if (!text) return null;
  if (text.length > maxLength) {
    throw new GoldenCoastPhase9WithdrawalError(`${field} must be at most ${maxLength} characters`);
  }
  return text;
}

function withdrawalDate(value: unknown): string {
  const text = requiredText(value, "withdrawalDate", 10);
  if (!ISO_DATE_PATTERN.test(text)) {
    throw new GoldenCoastPhase9WithdrawalError("withdrawalDate must be an ISO calendar date (YYYY-MM-DD)");
  }
  const [year, month, day] = text.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new GoldenCoastPhase9WithdrawalError("withdrawalDate must be an ISO calendar date (YYYY-MM-DD)");
  }
  if (text < GOLDEN_COAST_CUTOVER_DATE) {
    throw new GoldenCoastPhase9WithdrawalError(
      `withdrawalDate cannot be earlier than the Golden Coast cutover date ${GOLDEN_COAST_CUTOVER_DATE}`,
      "GC_PHASE9_PRE_CUTOVER_DATE"
    );
  }
  return text;
}

function clientRequestId(value: unknown): string {
  const text = requiredText(value, "clientRequestId", GOLDEN_COAST_PHASE9_MAX_REQUEST_ID_LENGTH);
  if (!REQUEST_ID_PATTERN.test(text)) {
    throw new GoldenCoastPhase9WithdrawalError("clientRequestId contains unsupported characters");
  }
  return text;
}

function cashAccount(value: unknown): GoldenCoastPhase9CashAccount {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GoldenCoastPhase9WithdrawalError("paymentAccount is required");
  }
  const input = value as Record<string, unknown>;
  if (input.kind !== "ledger" && input.kind !== "bank") {
    throw new GoldenCoastPhase9WithdrawalError('paymentAccount.kind must be "ledger" or "bank"');
  }
  return { kind: input.kind, id: positiveId(input.id, "paymentAccount.id") };
}

export function parseGoldenCoastPhase9WithdrawalInput(input: {
  companyId: number;
  body: unknown;
}): GoldenCoastPhase9WithdrawalInput {
  const companyId = positiveId(input.companyId, "companyId");
  if (!input.body || typeof input.body !== "object" || Array.isArray(input.body)) {
    throw new GoldenCoastPhase9WithdrawalError("A Phase 9 withdrawal request body is required");
  }
  const raw = input.body as Record<string, unknown>;
  const confirmation = requiredText(raw.confirmation, "confirmation", 64);
  if (confirmation !== GOLDEN_COAST_PHASE9_CONFIRMATION) {
    throw new GoldenCoastPhase9WithdrawalError(`confirmation must be exactly: ${GOLDEN_COAST_PHASE9_CONFIRMATION}`);
  }
  const reason = requiredText(raw.reason, "reason", 500);
  if (reason.length < 5) {
    throw new GoldenCoastPhase9WithdrawalError("reason must be at least 5 characters");
  }

  return {
    companyId,
    withdrawalDate: withdrawalDate(raw.withdrawalDate),
    amountUsd: money(positiveMoney(raw.amountUsd, "amountUsd")),
    clientRequestId: clientRequestId(raw.clientRequestId),
    paymentAccount: cashAccount(raw.paymentAccount),
    reference: optionalText(raw.reference, "reference", 200),
    reason,
    confirmation: GOLDEN_COAST_PHASE9_CONFIRMATION,
  };
}

export function planGoldenCoastPhase9Withdrawal(input: {
  withdrawal: GoldenCoastPhase9WithdrawalInput;
  savingsBalanceUsd: string | number;
}): GoldenCoastPhase9WithdrawalPlan {
  const amount = positiveMoney(input.withdrawal.amountUsd, "amountUsd");
  const balance = balanceMoney(input.savingsBalanceUsd, "savingsBalanceUsd");
  if (balance.lessThan(0)) {
    throw new GoldenCoastPhase9WithdrawalError(
      "Hassan Savings has a negative credit balance; reconcile the account before withdrawing",
      "GC_PHASE9_BALANCE_INVALID"
    );
  }
  if (amount.greaterThan(balance)) {
    throw new GoldenCoastPhase9WithdrawalError(
      `Withdrawal ${money(amount)} exceeds the available Hassan Savings balance ${money(balance)}`,
      "GC_PHASE9_WITHDRAWAL_EXCEEDS_SAVINGS"
    );
  }
  return {
    ...input.withdrawal,
    savingsBalanceBeforeUsd: money(balance),
    savingsBalanceAfterUsd: money(balance.minus(amount)),
  };
}

export function goldenCoastPhase9WithdrawalDigest(input: {
  withdrawal: GoldenCoastPhase9WithdrawalInput;
  hassanSavingsAccountId: number;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        companyId: input.withdrawal.companyId,
        withdrawalDate: input.withdrawal.withdrawalDate,
        amountUsd: money(positiveMoney(input.withdrawal.amountUsd, "amountUsd")),
        clientRequestId: input.withdrawal.clientRequestId,
        paymentAccount: input.withdrawal.paymentAccount,
        reference: input.withdrawal.reference,
        reason: input.withdrawal.reason,
        hassanSavingsAccountId: positiveId(input.hassanSavingsAccountId, "hassanSavingsAccountId"),
      })
    )
    .digest("hex")
    .slice(0, 32);
}

export function goldenCoastPhase9IdempotencyKey(companyId: number, requestId: string): string {
  return `${GOLDEN_COAST_PHASE9_SOURCE_TYPE}:${positiveId(companyId, "companyId")}:${clientRequestId(requestId)}`;
}

export function goldenCoastPhase9SourceId(withdrawalDigest: string): string {
  const digest = requiredText(withdrawalDigest, "withdrawalDigest", 64);
  return `withdrawal:${digest}`;
}

function cashTarget(account: GoldenCoastPhase9CashAccount): Record<string, number> {
  return account.kind === "bank" ? { bankAccountId: account.id } : { ledgerAccountId: account.id };
}

export function buildGoldenCoastPhase9WithdrawalPosting(input: {
  plan: GoldenCoastPhase9WithdrawalPlan;
  hassanSavingsAccountId: number;
  withdrawalDigest: string;
  exchangeRate?: string | null;
  actor?: PostingActor;
}): CentralPostingRequest {
  const hassanSavingsAccountId = positiveId(input.hassanSavingsAccountId, "hassanSavingsAccountId");
  const description = releaseDebtEnglish(
    `Hassan Savings withdrawal${input.plan.reference ? ` — ${input.plan.reference}` : ""}`
  );
  const posting = buildGenericVoucherPostingRequest({
    companyId: input.plan.companyId,
    clientRequestId: input.plan.clientRequestId,
    voucher: {
      voucherNumber: `GC-HSW-C${input.plan.companyId}-${input.plan.clientRequestId}`,
      voucherType: "Payment",
      voucherDate: input.plan.withdrawalDate,
      description,
      currency: "USD",
    },
    entries: [
      {
        ledgerAccountId: hassanSavingsAccountId,
        debitAmount: input.plan.amountUsd,
        creditAmount: "0",
        narration: description,
      },
      {
        ...cashTarget(input.plan.paymentAccount),
        debitAmount: "0",
        creditAmount: input.plan.amountUsd,
        narration: description,
      },
    ],
    exchangeRate: input.exchangeRate ?? null,
    actor: input.actor,
  });

  return {
    ...posting.request,
    source: {
      sourceType: GOLDEN_COAST_PHASE9_SOURCE_TYPE,
      sourceId: goldenCoastPhase9SourceId(input.withdrawalDigest),
      idempotencyKey: goldenCoastPhase9IdempotencyKey(input.plan.companyId, input.plan.clientRequestId),
    },
  };
}
