/**
 * Phase 3 — evidence-led, read-only historical mix-batch reconciliation.
 *
 * Every number is reconstructed from PERSISTED source rows and batch headers
 * in a single repeatable-read snapshot. A supplier's CURRENT locked cost is
 * comparison metadata, never historical proof or a repair target.
 *
 * This module intentionally contains no UPDATE, INSERT or DELETE operation.
 * Confirmed historical repairs must use the separate reviewed replay system
 * and its downstream bale/GL safeguards (Phases 4–5).
 */
import Decimal from "decimal.js";
import { pool } from "../../db";

const ZERO = new Decimal(0);
const KG_TOLERANCE = new Decimal("0.01");
const USD_TOLERANCE = new Decimal("0.02");
const RATE_TOLERANCE = new Decimal("0.0001");
const PREVIEW_USD_TOLERANCE = new Decimal("1");

type RawAmount = string | number | null;
type IssueSeverity = "error" | "review" | "informational";
export type HistoricalMixIssueCode =
  | "MISSING_SOURCE"
  | "SOURCE_WEIGHT_INVALID"
  | "SOURCE_VALUE_MATH_MISMATCH"
  | "HEADER_SOURCE_WEIGHT_MISMATCH"
  | "HEADER_SOURCE_COST_MISMATCH"
  | "HEADER_BLENDED_RATE_MISMATCH"
  | "RECORDED_ZERO_COST_SOURCE"
  | "MISSING_SUPPLIER_REFERENCE"
  | "MISSING_CONTAINER_REFERENCE"
  | "MISSING_UPSTREAM_REFERENCE"
  | "CROSS_COMPANY_REFERENCE"
  | "INVENTORY_SUPPLIER_LINK_MISMATCH"
  | "CONTAINER_OFFLOAD_AFTER_BATCH"
  | "UNCLASSIFIED_PRIOR_ADJUSTMENT"
  | "USED_MORE_THAN_RECORDED"
  | "COMPLETED_WITH_REMAINDER"
  | "CURRENT_SUPPLIER_RATE_CHANGED"
  | "CURRENT_SUPPLIER_RATE_MISSING";

export interface HistoricalMixIssue {
  code: HistoricalMixIssueCode;
  severity: IssueSeverity;
  sourceId?: number;
  detail: string;
}

export interface HistoricalMixSourceEvidence {
  sourceId: number;
  supplierId: number | null;
  supplierName: string | null;
  inventorySupplierId: number | null;
  containerId: number | null;
  containerNumber: string | null;
  sourceBatchId: number | null;
  sourceBatchCode: string | null;
  weightKg: string;
  recordedRateUsdPerKg: string;
  recordedTotalUsd: string;
  currentSupplierRateUsdPerKg: string | null;
  priorAdjustmentCount: number;
  unclassifiedPriorAdjustmentCount: number;
  rateProvenance: "RECORDED_SNAPSHOT" | "RECORDED_ZERO" | "NO_SOURCE_RATE";
  issues: HistoricalMixIssue[];
}

export interface HistoricalMixBatchAudit {
  batchId: number;
  batchCode: string;
  batchDate: string | null;
  status: string;
  deleted: boolean;
  recordedWeightKg: string;
  recordedUsedKg: string;
  sourceWeightKg: string;
  recordedTotalUsd: string;
  sourceTotalUsd: string;
  recordedBlendedUsdPerKg: string;
  reconstructedBlendedUsdPerKg: string | null;
  currentRateEstimateUsd: string | null;
  currentRateDifferenceUsd: string | null;
  sourceCount: number;
  classification: "RECONCILED" | "CURRENT_RATE_ONLY" | "EVIDENCE_REVIEW" | "ARITHMETIC_ERROR" | "DELETED_HISTORY";
  issues: HistoricalMixIssue[];
  sources: HistoricalMixSourceEvidence[];
}

export interface HistoricalMixAuditReport {
  companyId: number;
  generatedAt: string;
  readOnly: true;
  historicalCostPolicy: string;
  summary: {
    batches: number;
    activeBatches: number;
    deletedBatches: number;
    sources: number;
    headerMismatchBatches: number;
    sourceLineMismatchBatches: number;
    historicalZeroSourceBatches: number;
    inventoryOwnerReviewBatches: number;
    missingCurrentRateBatches: number;
    currentRateEstimateDifferenceBatches: number;
    currentRateOnlyBatches: number;
    adjustmentEvidenceReviewBatches: number;
    overusedBatches: number;
    arithmeticErrorBatches: number;
    evidenceReviewBatches: number;
    reconciledActiveBatches: number;
  };
  batches: HistoricalMixBatchAudit[];
}

