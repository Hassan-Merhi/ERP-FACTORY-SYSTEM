import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import type { CentralPostingRequest, PostingActor } from "./centralPostingEngine";
import { buildGenericVoucherPostingRequest } from "./genericVoucherPosting";
import { GOLDEN_COAST_CUTOVER_DATE } from "./goldenCoastCutoverFifo";

export const GOLDEN_COAST_FRESH_START_HADI_PAYMENT_SOURCE_TYPE = "golden-coast-fresh-start-hadi-payment";
const MONEY_SCALE = 2;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

export class GoldenCoastFreshStartHadiPaymentError extends Error {
  constructor(
    message: string,
    readonly code: string = "GC_FRESH_START_HADI_PAYMENT_INVALID"
  ) {
    super(releaseDebtEnglish(message));
    this.name = "GoldenCoastFreshStartHadiPaymentError";
  }
}

export type GoldenCoastFreshStartHadiCashAccount = {
  kind: "ledger" | "bank";
  id: number;
};

export interface GoldenCoastFreshStartHadiPaymentInput {
  companyId: number;
  hadiCompanyId: number;
  paymentDate: string;
  amountUsd: string;
  clientRequestId: string;
  reference: string | null;
  hadiCashAccount: GoldenCoastFreshStartHadiCashAccount;
}

export interface GoldenCoastFreshStartHadiPaymentAccounts {
  gcSalesCashAccountId: number;
  goldenCoastHadiIntercompanyAccountId: number;
  hadiGoldenCoastIntercompanyAccountId: number;
}

export interface GoldenCoastFreshStartHadiPaymentPlan extends GoldenCoastFreshStartHadiPaymentInput {
  gcSalesCashPayableBeforeUsd: string;
  gcSalesCashPayableAfterUsd: string;
  outstandingHadiSalesCashBeforeUsd: string;
  outstandingHadiSalesCashAfterUsd: string;
  hadiIntercompanyAssetBeforeUsd: string;
  hadiIntercompanyAssetAfterUsd: string;
}

function positiveId(value: unknown, field: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0)
    throw new GoldenCoastFreshStartHadiPaymentError(`${field} must be a positive integer`);
  return id;
}

function decimal(value: unknown, field: string): Decimal {
  try {
    const parsed = new Decimal(String(value ?? ""));
    if (!parsed.isFinite()) throw new Error("not finite");
    return parsed;
  } catch {
    throw new GoldenCoastFreshStartHadiPaymentError(`${field} must be a finite number`);
  }
}

function positiveMoney(value: unknown, field: string): Decimal {
  const parsed = decimal(value, field);
  if (!parsed.gt(0)) throw new GoldenCoastFreshStartHadiPaymentError(`${field} must be greater than zero`);
  if (parsed.decimalPlaces() > MONEY_SCALE) {
    throw new GoldenCoastFreshStartHadiPaymentError(`${field} supports at most ${MONEY_SCALE} decimal places`);
  }
  return parsed;
}

function nonNegativeMoney(value: unknown, field: string): Decimal {
  const parsed = decimal(value, field);
  if (parsed.lt(0)) throw new GoldenCoastFreshStartHadiPaymentError(`${field} cannot be negative`);
  return parsed;
}

function money(value: Decimal): string {
  return value.toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP).toFixed(MONEY_SCALE);
}

function parseDate(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!ISO_DATE_PATTERN.test(text)) throw new GoldenCoastFreshStartHadiPaymentError("paymentDate must use YYYY-MM-DD");
  const [year, month, day] = text.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new GoldenCoastFreshStartHadiPaymentError("paymentDate must be a real calendar date");
  }
  if (text < GOLDEN_COAST_CUTOVER_DATE) {
    throw new GoldenCoastFreshStartHadiPaymentError(
      `paymentDate cannot be earlier than the Golden Coast cutover date ${GOLDEN_COAST_CUTOVER_DATE}`
    );
  }
  return text;
}

function parseCashAccount(value: unknown): GoldenCoastFreshStartHadiCashAccount {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GoldenCoastFreshStartHadiPaymentError("hadiCashAccount is required");
  }
  const raw = value as Record<string, unknown>;
  if (raw.kind !== "ledger" && raw.kind !== "bank") {
    throw new GoldenCoastFreshStartHadiPaymentError('hadiCashAccount.kind must be "ledger" or "bank"');
  }
  return { kind: raw.kind, id: positiveId(raw.id, "hadiCashAccount.id") };
}

