import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import type { CentralPostingRequest, PostingActor } from "./centralPostingEngine";
import { buildGenericVoucherPostingRequest } from "./genericVoucherPosting";
import { GOLDEN_COAST_CUTOVER_DATE } from "./goldenCoastPhase4CutoverFifo";
import { gcSalesCashPayableAfterPayment } from "./goldenCoastSalesCashPayable";

/**
 * Golden Coast — settling GC Sales Cash out of Hassan's own equity.
 *
 * Phase 10 already pays the GC Sales Cash payable with real money, so it
 * credits a cash or bank account. This path is the no-cash alternative Hassan
 * asked for: he funds the payment from his own partner capital instead.
 *
 * GC Sales Cash and Hassan Dakik Equity are both credit-normal, and both have
 * to move DOWN, so both are debited and Fresh Start FZ Equity is the balancing
 * credit:
 *
 *   Dr GC Sales Cash        amountUsd
 *   Dr Hassan Dakik Equity  amountUsd
 *   Cr Fresh Start FZ Equity  2 x amountUsd
 *
 * That plug is not arbitrary — it is what keeps the partners whole. Fresh Start
 * gives up a payable of `amountUsd` and receives `amountUsd` of equity for it,
 * and separately receives the `amountUsd` of equity Hassan gave up, so Fresh
 * Start's total claim rises by exactly what Hassan's falls by and total
 * equity-plus-liabilities is unchanged. No asset moves, which is precisely why
 * no cash or bank account appears in the journal.
 */
export const GOLDEN_COAST_EQUITY_SALES_CASH_SOURCE_TYPE = "golden-coast-equity-sales-cash-settlement";
export const GOLDEN_COAST_EQUITY_SALES_CASH_CONFIRMATION = "SETTLE SALES CASH FROM EQUITY";
export const GOLDEN_COAST_EQUITY_SALES_CASH_MAX_REQUEST_ID_LENGTH = 64;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONEY_SCALE = 2;

export type GoldenCoastEquitySalesCashErrorCode =
  | "GC_EQUITY_SALES_CASH_INPUT_INVALID"
  | "GC_EQUITY_SALES_CASH_PRE_CUTOVER_DATE"
  | "GC_EQUITY_SALES_CASH_EXCEEDS_PAYABLE"
  | "GC_EQUITY_SALES_CASH_EXCEEDS_EQUITY"
  | "GC_EQUITY_SALES_CASH_BALANCE_INVALID";

export class GoldenCoastEquitySalesCashError extends Error {
  readonly code: GoldenCoastEquitySalesCashErrorCode;

  constructor(message: string, code: GoldenCoastEquitySalesCashErrorCode = "GC_EQUITY_SALES_CASH_INPUT_INVALID") {
    super(releaseDebtEnglish(message));
    this.name = "GoldenCoastEquitySalesCashError";
    this.code = code;
  }
}

export interface GoldenCoastEquitySalesCashInput {
  companyId: number;
  settlementDate: string;
  amountUsd: string;
  clientRequestId: string;
  reference: string | null;
  reason: string;
  confirmation: typeof GOLDEN_COAST_EQUITY_SALES_CASH_CONFIRMATION;
}

export interface GoldenCoastEquitySalesCashPlan extends GoldenCoastEquitySalesCashInput {
  gcSalesCashPayableBeforeUsd: string;
  gcSalesCashPayableAfterUsd: string;
  hassanEquityBeforeUsd: string;
  hassanEquityAfterUsd: string;
  /** The balancing credit: both debits land on Fresh Start FZ Equity. */
  freshStartEquityCreditUsd: string;
}

export interface GoldenCoastEquitySalesCashAccounts {
  gcSalesCashAccountId: number;
  hassanEquityAccountId: number;
  freshStartEquityAccountId: number;
}

function positiveId(value: unknown, field: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new GoldenCoastEquitySalesCashError(`${field} must be a positive integer`);
  }
  return id;
}

function decimal(value: unknown, field: string): Decimal {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new GoldenCoastEquitySalesCashError(`${field} must be a number or numeric string`);
  }
  try {
    const parsed = new Decimal(value);
    if (!parsed.isFinite()) throw new Error("not finite");
    return parsed;
  } catch {
    throw new GoldenCoastEquitySalesCashError(`${field} must be a finite number`);
  }
}

function money(value: Decimal): string {
  return value.toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP).toFixed(MONEY_SCALE);
}

function positiveMoney(value: unknown, field: string): Decimal {
  const parsed = decimal(value, field);
  if (!parsed.greaterThan(0)) {
    throw new GoldenCoastEquitySalesCashError(`${field} must be greater than zero`);
  }
  if (parsed.decimalPlaces() > MONEY_SCALE) {
    throw new GoldenCoastEquitySalesCashError(`${field} supports at most ${MONEY_SCALE} decimal places`);
  }
  return parsed;
}

