import { createHash } from "node:crypto";
import type { CategoryBonusDayProposal } from "@shared/productionTargetBonusCategoryCalculation";

/** Frozen, deterministic review source: no mutable account, user preferences,
 * timestamp or UI-generated amount. The SHA must match at approval time.
 */
export function categoryReviewSnapshotPayload(
  version: string,
  worker: CategoryBonusDayProposal["workers"][number],
) {
  return {
    calculationVersion: version,
    currency: "USD" as const,
    date: worker.date,
    workerId: worker.workerId,
    workerName: worker.workerName,
    targetBales: worker.targetBales,
    creditedBales: worker.creditedBales,
    extraBales: worker.extraBales,
    bonusUsd: worker.proposedBonusUsd,
    categoryLines: [...worker.lines].sort((a,b)=>a.categoryKey.localeCompare(b.categoryKey))
      .map(line=>({
        categoryKey: line.categoryKey, categoryLabel: line.categoryLabel,
        creditedBales: line.creditedBales, targetBales: line.targetBales,
        extraBales: line.extraBales, rateVersionId: line.rateVersionId,
        rateEffectiveFrom: line.rateEffectiveFrom,
        ratePerExtraBaleUsd: line.ratePerExtraBaleUsd,
        enabled: line.enabled, unroundedBonusUsd: line.unroundedBonusUsd,
      })),
  };
}

export function categoryReviewSnapshotToken(payload: ReturnType<typeof categoryReviewSnapshotPayload>): string {
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}
