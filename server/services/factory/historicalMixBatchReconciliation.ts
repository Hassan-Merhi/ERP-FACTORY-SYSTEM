/** Historical batch reconciliation report, read-only snapshot and CSV. */
import { pool } from "../../db";
import {
  PREVIEW_USD_TOLERANCE,
  dec,
  issueHas,
  classifyHistoricalMixBatch,
  type HistoricalMixIssueCode,
  type HistoricalMixBatchAudit,
  type HistoricalMixAuditReport,
  type DbBatch,
  type DbSource,
  type DbAdjustment,
} from "./historicalMixBatchEvidence";

export * from "./historicalMixBatchEvidence";

export function summarizeHistoricalMixAudit(
  companyId: number,
  batches: HistoricalMixBatchAudit[]
): HistoricalMixAuditReport {
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
      headerMismatchBatches: active.filter((b) =>
        b.issues.some(
          (i) =>
            i.code === "HEADER_SOURCE_WEIGHT_MISMATCH" ||
            i.code === "HEADER_SOURCE_COST_MISMATCH" ||
            i.code === "HEADER_BLENDED_RATE_MISMATCH"
        )
      ).length,
      sourceLineMismatchBatches: count("SOURCE_VALUE_MATH_MISMATCH"),
      historicalZeroSourceBatches: count("RECORDED_ZERO_COST_SOURCE"),
      inventoryOwnerReviewBatches: count("INVENTORY_SUPPLIER_LINK_MISMATCH"),
      missingCurrentRateBatches: count("CURRENT_SUPPLIER_RATE_MISSING"),
      currentRateEstimateDifferenceBatches: active.filter(
        (b) => b.currentRateDifferenceUsd !== null && dec(b.currentRateDifferenceUsd).abs().gt(PREVIEW_USD_TOLERANCE)
      ).length,
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
    const batches = (
      await client.query<DbBatch>(
        "SELECT id, batch_code, status, batch_date::text, total_weight_kg::text, " +
          "used_kg::text, total_cost::text, cost_per_kg::text, deleted_at::text " +
          "FROM factory_mix_batches WHERE company_id = $1 ORDER BY id",
        [companyId]
      )
    ).rows;
    const sources = (
      await client.query<DbSource>(
        "SELECT s.id, s.mix_batch_id, s.weight_kg::text, s.cost_per_kg::text, s.total_cost::text, " +
          "s.created_at::text, s.supplier_id, s.inventory_supplier_id, s.container_id, s.source_batch_id, " +
          "CASE WHEN sp.company_id = m.company_id THEN sp.name ELSE NULL END AS supplier_name, " +
          "sp.company_id AS supplier_company_id, " +
          "CASE WHEN sp.company_id = m.company_id THEN sp.current_raw_material_cost_per_kg_usd::text ELSE NULL END AS current_supplier_rate, " +
          "CASE WHEN c.company_id = m.company_id THEN c.container_number ELSE NULL END AS container_number, " +
          "c.company_id AS container_company_id, c.supplier_id AS container_supplier_id, " +
          "r.first_offloaded_at::text AS container_offloaded_at, " +
          "up.company_id AS upstream_company_id, " +
          "CASE WHEN up.company_id = m.company_id THEN up.batch_code ELSE NULL END AS upstream_batch_code " +
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
        [companyId]
      )
    ).rows;
    const adjustments = (
      await client.query<DbAdjustment>(
        "SELECT supplier_id, date::text, type AS adjustment_type, " +
          "cost_per_kg::text, valuation_basis FROM factory_raw_material_adjustments " +
          "WHERE company_id = $1 AND deleted_at IS NULL ORDER BY id",
        [companyId]
      )
    ).rows;
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
      classifyHistoricalMixBatch(batch, byBatch.get(batch.id) ?? [], adjustments, companyId)
    );
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

/** Spreadsheet-safe CSV export. One batch row, or one row per persisted source. */
export function historicalMixAuditCsv(
  report: HistoricalMixAuditReport,
  level: "batches" | "sources" = "batches"
): string {
  const cell = (value: unknown): string => {
    const raw = String(value ?? "");
    // Prevent Excel/LibreOffice formula execution in names/codes/notes.
    const isFormula = /^[\s]*[=+@-]/.test(raw) && !/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw.trim());
    const safe = isFormula ? "'" + raw : raw;
    return '"' + safe.replace(/"/g, '""').replace(/\r?\n/g, " ") + '"';
  };
  const rows: unknown[][] = [];
  if (level === "batches") {
    rows.push([
      "Batch ID",
      "Batch Code",
      "Date",
      "Status",
      "Deleted",
      "Classification",
      "Recorded Kg",
      "Used Kg",
      "Source Kg",
      "Recorded USD",
      "Source USD",
      "Recorded USD/kg",
      "Source Blended USD/kg",
      "Current-Rate Estimate USD (informational)",
      "Current Minus Recorded USD (informational)",
      "Source Count",
      "Issue Codes",
    ]);
    for (const batch of report.batches) {
      rows.push([
        batch.batchId,
        batch.batchCode,
        batch.batchDate,
        batch.status,
        batch.deleted,
        batch.classification,
        batch.recordedWeightKg,
        batch.recordedUsedKg,
        batch.sourceWeightKg,
        batch.recordedTotalUsd,
        batch.sourceTotalUsd,
        batch.recordedBlendedUsdPerKg,
        batch.reconstructedBlendedUsdPerKg,
        batch.currentRateEstimateUsd,
        batch.currentRateDifferenceUsd,
        batch.sourceCount,
        [...new Set(batch.issues.map((issue) => issue.code))].join(" | "),
      ]);
    }
  } else {
    rows.push([
      "Batch ID",
      "Batch Code",
      "Date",
      "Status",
      "Deleted",
      "Batch Classification",
      "Source ID",
      "Supplier ID",
      "Supplier Name",
      "Inventory Supplier ID",
      "Container ID",
      "Container Number",
      "Upstream Batch ID",
      "Upstream Batch Code",
      "Historical Source Kg",
      "Historical USD/kg",
      "Historical Total USD",
      "Current Supplier USD/kg (informational)",
      "Prior Adjustments",
      "Unclassified Prior Adjustments",
      "Historical Rate Provenance",
      "Source Issue Codes",
    ]);
    for (const batch of report.batches) {
      for (const source of batch.sources) {
        rows.push([
          batch.batchId,
          batch.batchCode,
          batch.batchDate,
          batch.status,
          batch.deleted,
          batch.classification,
          source.sourceId,
          source.supplierId,
          source.supplierName,
          source.inventorySupplierId,
          source.containerId,
          source.containerNumber,
          source.sourceBatchId,
          source.sourceBatchCode,
          source.weightKg,
          source.recordedRateUsdPerKg,
          source.recordedTotalUsd,
          source.currentSupplierRateUsdPerKg,
          source.priorAdjustmentCount,
          source.unclassifiedPriorAdjustmentCount,
          source.rateProvenance,
          source.issues.map((issue) => issue.code).join(" | "),
        ]);
      }
    }
  }
  return "\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