function balanceMoney(value: unknown, field: string): Decimal {
  const parsed = decimal(value, field);
  if (parsed.decimalPlaces() > 6) {
    throw new GoldenCoastEquitySalesCashError(
      `${field} has unsupported precision`,
      "GC_EQUITY_SALES_CASH_BALANCE_INVALID"
    );
  }
  return parsed;
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new GoldenCoastEquitySalesCashError(`${field} is required`);
  if (text.length > maxLength) {
    throw new GoldenCoastEquitySalesCashError(`${field} must be at most ${maxLength} characters`);
  }
  return text;
}

function optionalText(value: unknown, field: string, maxLength: number): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new GoldenCoastEquitySalesCashError(`${field} must be a string`);
  const text = value.trim();
  if (!text) return null;
  if (text.length > maxLength) {
    throw new GoldenCoastEquitySalesCashError(`${field} must be at most ${maxLength} characters`);
  }
  return text;
}

function settlementDate(value: unknown): string {
  const text = requiredText(value, "settlementDate", 10);
  if (!ISO_DATE_PATTERN.test(text)) {
    throw new GoldenCoastEquitySalesCashError("settlementDate must be an ISO calendar date (YYYY-MM-DD)");
  }
  const [year, month, day] = text.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new GoldenCoastEquitySalesCashError("settlementDate must be an ISO calendar date (YYYY-MM-DD)");
  }
  if (text < GOLDEN_COAST_CUTOVER_DATE) {
    throw new GoldenCoastEquitySalesCashError(
      `settlementDate cannot be earlier than the Golden Coast cutover date ${GOLDEN_COAST_CUTOVER_DATE}`,
      "GC_EQUITY_SALES_CASH_PRE_CUTOVER_DATE"
    );
  }
  return text;
}

function clientRequestId(value: unknown): string {
  const text = requiredText(value, "clientRequestId", GOLDEN_COAST_EQUITY_SALES_CASH_MAX_REQUEST_ID_LENGTH);
  if (!REQUEST_ID_PATTERN.test(text)) {
    throw new GoldenCoastEquitySalesCashError("clientRequestId contains unsupported characters");
  }
  return text;
}

export function parseGoldenCoastEquitySalesCashInput(input: {
  companyId: number;
  body: unknown;
}): GoldenCoastEquitySalesCashInput {
  const companyId = positiveId(input.companyId, "companyId");
  if (!input.body || typeof input.body !== "object" || Array.isArray(input.body)) {
    throw new GoldenCoastEquitySalesCashError("An equity sales-cash settlement request body is required");
  }
  const raw = input.body as Record<string, unknown>;
  const confirmation = requiredText(raw.confirmation, "confirmation", 64);
  if (confirmation !== GOLDEN_COAST_EQUITY_SALES_CASH_CONFIRMATION) {
    throw new GoldenCoastEquitySalesCashError(
      `confirmation must be exactly: ${GOLDEN_COAST_EQUITY_SALES_CASH_CONFIRMATION}`
    );
  }
  const reason = requiredText(raw.reason, "reason", 500);
  if (reason.length < 5) {
    throw new GoldenCoastEquitySalesCashError("reason must be at least 5 characters");
  }

  return {
    companyId,
    settlementDate: settlementDate(raw.settlementDate),
    amountUsd: money(positiveMoney(raw.amountUsd, "amountUsd")),
    clientRequestId: clientRequestId(raw.clientRequestId),
    reference: optionalText(raw.reference, "reference", 200),
    reason,
    confirmation: GOLDEN_COAST_EQUITY_SALES_CASH_CONFIRMATION,
  };
}

/**
 * Two independent ceilings apply, because two credit-normal balances are being
 * drawn down at once: the settlement can never clear more than Fresh Start is
 * actually owed, and it can never push Hassan's capital negative.
 *
 * Both inputs are already credit-normal (credits minus debits) — callers
 * convert the raw signed GC Sales Cash ledger figure through
 * `gcSalesCashPayableBalance` before getting here.
 */
export function planGoldenCoastEquitySalesCashSettlement(input: {
  settlement: GoldenCoastEquitySalesCashInput;
  gcSalesCashPayableUsd: string | number;
  hassanEquityCreditBalanceUsd: string | number;
}): GoldenCoastEquitySalesCashPlan {
  const amount = positiveMoney(input.settlement.amountUsd, "amountUsd");
  const payable = balanceMoney(input.gcSalesCashPayableUsd, "gcSalesCashPayableUsd");
  const equity = balanceMoney(input.hassanEquityCreditBalanceUsd, "hassanEquityCreditBalanceUsd");

  if (amount.greaterThan(payable)) {
    throw new GoldenCoastEquitySalesCashError(
      `Settlement ${money(amount)} exceeds the current GC Sales Cash payable ${money(Decimal.max(payable, 0))}`,
      "GC_EQUITY_SALES_CASH_EXCEEDS_PAYABLE"
    );
  }
  if (equity.lessThan(0)) {
    throw new GoldenCoastEquitySalesCashError(
      "Hassan Dakik Equity carries a debit balance; reconcile the account before settling from it",
      "GC_EQUITY_SALES_CASH_BALANCE_INVALID"
    );
  }
  if (amount.greaterThan(equity)) {
    throw new GoldenCoastEquitySalesCashError(
      `Settlement ${money(amount)} exceeds the available Hassan Dakik Equity balance ${money(equity)}`,
      "GC_EQUITY_SALES_CASH_EXCEEDS_EQUITY"
    );
  }

  return {
    ...input.settlement,
    gcSalesCashPayableBeforeUsd: money(payable),
    gcSalesCashPayableAfterUsd: gcSalesCashPayableAfterPayment(payable.toFixed(), amount.toFixed()),
    hassanEquityBeforeUsd: money(equity),
    hassanEquityAfterUsd: money(equity.minus(amount)),
    freshStartEquityCreditUsd: money(amount.times(2)),
  };
}