export function parseGoldenCoastFreshStartHadiPayment(input: {
  companyId: number;
  hadiCompanyId: number;
  body: unknown;
}): GoldenCoastFreshStartHadiPaymentInput {
  const companyId = positiveId(input.companyId, "companyId");
  const hadiCompanyId = positiveId(input.hadiCompanyId, "hadiCompanyId");
  if (companyId === hadiCompanyId) {
    throw new GoldenCoastFreshStartHadiPaymentError("Golden Coast and HADI must be different companies");
  }
  if (!input.body || typeof input.body !== "object" || Array.isArray(input.body)) {
    throw new GoldenCoastFreshStartHadiPaymentError("A payment request body is required");
  }
  const raw = input.body as Record<string, unknown>;
  const clientRequestId = typeof raw.clientRequestId === "string" ? raw.clientRequestId.trim() : "";
  if (!clientRequestId || clientRequestId.length > 64 || !REQUEST_ID_PATTERN.test(clientRequestId)) {
    throw new GoldenCoastFreshStartHadiPaymentError("clientRequestId must be 1-64 supported characters");
  }
  const reference =
    typeof raw.reference === "string" && raw.reference.trim() ? raw.reference.trim().slice(0, 200) : null;
  return {
    companyId,
    hadiCompanyId,
    paymentDate: parseDate(raw.paymentDate),
    amountUsd: money(positiveMoney(raw.amountUsd, "amountUsd")),
    clientRequestId,
    reference,
    hadiCashAccount: parseCashAccount(raw.hadiCashAccount),
  };
}

/**
 * A HADI payment can never exceed any of the three independent caps:
 * 1) GC Sales Cash still owed to Fresh Start,
 * 2) sale cash still tracked as held by HADI, and
 * 3) the actual debit asset on GC's HADI intercompany account.
 */
export function planGoldenCoastFreshStartHadiPayment(input: {
  payment: GoldenCoastFreshStartHadiPaymentInput;
  gcSalesCashPayableUsd: string | number;
  outstandingHadiSalesCashUsd: string | number;
  hadiIntercompanyAssetUsd: string | number;
}): GoldenCoastFreshStartHadiPaymentPlan {
  const amount = positiveMoney(input.payment.amountUsd, "amountUsd");
  const payable = nonNegativeMoney(input.gcSalesCashPayableUsd, "gcSalesCashPayableUsd");
  const outstanding = nonNegativeMoney(input.outstandingHadiSalesCashUsd, "outstandingHadiSalesCashUsd");
  const hadiAsset = nonNegativeMoney(input.hadiIntercompanyAssetUsd, "hadiIntercompanyAssetUsd");
  const maximum = Decimal.min(payable, outstanding, hadiAsset);
  if (amount.gt(maximum)) {
    throw new GoldenCoastFreshStartHadiPaymentError(
      `Fresh Start payment ${money(amount)} exceeds the available payable/HADI balance ${money(maximum)}`,
      "GC_FRESH_START_HADI_PAYMENT_EXCEEDS_AVAILABLE"
    );
  }
  return {
    ...input.payment,
    gcSalesCashPayableBeforeUsd: money(payable),
    gcSalesCashPayableAfterUsd: money(payable.minus(amount)),
    outstandingHadiSalesCashBeforeUsd: money(outstanding),
    outstandingHadiSalesCashAfterUsd: money(outstanding.minus(amount)),
    hadiIntercompanyAssetBeforeUsd: money(hadiAsset),
    hadiIntercompanyAssetAfterUsd: money(hadiAsset.minus(amount)),
  };
}

export function goldenCoastFreshStartHadiPaymentDigest(input: {
  payment: GoldenCoastFreshStartHadiPaymentInput;
  accounts: GoldenCoastFreshStartHadiPaymentAccounts;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({ payment: input.payment, accounts: input.accounts }))
    .digest("hex")
    .slice(0, 32);
}

export function goldenCoastFreshStartHadiPaymentIdempotencyKey(
  companyId: number,
  requestId: string,
  role: "golden_coast" | "hadi"
): string {
  return `${GOLDEN_COAST_FRESH_START_HADI_PAYMENT_SOURCE_TYPE}:${positiveId(companyId, "companyId")}:${requestId}:${role}`;
}

