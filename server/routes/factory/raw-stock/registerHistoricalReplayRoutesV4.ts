// Extracted from ./historicalReplayRoutesV4.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { requireAuth, requireRole } from "../../../auth";
import { pool } from "../../../db";
import {
  assertExactReplayCurrentCostsMatchApplied,
  assertExactReplayNonCostInvariants,
  captureExactReplaySnapshot,
  lockExactReplayScopeRows,
  previewHistoricalCostReplay,
  REPLAY_ALGORITHM_VERSION,
  type ReplayQueryExecutor,
} from "../../../services/factory/historicalCostReplay";
import {
  ADMIN_ROLES,
  EXACT_UNDO_KIND,
  assertOne,
  parseExactUndoEnvelope,
  restoreExactReplayCosts,
} from "./restoreExactReplayCosts";
import { registerHistoricalReplayRoutesV4Part1 } from "./registerHistoricalReplayRoutesV4Part1";

/**
 * Registers exact replay routes before the preserved legacy raw-stock module.
 */
export function registerHistoricalReplayRoutesV4(app: Express): void {
  // Exact stale-safe undo intercept. Non-replay undo entries fall through to the
  // preserved legacy handler registered after this module.
  app.post("/api/factory/raw-stock/recalc/undo", requireAuth, requireRole(...ADMIN_ROLES), async (req, res, next) => {
    const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
    if (!companyId) return res.status(400).json({ message: "No company selected" });
    const undoLogId = Number.parseInt(String(req.body?.undoLogId ?? ""), 10);
    if (!Number.isInteger(undoLogId) || undoLogId <= 0) return next();

    try {
      const probe = await pool.query<{ snapshot: unknown }>(
        `SELECT snapshot
           FROM factory_recalc_undo_log
           WHERE id = $1 AND company_id = $2`,
        [undoLogId, companyId]
      );
      if (!probe.rows[0] || !(probe.rows[0].snapshot as { kind: unknown })?.kind) return next();
      if ((probe.rows[0].snapshot as { kind: "HISTORICAL_REPLAY_EXACT_V1" }).kind !== EXACT_UNDO_KIND) return next();

      const client = await pool.connect();
      const executor = client as unknown as ReplayQueryExecutor;
      try {
        await client.query("BEGIN");
        await client.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
        await client.query(`SELECT pg_advisory_xact_lock(9003, $1)`, [companyId]);

        const lockedLog = await client.query<{ snapshot: unknown; undone_at: Date | null }>(
          `SELECT snapshot, undone_at
             FROM factory_recalc_undo_log
             WHERE id = $1 AND company_id = $2
             FOR UPDATE`,
          [undoLogId, companyId]
        );
        if (!lockedLog.rows[0]) {
          throw Object.assign(new Error("Undo log entry not found"), { statusCode: 404 });
        }
        if (lockedLog.rows[0].undone_at) {
          throw Object.assign(new Error("This historical replay has already been undone"), { statusCode: 409 });
        }

        const envelope = parseExactUndoEnvelope(lockedLog.rows[0].snapshot);
        if (!envelope) {
          throw Object.assign(new Error("Undo log is not an exact historical replay snapshot"), { statusCode: 409 });
        }
        if (envelope.algorithmVersion !== REPLAY_ALGORITHM_VERSION) {
          throw Object.assign(
            new Error("Undo snapshot algorithm differs from the current replay engine; manual review is required"),
            { statusCode: 409 }
          );
        }

        await lockExactReplayScopeRows(executor, companyId, envelope.scope, envelope.baleIds);
        const current = await captureExactReplaySnapshot(executor, companyId, envelope.scope, envelope.baleIds);
        assertExactReplayNonCostInvariants(envelope.after, current);
        assertExactReplayCurrentCostsMatchApplied(envelope.after, current);

        await restoreExactReplayCosts(executor, companyId, envelope.before);
        const restored = await captureExactReplaySnapshot(executor, companyId, envelope.scope, envelope.baleIds);
        assertExactReplayNonCostInvariants(envelope.before, restored);
        assertExactReplayCurrentCostsMatchApplied(envelope.before, restored);

        const markUndone = await client.query(
          `UPDATE factory_recalc_undo_log
             SET undone_at = NOW(),
                 undone_by_user_id = $1,
                 undone_by_username = $2
             WHERE id = $3 AND company_id = $4 AND undone_at IS NULL`,
          [String(req.session.userId ?? ""), req.session.username ?? null, undoLogId, companyId]
        );
        assertOne(markUndone.rowCount, `undo log ${undoLogId}`);

        await client.query(
          `INSERT INTO audit_log
               (user_id, username, company_id, action, table_name, record_id,
                record_identifier, changes, created_at)
             VALUES ($1, $2, $3, 'historical_cost_replay_undo',
                     'factory_recalc_undo_log', $4, $5, $6::jsonb, NOW())`,
          [
            String(req.session.userId ?? ""),
            req.session.username ?? null,
            companyId,
            undoLogId,
            `historical replay exact undo — log ${undoLogId}`,
            JSON.stringify({
              fingerprint: envelope.fingerprint,
              scope: envelope.scope,
              restored: {
                containers: envelope.before.containers.length,
                rawStockRows: envelope.before.rawStockRows.length,
                sources: envelope.before.mixBatchSources.length,
                batches: envelope.before.mixBatches.length,
                bales: envelope.before.bales.length,
                suppliers: envelope.before.suppliers.length,
              },
            }),
          ]
        );

        await client.query("COMMIT");
        return res.json({
          success: true,
          exactHistoricalReplayUndo: true,
          containersRestored: envelope.before.containers.length,
          rawStockRowsRestored: envelope.before.rawStockRows.length,
          mixBatchSourcesRestored: envelope.before.mixBatchSources.length,
          mixBatchesRestored: envelope.before.mixBatches.length,
          balesRestored: envelope.before.bales.length,
          suppliersRestored: envelope.before.suppliers.length,
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error: unknown) {
      const stale = [
        "HISTORICAL_REPLAY_UNDO_STALE",
        "HISTORICAL_REPLAY_UNDO_INVALID",
        "HISTORICAL_REPLAY_UNDO_SCOPE_VIOLATION",
        "HISTORICAL_REPLAY_INVARIANT_VIOLATION",
      ].includes((error as { code?: string }).code ?? "");
      return res.status((error as { statusCode?: number }).statusCode ?? (stale ? 409 : 500)).json({
        message: getErrorMessage(error) || "Failed to undo historical replay",
        code: (error as { code?: string }).code,
      });
    }
  });

  app.get(
    "/api/factory/raw-stock/recalc/historical-replay",
    requireAuth,
    requireRole(...ADMIN_ROLES),
    async (req, res) => {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      try {
        const preview = await previewHistoricalCostReplay(companyId);
        res.json(preview);
      } catch (error: unknown) {
        logger.error("[historical-replay v4 preview] error:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) || "Failed to compute historical replay preview" });
      }
    }
  );

  registerHistoricalReplayRoutesV4Part1(app);
}
