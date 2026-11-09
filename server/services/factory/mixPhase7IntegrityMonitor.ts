/**
 * Phase 7 — Factory mix integrity monitoring.
 *
 * Cost/quantity/provenance reports remain read-only. Only the existing
 * factory_alerts table stores the compact last-good baseline and alerts.
 * This never mutates mixes, bales, raw stock, vouchers or journal entries.
 *
 * First successful scan establishes a baseline (legacy problems remain visible
 * in the detailed audits, but do not spam Factory Alerts). Later scans notify
 * only new issues, worsened magnitudes or increased severity. Changes in CURRENT supplier rate are
 * not recorded as historical cost defects.
 */
import Decimal from "decimal.js";
import { pool } from "../../db";
import { logger } from "../../lib/logger";
import { getHistoricalMixBatchReconciliation, type HistoricalMixAuditReport } from "./historicalMixBatchReconciliation";
import { getPhase4MixProvenanceReport, type Phase4SourceProvenanceReport } from "./mixPhase4ProvenanceAudit";
import { getPhase5MixDownstreamReconciliation, type Phase5DownstreamReconciliation } from "./mixPhase5DownstreamAudit";
import { getPhase6MixLifecycleReport, type Phase6MixLifecycleReport } from "./mixPhase6LifecycleAudit";

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
interface StoredMonitorState {
  version: 1;
  lastSuccessAt: string;
  findings: Array<{ key: string; severity: MixMonitorSeverity;
    metric?: MixMonitorFinding["metric"] }>;
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
const MONITOR_STATE_TYPE = "MIX_MONITOR_STATE";
const MONITOR_ALERT_TYPE = "MIX_INTEGRITY";
const MONITOR_FAILURE_TYPE = "MIX_MONITOR_FAILURE";
const MONITOR_ENTITY_TYPE = "mix_monitor";
const MAX_FINDINGS = 20_000;
const severityLevel: Record<MixMonitorSeverity, number> = { review: 1, warning: 2, critical: 3 };
const codeIsCritical = new Set([
  "SOURCE_WEIGHT_INVALID", "SOURCE_VALUE_MATH_MISMATCH", "HEADER_SOURCE_WEIGHT_MISMATCH",
  "HEADER_SOURCE_COST_MISMATCH", "HEADER_BLENDED_RATE_MISMATCH", "CROSS_COMPANY_REFERENCE",
  "OVERUSED", "NEGATIVE_USED", "NEGATIVE_OR_ZERO_TOTAL", "CARRY_PARENT_MISSING",
  "CARRY_PARENT_CROSS_COMPANY", "CARRY_PARENT_DELETED", "CARRY_PARENT_SELF",
  "CARRY_SOURCE_INCONSISTENT", "UNBACKED_SHORTAGE", "LINKED_BALE_COST_MISMATCH",
]);
const suppressHistoricalRateChange = new Set([
  "CURRENT_SUPPLIER_RATE_CHANGED", "CURRENT_SUPPLIER_RATE_MISSING",
  "USED_MORE_THAN_RECORDED", "COMPLETED_WITH_REMAINDER",
  "INVENTORY_SUPPLIER_LINK_MISMATCH", "UNCLASSIFIED_PRIOR_ADJUSTMENT",
]);

export function buildMixMonitorSnapshot(
  companyId: number,
  history: HistoricalMixAuditReport,
  stock: Phase4SourceProvenanceReport,
  downstream: Phase5DownstreamReconciliation,
  lifecycle: Phase6MixLifecycleReport,
): MixMonitorSnapshot {
  if ([history.companyId, stock.companyId, downstream.companyId, lifecycle.companyId].some(id => id !== companyId)) {
    throw new Error("Factory monitoring company mismatch: cross-tenant evidence rejected");
  }
  const findings = new Map<string, MixMonitorFinding>();
  function add(domain: string, id: number, code: string, severity: MixMonitorSeverity,
    title: string, detail: string, entityType: MixMonitorFinding["entityType"],
    entityId: number, metric?: MixMonitorFinding["metric"]) {
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(entityId) || entityId <= 0) return;
    const key = domain + ":" + String(id) + ":" + code;
    const previous = findings.get(key);
    if (!previous || severityLevel[severity] > severityLevel[previous.severity]) {
      findings.set(key, { key, code, severity,
        title: title.slice(0, 230), detail: detail.slice(0, 1600), entityType, entityId, metric });
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
          const source = batch.sources.find(s => s.sourceId === issue.sourceId);
          if (source) delta = new Decimal(source.recordedTotalUsd)
            .minus(new Decimal(source.weightKg).times(source.recordedRateUsdPerKg)).abs();
        } else if (issue.code === "HEADER_BLENDED_RATE_MISMATCH" &&
          batch.reconstructedBlendedUsdPerKg != null) {
          // Convert rate-only drift to the corresponding batch USD difference so
          // the monitor's 2-cent threshold has the correct unit.
          delta = new Decimal(batch.recordedBlendedUsdPerKg)
            .minus(batch.reconstructedBlendedUsdPerKg).abs().times(batch.recordedWeightKg);
        }
        if (delta?.isFinite()) metric = { value: delta.toFixed(7), unit };
      } catch { /* keep invalid historical numeric inputs as issues, never fake a zero magnitude */ }
      add(issue.sourceId != null ? "source" : "mix", id, issue.code,
        codeIsCritical.has(issue.code) || issue.severity === "error" ? "critical" : "warning",
        batch.batchCode + " — " + issue.code,
        issue.detail + " Saved USD/kg: " + batch.recordedBlendedUsdPerKg +
          ". Current supplier price is NOT an authorized repair value.",
        issue.sourceId != null ? "mix_source" : "mix_batch", id, metric);
    }
  }
  for (const row of stock.rawStockExceptions) {
    const code = row.supplierCoverage === "UNBACKED_SHORTAGE" ? "UNBACKED_SHORTAGE" : "ADJUSTMENT_BACKED_OVERDRAW_REVIEW";
    add("raw", row.rawStockId, code, codeIsCritical.has(code) ? "critical" : "review",
      (row.containerNumber ?? "Raw stock #" + row.rawStockId) + " — " + code,
      row.excessUsedKg + " kg above the original receipt row. ADD adjustment coverage must be verified at the transaction date.",
      "raw_stock", row.rawStockId, { value: row.excessUsedKg, unit: "kg" });
  }
  for (const owner of stock.ownershipExceptions) {
    add("owner", owner.sourceId, owner.classification,
      owner.classification === "CROSS_COMPANY_REFERENCE" ? "critical" : "warning",
      owner.batchCode + " — supplier ownership provenance",
      "Saved inventory supplier " + owner.recordedInventorySupplierId +
        " differs from current container supplier " + owner.currentContainerSupplierId +
        ". Verify dated transfer evidence; do not overwrite the saved rate.",
      "mix_source", owner.sourceId);
  }
  for (const adj of stock.adjustmentEvidence) {
    add("adjustment", adj.adjustmentId, adj.classification, "warning",
      "Supplier ADD #" + adj.adjustmentId + " — missing valuation evidence",
      "Supplier " + (adj.supplierName ?? String(adj.supplierId)) +
        ", " + adj.kg + " kg in " + adj.currency + "; original basis/FX requires dated documentation.",
      "adjustment", adj.adjustmentId);
  }
  for (const batch of downstream.batches) {
    if (batch.deleted) continue;
    // Missing old links are a visibility/repair blocker, not a proved new
    // cost error. The Phase 5 audit and replay gate continue to report it.
    if (batch.classification === "LINKED_BALE_COST_MISMATCH" && batch.mismatchedLinkedBales > 0) {
      add("bale", batch.batchId, "LINKED_BALE_COST_MISMATCH", "critical",
        batch.batchCode + " — verified linked bale rate mismatch",
        String(batch.mismatchedLinkedBales) + " linked bales have saved cost/rate differences; review sales and GL exposure before recost.",
        "mix_batch", batch.batchId, { value: String(batch.mismatchedLinkedBales), unit: "count" });
    }
  }
  for (const batch of lifecycle.batches) {
    if (batch.deleted) continue;
    for (const issue of batch.issues) {
      let metric: MixMonitorFinding["metric"];
      if (["OVERUSED", "COMPLETED_WITH_REMAINDER", "CLOSED_WITH_REMAINDER"].includes(issue.code)) {
        try {
          const total = new Decimal(batch.totalKg), used = new Decimal(batch.usedKg);
          const amount = issue.code === "OVERUSED" ? used.minus(total) : total.minus(used);
          if (amount.gt(0)) metric = { value: amount.toFixed(3), unit: "kg" };
        } catch { /* original invalid quantity remains an error with no inferred amount */ }
      }
      add("lifecycle", batch.batchId, issue.code,
        codeIsCritical.has(issue.code) || issue.severity === "error" ? "critical" : "warning",
        batch.batchCode + " — " + issue.code,
        issue.detail + " Recorded: " + batch.usedKg + " kg used / " + batch.totalKg + " kg total; no automatic correction.",
        "mix_batch", batch.batchId, metric);
    }
  }
  const result = [...findings.values()].sort((a,b) =>
    severityLevel[b.severity] - severityLevel[a.severity] || a.key.localeCompare(b.key));
  return {
    companyId, generatedAt: new Date().toISOString(), findings: result,
    summary: {
      critical: result.filter(f => f.severity === "critical").length,
      warning: result.filter(f => f.severity === "warning").length,
      review: result.filter(f => f.severity === "review").length,
      total: result.length,
      suppressedCurrentRateDrift: true,
    },
  };
}