interface DbBatch {
  id: number;
  batch_code: string;
  status: string;
  batch_date: string | null;
  total_weight_kg: string;
  used_kg: string;
  total_cost: string;
  cost_per_kg: string;
  deleted_at: string | null;
}
interface DbSource {
  id: number;
  mix_batch_id: number;
  weight_kg: string;
  cost_per_kg: string;
  total_cost: string;
  created_at: string | null;
  supplier_id: number | null;
  inventory_supplier_id: number | null;
  container_id: number | null;
  source_batch_id: number | null;
  supplier_name: string | null;
  supplier_company_id: number | null;
  current_supplier_rate: string | null;
  container_number: string | null;
  container_company_id: number | null;
  container_supplier_id: number | null;
  container_offloaded_at: string | null;
  upstream_company_id: number | null;
  upstream_batch_code: string | null;
}
interface DbAdjustment {
  supplier_id: number | null;
  date: string | null;
  adjustment_type: string | null;
  cost_per_kg: string | null;
  valuation_basis: string | null;
}
function dec(value: RawAmount): Decimal {
  if (value == null || value === "") return ZERO;
  const parsed = new Decimal(value);
  if (!parsed.isFinite()) throw new Error("Non-finite persisted costing value");
  return parsed;
}
function fixed(value: Decimal, places = 7): string {
  return value.toDecimalPlaces(places, Decimal.ROUND_HALF_UP).toFixed(places);
}
function addIssue(target: HistoricalMixIssue[], code: HistoricalMixIssueCode, severity: IssueSeverity, detail: string, sourceId?: number): void {
  target.push({ code, severity, detail, ...(sourceId === undefined ? {} : { sourceId }) });
}
function datePrefix(value: string | null): string | null {
  return value ? value.slice(0, 10) : null;
}
const issueHas = (batch: HistoricalMixBatchAudit, code: HistoricalMixIssueCode): boolean =>
  batch.issues.some((issue) => issue.code === code);

