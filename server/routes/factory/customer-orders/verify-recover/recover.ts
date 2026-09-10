/**
 * orderVerifyRecoverRoutes: OrderRecoverBales endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { parseId } from "../../../../lib/parseId";
import { logger } from "../../../../lib/logger";
import { requireAuth } from "../../../../auth";
import {
  autoRecoverBalesAtomically,
  recoverBalesByReferencesAtomically,
  RecoverBalesError,
} from "./recoverBalesAtomic";

function requireRecoveryRole(req: Request, res: Response): boolean {
  const role = (req.session.currentRole || req.session.role || "").toLowerCase();
  if (!["admin", "owner", "developer"].includes(role)) {
    res.status(403).json({ message: "Only Admin / Owner can recover bales" });
    return false;
  }
  return true;
}

function recoveryError(res: Response, error: unknown, context: string) {
  logger.error(context, { error });
  if (error instanceof RecoverBalesError) {
    return res.status(error.status).json({ message: error.message });
  }
  return res.status(500).json({ message: getErrorMessage(error) });
}

export function registerOrderRecoverBalesRoutes(app: Express) {
  app.post("/api/factory/customer-orders/:id/recover-bales", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!requireRecoveryRole(req, res)) return;

      const orderId = parseId(req.params.id);
      if (orderId === null) return res.status(400).json({ message: "Invalid order id" });

      const baleReferences: unknown = req.body.baleReferences;
      if (!Array.isArray(baleReferences) || baleReferences.length === 0) {
        return res.status(400).json({ message: "baleReferences array is required and must not be empty" });
      }

      const result = await recoverBalesByReferencesAtomically({
        companyId,
        orderId,
        baleReferences: baleReferences.map((value) => String(value ?? "")),
        scannerName: req.session.username || req.session.name || req.session.email || null,
      });

      logger.info(`[recover-bales] orderId=${orderId} linked=${result.linked} notFound=${result.notFound.length}`);
      res.json({
        message: `${result.linked} bale(s) linked successfully`,
        linked: result.linked,
        notFound: result.notFound,
      });
    } catch (error: unknown) {
      return recoveryError(res, error, "Error recovering bales:");
    }
  });

  app.post("/api/factory/customer-orders/:id/auto-recover-bales", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!requireRecoveryRole(req, res)) return;

      const orderId = parseId(req.params.id);
      if (orderId === null) return res.status(400).json({ message: "Invalid order id" });

      const result = await autoRecoverBalesAtomically({
        companyId,
        orderId,
        scannerName: req.session.username || req.session.name || req.session.email || null,
      });

      logger.info(`[auto-recover-bales] orderId=${orderId} totalLinked=${result.linked}`);
      res.json({
        message: `${result.linked} bale(s) auto-linked from stock`,
        linked: result.linked,
        summary: result.summary,
      });
    } catch (error: unknown) {
      return recoveryError(res, error, "Error auto-recovering bales:");
    }
  });
}