export function compareMixMonitorFindings(
  previous: StoredMonitorState["findings"] | null,
  current: MixMonitorFinding[],
): { baseline: boolean; newOrEscalated: MixMonitorFinding[]; resolvedKeys: string[] } {
  if (previous === null) return { baseline: true, newOrEscalated: [], resolvedKeys: [] };
  const old = new Map(previous.map(item => [item.key, item] as const));
  const worsened = (now: MixMonitorFinding, before?: StoredMonitorState["findings"][number]): boolean => {
    if (!now.metric || !before?.metric || now.metric.unit !== before.metric.unit) return false;
    try {
      const tolerance = now.metric.unit === "kg" ? "0.001" : now.metric.unit === "usd" ? "0.02" : "0";
      return new Decimal(now.metric.value).gt(new Decimal(before.metric.value).plus(tolerance));
    } catch { return false; }
  };
  const present = new Set(current.map(item => item.key));
  return {
    baseline: false,
    newOrEscalated: current.filter(item => {
      const prior = old.get(item.key);
      return prior === undefined || severityLevel[item.severity] > severityLevel[prior.severity] ||
        worsened(item, prior);
    }),
    resolvedKeys: previous.map(item => item.key).filter(key => !present.has(key)),
  };
}

function parseState(payload: string | null): StoredMonitorState | null {
  if (!payload) return null;
  try {
    const value: unknown = JSON.parse(payload);
    if (!value || typeof value !== "object") return null;
    const v = value as Partial<StoredMonitorState>;
    if (v.version !== 1 || !Array.isArray(v.findings) || typeof v.lastSuccessAt !== "string" ||
        !v.summary || v.findings.length > MAX_FINDINGS ||
        !v.findings.every(f => f && typeof f.key === "string" &&
          (f.severity === "review" || f.severity === "warning" || f.severity === "critical"))) {
      return null;
    }
    return v as StoredMonitorState;
  } catch { return null; }
}

