/**
 * rawStockRecalcRoutesLegacy: RawStockPartialOffloadScan endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { requireAuth, requireRole } from "../../../../auth";
import { getRawStockRecalcPreview, applyRawStockRecalc } from "../../../../services/factory/raw-stock-recalc";
import type { RecalcRow } from "../../../../services/factory/raw-stock-recalc/preview";
import {
  signRepairToken,
  verifyRepairToken,
  ExpiredRepairTokenError,
  RepairTokenConfigurationError,
  REPAIR_TOKEN_TTL_MS,
} from "../../../../services/factory/repairToken";
import { pool } from "../../../../db";

import { ADMIN_ROLES, captureRecalcSnapshot } from "./_helpers";

export function registerRawStockPartialOffloadScanRoutes(app: Express) {
  // ──────────────────────────────────────────────────────────────────────────
  // Partial-offload legacy cost fix
  // GET  /api/factory/raw-stock/recalc/partial-offload-scan
  //   → Scans ALL containers (including historical) for ones that were
  //     partially received and whose stored cost/kg still reflects the old
  //     wrong formula (supplier rate only). Returns the list with old vs new.
  // POST /api/factory/raw-stock/recalc/partial-offload-scan/apply
  //   → No body            → dry-run: returns preview + signed token
  //   → { confirm, confirmationToken } → applies all via applyRawStockRecalc
  // ──────────────────────────────────────────────────────────────────────────
  app.get(
    "/api/factory/raw-stock/recalc/partial-offload-scan",
    requireAuth,
    requireRole(...ADMIN_ROLES),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const rows = await getRawStockRecalcPreview(companyId);
        // Include partial receipts (received < declared) AND fully-consumed containers
        // (remaining = 0). Old records may have null totalKg/declaredKg so wasPartialReceipt
        // can be false even when the container was a short delivery — fullyUsed catches those.
        const isTarget = (r: RecalcRow) => r.wasPartialReceipt || r.fullyUsed;
        const affected = rows.filter((r) => isTarget(r) && r.changed && !r.fxUnresolved);
        const skippedFx = rows.filter((r) => isTarget(r) && r.fxUnresolved);
        res.json({ affected, skippedFx, totalScanned: rows.length });
      } catch (err: unknown) {
        logger.error("[partial-offload-scan] error:", { error: err });
        res.status(500).json({ message: getErrorMessage(err) || "Failed to scan partial offload containers" });
      }
    }
  );

  app.post(
    "/api/factory/raw-stock/recalc/partial-offload-scan/apply",
    requireAuth,
    requireRole(...ADMIN_ROLES),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const { confirm, confirmationToken } = req.body || {};

        if (!confirm) {
          // ── Dry-run: identify containers, build token ──────────────────────
          const rows = await getRawStockRecalcPreview(companyId);
          const isTarget = (r: RecalcRow) => r.wasPartialReceipt || r.fullyUsed;
          const affected = rows.filter((r) => isTarget(r) && r.changed && !r.fxUnresolved);
          if (affected.length === 0) {
            return res.json({ dryRun: true, count: 0, confirmationToken: null, affected: [] });
          }
          const containerIds = affected.map((r) => r.containerId).sort((a, b) => a - b);
          const token = signRepairToken({
            companyId,
            containerIds,
            userId: req.session.userId,
            expiresAt: Date.now() + REPAIR_TOKEN_TTL_MS,
            kind: "partial-offload-fix",
          });
          return res.json({ dryRun: true, count: affected.length, confirmationToken: token, affected });
        }

        // ── Confirm: verify token and apply ────────────────────────────────
        if (!confirmationToken || typeof confirmationToken !== "string") {
          return res.status(400).json({ code: "MISSING_TOKEN", message: "confirmationToken required" });
        }
        type PartialOffloadTokenPayload = { companyId: number; kind: string; containerIds: number[] };
        let tokenPayload: PartialOffloadTokenPayload;
        try {
          tokenPayload = verifyRepairToken<PartialOffloadTokenPayload>(confirmationToken);
        } catch (err: unknown) {
          if (err instanceof ExpiredRepairTokenError) {
            return res.status(400).json({ code: "TOKEN_EXPIRED", message: err.message });
          }
          return res
            .status(400)
            .json({ code: "INVALID_TOKEN", message: "Invalid or tampered token — re-run the scan first." });
        }
        if (tokenPayload.companyId !== companyId || tokenPayload.kind !== "partial-offload-fix") {
          return res.status(400).json({ code: "INVALID_TOKEN", message: "Token does not match this request." });
        }

        // Capture snapshot for undo log before applying
        const snapshot = await captureRecalcSnapshot(companyId, tokenPayload.containerIds);

        const results = await applyRawStockRecalc(companyId, tokenPayload.containerIds, {
          includeHistoricalContainers: true,
          includeCompletedBatches: true,
        });

        const applied = results.filter((r) => r.applied);
        const skipped = results.filter((r) => !r.applied);

        // Write undo log entry
        await pool.query(
          `INSERT INTO factory_recalc_undo_log
             (company_id, user_id, username, description, container_count, container_numbers, snapshot)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            companyId,
            req.session.userId,
            req.session.username || null,
            `Partial-offload legacy cost fix — ${applied.length} container(s) corrected`,
            applied.length,
            applied.map((r) => r.containerNumber),
            JSON.stringify(snapshot),
          ]
        );

        res.json({ dryRun: false, applied: applied.length, skipped: skipped.length, results });
      } catch (err: unknown) {
        if (err instanceof RepairTokenConfigurationError) {
          return res.status(500).json({ message: err.message, code: "REPAIR_TOKEN_MISCONFIGURED" });
        }
        logger.error("[partial-offload-scan apply] error:", { error: err });
        res.status(500).json({ message: getErrorMessage(err) || "Failed to apply partial-offload fix" });
      }
    }
  );
}