export function classifyHistoricalMixBatch(
  batch: DbBatch,
  sources: readonly DbSource[],
  adjustments: readonly DbAdjustment[],
  companyId: number,
): HistoricalMixBatchAudit {
  const deleted = batch.deleted_at !== null;
  const recordedWeight = dec(batch.total_weight_kg);
  const usedKg = dec(batch.used_kg);
  const recordedTotal = dec(batch.total_cost);
  const storedRate = dec(batch.cost_per_kg);
  const issues: HistoricalMixIssue[] = [];
  const recorded: HistoricalMixSourceEvidence[] = [];
  let sourceWeight = ZERO;
  let sourceTotal = ZERO;
  let currentEstimate = ZERO;
  let currentEstimateAvailable = true;
  const adjustmentBySupplier = new Map<number, DbAdjustment[]>();
  for (const adjustment of adjustments) {
    if (adjustment.supplier_id == null) continue;
    const existing = adjustmentBySupplier.get(adjustment.supplier_id) ?? [];
    existing.push(adjustment);
    adjustmentBySupplier.set(adjustment.supplier_id, existing);
  }
  if (!sources.length) {
    addIssue(issues, "MISSING_SOURCE", "error", "No saved source rows were found for this batch.");
  }
  for (const source of sources) {
    const weight = dec(source.weight_kg);
    const rate = dec(source.cost_per_kg);
    const total = dec(source.total_cost);
    const local: HistoricalMixIssue[] = [];
    sourceWeight = sourceWeight.plus(weight);
    sourceTotal = sourceTotal.plus(total);
    if (weight.lte(0)) {
      addIssue(local, "SOURCE_WEIGHT_INVALID", "error", "Source weight is zero or negative.", source.id);
    }
    if (weight.gt(0) && (rate.lte(0) || total.lte(0))) {
      addIssue(local, "RECORDED_ZERO_COST_SOURCE", "review",
        "Recorded historical value is zero/unvalued; establish dated USD evidence before recosting.", source.id);
    }
    if (total.minus(weight.times(rate)).abs().gt(USD_TOLERANCE)) {
      addIssue(local, "SOURCE_VALUE_MATH_MISMATCH", "error",
        "Recorded source total differs from recorded kg multiplied by recorded rate.", source.id);
    }
    if (source.supplier_id !== null && (source.supplier_company_id == null)) {
      addIssue(local, "MISSING_SUPPLIER_REFERENCE", "review",
        "Historical supplier reference cannot be resolved in the database.", source.id);
    } else if (source.supplier_company_id !== null && source.supplier_company_id !== companyId) {
      addIssue(local, "CROSS_COMPANY_REFERENCE", "error", "Supplier belongs to a different company.", source.id);
    }
    if (source.container_id !== null && source.container_company_id === null) {
      addIssue(local, "MISSING_CONTAINER_REFERENCE", "review", "Source container reference is missing.", source.id);
    } else if (source.container_company_id !== null && source.container_company_id !== companyId) {
      addIssue(local, "CROSS_COMPANY_REFERENCE", "error", "Source container belongs to a different company.", source.id);
    }
    if (source.source_batch_id !== null && source.upstream_company_id === null) {
      addIssue(local, "MISSING_UPSTREAM_REFERENCE", "review", "Upstream batch reference is missing.", source.id);
    } else if (source.upstream_company_id !== null && source.upstream_company_id !== companyId) {
      addIssue(local, "CROSS_COMPANY_REFERENCE", "error", "Upstream batch belongs to a different company.", source.id);
    }
    if (source.container_id !== null && source.container_company_id === companyId &&
        source.inventory_supplier_id !== source.container_supplier_id) {
      addIssue(local, "INVENTORY_SUPPLIER_LINK_MISMATCH", "review",
        "Inventory ownership differs from the source container's supplier; review attribution, not the historical rate.", source.id);
    }
    const businessDate = datePrefix(batch.batch_date);
    const offloadDate = datePrefix(source.container_offloaded_at);
    if (businessDate && offloadDate && offloadDate > businessDate) {
      addIssue(local, "CONTAINER_OFFLOAD_AFTER_BATCH", "review",
        "The referenced container offload is dated after the mix batch; verify the source timeline.", source.id);
    }
    const priorAdjustments = source.supplier_id == null || businessDate == null
      ? []
      : (adjustmentBySupplier.get(source.supplier_id) ?? []).filter((adj) =>
          adj.date != null && datePrefix(adj.date)! <= businessDate);
    const unclassified = priorAdjustments.filter((adj) =>
      String(adj.adjustment_type ?? "").toUpperCase() === "ADD" &&
      dec(adj.cost_per_kg).gt(0) &&
      !adj.valuation_basis,
    );
    if (unclassified.length) {
      addIssue(local, "UNCLASSIFIED_PRIOR_ADJUSTMENT", "review",
        "A prior valued raw-material adjustment lacks its historical valuation basis.", source.id);
    }
    // Treat the original source rate as the snapshot. Today's supplier rate
    // is never used to assert what this source originally cost.
    const isSupplierPriced = source.supplier_id !== null && source.source_batch_id === null;
    const currentRate = source.current_supplier_rate == null ? null : dec(source.current_supplier_rate);
    if (isSupplierPriced) {
      if (currentRate === null || currentRate.lte(0)) {
        currentEstimateAvailable = false;
        addIssue(local, "CURRENT_SUPPLIER_RATE_MISSING", "informational",
          "Current supplier rate is missing; this does not invalidate the recorded historical value.", source.id);
      } else {
        currentEstimate = currentEstimate.plus(weight.times(currentRate));
        if (currentRate.minus(rate).abs().gt(RATE_TOLERANCE)) {
          addIssue(local, "CURRENT_SUPPLIER_RATE_CHANGED", "informational",
            "Current rate differs from recorded source rate. This is NOT proof of incorrect historical cost.", source.id);
        }
      }
    } else {
      currentEstimate = currentEstimate.plus(total);
    }
    issues.push(...local);
    recorded.push({
      sourceId: source.id,
      supplierId: source.supplier_id,
      supplierName: source.supplier_name,
      inventorySupplierId: source.inventory_supplier_id,
      containerId: source.container_id,
      containerNumber: source.container_number,
      sourceBatchId: source.source_batch_id,
      sourceBatchCode: source.upstream_batch_code,
      weightKg: fixed(weight, 3),
      recordedRateUsdPerKg: fixed(rate),
      recordedTotalUsd: fixed(total),
      currentSupplierRateUsdPerKg: currentRate === null ? null : fixed(currentRate),
      priorAdjustmentCount: priorAdjustments.length,
      unclassifiedPriorAdjustmentCount: unclassified.length,
      rateProvenance: rate.lte(0) ? "RECORDED_ZERO" : source.id > 0 ? "RECORDED_SNAPSHOT" : "NO_SOURCE_RATE",
      issues: local,
    });
  }
  if (recordedWeight.minus(sourceWeight).abs().gt(KG_TOLERANCE)) {
    addIssue(issues, "HEADER_SOURCE_WEIGHT_MISMATCH", "error",
      "Batch header weight does not equal the sum of its recorded source kg.");
  }
  if (recordedTotal.minus(sourceTotal).abs().gt(USD_TOLERANCE)) {
    addIssue(issues, "HEADER_SOURCE_COST_MISMATCH", "error",
      "Batch header total cost does not equal the sum of recorded source USD totals.");
  }
  if (recordedWeight.gt(0) && storedRate.minus(recordedTotal.div(recordedWeight)).abs().gt(RATE_TOLERANCE)) {
    addIssue(issues, "HEADER_BLENDED_RATE_MISMATCH", "error",
      "Batch recorded cost per kg differs from its own stored USD total divided by kg.");
  }
  if (usedKg.gt(recordedWeight.plus(KG_TOLERANCE))) {
    addIssue(issues, "USED_MORE_THAN_RECORDED", "review",
      "Used kg exceed recorded source kg; quantity lifecycle review is needed.");
  }
  if (batch.status === "COMPLETED" && recordedWeight.minus(usedKg).gt(KG_TOLERANCE)) {
    addIssue(issues, "COMPLETED_WITH_REMAINDER", "informational",
      "Completed batch retains unused kg; carry-forward/finalization review belongs to Phase 6.");
  }
  const currentDiff = currentEstimateAvailable ? currentEstimate.minus(recordedTotal) : null;
  const errors = issues.some((item) => item.severity === "error");
  const reviews = issues.some((item) => item.severity === "review");
  const rateOnly = issues.length > 0 && issues.every((item) =>
    item.code === "CURRENT_SUPPLIER_RATE_CHANGED" || item.code === "CURRENT_SUPPLIER_RATE_MISSING" ||
    item.code === "COMPLETED_WITH_REMAINDER");
  const classification: HistoricalMixBatchAudit["classification"] = deleted ? "DELETED_HISTORY"
    : errors ? "ARITHMETIC_ERROR"
    : reviews ? "EVIDENCE_REVIEW"
    : rateOnly ? "CURRENT_RATE_ONLY" : "RECONCILED";
  return {
    batchId: batch.id,
    batchCode: batch.batch_code,
    batchDate: datePrefix(batch.batch_date),
    status: batch.status,
    deleted,
    recordedWeightKg: fixed(recordedWeight, 3),
    recordedUsedKg: fixed(usedKg, 3),
    sourceWeightKg: fixed(sourceWeight, 3),
    recordedTotalUsd: fixed(recordedTotal),
    sourceTotalUsd: fixed(sourceTotal),
    recordedBlendedUsdPerKg: fixed(storedRate),
    reconstructedBlendedUsdPerKg: sourceWeight.gt(0) ? fixed(sourceTotal.div(sourceWeight)) : null,
    currentRateEstimateUsd: currentEstimateAvailable ? fixed(currentEstimate) : null,
    currentRateDifferenceUsd: currentDiff === null ? null : fixed(currentDiff),
    sourceCount: sources.length,
    classification,
    issues,
    sources: recorded,
  };
}

