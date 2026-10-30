import Decimal from "decimal.js";
import { isBonusCategoryDate, parseBonusCategoryRate, resolveBonusCategoryRate,
  type ProductionBonusCategoryRateVersion } from "./productionTargetBonusCategoryRates";
import { validateCategoryTargetSplit, type CreditedCategory,
  type CategoryWorkerEvidence, type CategoryEvidenceIssue } from "./productionTargetBonusCategoryAttribution";

export interface CategoryEvidenceForCalculation {
  productionDate: string;
  finalized: boolean;
  captured: boolean;
  readyForTargetAllocation: boolean;
  issues: CategoryEvidenceIssue[];
  workers: Array<CategoryWorkerEvidence & { status: "Present" | "Absent" | "New" }>;
  allocations: Array<{
    workerId: number; categoryKey: string; categoryLabel: string;
    creditedBales: number; targetBales: number;
  }>;
}

export const CATEGORY_BONUS_CALCULATION_VERSION = "production-target-category-v1" as const;

export type CategoryBonusBlockReason =
  | "DAY_NOT_FINALIZED"
  | "UNVERIFIED_CATEGORY_EVIDENCE"
  | "NO_DAILY_TARGET"
  | "INVALID_DAILY_TARGET"
  | "WORKER_ABSENT"
  | "MISSING_CATEGORY_ALLOCATION"
  | "ALLOCATION_MISMATCH"
  | "CREDIT_MISMATCH"
  | "MISSING_CATEGORY_RATE"
  | "INVALID_CATEGORY_RATE"
  | "EXISTING_BONUS_REVIEW";

export interface CategoryBonusLine {
  categoryKey: string;
  categoryLabel: string;
  creditedBales: number;
  targetBales: string;
  extraBales: string;
  enabled: boolean;
  rateVersionId: number | null;
  rateEffectiveFrom: string | null;
  ratePerExtraBaleUsd: string | null;
  /** Six decimal places, before worker-level cent rounding (2dp bale targets × 4dp rates). */
  unroundedBonusUsd: string;
  issue: "NO_RATE" | "INVALID_RATE" | "RATE_DISABLED" | null;
}

export interface CategoryBonusWorkerProposal {
  workerId: number;
  workerName: string | null;
  date: string;
  targetBales: string | null;
  creditedBales: number;
  extraBales: string;
  lines: CategoryBonusLine[];
  proposedBonusUsd: string;
  blocked: boolean;
  reasons: CategoryBonusBlockReason[];
  legacyReviewStatus: "approved" | "rejected" | null;
}

export interface CategoryBonusDayProposal {
  date: string;
  currency: "USD";
  calculationVersion: typeof CATEGORY_BONUS_CALCULATION_VERSION;
  proposalOnly: true;
  canApprove: false;
  canPost: false;
  finalized: boolean;
  evidenceVerified: boolean;
  workers: CategoryBonusWorkerProposal[];
  totalProposedBonusUsd: string;
  blockedWorkerCount: number;
}

export interface CategoryBonusAllocation {
  workerId: number;
  categoryKey: string;
  categoryLabel: string;
  creditedBales: number;
  targetBales: number;
}

function validTarget(value: number): boolean {
  return Number.isFinite(value) && value >= 0 &&
    Number.isSafeInteger(Math.round(value * 100)) &&
    Math.abs(Math.round(value * 100) - value * 100) < 0.000001;
}

/** Category-level rates must never fall back to a whole-day worker rate:
 * that silently misprices a worker who switches categories mid-day.
 *
 * The calculation is proposal-only, even for an otherwise valid day.
 * A pre-existing worker/day approval hard-blocks the new calculation to
 * prevent dual claims for the same person, source and production date.
 */
