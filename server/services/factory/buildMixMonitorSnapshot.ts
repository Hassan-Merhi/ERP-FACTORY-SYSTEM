// Extracted from ./mixPhase7IntegrityMonitor.ts to keep that module under the source-size cap.
import Decimal from "decimal.js";
import type { HistoricalMixAuditReport } from "./historicalMixBatchReconciliation";
import type { Phase4SourceProvenanceReport } from "./mixPhase4ProvenanceAudit";
import type { Phase5DownstreamReconciliation } from "./mixPhase5DownstreamAudit";
import type { Phase6MixLifecycleReport } from "./mixPhase6LifecycleAudit";

export type MixMonitorSeverity = "critical" | "warning" | "review";

export interface MixMonitorFinding {
  key: string;
  code: string;
  severity: MixMonitorSeverity;
  title: string;
  detail: string;
  entityType: "mix_batch" | "mix_source" | "raw_stock" | "supplier" | "adjustment";
  entityId: number;
  /** Tracked signed magnitude; worsening means a material increase. */
  metric?: { value: string; unit: "kg" | "usd" | "count" };
}

export interface MixMonitorSnapshot {
  companyId: number;
  generatedAt: string;
  findings: MixMonitorFinding[];
  summary: { critical: number; warning: number; review: number; total: number; suppressedCurrentRateDrift: boolean };
}

export interface StoredMonitorState {
  version: 1;
  lastSuccessAt: string;
  findings: Array<{ key: string; severity: MixMonitorSeverity; metric?: MixMonitorFinding["metric"] }>;
  summary: MixMonitorSnapshot["summary"];
}

export interface MixMonitorStatus {
  companyId: number;
  initialized: boolean;
  lastSuccessAt: string | null;
  stale: boolean;
  summary: MixMonitorSnapshot["summary"] | null;
  unreadAlerts: number;
  monitoringEnabled: boolean;
  nextCheck: string;
  legacyBaselinePolicy: string;
}

export const MONITOR_STATE_TYPE = "MIX_MONITOR_STATE";

export const MONITOR_ALERT_TYPE = "MIX_INTEGRITY";

export const MONITOR_FAILURE_TYPE = "MIX_MONITOR_FAILURE";

export const MONITOR_ENTITY_TYPE = "mix_monitor";

export const MAX_FINDINGS = 20_000;

export const severityLevel: Record<MixMonitorSeverity, number> = { review: 1, warning: 2, critical: 3 };

const codeIsCritical = new Set([
  "SOURCE_WEIGHT_INVALID",
  "SOURCE_VALUE_MATH_MISMATCH",
  "HEADER_SOURCE_WEIGHT_MISMATCH",
  "HEADER_SOURCE_COST_MISMATCH",
  "HEADER_BLENDED_RATE_MISMATCH",
  "CROSS_COMPANY_REFERENCE",
  "OVERUSED",
  "NEGATIVE_USED",
  "NEGATIVE_OR_ZERO_TOTAL",
  "CARRY_PARENT_MISSING",
  "CARRY_PARENT_CROSS_COMPANY",
  "CARRY_PARENT_DELETED",
  "CARRY_PARENT_SELF",
  "CARRY_SOURCE_INCONSISTENT",
  "UNBACKED_SHORTAGE",
  "LINKED_BALE_COST_MISMATCH",
]);

const suppressHistoricalRateChange = new Set([
  "CURRENT_SUPPLIER_RATE_CHANGED",
  "CURRENT_SUPPLIER_RATE_MISSING",
  "USED_MORE_THAN_RECORDED",
  "COMPLETED_WITH_REMAINDER",
  "INVENTORY_SUPPLIER_LINK_MISMATCH",
  "UNCLASSIFIED_PRIOR_ADJUSTMENT",
]);

