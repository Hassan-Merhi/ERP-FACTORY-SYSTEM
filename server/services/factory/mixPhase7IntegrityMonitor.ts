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
import { getHistoricalMixBatchReconciliation } from "./historicalMixBatchReconciliation";
import { getPhase4MixProvenanceReport } from "./mixPhase4ProvenanceAudit";
import { getPhase5MixDownstreamReconciliation } from "./mixPhase5DownstreamAudit";
import { getPhase6MixLifecycleReport } from "./mixPhase6LifecycleAudit";
import {
  MAX_FINDINGS,
  MONITOR_ALERT_TYPE,
  MONITOR_ENTITY_TYPE,
  MONITOR_FAILURE_TYPE,
  MONITOR_STATE_TYPE,
  buildMixMonitorSnapshot,
  severityLevel,
  type MixMonitorFinding,
  type MixMonitorSnapshot,
  type MixMonitorStatus,
  type StoredMonitorState,
} from "./buildMixMonitorSnapshot";
export { buildMixMonitorSnapshot } from "./buildMixMonitorSnapshot";
export type {
  MixMonitorFinding,
  MixMonitorSeverity,
  MixMonitorSnapshot,
  MixMonitorStatus,
} from "./buildMixMonitorSnapshot";

export function compareMixMonitorFindings(
  previous: StoredMonitorState["findings"] | null,
  current: MixMonitorFinding[]
): { baseline: boolean; newOrEscalated: MixMonitorFinding[]; resolvedKeys: string[] } {
  if (previous === null) return { baseline: true, newOrEscalated: [], resolvedKeys: [] };
  const old = new Map(previous.map((item) => [item.key, item] as const));
  const worsened = (now: MixMonitorFinding, before?: StoredMonitorState["findings"][number]): boolean => {
    if (!now.metric || !before?.metric || now.metric.unit !== before.metric.unit) return false;
    try {
      const tolerance = now.metric.unit === "kg" ? "0.001" : now.metric.unit === "usd" ? "0.02" : "0";
      return new Decimal(now.metric.value).gt(new Decimal(before.metric.value).plus(tolerance));
    } catch {
      return false;
    }
  };
  const present = new Set(current.map((item) => item.key));
  return {
    baseline: false,
    newOrEscalated: current.filter((item) => {
      const prior = old.get(item.key);
      return (
        prior === undefined || severityLevel[item.severity] > severityLevel[prior.severity] || worsened(item, prior)
      );
    }),
    resolvedKeys: previous.map((item) => item.key).filter((key) => !present.has(key)),
  };
}

