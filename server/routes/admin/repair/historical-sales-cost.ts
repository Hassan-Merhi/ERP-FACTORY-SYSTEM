import type { Express, Request, Response } from "express";

import { requireAuth, requirePasswordConfirmation, requireRole } from "../../../auth";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import {
  privilegedConcurrencyLimit,
  privilegedMutationRateLimit,
  privilegedReadRateLimit,
  privilegedRequestBudget,
} from "../../../middleware/privilegedEndpointSecurity";
import {
  applyHistoricalSalesCostRepair,
  buildHistoricalSalesCostRepairDryRun,
  getHistoricalSalesCostRepairRun,
} from "../../../services/inventory/historicalSalesCostRepair";

const developerOnly = requireRole("Developer");
const repairBudget = privilegedRequestBudget({ maxBodyBytes: 16 * 1024, maxCollectionItems: 100 });
const repairConcurrency = privilegedConcurrencyLimit({
  scope: "historical-sales-cost-repair",
  maxConcurrent: 1,
});

function actor(req: Request): string {
  return String(req.session.username || req.session.userId || "developer");
}

function parseCompanyIds(value: unknown): number[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error("companyIds must be an array");
  const companyIds = [...new Set(value.map((id) => Number(id)))];
  if (companyIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error("companyIds must contain only positive integer company IDs");
  }
  return companyIds;
}

export function registerHistoricalSalesCostRepairRoutes(app: Express): void {
  app.post(
    "/api/admin/repair/historical-sales-cost/dry-run",
    requireAuth,
    developerOnly,
    privilegedMutationRateLimit,
    repairBudget,
    repairConcurrency,
    async (req: Request, res: Response) => {
      try {
        if (req.body?.confirmation !== "BUILD-HISTORICAL-SALES-COST-DRY-RUN") {
          return res.status(400).json({
            message: 'Dry run requires confirmation="BUILD-HISTORICAL-SALES-COST-DRY-RUN"',
          });
        }

        const result = await buildHistoricalSalesCostRepairDryRun({
          createdBy: actor(req),
          companyIds: parseCompanyIds(req.body?.companyIds),
        });
        return res.json(result);
      } catch (error: unknown) {
        logger.error("Historical sales cost repair dry-run failed", {
          module: "historical-sales-cost-repair",
          action: "dry-run-route",
          error,
        });
        return res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.get(
    "/api/admin/repair/historical-sales-cost/:runId",
    requireAuth,
    developerOnly,
    privilegedReadRateLimit,
    async (req: Request, res: Response) => {
      try {
        const runId = Number.parseInt(req.params.runId, 10);
        if (!Number.isInteger(runId) || runId <= 0) {
          return res.status(400).json({ message: "Invalid historical sales cost repair run ID" });
        }
        const run = await getHistoricalSalesCostRepairRun(runId);
        if (!run) return res.status(404).json({ message: "Historical sales cost repair run not found" });
        return res.json(run);
      } catch (error: unknown) {
        logger.error("Historical sales cost repair report failed", {
          module: "historical-sales-cost-repair",
          action: "report-route",
          error,
        });
        return res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.post(
    "/api/admin/repair/historical-sales-cost/:runId/apply",
    requireAuth,
    developerOnly,
    privilegedMutationRateLimit,
    repairBudget,
    repairConcurrency,
    requirePasswordConfirmation,
    async (req: Request, res: Response) => {
      try {
        const runId = Number.parseInt(req.params.runId, 10);
        if (!Number.isInteger(runId) || runId <= 0) {
          return res.status(400).json({ message: "Invalid historical sales cost repair run ID" });
        }

        const auditHash = String(req.body?.auditHash || "").trim();
        if (!/^[a-f0-9]{64}$/i.test(auditHash)) {
          return res.status(400).json({ message: "A valid 64-character auditHash is required" });
        }

        const requiredConfirmation = `APPLY-HISTORICAL-SALES-COST:${runId}:${auditHash.slice(0, 12)}`;
        if (req.body?.confirmation !== requiredConfirmation) {
          return res.status(400).json({
            message: "Apply confirmation does not match the reviewed repair run",
            requiredConfirmation,
          });
        }

        const result = await applyHistoricalSalesCostRepair({
          runId,
          auditHash,
          appliedBy: actor(req),
        });
        return res.json(result);
      } catch (error: unknown) {
        logger.error("Historical sales cost repair apply failed", {
          module: "historical-sales-cost-repair",
          action: "apply-route",
          runId: req.params.runId,
          error,
        });
        return res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
