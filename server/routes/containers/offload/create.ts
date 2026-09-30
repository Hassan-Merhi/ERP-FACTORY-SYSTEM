/**
 * containerOffloadRoutes: ContainerOffloadCreate endpoints.
 *
 * All create/replace offloads now use the canonical atomic lifecycle so the
 * inventory mutation, stock movement evidence, charge vouchers, SP journals,
 * and replacement reversal cannot drift apart.
 */
import type { Express } from "express";
import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { getClientDate } from "../../../lib/dateUtils";
import { logger } from "../../../lib/logger";
import { requireAuth, requireNonPOS } from "../../../auth";
import { offloadRequestSchema } from "@shared/schema";
import { executeContainerOffloadLifecycle } from "../../../services/containers/offload-lifecycle/execute";
import { ContainerOffloadLifecycleError } from "../../../services/containers/offload-lifecycle/types";

export function registerContainerOffloadCreateRoutes(app: Express) {
  app.post("/api/containers/:id/offload", requireAuth, requireNonPOS, async (req, res) => {
    const startedAt = Date.now();
    const userId = req.user?.id;
    const companyId = req.session.currentCompanyId;

    logger.info("Container offload started", {
      module: "containers",
      action: "offload",
      userId,
      companyId,
      containerId: req.params.id,
    });

    try {
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const containerId = parseId(req.params.id);
      if (containerId === null) return res.status(400).json({ message: "Invalid id" });

      const validation = offloadRequestSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ message: "Validation failed", errors: validation.error.issues });
      }

      const input = validation.data;
      const result = await executeContainerOffloadLifecycle({
        companyId,
        containerId,
        mode: "create-or-replace",
        locationId: input.locationId,
        offloadDate: input.offloadDate || getClientDate(req),
        duties: input.duties,
        dutiesAccountId: input.dutiesAccountId,
        officeCharges: input.officeCharges,
        officeChargesAccountId: input.officeChargesAccountId,
        officeChargesCashAccountId: input.officeChargesCashAccountId,
        transferCharges: input.transferCharges,
        transportFees: input.transportFees,
        transportAccountId: input.transportAccountId,
        additionalCharges: input.additionalCharges,
        inventoryCostCorrections: input.inventoryCostCorrections,
        agentChargeLines: input.agentChargeLines,
      });

      logger.info("Container offload succeeded", {
        module: "containers",
        action: "offload",
        userId,
        companyId,
        containerId,
        replacedExistingOffload: result.replacedExistingOffload,
        durationMs: Date.now() - startedAt,
      });

      res.json(result.offload);

      // Preserve posted sales at their transaction-time cost. A new receipt
      // must not reprice historical sales from today's inventory average.
    } catch (error: unknown) {
      logger.error("Container offload failed", {
        module: "containers",
        action: "offload",
        userId,
        companyId,
        containerId: req.params.id,
        durationMs: Date.now() - startedAt,
        error,
      });
      if (error instanceof ContainerOffloadLifecycleError) {
        return res.status(error.status).json({ message: error.message, code: error.code });
      }
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
