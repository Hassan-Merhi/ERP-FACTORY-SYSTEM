import { createHash } from "node:crypto";
import type {
  WeeklyFlatBonusProposal, WeeklyFlatWorkerProposal,
} from "@shared/productionTargetBonusWeeklyCalculation";

/** Stable, company-bound canonical snapshot for a reviewed week. */
export function weeklyBonusReviewSnapshot(
  companyId: number,
  proposal: WeeklyFlatBonusProposal,
  worker: WeeklyFlatWorkerProposal,
) {
  return {
    companyId,
    weekStart: proposal.weekStart,
    weekEnd: proposal.weekEnd,
    calculationVersion: proposal.calculationVersion,
    workerId: worker.workerId,
    workerName: worker.workerName,
    method: proposal.method,
    methodVersionId: proposal.methodVersionId,
    flatBonusUsd: proposal.flatBonusUsd,
    currency: "USD" as const,
    targetBales: worker.targetBales,
    creditedBales: worker.creditedBales,
    extraBales: worker.extraBales,
    amount: worker.proposedBonusUsd,
    workedDays: worker.workedDays,
    absentDays: worker.absentDays,
    categories: [...worker.categories].sort((a, b) => a.categoryKey.localeCompare(b.categoryKey)),
    days: [...worker.dayBreakdown].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/** PostgreSQL jsonb canonicalizes object keys; hash must survive JSONB round trips. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).sort().map(key =>
      JSON.stringify(key) + ":" + canonicalJson(record[key])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}
export function weeklyBonusReviewToken(snapshot: unknown): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}
