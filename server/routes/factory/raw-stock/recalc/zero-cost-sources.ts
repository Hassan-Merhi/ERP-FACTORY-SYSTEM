/**
 * rawStockRecalcRoutesLegacy: RawStockZeroCostSource endpoints.
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
  getZeroCostMixBatchSourcesPreview,
  applyZeroCostMixBatchSourcesFix,
} from "../../../../services/factory/raw-stock-recalc";
import { logAudit } from "../../../helpers/auditHelpers";
import {
  signRepairToken,
  verifyRepairToken,
  ExpiredRepairTokenError,
  RepairTokenConfigurationError,
  REPAIR_TOKEN_TTL_MS,
} from "../../../../services/factory/repairToken";
import { ADMIN_ROLES, ZeroCostSourceTokenPayload } from "./_helpers";

export function registerRawStockZeroCostSourceRoutes(app: Express) {
  // Read-only scan for mix-batch-source rows recorded with cost 0 despite real
  // weight — a different bug from the container-level drift above: the parent
  // container's own cost can already be correct (so it never shows up as a
  // "changed" row and is never selectable there), yet its downstream batches
  // are still dragged toward zero. Independent of container selection.
  app.get(
    "/api/factory/raw-stock/recalc/zero-cost-sources",
    requireAuth,
    requireRole(...ADMIN_ROLES),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const rows = await getZeroCostMixBatchSourcesPreview(companyId);
        res.json(rows);
      } catch (err: unknown) {
        logger.error("[raw-stock recalc zero-cost-sources] error:", { error: err });
        res
          .status(500)
          .json({ message: getErrorMessage(err) || "Failed to compute zero-cost mix-batch-source preview" });
      }
    }
  );

  // Apply the fix for the zero-cost mix-batch-source rows the admin approved.
  // Same dry-run → signed confirmationToken → confirm flow as recalc/apply
  // above. manualRates only ever applies to sources with no container link
  // (the service layer refuses to let a manual rate override a container-linked
  // source that already has a real cost on file).
  app.post(
    "/api/factory/raw-stock/recalc/zero-cost-sources/apply",
    requireAuth,
    requireRole(...ADMIN_ROLES),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const { sourceIds, manualRates, confirm, confirmationToken } = req.body;
        if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
          return res.status(400).json({ message: "sourceIds must be a non-empty array" });
        }
        const parsedIds = sourceIds
          .map((id) => parseInt(id))
          .filter((id: number) => !isNaN(id))
          .sort((a: number, b: number) => a - b);
        if (parsedIds.length === 0) {
          return res.status(400).json({ message: "sourceIds must contain at least one valid id" });
        }
        const parsedManualRates: Record<number, number> = {};
        if (manualRates && typeof manualRates === "object") {
          for (const [key, value] of Object.entries(manualRates)) {
            const id = parseInt(key);
            const rate = parseFloat(value as string);
            if (!isNaN(id) && !isNaN(rate) && rate > 0) parsedManualRates[id] = rate;
          }
        }

        if (!confirm) {
          const preview = await getZeroCostMixBatchSourcesPreview(companyId);
          const previewById = new Map(preview.map((r) => [r.sourceId, r]));
          const tokenPayload: ZeroCostSourceTokenPayload = {
            companyId,
            sourceIds: parsedIds,
            manualRates: parsedManualRates,
            userId: requireSessionUserId(req),
            expiresAt: Date.now() + REPAIR_TOKEN_TTL_MS,
          };
          const token = signRepairToken(tokenPayload);
          return res.json({
            dryRun: true,
            rows: parsedIds.map((id: number) => previewById.get(id)).filter(Boolean),
            confirmationToken: token,
          });
        }

        let tokenPayload: ZeroCostSourceTokenPayload;
        try {
          tokenPayload = verifyRepairToken<ZeroCostSourceTokenPayload>(confirmationToken);
        } catch (err: unknown) {
          if (err instanceof ExpiredRepairTokenError) {
            return res.status(400).json({ code: "TOKEN_EXPIRED", message: err.message });
          }
          return res.status(400).json({
            code: "INVALID_TOKEN",
            message: "confirmationToken does not match this exact request — re-run the dry-run preview first.",
          });
        }

        const sameIds =
          tokenPayload.sourceIds.length === parsedIds.length &&
          tokenPayload.sourceIds.every((id, i) => id === parsedIds[i]);
        const sameRates = JSON.stringify(tokenPayload.manualRates) === JSON.stringify(parsedManualRates);
        if (
          tokenPayload.companyId !== companyId ||
          !sameIds ||
          !sameRates ||
          tokenPayload.userId !== req.session.userId
        ) {
          return res.status(400).json({
            code: "INVALID_TOKEN",
            message: "confirmationToken does not match this exact request — re-run the dry-run preview first.",
          });
        }

        const results = await applyZeroCostMixBatchSourcesFix(companyId, parsedIds, {
          manualRates: parsedManualRates,
          onAudit: async (tx, result) => {
            await logAudit(
              {
                userId: requireSessionUserId(req),
                username: req.session.username || requireSessionUserId(req),
                companyId,
                action: "update",
                tableName: "factory_mix_batch_sources",
                recordId: result.sourceId,
                recordIdentifier: `zero-cost-source/apply — batch ${result.batchCode}`,
                changes: { result: { new: result } },
              },
              tx
            );
          },
        });

        res.json({ dryRun: false, results });
      } catch (err: unknown) {
        if (err instanceof RepairTokenConfigurationError) {
          logger.error("Repair token configuration error (SESSION_SECRET missing/fallback in production):", {
            error: err.message,
          });
          return res.status(500).json({ message: err.message, code: "REPAIR_TOKEN_MISCONFIGURED" });
        }
        logger.error("[raw-stock recalc zero-cost-sources apply] error:", { error: err });
        res.status(500).json({ message: getErrorMessage(err) || "Failed to apply zero-cost source fix" });
      }
    }
  );
}
