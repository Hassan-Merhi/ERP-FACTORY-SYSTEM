// Extracted from ./historicalReplayRoutesV4.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { inspectPhase5ReplayScopeSafety } from "../../../services/factory/historical-replay/downstreamGatePhase5";
import { logger } from "../../../lib/logger";
import crypto from "crypto";
import { requireAuth, requireRole } from "../../../auth";
import { pool } from "../../../db";
import {
  applyHistoricalCostReplay,
  assertExactReplayCurrentCostsMatchApplied,
  assertExactReplayNonCostInvariants,
  buildHistoricalReplayScopeInternal,
  captureExactReplaySnapshot,
  computeReplayFingerprint,
  lockExactReplayScopeRows,
  normalizeReplayWriteScope,
  previewHistoricalCostReplay,
  previewHistoricalCostReplayWithExecutor,
  REPLAY_ALGORITHM_VERSION,
  replayBaleIdsForScope,
  type ReplayQueryExecutor,
  StaleTokenError,
} from "../../../services/factory/historicalCostReplay";
import {
  ExpiredRepairTokenError,
  REPAIR_TOKEN_TTL_MS,
  RepairTokenConfigurationError,
  signRepairToken,
  verifyRepairToken,
} from "../../../services/factory/repairToken";
import {
  ADMIN_ROLES,
  EXACT_UNDO_KIND,
  assertOne,
  numberArray,
  parseExactUndoEnvelope,
  parseReplayWriteScope,
  restoreExactReplayCosts,
  type ExactReplayUndoEnvelope,
  type HistoricalReplayTokenPayload,
} from "./restoreExactReplayCosts";

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

  app.post(
    "/api/factory/raw-stock/recalc/historical-replay/apply",
    requireAuth,
    requireRole(...ADMIN_ROLES),
    async (req, res) => {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      const userId = String(req.session.userId ?? "");
      const username = req.session.username ?? null;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const providedToken = req.body?.confirmationToken;
      const isDryRun = req.body?.dryRun === true || !providedToken;
      const wantsCompletedBatches = req.body?.includeCompletedBatches === true;
      const wantsFinalizedBales = req.body?.includeFinalizedBales === true;

      try {
        if (isDryRun) {
          const requestedIds = numberArray(req.body?.supplierIds) ?? [];
          const prepareClient = await pool.connect();
          try {
            await prepareClient.query("BEGIN");
            await prepareClient.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
            await prepareClient.query("SELECT set_config('app.current_company_id', $1, true)", [String(companyId)]);
            const executor = prepareClient as unknown as ReplayQueryExecutor;

            const selectionPreview = await previewHistoricalCostReplayWithExecutor(executor, companyId);
            const previewSafeIds = selectionPreview.supplierRows
              .filter((supplier) => supplier.safeToRepair)
              .map((supplier) => supplier.supplierId);
            const selectedSafeIds =
              requestedIds.length > 0 ? requestedIds.filter((id) => previewSafeIds.includes(id)) : previewSafeIds;

            const internalScope = await buildHistoricalReplayScopeInternal({
              companyId,
              selectedSupplierIds: new Set(selectedSafeIds),
              includeCompletedBatches: wantsCompletedBatches,
              includeFinalizedBales: wantsFinalizedBales,
              executor,
              lockRows: false,
            });
            const normalizedScope = normalizeReplayWriteScope(internalScope);
            const downstreamSafety = await inspectPhase5ReplayScopeSafety(executor, companyId, normalizedScope);
            const preview = internalScope._fullPreview;
            const safeSupplierIds = normalizedScope.supplierIds;
            const fingerprint = computeReplayFingerprint(
              companyId,
              safeSupplierIds,
              preview,
              {
                includeCompletedBatches: wantsCompletedBatches,
                includeFinalizedBales: wantsFinalizedBales,
              },
              normalizedScope
            );

            const tokenPayload: HistoricalReplayTokenPayload = {
              companyId,
              supplierIds: safeSupplierIds,
              includeCompletedBatches: wantsCompletedBatches,
              includeFinalizedBales: wantsFinalizedBales,
              fingerprint,
              scope: normalizedScope,
              userId,
              algorithmVersion: REPLAY_ALGORITHM_VERSION,
              expiresAt: Date.now() + REPAIR_TOKEN_TTL_MS,
            };
            const confirmationToken = downstreamSafety.safeToApply ? signRepairToken(tokenPayload) : null;
            await prepareClient.query("COMMIT");

            return res.json({
              dryRun: true,
              downstreamSafety,
              summary: preview.summary,
              safeSupplierIds,
              suppliersToApply: preview.supplierRows.filter((supplier) =>
                safeSupplierIds.includes(supplier.supplierId)
              ),
              confirmationToken,
              fingerprint,
              expiresInMs: REPAIR_TOKEN_TTL_MS,
              algorithmVersion: REPLAY_ALGORITHM_VERSION,
              frozenOptions: {
                includeCompletedBatches: wantsCompletedBatches,
                includeFinalizedBales: wantsFinalizedBales,
              },
              scope: {
                suppliers: normalizedScope.supplierIds.length,
                containers: normalizedScope.containerIdsToUpdate.length,
                rawStockRows: normalizedScope.rawStockIdsToUpdate.length,
                supplierSources: normalizedScope.sourceIdsToUpdate.length,
                batches: normalizedScope.batchIdsToUpdate.length,
                availableBales: normalizedScope.availableBaleIdsToUpdate.length,
                finalizedBales: wantsFinalizedBales ? normalizedScope.finalizedBaleIdsToUpdate.length : 0,
                excludedFinalizedBales: wantsFinalizedBales ? 0 : normalizedScope.finalizedBaleIdsToUpdate.length,
                blockedBatches: normalizedScope.blockedBatches.length,
              },
            });
          } catch (error) {
            await prepareClient.query("ROLLBACK");
            throw error;
          } finally {
            prepareClient.release();
          }
        }

        let payload: HistoricalReplayTokenPayload;
        try {
          payload = verifyRepairToken<HistoricalReplayTokenPayload>(providedToken);
        } catch (error: unknown) {
          if (error instanceof ExpiredRepairTokenError) {
            return res.status(400).json({
              message: "Confirmation token expired — re-run Prepare Historical Replay.",
            });
          }
          return res.status(400).json({ message: `Invalid confirmation token: ${getErrorMessage(error)}` });
        }

        if (payload.companyId !== companyId) return res.status(400).json({ message: "Token company mismatch" });
        if (payload.userId !== userId) {
          return res.status(400).json({ message: "Token user mismatch — token belongs to another user." });
        }
        if (payload.algorithmVersion !== REPLAY_ALGORITHM_VERSION) {
          return res.status(400).json({ message: "Replay algorithm changed — re-run Prepare Historical Replay." });
        }

        const signedScope = parseReplayWriteScope(payload.scope);
        const signedSupplierIds = numberArray(payload.supplierIds);
        if (!signedScope || !signedSupplierIds) {
          return res.status(400).json({
            message: "Token predates exact signed replay scopes — re-run Prepare Historical Replay.",
          });
        }
        if (JSON.stringify(signedSupplierIds) !== JSON.stringify(signedScope.supplierIds)) {
          return res.status(400).json({ message: "Token supplier scope is inconsistent." });
        }

        const supplierNameResult =
          signedSupplierIds.length > 0
            ? await pool.query<{ name: string }>(
                `SELECT name FROM factory_suppliers
               WHERE id = ANY($1) AND company_id = $2 ORDER BY id`,
                [signedSupplierIds, companyId]
              )
            : { rows: [] as Array<{ name: string }> };
        const supplierNames = supplierNameResult.rows.map((row) => row.name).join(", ");
        const tokenHash = crypto.createHash("sha256").update(providedToken).digest("hex");
        const baleIds = replayBaleIdsForScope(signedScope, payload.includeFinalizedBales === true);

        const result = await applyHistoricalCostReplay({
          companyId,
          supplierIds: signedSupplierIds,
          includeCompletedBatches: payload.includeCompletedBatches === true,
          includeFinalizedBales: payload.includeFinalizedBales === true,
          expectedFingerprint: payload.fingerprint,
          expectedScope: signedScope,
          algorithmVersion: payload.algorithmVersion,
          issuedByUserId: payload.userId,
          tokenHash,
          onCommit: async (client, applyResult, snapshots) => {
            const undoEnvelope: ExactReplayUndoEnvelope = {
              kind: EXACT_UNDO_KIND,
              algorithmVersion: payload.algorithmVersion,
              fingerprint: payload.fingerprint,
              includeCompletedBatches: payload.includeCompletedBatches === true,
              includeFinalizedBales: payload.includeFinalizedBales === true,
              scope: signedScope,
              baleIds,
              before: snapshots.before,
              after: snapshots.after,
            };
            await client.query(
              `INSERT INTO factory_recalc_undo_log
                 (company_id, user_id, username, description, container_count,
                  container_numbers, snapshot, operation_type, algorithm_version,
                  scope_fingerprint)
               VALUES ($1, $2, $3, $4, $5, $6, $7, 'HISTORICAL_REPLAY_EXACT', $8, $9)`,
              [
                companyId,
                userId || null,
                username,
                `Historical cost replay — ${signedSupplierIds.length} supplier(s): ${supplierNames}`,
                signedScope.containerIdsToUpdate.length,
                [],
                JSON.stringify(undoEnvelope),
                payload.algorithmVersion,
                payload.fingerprint,
              ]
            );
            await client.query(
              `INSERT INTO audit_log
                 (user_id, username, company_id, action, table_name, record_id,
                  record_identifier, changes, created_at)
               VALUES ($1, $2, $3, 'historical_cost_replay_applied',
                       'factory_suppliers', $4, $5, $6::jsonb, NOW())`,
              [
                userId,
                username,
                companyId,
                companyId,
                `historical_cost_replay — ${signedSupplierIds.length} supplier(s): ${supplierNames}`,
                JSON.stringify({
                  applied: applyResult,
                  supplierIds: signedSupplierIds,
                  scope: signedScope,
                  options: {
                    includeCompletedBatches: payload.includeCompletedBatches,
                    includeFinalizedBales: payload.includeFinalizedBales,
                  },
                  fingerprint: payload.fingerprint,
                }),
              ]
            );
          },
        });

        return res.json({ success: true, ...result });
      } catch (error: unknown) {
        if (
          error instanceof StaleTokenError ||
          (error as { code?: string }).code === "STALE_TOKEN" ||
          (error as { code?: string }).code === "HISTORICAL_REPLAY_SCOPE_VIOLATION" ||
          (error as { code?: string }).code === "HISTORICAL_REPLAY_INVARIANT_VIOLATION" ||
          (error as { code?: string }).code === "HISTORICAL_REPLAY_DOWNSTREAM_UNRECONCILED"
        ) {
          return res.status(409).json({
            message: getErrorMessage(error),
            code: (error as { code?: string }).code ?? "STALE_TOKEN",
          });
        }
        if (error instanceof RepairTokenConfigurationError) {
          return res.status(500).json({
            message: error.message,
            code: "REPAIR_TOKEN_MISCONFIGURED",
          });
        }
        logger.error("[historical-replay v4 apply] error:", { error: error });
        return res.status(500).json({
          message: getErrorMessage(error) || "Failed to apply historical replay",
        });
      }
    }
  );
}
