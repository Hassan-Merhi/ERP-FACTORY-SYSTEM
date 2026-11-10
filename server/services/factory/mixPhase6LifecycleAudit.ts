/**
 * Phase 6 factory mix completion and carry-forward evidence.
 *
 * Snapshot only. No SQL writes, no implied write-offs, and no fictitious
 * carry-forward batch creation for historical completed mixes.
 */
import Decimal from "decimal.js";
import { pool } from "../../db";

type Value = string | number | null;
const dec = (x: Value): Decimal => new Decimal(x ?? "0");
const fixed = (x: Decimal, p = 3): string => x.toDecimalPlaces(p).toFixed(p);
const KG = new Decimal("0.001");
const USD = new Decimal("0.02");

interface MixLifecycleDbLine {
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

export function classifyMixLifecycleEvidence(row: MixLifecycleDbLine, companyId: number): Phase6MixLifecycleRow {
  const total = dec(row.total_weight_kg);
  const used = dec(row.used_kg);
  const remaining = total.minus(used);
  const issues: MixLifecycleIssue[] = [];
  const issue = (code: MixLifecycleIssueCode, severity: MixLifecycleIssue["severity"], detail: string) => {
    issues.push({ code, severity, detail });
  };
  if (total.lte(0)) issue("NEGATIVE_OR_ZERO_TOTAL", "error", "Mix total weight is not positive.");
  if (used.lt(0)) issue("NEGATIVE_USED", "error", "Used kilograms are negative.");
  if (used.minus(total).gt(KG)) issue("OVERUSED", "error", "Used kilograms exceed the batch's recorded quantity.");
  if (total.minus(used).gt(KG) && row.status === "COMPLETED") {
    issue(
      "COMPLETED_WITH_REMAINDER",
      "review",
      "Completed status conflicts with the used-kg counter. Do not silently set usedKg to total or create a carry forward."
    );
  }
  if (total.minus(used).gt(KG) && row.status === "CLOSED") {
    issue("CLOSED_WITH_REMAINDER", "review", "Closed mix still has unconsumed kg.");
  }
  if (remaining.abs().lte(KG) && ["ACTIVE", "OPEN", "CARRY_FORWARD"].includes(row.status)) {
    issue("ACTIVE_WITH_ZERO_REMAINDER", "review", "Active batch has no remaining kg to consume.");
  }
  const parentId = row.carry_forward_from_id;
  const toppedUp = Number(row.added_source_count ?? 0) > 0;
  if (parentId !== null) {
    if (row.parent_id === null) {
      issue("CARRY_PARENT_MISSING", "error", "The recorded parent batch no longer exists.");
    } else if (row.parent_company_id !== companyId) {
      issue("CARRY_PARENT_CROSS_COMPANY", "error", "Carry-forward parent belongs to a different company.");
    } else {
      if (row.parent_id === row.id) issue("CARRY_PARENT_SELF", "error", "Self-referential carry-forward.");
      if (row.parent_deleted_at !== null)
        issue(
          "CARRY_PARENT_DELETED",
          "error",
          "Carry-forward parent was deleted; its source/stock reversal needs review."
        );
      if (!["CLOSED", "COMPLETED"].includes(row.parent_status ?? "")) {
        issue(
          "CARRY_PARENT_NOT_CLOSED",
          "review",
          "Parent mix is not closed; verify the transfer did not duplicate available kg."
        );
      }
      if (row.parent_batch_date && row.batch_date && row.parent_batch_date.slice(0, 10) > row.batch_date.slice(0, 10)) {
        issue("CARRY_PARENT_DATED_LATER", "review", "Carry-forward predates its source mix.");
      }
    }
    if (Number(row.carry_source_count) !== 1) {
      issue(
        "CARRY_SOURCE_MISSING",
        "review",
        "Carry-forward requires exactly one recorded parent-source cost/weight line."
      );
    } else {
      // A carry-forward that later received a top-up keeps its parent link while
      // its header grows by the appended source lines. Compare the header with
      // the carried portion plus those recorded additions, never the carry alone.
      const expectedKg = dec(row.carry_source_kg).plus(dec(row.added_source_kg ?? "0"));
      const expectedUsd = dec(row.carry_source_usd).plus(dec(row.added_source_usd ?? "0"));
      if (expectedKg.minus(total).abs().gt(KG) || expectedUsd.minus(dec(row.total_cost)).abs().gt(USD)) {
        issue(
          "CARRY_SOURCE_INCONSISTENT",
          "error",
          "Parent-source carry quantity or USD differs from the child header."
        );
      }
    }
    if (
      // A topped-up carry-forward is re-blended with the added sources, so its
      // rate legitimately differs from the parent's recorded rate.
      !toppedUp &&
      row.parent_company_id === companyId &&
      row.parent_cost_per_kg != null &&
      dec(row.parent_cost_per_kg).minus(dec(row.cost_per_kg)).abs().gt("0.0001")
    ) {
      issue(
        "CARRY_RATE_DRIFT",
        "review",
        "Recorded parent and child per-kg rates differ. Verify historical rate version."
      );
    }
  }
  if (dec(row.daily_usage_kg).gt(total.plus(KG))) {
    issue("DAILY_USAGE_EXCEEDS_RECORDED_TOTAL", "review", "Daily usage lines exceed the total recorded kg.");
  }
  const deleted = row.deleted_at !== null;
  const hasError = issues.some((i) => i.severity === "error");
  return {
    batchId: row.id,
    batchCode: row.batch_code,
    status: row.status,
    batchDate: row.batch_date?.slice(0, 10) ?? null,
    deleted,
    totalKg: fixed(total),
    usedKg: fixed(used),
    remainingKg: fixed(remaining),
    recordedRateUsdPerKg: fixed(dec(row.cost_per_kg), 7),
    recordedTotalCostUsd: fixed(dec(row.total_cost), 7),
    estimatedRemainingUsd: fixed(Decimal.max(0, remaining).times(dec(row.cost_per_kg)), 7),
    carryForwardFromId: parentId,
    parentBatchCode: row.parent_company_id === companyId ? row.parent_batch_code : null,
    carrySourceCount: Number(row.carry_source_count),
    carrySourceKg: fixed(dec(row.carry_source_kg)),
    carrySourceUsd: fixed(dec(row.carry_source_usd), 7),
    childCarryCount: Number(row.child_count),
    dailyUsageCount: Number(row.daily_usage_count),
    dailyUsageKg: fixed(dec(row.daily_usage_kg)),
    classification: deleted
      ? "DELETED_HISTORY"
      : hasError
        ? "INVALID_QUANTITY"
        : issues.some((i) => i.severity === "review")
          ? "REQUIRES_REVIEW"
          : "RECONCILED",
    issues,
    readOnly: true,
  };
}
const hasIssue = (row: Phase6MixLifecycleRow, code: MixLifecycleIssueCode) => row.issues.some((i) => i.code === code);
export function summarizePhase6MixLifecycle(companyId: number, rows: MixLifecycleDbLine[]): Phase6MixLifecycleReport {
  const batches = rows.map((row) => classifyMixLifecycleEvidence(row, companyId));
  const active = batches.filter((row) => !row.deleted);
  const withIssue = (code: MixLifecycleIssueCode) => active.filter((row) => hasIssue(row, code));
  const carryExceptions = active.filter(
    (row) => row.carryForwardFromId !== null && row.issues.some((i) => i.code.startsWith("CARRY_"))
  );
  return {
    companyId,
    generatedAt: new Date().toISOString(),
    readOnly: true,
    summary: {
      allBatches: batches.length,
      activeBatches: active.length,
      deletedBatches: batches.length - active.length,
      completedActiveBatches: active.filter((b) => b.status === "COMPLETED").length,
      completedWithRemainderBatches: withIssue("COMPLETED_WITH_REMAINDER").length,
      completedRemainderKg: fixed(
        withIssue("COMPLETED_WITH_REMAINDER").reduce((a, b) => a.plus(b.remainingKg), dec(0))
      ),
      completedRemainderPotentialValueUsd: fixed(
        withIssue("COMPLETED_WITH_REMAINDER").reduce((a, b) => a.plus(b.estimatedRemainingUsd), dec(0)),
        7
      ),
      overusedBatches: withIssue("OVERUSED").length,
      overusedKg: fixed(withIssue("OVERUSED").reduce((a, b) => a.minus(b.remainingKg), dec(0))),
      negativeUsedBatches: withIssue("NEGATIVE_USED").length,
      closedWithRemainderBatches: withIssue("CLOSED_WITH_REMAINDER").length,
      carryForwardBatches: active.filter((b) => b.carryForwardFromId !== null).length,
      carryForwardExceptions: carryExceptions.length,
      batchesWithDailyUsage: active.filter((b) => b.dailyUsageCount > 0).length,
      invalidQuantityBatches: active.filter((b) => b.classification === "INVALID_QUANTITY").length,
      evidenceReviewBatches: active.filter((b) => b.classification === "REQUIRES_REVIEW").length,
    },
    batches,
    policy: [
      "This is a snapshot, not a mass-quantity correction. Completed mixes with unused kg may reflect old production-entry adjustments, not saleable leftover stock.",
      "No carry-forward is created for a historical completed batch without dated consumption, production and physical stock evidence.",
      "Overuse is a recorded negative discrepancy; never clamp usedKg or create invented receipt/adjustment quantities.",
      "Future consumption and carry-forwards must use exact three-decimal kg, an open batch, a single transaction and a persistent parent/source link.",
      "A remaining-kg finalization is an explicit WASTE write-off requiring reviewed quantity and a documented reason.",
    ],
  };
}

export async function getPhase6MixLifecycleReport(companyId: number): Promise<Phase6MixLifecycleReport> {
  if (!Number.isSafeInteger(companyId) || companyId <= 0) throw new Error("Company is required");
  const client = await pool.connect();
  let open = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    open = true;
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [String(companyId)]);
    const rows = (
      await client.query<MixLifecycleDbLine>(
        "SELECT m.id,m.batch_code,m.status,m.batch_date::text,m.deleted_at::text," +
          "m.total_weight_kg::text,m.used_kg::text,m.cost_per_kg::text,m.total_cost::text," +
          "m.carry_forward_from_id,p.id AS parent_id,p.company_id AS parent_company_id," +
          "p.status AS parent_status,p.deleted_at::text AS parent_deleted_at," +
          "CASE WHEN p.company_id=m.company_id THEN p.batch_code ELSE NULL END AS parent_batch_code," +
          "p.batch_date::text AS parent_batch_date,p.cost_per_kg::text AS parent_cost_per_kg," +
          "COALESCE(s.cnt,0)::text AS carry_source_count,COALESCE(s.kg,0)::text AS carry_source_kg," +
          "COALESCE(s.usd,0)::text AS carry_source_usd," +
          "COALESCE(a.cnt,0)::text AS added_source_count,COALESCE(a.kg,0)::text AS added_source_kg," +
          "COALESCE(a.usd,0)::text AS added_source_usd," +
          "COALESCE(d.cnt,0)::text AS daily_usage_count,COALESCE(d.kg,0)::text AS daily_usage_kg," +
          "COALESCE(ch.cnt,0)::text AS child_count " +
          "FROM factory_mix_batches m " +
          "LEFT JOIN factory_mix_batches p ON p.id=m.carry_forward_from_id " +
          "LEFT JOIN LATERAL (SELECT COUNT(*) cnt,COALESCE(SUM(x.weight_kg),0) kg," +
          "COALESCE(SUM(x.total_cost),0) usd FROM factory_mix_batch_sources x " +
          "WHERE x.mix_batch_id=m.id AND x.source_batch_id=m.carry_forward_from_id) s ON TRUE " +
          "LEFT JOIN LATERAL (SELECT COUNT(*) cnt,COALESCE(SUM(x.weight_kg),0) kg," +
          "COALESCE(SUM(x.total_cost),0) usd FROM factory_mix_batch_sources x " +
          "WHERE m.carry_forward_from_id IS NOT NULL AND x.mix_batch_id=m.id " +
          "AND x.source_batch_id IS DISTINCT FROM m.carry_forward_from_id) a ON TRUE " +
          "LEFT JOIN LATERAL (SELECT COUNT(*) cnt,COALESCE(SUM(d.kg_used),0) kg " +
          "FROM factory_daily_usages d WHERE d.company_id=m.company_id AND d.mix_batch_id=m.id) d ON TRUE " +
          "LEFT JOIN LATERAL (SELECT COUNT(*) cnt FROM factory_mix_batches child " +
          "WHERE child.company_id=m.company_id AND child.carry_forward_from_id=m.id AND child.deleted_at IS NULL) ch ON TRUE " +
          "WHERE m.company_id=$1 ORDER BY m.id",
        [companyId]
      )
    ).rows;
    if (rows.length > 50000) throw new Error("Lifecycle audit exceeds safe row bounds");
    const report = summarizePhase6MixLifecycle(companyId, rows);
    await client.query("COMMIT");
    open = false;
    return report;
  } catch (e) {
    if (open) await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
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
