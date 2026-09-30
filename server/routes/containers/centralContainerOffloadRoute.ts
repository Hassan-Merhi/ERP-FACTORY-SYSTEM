import type { Express, Request, Response } from "express";
import { offloadRequestSchema } from "@shared/schema";
import { requireAuth, requireNonPOS, requireRole } from "../../auth";
import { getClientDate } from "../../lib/dateUtils";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { parseId } from "../../lib/parseId";
import {
  ContainerOffloadLifecycleError,
  executeContainerOffloadLifecycle,
  type ContainerOffloadLifecycleMode,
} from "../../services/containers/offload-lifecycle";

async function runCentralOffload(req: Request, res: Response, mode: ContainerOffloadLifecycleMode): Promise<void> {
  const startedAt = Date.now();
  const companyId = Number(req.session?.currentCompanyId);
  const containerId = parseId(req.params.id);

  if (!Number.isInteger(companyId) || companyId <= 0) {
    res.status(400).json({ message: "No company selected" });
    return;
  }
  if (containerId === null) {
    res.status(400).json({ message: "Invalid container ID" });
    return;
  }

  const validation = offloadRequestSchema.safeParse(req.body);
  if (!validation.success) {
    res.status(400).json({
      message: "Validation failed",
      errors: validation.error.issues,
    });
    return;
  }

  const data = validation.data;
  const offloadDate = data.offloadDate || getClientDate(req);

  try {
    const result = await executeContainerOffloadLifecycle({
      companyId,
      containerId,
      mode,
      locationId: data.locationId,
      offloadDate,
      duties: data.duties,
      dutiesAccountId: data.dutiesAccountId ?? null,
      officeCharges: data.officeCharges,
      officeChargesAccountId: data.officeChargesAccountId ?? null,
      officeChargesCashAccountId: data.officeChargesCashAccountId ?? null,
      transferCharges: data.transferCharges,
      transportFees: data.transportFees,
      transportAccountId: data.transportAccountId ?? null,
      additionalCharges: data.additionalCharges ?? [],
      inventoryCostCorrections: data.inventoryCostCorrections ?? [],
      agentChargeLines: data.agentChargeLines ?? [],
    });

    logger.info("Atomic container offload lifecycle completed", {
      module: "containers",
      action: mode === "replace-only" ? "edit-offload" : "offload",
      companyId,
      containerId,
      locationId: result.locationId,
      replacedExistingOffload: result.replacedExistingOffload,
      durationMs: Date.now() - startedAt,
    });

    if (mode === "replace-only") {
      res.json({
        success: true,
        message: "Container offload updated successfully",
        offload: result.offload,
      });
    } else {
      res.json(result.offload);
    }

    // A receipt changes current inventory cost only. Posted sales keep the
    // historical cost captured when they were sold; a later offload must not
    // retroactively rewrite sales_items.costPrice / totalCost / profit.
  } catch (error: unknown) {
    logger.error("Atomic container offload lifecycle failed", {
      module: "containers",
      action: mode === "replace-only" ? "edit-offload" : "offload",
      companyId,
      containerId,
      durationMs: Date.now() - startedAt,
      error,
    });

    if (error instanceof ContainerOffloadLifecycleError) {
      res.status(error.status).json({
        code: error.code,
        message: error.message,
      });
      return;
    }

    res.status(500).json({ message: getErrorMessage(error) });
  }
}

/** Register after the concurrency preflight and before the legacy offload routes. */
export function registerCentralContainerOffloadRoute(app: Express): void {
  app.post("/api/containers/:id/offload", requireAuth, requireNonPOS, (req, res) => {
    void runCentralOffload(req, res, "create-or-replace");
  });

  app.patch("/api/containers/:id/offload", requireAuth, requireRole("Admin"), (req, res) => {
    void runCentralOffload(req, res, "replace-only");
  });
}
