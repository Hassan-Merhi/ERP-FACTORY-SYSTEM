import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { requireAuth, requireRole } from "../../../auth";
import { pool } from "../../../db";
import {
  previewHistoricalCostReplayWithExecutor,
  type ReplayQueryExecutor,
} from "../../../services/factory/historicalCostReplay";

const APPLY_PATH = "/api/factory/raw-stock/recalc/historical-replay/apply";
const ADMIN_ROLES = ["Admin", "Developer"] as const;

function positiveIntegerIds(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.map((entry) => Number(entry));
  if (ids.some((entry) => !Number.isInteger(entry) || entry <= 0)) return null;
  return [...new Set(ids)].sort((left, right) => left - right);
}

/**
 * Historical Replay is a one-time company-wide migration, not a supplier-by-supplier
 * patch. This middleware runs before the protected Prepare route and replaces the
 * user's selection with every safe supplier in the company after all global gates pass.
 *
 * Apply requests carrying a signed token pass through unchanged: the token already
 * freezes the exact expanded supplier/batch/source/bale scope and options.
 */
export function registerHistoricalReplayFullCompanyScopeRoutes(app: Express): void {
  app.post(
    APPLY_PATH,
    requireAuth,
    requireRole(...ADMIN_ROLES),
    async (req, res, next) => {
      const hasToken = typeof req.body?.confirmationToken === "string"
        && req.body.confirmationToken.length > 0;
      if (hasToken) return next();

      const requestedSupplierIds = positiveIntegerIds(req.body?.supplierIds);
      if (!requestedSupplierIds || requestedSupplierIds.length === 0) {
        return res.status(400).json({
          message: "Select at least one supplier to confirm intent before preparing the full-company replay.",
          code: "HISTORICAL_REPLAY_EMPTY_SCOPE",
        });
      }

      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      try {
        const preview = await previewHistoricalCostReplayWithExecutor(
          pool as ReplayQueryExecutor,
          companyId
        );
        const impact = preview.financialImpact;
        if (!impact || impact.allSafetyGatesPassed !== true) {
          return res.status(409).json({
            message:
              "Historical Replay cannot prepare until every company-wide safety gate passes.",
            code: "HISTORICAL_REPLAY_SAFETY_GATES_FAILED",
            safetyGateDetails: impact?.safetyGateDetails ?? null,
            blockedBatches: preview.blockedBatches ?? [],
            unclassifiedAdjustmentRows: preview.unclassifiedAdjustmentRows ?? [],
            missingSupplierTimelineRows: preview.missingSupplierTimelineRows ?? [],
          });
        }

        const unsafeSuppliers = preview.supplierRows
          .filter((supplier) => !supplier.safeToRepair)
          .map((supplier) => ({
            supplierId: supplier.supplierId,
            supplierName: supplier.supplierName,
            reasons: supplier.reasons,
          }));
        if (unsafeSuppliers.length > 0) {
          return res.status(409).json({
            message:
              "Historical Replay cannot prepare while any company supplier timeline requires review.",
            code: "HISTORICAL_REPLAY_UNSAFE_SUPPLIERS",
            unsafeSuppliers,
          });
        }

        const allSafeSupplierIds = preview.supplierRows
          .map((supplier) => supplier.supplierId)
          .sort((left, right) => left - right);
        if (allSafeSupplierIds.length === 0) {
          return res.status(409).json({
            message: "Historical Replay found no supplier timelines to migrate.",
            code: "HISTORICAL_REPLAY_NO_SUPPLIERS",
          });
        }

        const originalJson = res.json.bind(res);
        res.json = (payload) => {
          if (!payload?.dryRun) return originalJson(payload);
          return originalJson({
            ...payload,
            fullCompanyScope: true,
            requestedSupplierIds,
            expandedSupplierIds: allSafeSupplierIds,
            frozenOptions: {
              ...(payload.frozenOptions ?? {}),
              includeCompletedBatches: true,
              includeFinalizedBales: false,
            },
          });
        };

        req.body.supplierIds = allSafeSupplierIds;
        req.body.forceSupplierIds = [];
        req.body.includeCompletedBatches = true;
        req.body.includeFinalizedBales = false;
        return next();
      } catch (error: unknown) {
        return res.status(500).json({
          message: getErrorMessage(error) || "Failed to prepare the full-company Historical Replay scope",
          code: (error as { code?: string }).code,
        });
      }
    }
  );
}
