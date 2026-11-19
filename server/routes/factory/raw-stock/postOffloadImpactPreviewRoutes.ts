import type { Express } from "express";
import { requireAuth } from "../../../auth";
import { getClientDate } from "../../../lib/dateUtils";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { validateRequest, validatedInput } from "../../../lib/validateRequest";
import { preparePostOffloadImpactPreview } from "../../../services/factory/postOffloadImpactPreview";
import { previewPostOffloadChargesInput } from "./containerChargeRouteSchemas";

export function registerPostOffloadImpactPreviewRoutes(app: Express): void {
  app.post(
    "/api/factory/containers/:id/post-offload-charges/preview",
    requireAuth,
    validateRequest(previewPostOffloadChargesInput),
    async (req: import("express").Request, res: import("express").Response) => {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      const userId = String(req.session.userId || req.user?.id || "");
      const containerId = validatedInput(req, previewPostOffloadChargesInput).params.id;

      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!userId) return res.status(401).json({ message: "Authentication required" });

      try {
        const result = await preparePostOffloadImpactPreview({
          companyId,
          userId,
          containerId,
          transactionDate: req.body?.txDate || getClientDate(req),
          charges: req.body?.charges,
        });
        res.setHeader("Cache-Control", "no-store");
        return res.json(result);
      } catch (error: unknown) {
        logger.warn("Post-offload impact preview failed", {
          error,
          companyId,
          containerId,
          userId,
        });
        return res.status((error as { statusCode?: number }).statusCode || 400).json({
          message: getErrorMessage(error),
          code: (error as { code?: string }).code,
        });
      }
    }
  );
}