function parseState(payload: string | null): StoredMonitorState | null {
  if (!payload) return null;
  try {
    const value: unknown = JSON.parse(payload);
    if (!value || typeof value !== "object") return null;
    const v = value as Partial<StoredMonitorState>;
    if (
      v.version !== 1 ||
      !Array.isArray(v.findings) ||
      typeof v.lastSuccessAt !== "string" ||
      !v.summary ||
      v.findings.length > MAX_FINDINGS ||
      !v.findings.every(
        (f) =>
          f &&
          typeof f.key === "string" &&
          (f.severity === "review" || f.severity === "warning" || f.severity === "critical")
      )
    ) {
      return null;
    }
    return v as StoredMonitorState;
  } catch {
    return null;
  }
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
  companyId: number;
  baseline: boolean;
  currentIssues: number;
  alertsCreated: number;
  resolved: number;
  checkedAt: string;
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
    await client.query("SELECT pg_advisory_xact_lock(hashtext('factory_mix_monitor_v1'), $1::integer)", [
      snapshot.companyId,
    ]);
    const existing = (
      await client.query<{ id: number; message: string | null }>(
        "SELECT id, message FROM factory_alerts WHERE company_id=$1 AND type=$2 " +
          "AND entity_type=$3 AND entity_id=0 ORDER BY id DESC LIMIT 1 FOR UPDATE",
        [snapshot.companyId, MONITOR_STATE_TYPE, MONITOR_ENTITY_TYPE]
      )
    ).rows[0];
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
        [
          snapshot.companyId,
          MONITOR_ALERT_TYPE,
          issue.severity === "critical" ? "error" : "warning",
          issue.title,
          message,
          issue.entityType,
          issue.entityId,
        ]
      );
      created++;
    }
    for (const key of change.resolvedKeys) {
      // Only auto-clear unread alert(s) for the exact resolved issue key;
      // never mark unrelated notifications as read.
      await client.query(
        "UPDATE factory_alerts SET is_read=true WHERE company_id=$1 AND type=$2 " +
          "AND is_read=false AND left(message, length($3)) = $3",
        [snapshot.companyId, MONITOR_ALERT_TYPE, "[" + key + "] "]
      );
    }
    // A fresh successful check also clears a prior incomplete-monitor alert.
    await client.query("UPDATE factory_alerts SET is_read=true WHERE company_id=$1 AND type=$2 AND is_read=false", [
      snapshot.companyId,
      MONITOR_FAILURE_TYPE,
    ]);
    const state: StoredMonitorState = {
      version: 1,
      lastSuccessAt: snapshot.generatedAt,
      findings: snapshot.findings.map(({ key, severity, metric }) => ({ key, severity, metric })),
      summary: snapshot.summary,
    };
    const serialized = JSON.stringify(state);
    if (serialized.length > 1_000_000) throw new Error("Factory integrity baseline exceeds safe size");
    if (existing) {
      await client.query("UPDATE factory_alerts SET message=$1,is_read=true WHERE id=$2 AND company_id=$3", [
        serialized,
        existing.id,
        snapshot.companyId,
      ]);
    } else {
      await client.query(
        "INSERT INTO factory_alerts(company_id,type,severity,title,message,entity_type,entity_id,is_read) " +
          "VALUES($1,$2,'info','Factory mix monitor baseline',$3,$4,0,true)",
        [snapshot.companyId, MONITOR_STATE_TYPE, serialized, MONITOR_ENTITY_TYPE]
      );
    }
    await client.query("COMMIT");
    begun = false;
    return {
      companyId: snapshot.companyId,
      baseline: change.baseline,
      currentIssues: snapshot.findings.length,
      alertsCreated: created,
      resolved: change.resolvedKeys.length,
      checkedAt: snapshot.generatedAt,
    };
  } catch (error) {
    if (begun) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getMixMonitorStatus(companyId: number): Promise<MixMonitorStatus> {
  if (!Number.isSafeInteger(companyId) || companyId <= 0) throw new Error("Invalid company");
  const r = await pool.query<{ message: string | null; unread_alerts: string }>(
    "SELECT (SELECT message FROM factory_alerts " +
      "WHERE company_id=$1 AND type=$2 AND entity_type=$3 AND entity_id=0 " +
      "ORDER BY id DESC LIMIT 1) AS message," +
      "(SELECT COUNT(*)::text FROM factory_alerts WHERE company_id=$1 " +
      "AND type IN ($4,$5) AND is_read=false) AS unread_alerts",
    [companyId, MONITOR_STATE_TYPE, MONITOR_ENTITY_TYPE, MONITOR_ALERT_TYPE, MONITOR_FAILURE_TYPE]
  );
  const baseline = parseState(r.rows[0]?.message ?? null);
  return {
    companyId,
    initialized: baseline !== null,
    lastSuccessAt: baseline?.lastSuccessAt ?? null,
    stale:
      baseline !== null &&
      (!Number.isFinite(Date.parse(baseline.lastSuccessAt)) ||
        Date.now() - Date.parse(baseline.lastSuccessAt) > 48 * 60 * 60 * 1000),
    summary: baseline?.summary ?? null,
    unreadAlerts: Number(r.rows[0]?.unread_alerts ?? 0),
    monitoringEnabled:
      process.env.ENABLE_SCHEDULERS !== "false" && process.env.FACTORY_MIX_INTEGRITY_MONITOR_ENABLED !== "false",
    nextCheck: "Daily at 01:35 UTC when server schedulers are enabled",
    legacyBaselinePolicy:
      "First successful scan records existing issues without alerts. New, materially worsened, or higher-severity issues create Factory Alerts.",
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
      [
        companyId,
        MONITOR_FAILURE_TYPE,
        "The scheduled Factory mix audit was incomplete. The last successful baseline is preserved. Review server logs; no inventory or accounting repair was attempted.",
        MONITOR_ENTITY_TYPE,
      ]
    );
    await client.query("COMMIT");
    open = false;
  } catch (error) {
    if (open) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function runScheduledFactoryMixIntegrityMonitoring(): Promise<{
  companies: number;
  succeeded: number;
  failed: number;
  initialized: number;
  newAlerts: number;
  resolved: number;
}> {
  const ids = (
    await pool.query<{ company_id: number }>("SELECT DISTINCT company_id FROM factory_mix_batches ORDER BY company_id")
  ).rows
    .map((row) => row.company_id)
    .filter(Number.isSafeInteger);
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
          module: "factoryMixIntegrityMonitor",
          companyId,
          newAlerts: r.alertsCreated,
          resolved: r.resolved,
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
          module: "factoryMixIntegrityMonitor",
          companyId,
          error: notificationError,
        });
      }
      logger.error("Factory mix integrity scan failed without changing baseline", {
        module: "factoryMixIntegrityMonitor",
        companyId,
        error,
      });
    }
  }
  logger.info("Factory mix integrity monitoring scan complete", {
    module: "factoryMixIntegrityMonitor",
    ...summary,
  });
  return summary;
}
