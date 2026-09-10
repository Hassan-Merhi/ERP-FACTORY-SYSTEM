/**
 * factoryCustomerProformaRoutes: FactoryCustomerProformaLoading endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { getClientDate } from "../../../lib/dateUtils";
import { requireAuth } from "../../../auth";
import {
  createLoadingFromProformaAtomically,
  CreateLoadingFromProformaError,
} from "./createLoadingAtomic";

export function registerFactoryCustomerProformaLoadingRoutes(app: Express) {
  // Create a pending loading from a proforma — auto-adds matching bales from stock.
  // The service owns the transaction so the proforma-capacity lock, physical-bale
  // locks, order creation, bale links, totals, reservations, and daybook entry all
  // commit or roll back together.
  app.post("/api/factory/customer-proformas/:id/create-loading", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const proformaId = parseId(req.params.id);
      if (proformaId === null) return res.status(400).json({ message: "Invalid id" });

      const locationId = Number.parseInt(String(req.body.locationId ?? ""), 10);
      if (!Number.isInteger(locationId) || locationId <= 0) {
        return res.status(400).json({ message: "locationId is required" });
      }

      const result = await createLoadingFromProformaAtomically({
        companyId,
        proformaId,
        locationId,
        orderDate: req.body.orderDate || getClientDate(req),
      });

      res.json(result);
    } catch (error: unknown) {
      logger.error("Error creating loading from proforma:", { error });
      if (error instanceof CreateLoadingFromProformaError) {
        return res.status(error.status).json({ message: error.message, ...(error.details ?? {}) });
      }
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