export function buildMixMonitorSnapshot(
  companyId: number,
  history: HistoricalMixAuditReport,
  stock: Phase4SourceProvenanceReport,
  downstream: Phase5DownstreamReconciliation,
  lifecycle: Phase6MixLifecycleReport
): MixMonitorSnapshot {
  if ([history.companyId, stock.companyId, downstream.companyId, lifecycle.companyId].some((id) => id !== companyId)) {
    throw new Error("Factory monitoring company mismatch: cross-tenant evidence rejected");
  }
  const findings = new Map<string, MixMonitorFinding>();
  function add(
    domain: string,
    id: number,
    code: string,
    severity: MixMonitorSeverity,
    title: string,
    detail: string,
    entityType: MixMonitorFinding["entityType"],
    entityId: number,
    metric?: MixMonitorFinding["metric"]
  ) {
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(entityId) || entityId <= 0) return;
    const key = domain + ":" + String(id) + ":" + code;
    const previous = findings.get(key);
    if (!previous || severityLevel[severity] > severityLevel[previous.severity]) {
      findings.set(key, {
        key,
        code,
        severity,
        title: title.slice(0, 230),
        detail: detail.slice(0, 1600),
        entityType,
        entityId,
        metric,
      });
    }
    if (findings.size > MAX_FINDINGS) throw new Error("Too many Factory mix findings for safe monitoring");
  }
  for (const batch of history.batches) {
    if (batch.deleted) continue;
    for (const issue of batch.issues) {
      if (suppressHistoricalRateChange.has(issue.code)) continue;
      const id = issue.sourceId ?? batch.batchId;
      let metric: MixMonitorFinding["metric"];
      try {
        let delta: Decimal | null = null;
        let unit: "kg" | "usd" = "usd";
        if (issue.code === "HEADER_SOURCE_WEIGHT_MISMATCH") {
          delta = new Decimal(batch.recordedWeightKg).minus(batch.sourceWeightKg).abs();
          unit = "kg";
        } else if (issue.code === "HEADER_SOURCE_COST_MISMATCH") {
          delta = new Decimal(batch.recordedTotalUsd).minus(batch.sourceTotalUsd).abs();
        } else if (issue.code === "SOURCE_VALUE_MATH_MISMATCH" && issue.sourceId != null) {
          const source = batch.sources.find((s) => s.sourceId === issue.sourceId);
          if (source)
            delta = new Decimal(source.recordedTotalUsd)
              .minus(new Decimal(source.weightKg).times(source.recordedRateUsdPerKg))
              .abs();
        } else if (issue.code === "HEADER_BLENDED_RATE_MISMATCH" && batch.reconstructedBlendedUsdPerKg != null) {
          // Convert rate-only drift to the corresponding batch USD difference so
          // the monitor's 2-cent threshold has the correct unit.
          delta = new Decimal(batch.recordedBlendedUsdPerKg)
            .minus(batch.reconstructedBlendedUsdPerKg)
            .abs()
            .times(batch.recordedWeightKg);
        }
        if (delta?.isFinite()) metric = { value: delta.toFixed(7), unit };
      } catch {
        /* keep invalid historical numeric inputs as issues, never fake a zero magnitude */
      }
      add(
        issue.sourceId != null ? "source" : "mix",
        id,
        issue.code,
        codeIsCritical.has(issue.code) || issue.severity === "error" ? "critical" : "warning",
        batch.batchCode + " — " + issue.code,
        issue.detail +
          " Saved USD/kg: " +
          batch.recordedBlendedUsdPerKg +
          ". Current supplier price is NOT an authorized repair value.",
        issue.sourceId != null ? "mix_source" : "mix_batch",
        id,
        metric
      );
    }
  }
  for (const row of stock.rawStockExceptions) {
    const code =
      row.supplierCoverage === "UNBACKED_SHORTAGE" ? "UNBACKED_SHORTAGE" : "ADJUSTMENT_BACKED_OVERDRAW_REVIEW";
    add(
      "raw",
      row.rawStockId,
      code,
      codeIsCritical.has(code) ? "critical" : "review",
      (row.containerNumber ?? "Raw stock #" + row.rawStockId) + " — " + code,
      row.excessUsedKg +
        " kg above the original receipt row. ADD adjustment coverage must be verified at the transaction date.",
      "raw_stock",
      row.rawStockId,
      { value: row.excessUsedKg, unit: "kg" }
    );
  }
  for (const owner of stock.ownershipExceptions) {
    add(
      "owner",
      owner.sourceId,
      owner.classification,
      owner.classification === "CROSS_COMPANY_REFERENCE" ? "critical" : "warning",
      owner.batchCode + " — supplier ownership provenance",
      "Saved inventory supplier " +
        owner.recordedInventorySupplierId +
        " differs from current container supplier " +
        owner.currentContainerSupplierId +
        ". Verify dated transfer evidence; do not overwrite the saved rate.",
      "mix_source",
      owner.sourceId
    );
  }
  for (const adj of stock.adjustmentEvidence) {
    add(
      "adjustment",
      adj.adjustmentId,
      adj.classification,
      "warning",
      "Supplier ADD #" + adj.adjustmentId + " — missing valuation evidence",
      "Supplier " +
        (adj.supplierName ?? String(adj.supplierId)) +
        ", " +
        adj.kg +
        " kg in " +
        adj.currency +
        "; original basis/FX requires dated documentation.",
      "adjustment",
      adj.adjustmentId
    );
  }
  for (const batch of downstream.batches) {
    if (batch.deleted) continue;
    // Missing old links are a visibility/repair blocker, not a proved new
    // cost error. The Phase 5 audit and replay gate continue to report it.
    if (batch.classification === "LINKED_BALE_COST_MISMATCH" && batch.mismatchedLinkedBales > 0) {
      add(
        "bale",
        batch.batchId,
        "LINKED_BALE_COST_MISMATCH",
        "critical",
        batch.batchCode + " — verified linked bale rate mismatch",
        String(batch.mismatchedLinkedBales) +
          " linked bales have saved cost/rate differences; review sales and GL exposure before recost.",
        "mix_batch",
        batch.batchId,
        { value: String(batch.mismatchedLinkedBales), unit: "count" }
      );
    }
  }
  for (const batch of lifecycle.batches) {
    if (batch.deleted) continue;
    for (const issue of batch.issues) {
      let metric: MixMonitorFinding["metric"];
      if (["OVERUSED", "COMPLETED_WITH_REMAINDER", "CLOSED_WITH_REMAINDER"].includes(issue.code)) {
        try {
          const total = new Decimal(batch.totalKg),
            used = new Decimal(batch.usedKg);
          const amount = issue.code === "OVERUSED" ? used.minus(total) : total.minus(used);
          if (amount.gt(0)) metric = { value: amount.toFixed(3), unit: "kg" };
        } catch {
          /* original invalid quantity remains an error with no inferred amount */
        }
      }
      add(
        "lifecycle",
        batch.batchId,
        issue.code,
        codeIsCritical.has(issue.code) || issue.severity === "error" ? "critical" : "warning",
        batch.batchCode + " — " + issue.code,
        issue.detail +
          " Recorded: " +
          batch.usedKg +
          " kg used / " +
          batch.totalKg +
          " kg total; no automatic correction.",
        "mix_batch",
        batch.batchId,
        metric
      );
    }
  }
  const result = [...findings.values()].sort(
    (a, b) => severityLevel[b.severity] - severityLevel[a.severity] || a.key.localeCompare(b.key)
  );
  return {
    companyId,
    generatedAt: new Date().toISOString(),
    findings: result,
    summary: {
      critical: result.filter((f) => f.severity === "critical").length,
      warning: result.filter((f) => f.severity === "warning").length,
      review: result.filter((f) => f.severity === "review").length,
      total: result.length,
      suppressedCurrentRateDrift: true,
    },
  };
}