export function calculateCategoryBonusDay(
  input: CategoryEvidenceForCalculation,
  rates: ProductionBonusCategoryRateVersion[],
  legacyReviews: ReadonlyMap<number, "approved" | "rejected"> = new Map(),
): CategoryBonusDayProposal {
  if (!isBonusCategoryDate(input.productionDate)) throw new Error("Invalid production date");
  const workers: CategoryBonusWorkerProposal[] = input.workers.map(worker => {
    const reasons = new Set<CategoryBonusBlockReason>();
    if (!input.finalized) reasons.add("DAY_NOT_FINALIZED");
    if (!input.readyForTargetAllocation || !input.captured || input.issues.length || worker.issues.length)
      reasons.add("UNVERIFIED_CATEGORY_EVIDENCE");
    if (worker.dailyTargetBales === null) reasons.add("NO_DAILY_TARGET");
    else if (!validTarget(worker.dailyTargetBales) || worker.dailyTargetBales === 0)
      reasons.add("INVALID_DAILY_TARGET");
    if (worker.status === "Absent") reasons.add("WORKER_ABSENT");

    const legacyReviewStatus = legacyReviews.get(worker.workerId) ?? null;
    if (legacyReviewStatus) reasons.add("EXISTING_BONUS_REVIEW");

    const allocated = input.allocations.filter(row => row.workerId === worker.workerId);
    if (!allocated.length) reasons.add("MISSING_CATEGORY_ALLOCATION");
    const creditedSum = worker.categories.reduce((sum, cat) => sum + cat.creditedBales, 0);
    if (creditedSum !== worker.creditedBales) reasons.add("CREDIT_MISMATCH");

    const split = allocated.map(row => ({ categoryKey: row.categoryKey, targetBales: row.targetBales }));
    const splitIssue = worker.dailyTargetBales !== null
      ? validateCategoryTargetSplit(worker.dailyTargetBales, worker.categories, split)
      : "No saved daily target";
    if (allocated.length && splitIssue) reasons.add("ALLOCATION_MISMATCH");
    const allocationByKey = new Map(allocated.map(row => [row.categoryKey, row]));
    for (const cat of worker.categories) {
      const historical = allocationByKey.get(cat.categoryKey);
      if (historical && historical.creditedBales !== cat.creditedBales) reasons.add("CREDIT_MISMATCH");
    }

    const lines: CategoryBonusLine[] = worker.categories.map((cat: CreditedCategory) => {
      const allocation = allocationByKey.get(cat.categoryKey);
      const creditedBales = cat.creditedBales;
      const target = allocation?.targetBales ?? 0;
      const extra = allocation && validTarget(target)
        ? Decimal.max(new Decimal(creditedBales).minus(target), 0) : new Decimal(0);
      const rate = resolveBonusCategoryRate(cat.categoryKey, input.productionDate, rates);
      let issue: CategoryBonusLine["issue"] = null;
      let amount = new Decimal(0);
      let safeRate: string | null = null;
      if (extra.greaterThan(0)) {
        if (!rate) {
          issue = "NO_RATE";
          reasons.add("MISSING_CATEGORY_RATE");
        } else {
          safeRate = parseBonusCategoryRate(rate.ratePerExtraBale);
          if (safeRate === null) {
            issue = "INVALID_RATE";
            reasons.add("INVALID_CATEGORY_RATE");
          } else if (!rate.enabled) {
            issue = "RATE_DISABLED";
          } else if (new Decimal(safeRate).greaterThan(0)) {
            amount = extra.times(safeRate);
          } else {
            issue = "RATE_DISABLED";
          }
        }
      } else if (rate) safeRate = parseBonusCategoryRate(rate.ratePerExtraBale);
      return {
        categoryKey: cat.categoryKey, categoryLabel: cat.categoryLabel,
        creditedBales, targetBales: allocation ? new Decimal(target).toFixed(2) : "0.00",
        extraBales: extra.toFixed(2), enabled: Boolean(rate?.enabled && safeRate && Number(safeRate)>0),
        rateVersionId: rate?.id ?? null, rateEffectiveFrom: rate?.effectiveFrom ?? null,
        ratePerExtraBaleUsd: safeRate,
        unroundedBonusUsd: amount.toFixed(6), issue,
      };
    });
    const blocked = reasons.size > 0;
    const raw = lines.reduce((sum, line) => sum.plus(line.unroundedBonusUsd), new Decimal(0));
    const sumExtra = lines.reduce((sum, line) => sum.plus(line.extraBales), new Decimal(0));
    return {
      workerId: worker.workerId, workerName: worker.workerName ?? null,
      date: input.productionDate,
      targetBales: worker.dailyTargetBales == null ? null : new Decimal(worker.dailyTargetBales).toFixed(2),
      creditedBales: worker.creditedBales,
      extraBales: sumExtra.toFixed(2),
      lines,
      // Preserve the existing cents-round-at-worker-day convention.
      proposedBonusUsd: blocked ? "0.00" : raw.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
      blocked, reasons: [...reasons], legacyReviewStatus,
    };
  });
  return {
    date: input.productionDate, currency: "USD",
    calculationVersion: CATEGORY_BONUS_CALCULATION_VERSION,
    proposalOnly: true, canApprove: false, canPost: false,
    finalized: input.finalized, evidenceVerified: input.readyForTargetAllocation,
    workers, totalProposedBonusUsd: workers.reduce(
      (sum, worker) => sum.plus(worker.proposedBonusUsd), new Decimal(0),
    ).toFixed(2),
    blockedWorkerCount: workers.filter(worker => worker.blocked).length,
  };
}
