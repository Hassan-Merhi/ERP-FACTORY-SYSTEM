/**
 * Post-startup background jobs, run once the port is open.
 *
 * Startup diagnostics, bale-status repair, orphaned/hung export-run cleanup,
 * and the daily-export recovery retry. Extracted verbatim from
 * server/index.ts; behaviour (including the 30 s / 3 s / 90 s timings and the
 * 30-minute hung-run interval) is unchanged.
 */
import { pool } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { checkAndRecoverDailyExport } from "../services/scheduler";

export function runPostStartupJobs(): void {
  // Delayed 30 s so diagnostics don't compete with user requests for pool
  // connections the moment the server goes live.
  setTimeout(async () => {
    try {
      const [posRows, posWithStation, normalUserRows, oldRoleRows, canDeleteCol] = await Promise.all([
        pool.query(`SELECT COUNT(*) AS n FROM user_company_roles WHERE role = 'POS'`),
        pool.query(`SELECT COUNT(*) AS n FROM user_company_roles WHERE role = 'POS' AND pos_station IS NOT NULL`),
        pool.query(`SELECT COUNT(*) AS n FROM user_company_roles WHERE role = 'Normal User'`),
        pool.query(
          `SELECT COUNT(*) AS n FROM user_company_roles WHERE role IN ('POS1','POS2','POS3','POS4','POS5','POS6','User')`
        ),
        pool.query(
          `SELECT COUNT(*) AS n FROM information_schema.columns
         WHERE table_name = 'user_company_roles' AND column_name = 'can_delete_records'`
        ),
      ]);
      const posCount = parseInt(posRows.rows[0]?.n ?? "0", 10);
      const posWithStn = parseInt(posWithStation.rows[0]?.n ?? "0", 10);
      const normalCount = parseInt(normalUserRows.rows[0]?.n ?? "0", 10);
      const oldRoleCount = parseInt(oldRoleRows.rows[0]?.n ?? "0", 10);
      const canDeleteOk = parseInt(canDeleteCol.rows[0]?.n ?? "0", 10) > 0;
      logger.info(
        `[MigrationDiag] POS roles: ${posCount} (${posWithStn} with pos_station set) | ` +
          `Normal User roles: ${normalCount} | ` +
          `Old roles remaining: ${oldRoleCount} | ` +
          `can_delete_records column: ${canDeleteOk ? "✓ present" : "✗ MISSING"}`
      );
      if (oldRoleCount > 0) {
        logger.warn(
          `[MigrationDiag] ⚠️  ${oldRoleCount} row(s) still have old roles (POS1–POS6 or User) — check /api/admin/deployment-diagnostics`
        );
      }
    } catch (e: unknown) {
      logger.warn("[MigrationDiag] Could not run startup diagnostic:", { error: getErrorMessage(e) });
    }
  }, 30000);

  // ── Fix bales where deletedAt is set but status is not DELETED ────────────
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

  // ── Clean up orphaned export runs ────────────────────────────────────────
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
    }
  };

  setTimeout(cleanupOrphanedRuns, 3000);
  setInterval(cleanupHungRuns, 30 * 60 * 1000);

  setTimeout(async () => {
    try {
      await checkAndRecoverDailyExport();
    } catch (e: unknown) {
      logger.warn("[DailyExport] Startup recovery call failed:", { error: getErrorMessage(e) });
    }
  }, 90 * 1000);
}