export function summarizeHistoricalMixAudit(companyId: number, batches: HistoricalMixBatchAudit[]): HistoricalMixAuditReport {
  const active = batches.filter((b) => !b.deleted);
  const count = (code: HistoricalMixIssueCode): number => active.filter((b) => issueHas(b, code)).length;
  return {
    companyId,
    generatedAt: new Date().toISOString(),
    readOnly: true,
    historicalCostPolicy:
      "Recorded source USD and batch totals are historical snapshots. Current supplier rates are informational only. No batch or source is automatically repriced.",
    summary: {
      batches: batches.length,
      activeBatches: active.length,
      deletedBatches: batches.length - active.length,
      sources: batches.reduce((sum, b) => sum + b.sourceCount, 0),
      headerMismatchBatches: active.filter((b) => b.issues.some((i) =>
        i.code === "HEADER_SOURCE_WEIGHT_MISMATCH" ||
        i.code === "HEADER_SOURCE_COST_MISMATCH" ||
        i.code === "HEADER_BLENDED_RATE_MISMATCH")).length,
      sourceLineMismatchBatches: count("SOURCE_VALUE_MATH_MISMATCH"),
      historicalZeroSourceBatches: count("RECORDED_ZERO_COST_SOURCE"),
      inventoryOwnerReviewBatches: count("INVENTORY_SUPPLIER_LINK_MISMATCH"),
      missingCurrentRateBatches: count("CURRENT_SUPPLIER_RATE_MISSING"),
      currentRateEstimateDifferenceBatches: active.filter((b) =>
        b.currentRateDifferenceUsd !== null && dec(b.currentRateDifferenceUsd).abs().gt(PREVIEW_USD_TOLERANCE)).length,
      currentRateOnlyBatches: active.filter((b) => b.classification === "CURRENT_RATE_ONLY").length,
      adjustmentEvidenceReviewBatches: count("UNCLASSIFIED_PRIOR_ADJUSTMENT"),
      overusedBatches: count("USED_MORE_THAN_RECORDED"),
      arithmeticErrorBatches: active.filter((b) => b.classification === "ARITHMETIC_ERROR").length,
      evidenceReviewBatches: active.filter((b) => b.classification === "EVIDENCE_REVIEW").length,
      reconciledActiveBatches: active.filter((b) => b.classification === "RECONCILED").length,
    },
    batches,
  };
}

