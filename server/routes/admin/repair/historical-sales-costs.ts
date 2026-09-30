import type { Express } from "express";

import { requireAuth, requireRole } from "../../../auth";
import { getErrorMessage } from "../../../lib/httpHandlers";
import {
  applyHistoricalSalesCostRepair,
  buildHistoricalSalesCostRepairDryRun,
  getHistoricalSalesCostRepairRun,
} from "../../../services/inventory/historicalSalesCostRepair";

function actorName(req: Express.Request): string {
  return req.session.username || req.user?.username || req.session.userId || "developer";
}

export function registerAdminHistoricalSalesCostRepairRoutes(app: Express) {
  app.post(
    "/api/admin/historical-sales-cost-repair/dry-run",
    requireAuth,
    requireRole("Developer"),
    async (req, res) => {
      try {
        const companyIds = Array.isArray(req.body?.companyIds)
          ? req.body.companyIds.map(Number).filter((value: number) => Number.isInteger(value) && value > 0)
          : undefined;

        const result = await buildHistoricalSalesCostRepairDryRun({
          createdBy: actorName(req),
          companyIds,
        });
        res.json(result);
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.get(
    "/api/admin/historical-sales-cost-repair/:runId",
    requireAuth,
    requireRole("Developer"),
    async (req, res) => {
      try {
        const runId = Number(req.params.runId);
        if (!Number.isSafeInteger(runId) || runId <= 0) {
          return res.status(400).json({ message: "Invalid repair run ID" });
        }

        const result = await getHistoricalSalesCostRepairRun(runId);
        if (!result) return res.status(404).json({ message: "Repair run not found" });
        res.json(result);
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.post(
    "/api/admin/historical-sales-cost-repair/:runId/apply",
    requireAuth,
    requireRole("Developer"),
    async (req, res) => {
      try {
        const runId = Number(req.params.runId);
        if (!Number.isSafeInteger(runId) || runId <= 0) {
          return res.status(400).json({ message: "Invalid repair run ID" });
        }

        const auditHash = String(req.body?.auditHash ?? "").trim().toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(auditHash)) {
          return res.status(400).json({ message: "A valid 64-character dry-run audit hash is required" });
        }

        const expectedConfirmation = `APPLY-HISTORICAL-SALES-COST-REPAIR:${runId}:${auditHash.slice(0, 12)}`;
        if (req.body?.confirmation !== expectedConfirmation) {
          return res.status(400).json({
            message: "Explicit repair confirmation is required",
            expectedConfirmation,
          });
        }

        const result = await applyHistoricalSalesCostRepair({
          runId,
          auditHash,
          appliedBy: actorName(req),
        });
        res.json(result);
      } catch (error: unknown) {
        res.status(409).json({ message: getErrorMessage(error) });
      }
    }
  );
}