function accountIds(accounts: GoldenCoastEquitySalesCashAccounts): GoldenCoastEquitySalesCashAccounts {
  const resolved = {
    gcSalesCashAccountId: positiveId(accounts.gcSalesCashAccountId, "gcSalesCashAccountId"),
    hassanEquityAccountId: positiveId(accounts.hassanEquityAccountId, "hassanEquityAccountId"),
    freshStartEquityAccountId: positiveId(accounts.freshStartEquityAccountId, "freshStartEquityAccountId"),
  };
  const distinct = new Set(Object.values(resolved));
  if (distinct.size !== 3) {
    throw new GoldenCoastEquitySalesCashError(
      "GC Sales Cash, Hassan Dakik Equity and Fresh Start FZ Equity must resolve to three distinct accounts"
    );
  }
  return resolved;
}

export function goldenCoastEquitySalesCashDigest(input: {
  settlement: GoldenCoastEquitySalesCashInput;
  accounts: GoldenCoastEquitySalesCashAccounts;
}): string {
  const accounts = accountIds(input.accounts);
  return createHash("sha256")
    .update(
      JSON.stringify({
        companyId: input.settlement.companyId,
        settlementDate: input.settlement.settlementDate,
        amountUsd: money(positiveMoney(input.settlement.amountUsd, "amountUsd")),
        clientRequestId: input.settlement.clientRequestId,
        reference: input.settlement.reference,
        reason: input.settlement.reason,
        ...accounts,
      })
    )
    .digest("hex")
    .slice(0, 32);
}

export function goldenCoastEquitySalesCashIdempotencyKey(companyId: number, requestId: string): string {
  return `${GOLDEN_COAST_EQUITY_SALES_CASH_SOURCE_TYPE}:${positiveId(companyId, "companyId")}:${clientRequestId(
    requestId
  )}`;
}

export function goldenCoastEquitySalesCashSourceId(settlementDigest: string): string {
  const digest = requiredText(settlementDigest, "settlementDigest", 64);
  return `equity-settlement:${digest}`;
}

export function buildGoldenCoastEquitySalesCashPosting(input: {
  plan: GoldenCoastEquitySalesCashPlan;
  accounts: GoldenCoastEquitySalesCashAccounts;
  settlementDigest: string;
  exchangeRate?: string | null;
  actor?: PostingActor;
}): CentralPostingRequest {
  const accounts = accountIds(input.accounts);
  const description = releaseDebtEnglish(
    `GC Sales Cash settled from Hassan Dakik Equity${input.plan.reference ? ` — ${input.plan.reference}` : ""}`
  );
  const posting = buildGenericVoucherPostingRequest({
    companyId: input.plan.companyId,
    clientRequestId: input.plan.clientRequestId,
    voucher: {
      voucherNumber: `GC-ESC-C${input.plan.companyId}-${input.plan.clientRequestId}`,
      voucherType: "Journal",
      voucherDate: input.plan.settlementDate,
      description,
      currency: "USD",
    },
    entries: [
      {
        ledgerAccountId: accounts.gcSalesCashAccountId,
        debitAmount: input.plan.amountUsd,
        creditAmount: "0",
        narration: description,
      },
      {
        ledgerAccountId: accounts.hassanEquityAccountId,
        debitAmount: input.plan.amountUsd,
        creditAmount: "0",
        narration: description,
      },
      {
        ledgerAccountId: accounts.freshStartEquityAccountId,
        debitAmount: "0",
        creditAmount: input.plan.freshStartEquityCreditUsd,
        narration: description,
      },
    ],
    exchangeRate: input.exchangeRate ?? null,
    actor: input.actor,
  });

  return {
    ...posting.request,
    source: {
      sourceType: GOLDEN_COAST_EQUITY_SALES_CASH_SOURCE_TYPE,
      sourceId: goldenCoastEquitySalesCashSourceId(input.settlementDigest),
      idempotencyKey: goldenCoastEquitySalesCashIdempotencyKey(input.plan.companyId, input.plan.clientRequestId),
    },
  };
}