export async function collectMixMonitorSnapshot(companyId: number): Promise<MixMonitorSnapshot> {
  // Read each subsystem in its own bounded, repeatable-read/READ ONLY
  // transaction. Do not cross-infer changes between their independently
  // sampled times.
  const history = await getHistoricalMixBatchReconciliation(companyId);
  const stock = await getPhase4MixProvenanceReport(companyId);
  const downstream = await getPhase5MixDownstreamReconciliation(companyId);
  const lifecycle = await getPhase6MixLifecycleReport(companyId);
  return buildMixMonitorSnapshot(companyId, history, stock, downstream, lifecycle);
}

export interface MixMonitorRunResult {
  companyId: number; baseline: boolean; currentIssues: number;
  alertsCreated: number; resolved: number; checkedAt: string;
}

/** Durable baseline and alert dedupe using the existing factory_alerts table.
 * The state row is marked read and never appears in the Factory Alerts inbox.
 * Single transaction + advisory lock protect multi-instance Render scheduling.
 */
export async function persistMixMonitorSnapshot(snapshot: MixMonitorSnapshot): Promise<MixMonitorRunResult> {
  if (!Number.isSafeInteger(snapshot.companyId) || snapshot.companyId <= 0) throw new Error("Invalid company");
  const client = await pool.connect();
  let begun = false;
  try {
    await client.query("BEGIN");
    begun = true;
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [String(snapshot.companyId)]);
    await client.query("SELECT pg_advisory_xact_lock(hashtext('factory_mix_monitor_v1'), $1::integer)", [snapshot.companyId]);
    const existing = (await client.query<{ id: number; message: string | null }>(
      "SELECT id, message FROM factory_alerts WHERE company_id=$1 AND type=$2 " +
      "AND entity_type=$3 AND entity_id=0 ORDER BY id DESC LIMIT 1 FOR UPDATE",
      [snapshot.companyId, MONITOR_STATE_TYPE, MONITOR_ENTITY_TYPE],
    )).rows[0];
    const previous = existing ? parseState(existing.message) : null;
    // Fail closed on an unparseable baseline: never silently re-baseline away
    // production anomalies or generate uncontrolled duplicate alerts.
    if (existing && previous === null) throw new Error("Existing Factory integrity monitor baseline is corrupt");
    const change = compareMixMonitorFindings(previous?.findings ?? null, snapshot.findings);
    let created = 0;
    for (const issue of change.newOrEscalated) {
      const message = "[" + issue.key + "] " + issue.detail;
      await client.query(
        "INSERT INTO factory_alerts(company_id,type,severity,title,message,entity_type,entity_id,is_read) " +
        "VALUES($1,$2,$3,$4,$5,$6,$7,false)",
        [snapshot.companyId, MONITOR_ALERT_TYPE,
          issue.severity === "critical" ? "error" : "warning",
          issue.title, message, issue.entityType, issue.entityId],
      );
      created++;
    }
    for (const key of change.resolvedKeys) {
      // Only auto-clear unread alert(s) for the exact resolved issue key;
      // never mark unrelated notifications as read.
      await client.query(
        "UPDATE factory_alerts SET is_read=true WHERE company_id=$1 AND type=$2 " +
        "AND is_read=false AND left(message, length($3)) = $3",
        [snapshot.companyId, MONITOR_ALERT_TYPE, "[" + key + "] "],
      );
    }
    // A fresh successful check also clears a prior incomplete-monitor alert.
    await client.query(
      "UPDATE factory_alerts SET is_read=true WHERE company_id=$1 AND type=$2 AND is_read=false",
      [snapshot.companyId, MONITOR_FAILURE_TYPE],
    );
    const state: StoredMonitorState = {
      version: 1, lastSuccessAt: snapshot.generatedAt,
      findings: snapshot.findings.map(({ key, severity, metric }) => ({ key, severity, metric })),
      summary: snapshot.summary,
    };
    const serialized = JSON.stringify(state);
    if (serialized.length > 1_000_000) throw new Error("Factory integrity baseline exceeds safe size");
    if (existing) {
      await client.query(
        "UPDATE factory_alerts SET message=$1,is_read=true WHERE id=$2 AND company_id=$3",
        [serialized, existing.id, snapshot.companyId],
      );
    } else {
      await client.query(
        "INSERT INTO factory_alerts(company_id,type,severity,title,message,entity_type,entity_id,is_read) " +
        "VALUES($1,$2,'info','Factory mix monitor baseline',$3,$4,0,true)",
        [snapshot.companyId, MONITOR_STATE_TYPE, serialized, MONITOR_ENTITY_TYPE],
      );
    }
    await client.query("COMMIT");
    begun = false;
    return {
      companyId: snapshot.companyId, baseline: change.baseline,
      currentIssues: snapshot.findings.length,
      alertsCreated: created, resolved: change.resolvedKeys.length,
      checkedAt: snapshot.generatedAt,
    };
  } catch (error) {
    if (begun) await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export async function getMixMonitorStatus(companyId: number): Promise<MixMonitorStatus> {
  if (!Number.isSafeInteger(companyId) || companyId <= 0) throw new Error("Invalid company");
  const r = await pool.query<{ message: string | null; unread_alerts: string }>(
    "SELECT (SELECT message FROM factory_alerts " +
    "WHERE company_id=$1 AND type=$2 AND entity_type=$3 AND entity_id=0 " +
    "ORDER BY id DESC LIMIT 1) AS message," +
    "(SELECT COUNT(*)::text FROM factory_alerts WHERE company_id=$1 " +
    "AND type IN ($4,$5) AND is_read=false) AS unread_alerts",
    [companyId, MONITOR_STATE_TYPE, MONITOR_ENTITY_TYPE, MONITOR_ALERT_TYPE, MONITOR_FAILURE_TYPE],
  );
  const baseline = parseState(r.rows[0]?.message ?? null);
  return {
    companyId, initialized: baseline !== null,
    lastSuccessAt: baseline?.lastSuccessAt ?? null,
    stale: baseline !== null && (!Number.isFinite(Date.parse(baseline.lastSuccessAt)) ||
      Date.now() - Date.parse(baseline.lastSuccessAt) > 48 * 60 * 60 * 1000),
    summary: baseline?.summary ?? null,
    unreadAlerts: Number(r.rows[0]?.unread_alerts ?? 0),
    monitoringEnabled: process.env.ENABLE_SCHEDULERS !== "false" && process.env.FACTORY_MIX_INTEGRITY_MONITOR_ENABLED !== "false",
    nextCheck: "Daily at 01:35 UTC when server schedulers are enabled",
    legacyBaselinePolicy: "First successful scan records existing issues without alerts. New, materially worsened, or higher-severity issues create Factory Alerts.",
  };
}

/** Emit one diagnostic warning per unread failure, without touching the
 * last successful baseline or making up a clean scan result. */
export async function recordFactoryMixMonitorFailure(companyId: number): Promise<void> {
  const client = await pool.connect();
  let open = false;
  try {
    await client.query("BEGIN");
    open = true;
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [String(companyId)]);
    await client.query("SELECT pg_advisory_xact_lock(hashtext('factory_mix_monitor_v1'), $1::integer)", [companyId]);
    await client.query(
      "INSERT INTO factory_alerts(company_id,type,severity,title,message,entity_type,entity_id,is_read) " +
      "SELECT $1,$2,'warning','Factory mix integrity scan failed',$3,$4,$1,false " +
      "WHERE NOT EXISTS(SELECT 1 FROM factory_alerts WHERE company_id=$1 AND type=$2 " +
      "AND entity_type=$4 AND entity_id=$1 AND is_read=false)",
      [companyId, MONITOR_FAILURE_TYPE,
        "The scheduled Factory mix audit was incomplete. The last successful baseline is preserved. Review server logs; no inventory or accounting repair was attempted.",
        MONITOR_ENTITY_TYPE],
    );
    await client.query("COMMIT");
    open = false;
  } catch (error) {
    if (open) await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export async function runScheduledFactoryMixIntegrityMonitoring(): Promise<{
  companies: number; succeeded: number; failed: number; initialized: number;
  newAlerts: number; resolved: number;
}> {
  const ids = (await pool.query<{ company_id: number }>(
    "SELECT DISTINCT company_id FROM factory_mix_batches ORDER BY company_id",
  )).rows.map(row => row.company_id).filter(Number.isSafeInteger);
  const summary = { companies: ids.length, succeeded: 0, failed: 0, initialized: 0, newAlerts: 0, resolved: 0 };
  for (const companyId of ids) {
    try {
      const snapshot = await collectMixMonitorSnapshot(companyId);
      const r = await persistMixMonitorSnapshot(snapshot);
      summary.succeeded++;
      if (r.baseline) summary.initialized++;
      summary.newAlerts += r.alertsCreated;
      summary.resolved += r.resolved;
      if (r.alertsCreated > 0) {
        logger.warn("New Factory mix integrity exceptions", {
          module: "factoryMixIntegrityMonitor", companyId,
          newAlerts: r.alertsCreated, resolved: r.resolved,
          totalIssues: snapshot.findings.length,
          critical: snapshot.summary.critical,
        });
      }
    } catch (error: unknown) {
      summary.failed++;
      try {
        await recordFactoryMixMonitorFailure(companyId);
      } catch (notificationError) {
        logger.error("Factory mix audit failed and monitoring failure alert could not be recorded", {
          module: "factoryMixIntegrityMonitor", companyId, error: notificationError,
        });
      }
      logger.error("Factory mix integrity scan failed without changing baseline", {
        module: "factoryMixIntegrityMonitor", companyId, error,
      });
    }
  }
  logger.info("Factory mix integrity monitoring scan complete", {
    module: "factoryMixIntegrityMonitor", ...summary,
  });
  return summary;
}
