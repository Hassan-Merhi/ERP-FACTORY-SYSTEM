/**
 * factoryCustomerProformaRoutes: FactoryCustomerProformaTransfer endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { customerProformas, customerProformaLines, customers } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { validateRequest, validatedInput } from "../../../lib/validateRequest";
import { toggleProformaLineFixedInput, transferProformaInput } from "./customerProformaRouteSchemas";

export function registerFactoryCustomerProformaTransferRoutes(app: Express) {
  // Transfer a proforma to a different customer
  app.patch(
    "/api/factory/customer-proformas/:id/transfer",
    requireAuth,
    validateRequest(transferProformaInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const { id } = validatedInput(req, transferProformaInput).params;
        const { targetCustomerId } = req.body;
        if (!targetCustomerId) return res.status(400).json({ message: "targetCustomerId is required" });

        const [proforma] = await db
          .select()
          .from(customerProformas)
          .where(and(eq(customerProformas.id, id), eq(customerProformas.companyId, companyId)));
        if (!proforma) return res.status(404).json({ message: "Proforma not found" });

        const newCustomerId = parseInt(targetCustomerId);
        if (newCustomerId === proforma.customerId) {
          return res.status(400).json({ message: "Target customer is the same as the current customer" });
        }

        // Verify target customer belongs to this company
        const [targetCustomer] = await db
          .select({ id: customers.id, legalName: customers.legalName })
          .from(customers)
          .where(and(eq(customers.id, newCustomerId), eq(customers.companyId, companyId)));
        if (!targetCustomer) return res.status(404).json({ message: "Target customer not found" });

        // Check for name conflict on target customer
        const [conflict] = await db
          .select({ id: customerProformas.id })
          .from(customerProformas)
          .where(
            and(
              eq(customerProformas.companyId, companyId),
              eq(customerProformas.customerId, newCustomerId),
              eq(customerProformas.name, proforma.name)
            )
          );
        if (conflict) {
          return res.status(409).json({
            message: `Customer "${targetCustomer.legalName}" already has a proforma named "${proforma.name}". Rename it first before transferring.`,
          });
        }

        const [updated] = await db
          .update(customerProformas)
          .set({ customerId: newCustomerId, updatedAt: new Date() })
          .where(and(eq(customerProformas.id, id), eq(customerProformas.companyId, companyId)))
          .returning();

        const [fromCustomer] = await db
          .select({ legalName: customers.legalName })
          .from(customers)
          .where(eq(customers.id, proforma.customerId));

        logger.info(
          `[PROFORMA TRANSFER] id=${id} name="${proforma.name}" from customer ${proforma.customerId} ("${fromCustomer?.legalName}") → ${newCustomerId} ("${targetCustomer.legalName}")`
        );

        res.json({ ...updated, targetCustomerName: targetCustomer.legalName });
      } catch (error: unknown) {
        logger.error("Error transferring proforma:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // Toggle price_fixed flag on a proforma line
  app.patch(
    "/api/factory/customer-proforma-lines/:lineId/toggle-fixed",
    requireAuth,
    validateRequest(toggleProformaLineFixedInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const { lineId } = validatedInput(req, toggleProformaLineFixedInput).params;
        const [line] = await db
          .select()
          .from(customerProformaLines)
          .where(eq(customerProformaLines.id, lineId))
          .limit(1);
        if (!line) return res.status(404).json({ message: "Line not found" });
        const [updated] = await db
          .update(customerProformaLines)
          .set({ priceFixed: !line.priceFixed })
          .where(eq(customerProformaLines.id, lineId))
          .returning();
        res.json(updated);
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
