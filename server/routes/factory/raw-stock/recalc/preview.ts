/**
 * rawStockRecalcRoutesLegacy: RawStockRecalcPreview endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { requireSessionUserId } from "../../../../lib/sessionUser";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { requireAuth, requireRole } from "../../../../auth";
import {
  getRawStockRecalcPreview,
  applyRawStockRecalc,
  loadRecalcFingerprintInputs,
  computeRecalcFingerprint,
  getAffectedMixBatchesPreview,
} from "../../../../services/factory/raw-stock-recalc";
import { logAudit } from "../../../helpers/auditHelpers";
import {
  signRepairToken,
  verifyRepairToken,
  ExpiredRepairTokenError,
  RepairTokenConfigurationError,
  REPAIR_TOKEN_TTL_MS,
} from "../../../../services/factory/repairToken";
import { pool } from "../../../../db";

import { ADMIN_ROLES, RecalcTokenPayload, captureRecalcSnapshot, ensureUndoLogTable } from "./_helpers";

export function registerRawStockRecalcPreviewRoutes(app: Express) {
  // Ensure the undo log table exists (idempotent, runs once at startup).
  ensureUndoLogTable().catch((err) => logger.error("[recalc] Failed to create undo log table:", { error: err }));
  // FIX 11: ensureTokenTable removed — consumed-tokens table DDL lives in migration
  // 20260718_factory_replay_consumed_tokens.sql; no startup DDL needed here.

  // Read-only diff preview — never writes anything. Admin/Developer-only: this
  // surfaces exact stored vs. corrected landed-cost figures for every container.
  app.get(
    "/api/factory/raw-stock/recalc/preview",
    requireAuth,
    requireRole(...ADMIN_ROLES),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const rows = await getRawStockRecalcPreview(companyId);
        res.json(rows);
      } catch (err: unknown) {
        logger.error("[raw-stock recalc preview] error:", { error: err });
        res.status(500).json({ message: getErrorMessage(err) || "Failed to compute recalculation preview" });
      }
    }
  );

  // Read-only preview of every mix batch (and bale count) that would be touched
  // by applying the given containers' corrected cost — the same batch-selection
  // and weighted-average math cascadeContainerCostChange uses, but never writes
  // anything. Lets the admin see the downstream blast radius before clicking Apply.
  app.post(
    "/api/factory/raw-stock/recalc/mix-batches-preview",
    requireAuth,
    requireRole(...ADMIN_ROLES),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const { containerIds, includeCompletedBatches } = req.body;
        if (!Array.isArray(containerIds) || containerIds.length === 0) {
          return res.json([]);
        }
        const parsedIds = containerIds.map((id) => parseInt(id)).filter((id: number) => !isNaN(id));
        const rows = await getAffectedMixBatchesPreview(companyId, parsedIds, includeCompletedBatches === true);
        res.json(rows);
      } catch (err: unknown) {
        logger.error("[raw-stock recalc mix-batches-preview] error:", { error: err });
        res.status(500).json({ message: getErrorMessage(err) || "Failed to compute affected mix batches preview" });
      }
    }
  );

  // Apply the corrected cost for the containers the admin approved, cascading to
  // mix batches/bales. Admin/Developer-only, dry-run by default (returns a signed,
  // expiring confirmationToken bound to companyId/containerIds/their old costs/the
  // requesting user); the actual write only happens when the caller re-submits with
  // { confirm: true, confirmationToken } and the token still matches the containers'
  // CURRENT stored cost (rejecting a stale token if anything changed since preview).
  // Refuses CLOSED/COMPLETED containers (reported, not silently skipped). Each
  // container is applied in its own transaction with a row lock, and its audit-log
  // entry is written atomically with it — see rawStockRecalc.ts.
  app.post(
    "/api/factory/raw-stock/recalc/apply",
    requireAuth,
    requireRole(...ADMIN_ROLES),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const { containerIds, confirm, confirmationToken, includeCompletedBatches, includeHistoricalContainers } =
          req.body;
        const wantsCompletedBatches = includeCompletedBatches === true;
        const wantsHistorical = includeHistoricalContainers === true;
        if (!Array.isArray(containerIds) || containerIds.length === 0) {
          return res.status(400).json({ message: "containerIds must be a non-empty array" });
        }
        const parsedIds = containerIds
          .map((id) => parseInt(id))
          .filter((id: number) => !isNaN(id))
          .sort((a: number, b: number) => a - b);
        if (parsedIds.length === 0) {
          return res.status(400).json({ message: "containerIds must contain at least one valid id" });
        }

        const preview = await getRawStockRecalcPreview(companyId);
        const previewByContainer = new Map(preview.map((r) => [r.containerId, r]));

        if (!confirm) {
          // Fingerprint EVERY approved calculation input per container (not just its
          // old cost) so the token is bound to the exact calculation the admin saw,
          // not merely the numeric outcome.
          const fingerprintByContainer: Record<number, string> = {};
          for (const id of parsedIds) {
            const inputs = await loadRecalcFingerprintInputs(companyId, id);
            if (inputs) fingerprintByContainer[id] = computeRecalcFingerprint(inputs);
          }
          const tokenPayload: RecalcTokenPayload = {
            companyId,
            containerIds: parsedIds,
            fingerprintByContainer,
            userId: requireSessionUserId(req),
            expiresAt: Date.now() + REPAIR_TOKEN_TTL_MS,
            includeCompletedBatches: wantsCompletedBatches,
            includeHistoricalContainers: wantsHistorical,
          };
          const token = signRepairToken(tokenPayload);
          return res.json({
            dryRun: true,
            rows: parsedIds.map((id: number) => previewByContainer.get(id)).filter(Boolean),
            confirmationToken: token,
          });
        }

        let tokenPayload: RecalcTokenPayload;
        try {
          tokenPayload = verifyRepairToken<RecalcTokenPayload>(confirmationToken);
        } catch (err: unknown) {
          if (err instanceof ExpiredRepairTokenError) {
            return res.status(400).json({ code: "TOKEN_EXPIRED", message: err.message });
          }
          return res.status(400).json({
            code: "INVALID_TOKEN",
            message: "confirmationToken does not match this exact recalc request — re-run the dry-run preview first.",
          });
        }

        const sameIds =
          tokenPayload.containerIds.length === parsedIds.length &&
          tokenPayload.containerIds.every((id, i) => id === parsedIds[i]);
        if (
          tokenPayload.companyId !== companyId ||
          !sameIds ||
          tokenPayload.userId !== req.session.userId ||
          tokenPayload.includeCompletedBatches !== wantsCompletedBatches ||
          (tokenPayload.includeHistoricalContainers ?? false) !== wantsHistorical
        ) {
          return res.status(400).json({
            code: "INVALID_TOKEN",
            message: "confirmationToken does not match this exact recalc request — re-run the dry-run preview first.",
          });
        }

        // The authoritative stale check is inside applyRawStockRecalc's row-locked
        // transaction (fingerprint recomputed from a fresh read there), so any change
        // that lands after this point but before that lock is still caught. This is a
        // cheap early-exit for the common case — no EPS tolerance; 6dp exact match.
        //
        // Skip the fingerprint check for containers already correct (changed === false):
        // idempotent replay of a token whose cost was applied in a prior call should
        // reach the service-layer no-op path rather than hitting STALE_TOKEN here.
        const freshPreview = await getRawStockRecalcPreview(companyId);
        const freshPreviewByContainer = new Map(freshPreview.map((r) => [r.containerId, r]));
        for (const id of parsedIds) {
          const freshRow = freshPreviewByContainer.get(id);
          if (freshRow && freshRow.changed === false) continue; // already correct — let service handle idempotency
          const inputs = await loadRecalcFingerprintInputs(companyId, id);
          const freshFingerprint = inputs ? computeRecalcFingerprint(inputs) : undefined;
          const tokenFingerprint = tokenPayload.fingerprintByContainer[id];
          if (tokenFingerprint && freshFingerprint && freshFingerprint !== tokenFingerprint) {
            return res.status(400).json({
              code: "STALE_TOKEN",
              message: `Container #${id} changed since the dry-run preview was issued — re-run the preview and try again.`,
            });
          }
        }

        // Capture before-state snapshot (must happen before any writes)
        const snapshot = await captureRecalcSnapshot(companyId, parsedIds);

        const results = await applyRawStockRecalc(companyId, parsedIds, {
          expectedFingerprints: tokenPayload.fingerprintByContainer,
          includeCompletedBatches: wantsCompletedBatches,
          includeHistoricalContainers: wantsHistorical,
          onAudit: async (tx, result) => {
            await logAudit(
              {
                userId: requireSessionUserId(req),
                username: req.session.username || requireSessionUserId(req),
                companyId,
                action: "update",
                tableName: "factory_raw_stock",
                recordId: result.containerId,
                recordIdentifier: `recalc/apply — container ${result.containerNumber}`,
                changes: { result: { new: { ...result, includeCompletedBatches: wantsCompletedBatches } } },
              },
              tx
            );
          },
        });

        const staleResult = results.find((r) => r.staleToken);
        if (staleResult) {
          return res.status(400).json({
            code: "STALE_TOKEN",
            message: `Container #${staleResult.containerId} changed since the dry-run preview was issued — re-run the preview and try again.`,
          });
        }

        // Persist undo snapshot (non-fatal if it fails — apply already committed)
        const _appliedContainerNumbers = snapshot.containers.map((c) =>
          String(c.finalPayableAmount !== undefined ? c.id : c.id)
        );
        const containerNumbersForDescription = results.filter((r) => r.applied).map((r) => r.containerNumber);
        try {
          await pool.query(
            `INSERT INTO factory_recalc_undo_log
               (company_id, user_id, username, description, container_count, container_numbers, snapshot)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              companyId,
              req.session.userId ?? null,
              req.session.username ?? null,
              `Applied cost recalc to ${results.filter((r) => r.applied).length} container(s)`,
              parsedIds.length,
              containerNumbersForDescription,
              JSON.stringify(snapshot),
            ]
          );
        } catch (undoErr) {
          logger.error("[recalc] Failed to save undo snapshot:", { error: undoErr });
        }

        res.json({ dryRun: false, results });
      } catch (err: unknown) {
        if (err instanceof RepairTokenConfigurationError) {
          logger.error("Repair token configuration error (SESSION_SECRET missing/fallback in production):", {
            error: err.message,
          });
          return res.status(500).json({ message: err.message, code: "REPAIR_TOKEN_MISCONFIGURED" });
        }
        logger.error("[raw-stock recalc apply] error:", { error: err });
        res.status(500).json({ message: getErrorMessage(err) || "Failed to apply recalculation" });
      }
    }
  );
}
