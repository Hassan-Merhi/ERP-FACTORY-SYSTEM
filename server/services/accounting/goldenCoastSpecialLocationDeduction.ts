import Decimal from "decimal.js";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import type { CentralPostingRequest, PostingActor } from "./centralPostingEngine";
import { buildGenericVoucherPostingRequest } from "./genericVoucherPosting";
import type { GoldenCoastPhase5SalePlan } from "./goldenCoastPosSale";

export const GOLDEN_COAST_PHASE6_SOURCE_TYPE = "golden-coast-phase6-special-location-deduction";
const MONEY_SCALE = 2;
const RATE_SCALE = 4;

export class GoldenCoastPhase6DeductionError extends Error {
  readonly code: string;

  constructor(message: string, code = "GC_PHASE6_DEDUCTION_INVALID") {
    super(releaseDebtEnglish(message));
    this.name = "GoldenCoastPhase6DeductionError";
    this.code = code;
  }
}

export interface GoldenCoastPhase6DeductionPlan {
  companyId: number;
  locationId: number;
  saleDate: string;
  clientRequestId: string;
  totalQty: string;
  deductionPerQtyUsd: string;
  deductionUsd: string;
}

function positiveId(value: unknown, label: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0)
    throw new GoldenCoastPhase6DeductionError(`${label} must be a positive integer`);
  return id;
}

function decimal(value: unknown, label: string): Decimal {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new GoldenCoastPhase6DeductionError(`${label} must be numeric`);
  }
  try {
    const parsed = new Decimal(value);
    if (!parsed.isFinite()) throw new Error("not finite");
    return parsed;
  } catch {
    throw new GoldenCoastPhase6DeductionError(`${label} must be numeric`);
  }
}

export function planGoldenCoastPhase6SpecialLocationDeduction(input: {
  salePlan: GoldenCoastPhase5SalePlan;
  deductionPerQtyUsd: string | number;
}): GoldenCoastPhase6DeductionPlan | null {
  const companyId = positiveId(input.salePlan.companyId, "companyId");
  const locationId = positiveId(input.salePlan.locationId, "locationId");
  const qty = decimal(input.salePlan.totalQty, "totalQty");
  const rate = decimal(input.deductionPerQtyUsd, "deductionPerQtyUsd");
  const revenue = decimal(input.salePlan.revenueUsd, "revenueUsd");

  if (!qty.greaterThan(0)) throw new GoldenCoastPhase6DeductionError("totalQty must be greater than zero");
  if (rate.lessThan(0)) throw new GoldenCoastPhase6DeductionError("deductionPerQtyUsd cannot be negative");
  if (rate.decimalPlaces() > RATE_SCALE) {
    throw new GoldenCoastPhase6DeductionError(`deductionPerQtyUsd supports at most ${RATE_SCALE} decimal places`);
  }
  if (rate.isZero()) return null;

  const amount = qty.times(rate).toDecimalPlaces(MONEY_SCALE);
  if (!amount.greaterThan(0)) return null;
  if (amount.greaterThan(revenue)) {
    throw new GoldenCoastPhase6DeductionError(
      `Special-location deduction ${amount.toFixed(MONEY_SCALE)} exceeds sale revenue ${revenue.toFixed(MONEY_SCALE)}`,
      "GC_PHASE6_DEDUCTION_EXCEEDS_REVENUE"
    );
  }

  return {
    companyId,
    locationId,
    saleDate: input.salePlan.saleDate,
    clientRequestId: input.salePlan.clientRequestId,
    totalQty: qty.toFixed(4),
    deductionPerQtyUsd: rate.toFixed(RATE_SCALE),
    deductionUsd: amount.toFixed(MONEY_SCALE),
  };
}

export function goldenCoastPhase6IdempotencyKey(companyId: number, requestId: string): string {
  return `${GOLDEN_COAST_PHASE6_SOURCE_TYPE}:${companyId}:${requestId}:special-deduction`;
}

export function goldenCoastPhase6SourceId(input: {
  requestId: string;
  saleDigest: string;
  deductionPerQtyUsd: string;
  deductionUsd: string;
}): string {
  return `${input.requestId}:${input.saleDigest}:special-deduction:${input.deductionPerQtyUsd}:${input.deductionUsd}`;
}

export function buildGoldenCoastPhase6SpecialLocationDeductionPosting(input: {
  plan: GoldenCoastPhase6DeductionPlan;
  gcSalesCashAccountId: number;
  hassanSavingsAccountId: number;
  saleDigest: string;
  exchangeRate: string | null;
  actor?: PostingActor;
}): CentralPostingRequest {
  const { plan } = input;
  const gcSalesCashAccountId = positiveId(input.gcSalesCashAccountId, "gcSalesCashAccountId");
  const hassanSavingsAccountId = positiveId(input.hassanSavingsAccountId, "hassanSavingsAccountId");
  const description = releaseDebtEnglish(
    `Golden Coast special-location deduction — ${plan.totalQty} qty × $${plan.deductionPerQtyUsd}`
  );

  const posting = buildGenericVoucherPostingRequest({
    companyId: plan.companyId,
    clientRequestId: plan.clientRequestId,
    voucher: {
      locationId: plan.locationId,
      voucherNumber: `GC-POS-C${plan.companyId}-${plan.clientRequestId}-DED`,
      voucherType: "Journal",
      voucherDate: plan.saleDate,
      description,
      currency: "USD",
    },
    entries: [
      {
        ledgerAccountId: gcSalesCashAccountId,
        debitAmount: plan.deductionUsd,
        creditAmount: "0",
        narration: description,
      },
      {
        ledgerAccountId: hassanSavingsAccountId,
        debitAmount: "0",
        creditAmount: plan.deductionUsd,
        narration: description,
      },
    ],
    exchangeRate: input.exchangeRate,
    actor: input.actor,
  });

  return {
    ...posting.request,
    source: {
      sourceType: GOLDEN_COAST_PHASE6_SOURCE_TYPE,
      sourceId: goldenCoastPhase6SourceId({
        requestId: plan.clientRequestId,
        saleDigest: input.saleDigest,
        deductionPerQtyUsd: plan.deductionPerQtyUsd,
        deductionUsd: plan.deductionUsd,
      }),
      idempotencyKey: goldenCoastPhase6IdempotencyKey(plan.companyId, plan.clientRequestId),
    },
  };
}
