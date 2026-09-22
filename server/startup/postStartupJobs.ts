/**
 * Post-startup background jobs, run once the port is open.
 */
import { pool } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { startAisLiveTracking, stopAisLiveTracking } from "../services/ais/aisLiveTrackingService";
import { checkAndRecoverDailyExport } from "../services/scheduler";

let installed = false;
let hungCleanupInFlight = false;

function unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  (timer as unknown as { unref?: () => void }).unref?.();
}

export function runPostStartupJobs(): void {
  if (installed) return;
  installed = true;

  // AIS is optional and isolated from normal container tracking. It starts only
  // after the HTTP server is live and shuts down independently on process signals.
  startAisLiveTracking();
  process.once("SIGTERM", stopAisLiveTracking);
  process.once("SIGINT", stopAisLiveTracking);

  const migrationDiagTimer = setTimeout(async () => {
    try {
      const [posRows, posWithStation, normalUserRows, oldRoleRows, canDeleteCol] = await Promise.all([
        pool.query(`SELECT COUNT(*) AS n FROM user_company_roles WHERE role = 'POS'`),
        pool.query(`SELECT COUNT(*) AS n FROM user_company_roles WHERE role = 'POS' AND pos_station IS NOT NULL`),
        pool.query(`SELECT COUNT(*) AS n FROM user_company_roles WHERE role = 'Normal User'`),
        pool.query(`SELECT COUNT(*) AS n FROM user_company_roles WHERE role IN ('POS1','POS2','POS3','POS4','POS5','POS6','User')`),
        pool.query(`SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_name = 'user_company_roles' AND column_name = 'can_delete_records'`),
      ]);
      const posCount = parseInt(posRows.rows[0]?.n ?? "0", 10);
      const posWithStn = parseInt(posWithStation.rows[0]?.n ?? "0", 10);
      const normalCount = parseInt(normalUserRows.rows[0]?.n ?? "0", 10);
      const oldRoleCount = parseInt(oldRoleRows.rows[0]?.n ?? "0", 10);
      const canDeleteOk = parseInt(canDeleteCol.rows[0]?.n ?? "0", 10) > 0;
      logger.info(`[MigrationDiag] POS roles: ${posCount} (${posWithStn} with pos_station set) | Normal User roles: ${normalCount} | Old roles remaining: ${oldRoleCount} | can_delete_records column: ${canDeleteOk ? "✓ present" : "✗ MISSING"}`);
      if (oldRoleCount > 0) logger.warn(`[MigrationDiag] ⚠️  ${oldRoleCount} row(s) still have old roles (POS1–POS6 or User) — check /api/admin/deployment-diagnostics`);
    } catch (e: unknown) {
      logger.warn("[MigrationDiag] Could not run startup diagnostic:", { error: getErrorMessage(e) });
    }
  }, 30000);
  unrefTimer(migrationDiagTimer);

  void (async () => {
    try {
      const r = await pool.query(`
      UPDATE factory_bales
         SET status = 'DELETED', updated_at = NOW()
       WHERE deleted_at IS NOT NULL
         AND status != 'DELETED'
      RETURNING id, reference_number
    `);
      if (r.rowCount && r.rowCount > 0) {
        logger.info(`[BaleStatusFix] Fixed ${r.rowCount} bale(s) with deletedAt set but status != DELETED`, {
          detail: r.rows.map((x) => x.reference_number).join(", "),
        });
      }
    } catch (e: unknown) {
      logger.warn("[BaleStatusFix] Could not fix inconsistent bale statuses:", { error: getErrorMessage(e) });
    }
  })();

  const cleanupOrphanedRuns = async () => {
    try {
      const r = await pool.query(`
      UPDATE daily_export_runs
         SET status         = 'failed',
             finished_at    = NOW(),
             skipped_reason = 'Server restarted or timed out while export was in progress'
       WHERE status         = 'running'
         AND started_at     < NOW() - INTERVAL '5 minutes'
      RETURNING id, run_type
    `);
      if (r.rowCount && r.rowCount > 0) {
        logger.info(`[ExportRun] Startup: marked ${r.rowCount} orphaned run(s) as failed`, {
          detail: r.rows.map((x) => `#${x.id} ${x.run_type}`).join(", "),
        });
      }
    } catch (e: unknown) {
      logger.warn("[ExportRun] Startup orphan-cleanup failed:", { error: getErrorMessage(e) });
    }
  };

  const cleanupHungRuns = async () => {
    if (hungCleanupInFlight) {
      logger.warn("[ExportRun] Periodic hung-run cleanup skipped because the previous sweep is still running.");
      return;
    }
    hungCleanupInFlight = true;
    try {
      const r = await pool.query(`
      UPDATE daily_export_runs
         SET status         = 'failed',
             finished_at    = NOW(),
             skipped_reason = 'Export timed out — exceeded 3-hour safety limit'
       WHERE status         = 'running'
         AND started_at     < NOW() - INTERVAL '3 hours'
      RETURNING id, run_type
    `);
      if (r.rowCount && r.rowCount > 0) {
        logger.info(`[ExportRun] Periodic: timed out ${r.rowCount} hung run(s)`, {
          detail: r.rows.map((x) => `#${x.id} ${x.run_type}`).join(", "),
        });
      }
    } catch (e: unknown) {
      logger.warn("[ExportRun] Periodic hung-run cleanup failed:", { error: getErrorMessage(e) });
    } finally {
      hungCleanupInFlight = false;
    }
  };

  const orphanCleanupTimer = setTimeout(() => void cleanupOrphanedRuns(), 3000);
  const hungCleanupTimer = setInterval(() => void cleanupHungRuns(), 30 * 60 * 1000);
  unrefTimer(orphanCleanupTimer);
  unrefTimer(hungCleanupTimer);

  const exportRecoveryTimer = setTimeout(async () => {
    try {
      await checkAndRecoverDailyExport();
    } catch (e: unknown) {
      logger.warn("[DailyExport] Startup recovery call failed:", { error: getErrorMessage(e) });
    }
  }, 90 * 1000);
  unrefTimer(exportRecoveryTimer);
}