/** Single, consistent database snapshot. Never initiates an accounting repair. */
export async function getHistoricalMixBatchReconciliation(companyId: number): Promise<HistoricalMixAuditReport> {
  if (!Number.isSafeInteger(companyId) || companyId <= 0) throw new Error("Company is required");
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [String(companyId)]);
    const batches = (await client.query<DbBatch>(
      "SELECT id, batch_code, status, batch_date::text, total_weight_kg::text, " +
      "used_kg::text, total_cost::text, cost_per_kg::text, deleted_at::text " +
      "FROM factory_mix_batches WHERE company_id = $1 ORDER BY id",
      [companyId],
    )).rows;
    const sources = (await client.query<DbSource>(
      "SELECT s.id, s.mix_batch_id, s.weight_kg::text, s.cost_per_kg::text, s.total_cost::text, " +
      "s.created_at::text, s.supplier_id, s.inventory_supplier_id, s.container_id, s.source_batch_id, " +
      "sp.name AS supplier_name, sp.company_id AS supplier_company_id, " +
      "sp.current_raw_material_cost_per_kg_usd::text AS current_supplier_rate, " +
      "c.container_number, c.company_id AS container_company_id, c.supplier_id AS container_supplier_id, " +
      "r.first_offloaded_at::text AS container_offloaded_at, " +
      "up.company_id AS upstream_company_id, up.batch_code AS upstream_batch_code " +
      "FROM factory_mix_batch_sources s " +
      "JOIN factory_mix_batches m ON m.id = s.mix_batch_id AND m.company_id = $1 " +
      "LEFT JOIN factory_suppliers sp ON sp.id = s.supplier_id " +
      "LEFT JOIN factory_containers c ON c.id = s.container_id " +
      "LEFT JOIN LATERAL (" +
      "SELECT MIN(rs.offloaded_at) AS first_offloaded_at FROM factory_raw_stock rs " +
      "WHERE rs.company_id = m.company_id AND rs.container_id = s.container_id AND rs.deleted_at IS NULL" +
      ") r ON TRUE " +
      "LEFT JOIN factory_mix_batches up ON up.id = s.source_batch_id " +
      "ORDER BY s.mix_batch_id, s.id",
      [companyId],
    )).rows;
    const adjustments = (await client.query<DbAdjustment>(
      "SELECT supplier_id, date::text, type AS adjustment_type, " +
      "cost_per_kg::text, valuation_basis FROM factory_raw_material_adjustments " +
      "WHERE company_id = $1 AND deleted_at IS NULL ORDER BY id",
      [companyId],
    )).rows;
    if (batches.length > 20000 || sources.length > 250000 || adjustments.length > 250000) {
      throw new Error("Historical audit exceeded safe row bounds; run an offline paginated audit.");
    }
    const byBatch = new Map<number, DbSource[]>();
    for (const row of sources) {
      const list = byBatch.get(row.mix_batch_id) ?? [];
      list.push(row);
      byBatch.set(row.mix_batch_id, list);
    }
    const audited = batches.map((batch) =>
      classifyHistoricalMixBatch(batch, byBatch.get(batch.id) ?? [], adjustments, companyId));
    await client.query("COMMIT");
    transactionOpen = false;
    return summarizeHistoricalMixAudit(companyId, audited);
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
