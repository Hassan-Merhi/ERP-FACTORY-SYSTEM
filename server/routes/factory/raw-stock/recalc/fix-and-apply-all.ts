/**
 * rawStockRecalcRoutesLegacy: RawStockRecalcApplyAll endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { requireSessionUserId } from "../../../../lib/sessionUser";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { requireAuth, requireRole } from "../../../../auth";
import {
  applyRawStockRecalc,
  loadRecalcFingerprintInputs,
  computeRecalcFingerprint,
  computeApplyAllDryRun,
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

import { ADMIN_ROLES, ApplyAllSafeTokenPayload, captureRecalcSnapshot } from "./_helpers";

export function registerRawStockRecalcApplyAllRoutes(app: Express) {
  // ──────────────────────────────────────────────────────────────────────────
  // Apply all fixable source cost mismatches — no dry-run/token required
  // POST /api/factory/raw-stock/recalc/fix-source-mismatches
  //
  // Scans all mix_batch_source rows for cost mismatches against their
  // container's authoritative corrected rate, and applies fixes for all
  // "fixable" ones in a single pass. Safe to call after a recalc apply that
  // excluded completed batches — it will bring their source costs up to date
  // without cascading batch totals or bale costs.
  // ──────────────────────────────────────────────────────────────────────────
  app.post(
    "/api/factory/raw-stock/recalc/fix-source-mismatches",
    requireAuth,
    requireRole(...ADMIN_ROLES),
    async (req: import("express").Request, res: import("express").Response) => {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      // DEFECT 13 FIX: Supplier-priced source rows must be corrected through Historical
      // Replay (timeline-based rates), not this endpoint (container rate). Route 410.
      return res.status(410).json({
        message: "This endpoint is deprecated. Use the Historical Cost Replay tool to fix all source cost mismatches.",
        code: "USE_HISTORICAL_REPLAY",
      });
    }
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Apply all safe repairs — dry-run → token → confirm
  // POST /api/factory/raw-stock/recalc/apply-all-safe
  // Body (dry-run): { includeHistoricalContainers?, includeCompletedBatches? }
  // Body (confirm): { confirm: true, confirmationToken: "...", ... same flags }
  // ──────────────────────────────────────────────────────────────────────────
  app.post(
    "/api/factory/raw-stock/recalc/apply-all-safe",
    requireAuth,
    requireRole(...ADMIN_ROLES),
    async (req: import("express").Request, res: import("express").Response) => {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { confirm, confirmationToken, includeHistoricalContainers, includeCompletedBatches } = req.body;
      const wantsHistorical = includeHistoricalContainers === true;
      const wantsCompletedBatches = includeCompletedBatches === true;

      try {
        if (!confirm) {
          // ── Dry-run: identify all safe containers, build token ──────────
          const dryRun = await computeApplyAllDryRun(companyId, { includeHistoricalContainers: wantsHistorical });

          // DEFECT 12 FIX: Guard against applying to SUPPLIER_LOCKED_RATE sources via
          // apply-all-safe. Filter those containers OUT of the safe set rather than
          // blocking the entire operation — the remaining containers can still be fixed.
          if (dryRun.safeContainerIds.length > 0) {
            const { rows: supplierLinkedRows } = await pool.query<{ container_id: number }>(
              `SELECT DISTINCT mbs.container_id
               FROM factory_mix_batch_sources mbs
               JOIN factory_mix_batches mb ON mb.id = mbs.mix_batch_id
               WHERE mbs.container_id = ANY($1)
                 AND mb.company_id = $2
                 AND mbs.supplier_id IS NOT NULL AND mbs.source_batch_id IS NULL`,
              [dryRun.safeContainerIds, companyId]
            );
            if (supplierLinkedRows.length > 0) {
              const excludedIds = new Set(supplierLinkedRows.map((r) => r.container_id));
              dryRun.safeContainerIds = dryRun.safeContainerIds.filter((id) => !excludedIds.has(id));
            }
          }
          if (dryRun.safeContainerIds.length === 0) {
            return res.json({ dryRun: true, safeCount: 0, confirmationToken: null, summary: dryRun });
          }

          // Build per-container fingerprints so we can reject stale tokens at confirm
          const fingerprintByContainer: Record<number, string> = {};
          for (const cid of dryRun.safeContainerIds) {
            const inputs = await loadRecalcFingerprintInputs(companyId, cid);
            if (inputs) fingerprintByContainer[cid] = computeRecalcFingerprint(inputs);
          }

          const tokenPayload: ApplyAllSafeTokenPayload = {
            companyId,
            safeContainerIds: dryRun.safeContainerIds,
            userId: requireSessionUserId(req),
            expiresAt: Date.now() + REPAIR_TOKEN_TTL_MS,
            includeHistoricalContainers: wantsHistorical,
            includeCompletedBatches: wantsCompletedBatches,
          };

          const token = signRepairToken(tokenPayload);
          return res.json({ dryRun: true, summary: dryRun, confirmationToken: token });
        }

        // ── Confirm: verify token, check staleness, apply ─────────────────
        if (!confirmationToken || typeof confirmationToken !== "string") {
          return res
            .status(400)
            .json({ code: "MISSING_TOKEN", message: "confirmationToken is required for confirm=true" });
        }

        let tokenPayload: ApplyAllSafeTokenPayload;
        try {
          tokenPayload = verifyRepairToken<ApplyAllSafeTokenPayload>(confirmationToken);
        } catch (err: unknown) {
          if (err instanceof ExpiredRepairTokenError) {
            return res
              .status(400)
              .json({ code: "EXPIRED_TOKEN", message: "Dry-run preview has expired — please re-run it." });
          }
          return res.status(400).json({ code: "INVALID_TOKEN", message: getErrorMessage(err) });
        }

        if (
          tokenPayload.companyId !== companyId ||
          tokenPayload.userId !== req.session.userId ||
          (tokenPayload.includeHistoricalContainers ?? false) !== wantsHistorical ||
          (tokenPayload.includeCompletedBatches ?? false) !== wantsCompletedBatches
        ) {
          return res
            .status(400)
            .json({ code: "INVALID_TOKEN", message: "Token does not match this request — re-run the dry-run." });
        }

        const { safeContainerIds } = tokenPayload;

        // Capture before-state snapshot (must happen before any writes)
        const snapshot = await captureRecalcSnapshot(companyId, safeContainerIds);

        const results = await applyRawStockRecalc(companyId, safeContainerIds, {
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
                recordIdentifier: `recalc/apply-all-safe — container ${result.containerNumber}`,
                changes: { result: { new: { ...result, includeHistoricalContainers: wantsHistorical } } },
              },
              tx
            );
          },
        });

        const staleResult = results.find((r) => r.staleToken);
        if (staleResult) {
          return res.status(400).json({
            code: "STALE_TOKEN",
            message: `Container #${staleResult.containerId} changed since the dry-run — re-run.`,
          });
        }

        // Persist undo snapshot (non-fatal if it fails)
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
              `Applied all-safe cost recalc to ${results.filter((r) => r.applied).length} container(s)`,
              safeContainerIds.length,
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
          logger.error("Repair token configuration error:", { error: err.message });
          return res.status(500).json({ message: err.message, code: "REPAIR_TOKEN_MISCONFIGURED" });
        }
        logger.error("[raw-stock recalc apply-all-safe] error:", { error: err });
        res.status(500).json({ message: getErrorMessage(err) || "Failed to apply all safe repairs" });
      }
    }
  );
}
