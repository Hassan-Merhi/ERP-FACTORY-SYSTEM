/**
 * POST /api/factory/customer-proformas: single proforma create. The customer
 * must be one of the session company's live customers.
 *
 * Registered by ./proformas.ts at its original position.
 */
import type { Express, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { customerProformas, insertCustomerProformaSchema } from "@shared/schema";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { syncProformaReservations } from "../_stockReservationHelper";
import { normalizeProformaDestination } from "./destination";
import { customerBelongsToCompany } from "./_helpers";

export function registerFactoryCustomerProformaCreateRoute(app: Express) {
  app.post("/api/factory/customer-proformas", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const parsed = insertCustomerProformaSchema.parse({ ...req.body, companyId });
      if (req.body.destination !== undefined) {
        const destination = normalizeProformaDestination(req.body.destination);
        if (!destination) return res.status(400).json({ message: "A valid destination is required" });
        parsed.destination = destination;
      }
      if (!(await customerBelongsToCompany(companyId, parsed.customerId))) {
        return res.status(404).json({ message: "Customer not found" });
      }

      const [duplicate] = await db
        .select({ id: customerProformas.id })
        .from(customerProformas)
        .where(
          and(
            eq(customerProformas.companyId, companyId),
            eq(customerProformas.customerId, parsed.customerId),
            eq(customerProformas.name, parsed.name)
          )
        );
      if (duplicate) {
        return res.status(409).json({
          message: `A proforma named "${parsed.name}" already exists for this customer. Please choose a different name.`,
        });
      }

      const [proforma] = await db.insert(customerProformas).values(parsed).returning();
      await syncProformaReservations(db, companyId, proforma.id);
      res.json(proforma);
    } catch (error: unknown) {
      logger.error("Error creating customer proforma:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