function cashTarget(account: GoldenCoastFreshStartHadiCashAccount): Record<string, number> {
  return account.kind === "bank" ? { bankAccountId: account.id } : { ledgerAccountId: account.id };
}

/**
 * Fresh Start is a residual formula in the balance sheet, so this settlement
 * does not post directly to Fresh Start Equity. It reduces the operational GC
 * Sales Cash payable and the real HADI asset by the same amount. With Hassan
 * unchanged, Fresh Start consequently falls dollar-for-dollar in the residual
 * equity projection.
 */
export function buildGoldenCoastFreshStartHadiPaymentPostings(input: {
  plan: GoldenCoastFreshStartHadiPaymentPlan;
  accounts: GoldenCoastFreshStartHadiPaymentAccounts;
  digest: string;
  goldenCoastExchangeRate: string | null;
  hadiExchangeRate: string | null;
  actor?: PostingActor;
}): Array<{ role: "golden_coast" | "hadi"; request: CentralPostingRequest }> {
  const { plan, accounts } = input;
  positiveId(accounts.gcSalesCashAccountId, "gcSalesCashAccountId");
  positiveId(accounts.goldenCoastHadiIntercompanyAccountId, "goldenCoastHadiIntercompanyAccountId");
  positiveId(accounts.hadiGoldenCoastIntercompanyAccountId, "hadiGoldenCoastIntercompanyAccountId");
  const amount = money(positiveMoney(plan.amountUsd, "amountUsd"));
  const suffix = plan.reference ? ` — ${plan.reference}` : "";
  const gcDescription = releaseDebtEnglish(`HADI paid Fresh Start for Golden Coast${suffix}`);
  const hadiDescription = releaseDebtEnglish(`Fresh Start payment on behalf of Golden Coast${suffix}`);

  const gc = buildGenericVoucherPostingRequest({
    companyId: plan.companyId,
    clientRequestId: plan.clientRequestId,
    voucher: {
      voucherNumber: `GC-FS-HADI-C${plan.companyId}-${plan.clientRequestId}`,
      voucherType: "Journal",
      voucherDate: plan.paymentDate,
      description: gcDescription,
      currency: "USD",
    },
    entries: [
      {
        ledgerAccountId: accounts.gcSalesCashAccountId,
        debitAmount: amount,
        creditAmount: "0",
        narration: gcDescription,
      },
      {
        ledgerAccountId: accounts.goldenCoastHadiIntercompanyAccountId,
        debitAmount: "0",
        creditAmount: amount,
        narration: gcDescription,
      },
    ],
    exchangeRate: input.goldenCoastExchangeRate,
    actor: input.actor,
  });

  const hadi = buildGenericVoucherPostingRequest({
    companyId: plan.hadiCompanyId,
    clientRequestId: plan.clientRequestId,
    voucher: {
      voucherNumber: `GC-FS-HADI-C${plan.companyId}-${plan.clientRequestId}-HADI`,
      voucherType: "Journal",
      voucherDate: plan.paymentDate,
      description: hadiDescription,
      currency: "USD",
    },
    entries: [
      {
        ledgerAccountId: accounts.hadiGoldenCoastIntercompanyAccountId,
        debitAmount: amount,
        creditAmount: "0",
        narration: hadiDescription,
      },
      {
        ...cashTarget(plan.hadiCashAccount),
        debitAmount: "0",
        creditAmount: amount,
        narration: hadiDescription,
      },
    ],
    exchangeRate: input.hadiExchangeRate,
    actor: input.actor,
  });

  const tag = (request: CentralPostingRequest, markerCompanyId: number, role: "golden_coast" | "hadi") => ({
    ...request,
    source: {
      sourceType: GOLDEN_COAST_FRESH_START_HADI_PAYMENT_SOURCE_TYPE,
      sourceId: `payment:${input.digest}:${role}`,
      idempotencyKey: goldenCoastFreshStartHadiPaymentIdempotencyKey(plan.companyId, plan.clientRequestId, role),
    },
    voucher: { ...request.voucher, companyId: markerCompanyId },
  });

  return [
    {
      role: "golden_coast",
      request: tag(gc.request, plan.companyId, "golden_coast"),
    },
    { role: "hadi", request: tag(hadi.request, plan.hadiCompanyId, "hadi") },
  ];
}
