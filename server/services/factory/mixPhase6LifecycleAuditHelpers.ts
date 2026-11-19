// Extracted from ./mixPhase6LifecycleAudit.ts
import Decimal from "decimal.js";

type Value = string | number | null;

export const dec = (x: Value): Decimal => new Decimal(x ?? "0");

export const fixed = (x: Decimal, p = 3): string => x.toDecimalPlaces(p).toFixed(p);

export interface MixLifecycleDbLine {
  id: number;
  batch_code: string;
  status: string;
  batch_date: string | null;
  deleted_at: string | null;
  total_weight_kg: string;
  used_kg: string;
  cost_per_kg: string;
  total_cost: string;
  carry_forward_from_id: number | null;
  parent_id: number | null;
  parent_company_id: number | null;
  parent_status: string | null;
  parent_deleted_at: string | null;
  parent_batch_code: string | null;
  parent_batch_date: string | null;
  parent_cost_per_kg: string | null;
  carry_source_count: string;
  carry_source_kg: string;
  carry_source_usd: string;
  /** Source lines added after the carry (legitimate top-ups). Absent on legacy snapshots. */
  added_source_count?: string | null;
  added_source_kg?: string | null;
  added_source_usd?: string | null;
  daily_usage_count: string;
  daily_usage_kg: string;
  child_count: string;
}

export type MixLifecycleIssueCode =
  | "OVERUSED"
  | "NEGATIVE_USED"
  | "COMPLETED_WITH_REMAINDER"
  | "CLOSED_WITH_REMAINDER"
  | "ACTIVE_WITH_ZERO_REMAINDER"
  | "CARRY_PARENT_MISSING"
  | "CARRY_PARENT_CROSS_COMPANY"
  | "CARRY_PARENT_NOT_CLOSED"
  | "CARRY_PARENT_DELETED"
  | "CARRY_PARENT_SELF"
  | "CARRY_SOURCE_MISSING"
  | "CARRY_SOURCE_INCONSISTENT"
  | "CARRY_RATE_DRIFT"
  | "CARRY_PARENT_DATED_LATER"
  | "DAILY_USAGE_EXCEEDS_RECORDED_TOTAL"
  | "NEGATIVE_OR_ZERO_TOTAL";

export interface MixLifecycleIssue {
  code: MixLifecycleIssueCode;
  severity: "error" | "review" | "informational";
  detail: string;
}

export interface Phase6MixLifecycleRow {
  batchId: number;
  batchCode: string;
  status: string;
  batchDate: string | null;
  deleted: boolean;
  totalKg: string;
  usedKg: string;
  remainingKg: string;
  recordedRateUsdPerKg: string;
  recordedTotalCostUsd: string;
  estimatedRemainingUsd: string;
  carryForwardFromId: number | null;
  parentBatchCode: string | null;
  carrySourceCount: number;
  carrySourceKg: string;
  carrySourceUsd: string;
  childCarryCount: number;
  dailyUsageCount: number;
  dailyUsageKg: string;
  classification: "RECONCILED" | "REQUIRES_REVIEW" | "INVALID_QUANTITY" | "DELETED_HISTORY";
  issues: MixLifecycleIssue[];
  readOnly: true;
}

export interface Phase6MixLifecycleReport {
  companyId: number;
  generatedAt: string;
  readOnly: true;
  summary: {
    allBatches: number;
    activeBatches: number;
    deletedBatches: number;
    completedActiveBatches: number;
    completedWithRemainderBatches: number;
    completedRemainderKg: string;
    completedRemainderPotentialValueUsd: string;
    overusedBatches: number;
    overusedKg: string;
    negativeUsedBatches: number;
    closedWithRemainderBatches: number;
    carryForwardBatches: number;
    carryForwardExceptions: number;
    batchesWithDailyUsage: number;
    invalidQuantityBatches: number;
    evidenceReviewBatches: number;
  };
  batches: Phase6MixLifecycleRow[];
  policy: string[];
}

export const hasIssue = (row: Phase6MixLifecycleRow, code: MixLifecycleIssueCode) =>
  row.issues.some((i) => i.code === code);

export function phase6MixLifecycleCsv(report: Phase6MixLifecycleReport): string {
  const cell = (v: unknown) => {
    const s = String(v ?? "");
    const formula = /^\s*[=+@-]/.test(s) && !/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s.trim());
    return '"' + (formula ? "'" + s : s).replace(/"/g, '""').replace(/\r?\n/g, " ") + '"';
  };
  const rows: unknown[][] = [
    [
      "Batch",
      "Date",
      "Status",
      "Deleted",
      "Total Kg",
      "Used Kg",
      "Remaining Kg",
      "Recorded USD/kg",
      "Recorded USD",
      "Potential Remainder Value (unverified)",
      "Parent Batch ID",
      "Parent Batch Code",
      "Carry Source Count",
      "Carry Source Kg",
      "Carry Source USD",
      "Carry Child Count",
      "Daily Usage Records",
      "Daily Usage Kg",
      "Classification",
      "Issue Codes",
    ],
  ];
  for (const b of report.batches)
    rows.push([
      b.batchCode,
      b.batchDate,
      b.status,
      b.deleted,
      b.totalKg,
      b.usedKg,
      b.remainingKg,
      b.recordedRateUsdPerKg,
      b.recordedTotalCostUsd,
      b.estimatedRemainingUsd,
      b.carryForwardFromId,
      b.parentBatchCode,
      b.carrySourceCount,
      b.carrySourceKg,
      b.carrySourceUsd,
      b.childCarryCount,
      b.dailyUsageCount,
      b.dailyUsageKg,
      b.classification,
      b.issues.map((i) => i.code).join(" | "),
    ]);
  return "\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
