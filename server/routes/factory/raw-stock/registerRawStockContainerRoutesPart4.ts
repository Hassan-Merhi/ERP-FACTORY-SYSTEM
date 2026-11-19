// Extracted from ./registerRawStockContainerRoutesPart3.ts
import { parseId } from "../../../lib/parseId";
import { parseMoneyInput } from "../../../lib/money";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { getClientDate } from "../../../lib/dateUtils";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth, requireRole } from "../../../auth";
import {
  applyPostOffloadChargeMutation,
  type PostOffloadMutationResult,
} from "../../../services/factory/post-offload-charge";
import { factoryContainers, factoryDutyAuditLog } from "@shared/schema";
import { and, desc, eq } from "drizzle-orm";
import { ADMIN_ROLES, positiveRequestAmount } from "./registerRawStockContainerRoutesPart1";

export function registerRawStockContainerRoutesPart4(app: Express) {
  // ── DELETE /api/factory/containers/:id/post-offload-charges/:chargeId ────────
  // Undo (soft-delete) a charge and reverse accounting. Admin only.
  app.delete(
    "/api/factory/containers/:id/post-offload-charges/:chargeId",
    requireAuth,
    requireRole(...ADMIN_ROLES),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const containerId = parseId(req.params.id);
        const chargeId = parseId(req.params.chargeId);
        if (containerId === null || chargeId === null) return res.status(400).json({ message: "Invalid id" });

        const { expectedVersion, undoDate, legacyBaselineRate } = req.body || {};

        const [container] = await db
          .select()
          .from(factoryContainers)
          .where(and(eq(factoryContainers.id, containerId), eq(factoryContainers.companyId, companyId)));
        if (!container) return res.status(404).json({ message: "Container not found" });

        const txDate = undoDate || getClientDate(req);
        const userId = String(req.session.userId || req.user?.id || "system");
        // The transaction returns its callback's value, so the result is a plain
        // definitely-assigned local rather than the `any` it used to be.
        let mutResult: PostOffloadMutationResult;

        try {
          mutResult = await db.transaction(async (tx) =>
            applyPostOffloadChargeMutation(tx, {
              action: "UNDO",
              companyId,
              containerId,
              chargeId,
              txDate,
              userId,
              expectedVersion: expectedVersion !== undefined ? parseInt(expectedVersion) : undefined,
              legacyBaselineRate:
                legacyBaselineRate !== undefined ? (parseMoneyInput(legacyBaselineRate)?.toNumber() ?? NaN) : undefined,
            })
          );
        } catch (err: unknown) {
          if ((err as { status?: number }).status === 409)
            return res.status(409).json({ message: getErrorMessage(err) });
          throw err;
        }
        if (mutResult.alreadyUndone) {
          return res.json({ message: "Charge was already undone", alreadyUndone: true, chargeId });
        }

        res.json({
          message: "Post-offload charge undone and accounting reversed",
          ...mutResult,
          supplierLockedRateOldExact: mutResult.supplierLockedRateBefore,
          supplierLockedRateNewExact: mutResult.supplierLockedRateAfter,
          affectedBatches: (mutResult.cascadeResult?.affectedBatches ?? []).map((b) => ({
            batchId: b.batchId,
            batchCode: b.batchCode,
            status: b.status ?? null,
            wasCompleted: b.wasCompleted,
            weightKgFromContainer: b.weightKgFromContainer,
            oldCostPerKg: b.oldCostPerKg,
            newCostPerKg: b.newCostPerKg,
          })),
          affectedBalesCount: mutResult.cascadeResult?.affectedBales?.length ?? 0,
          rawStockRowsUpdated: mutResult.cascadeResult?.rawStockRowsUpdated ?? 0,
        });
      } catch (error: unknown) {
        logger.error("Error undoing post-offload charge:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // ── PATCH /api/factory/containers/:id/post-offload-charges/:chargeId/legacy-rebuild
  // Rebuild supplier rate for a legacy charge (supplierLockedRateBefore IS NULL). Admin only.
  app.patch(
    "/api/factory/containers/:id/post-offload-charges/:chargeId/legacy-rebuild",
    requireAuth,
    requireRole(...ADMIN_ROLES),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const containerId = parseId(req.params.id);
        const chargeId = parseId(req.params.chargeId);
        if (containerId === null || chargeId === null) return res.status(400).json({ message: "Invalid id" });

        const { legacyBaselineRate, expectedVersion } = req.body || {};
        const legacyBaselineRateExact = positiveRequestAmount(legacyBaselineRate);
        if (!legacyBaselineRateExact) {
          return res.status(400).json({ message: "legacyBaselineRate is required and must be > 0" });
        }

        const [container] = await db
          .select()
          .from(factoryContainers)
          .where(and(eq(factoryContainers.id, containerId), eq(factoryContainers.companyId, companyId)));
        if (!container) return res.status(404).json({ message: "Container not found" });

        const userId = String(req.session.userId || req.user?.id || "system");
        // The transaction returns its callback's value, so the result is a plain
        // definitely-assigned local rather than the `any` it used to be.
        let mutResult: PostOffloadMutationResult;

        try {
          mutResult = await db.transaction(async (tx) =>
            applyPostOffloadChargeMutation(tx, {
              action: "LEGACY_REBUILD",
              companyId,
              containerId,
              chargeId,
              txDate: getClientDate(req),
              userId,
              legacyBaselineRate: legacyBaselineRateExact.toNumber(),
              expectedVersion: expectedVersion !== undefined ? parseInt(expectedVersion) : undefined,
            })
          );
        } catch (err: unknown) {
          if ((err as { status?: number }).status === 409)
            return res.status(409).json({ message: getErrorMessage(err) });
          throw err;
        }
        res.json({
          message: "Legacy charge supplier rate rebuilt successfully",
          ...mutResult,
          supplierLockedRateOldExact: mutResult.supplierLockedRateBefore,
          supplierLockedRateNewExact: mutResult.supplierLockedRateAfter,
        });
      } catch (error: unknown) {
        logger.error("Error rebuilding legacy post-offload charge:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.get("/api/factory/containers/:id/duty-audit-log", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const containerId = parseId(req.params.id);

      if (containerId === null) return res.status(400).json({ message: "Invalid id" });
      const logs = await db
        .select()
        .from(factoryDutyAuditLog)
        .where(and(eq(factoryDutyAuditLog.companyId, companyId), eq(factoryDutyAuditLog.containerId, containerId)))
        .orderBy(desc(factoryDutyAuditLog.createdAt));

      res.json(logs);
    } catch (error: unknown) {
      logger.error("Error fetching duty audit log:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
