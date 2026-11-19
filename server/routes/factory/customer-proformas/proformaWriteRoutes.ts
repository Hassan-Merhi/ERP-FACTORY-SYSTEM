// Extracted from ./proformas.ts
/**
 * factoryCustomerProformaRoutes: customer proforma create, update and delete.
 *
 * Called at the end of registerFactoryCustomerProformaCrudRoutes, so the
 * registration order is unchanged.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { syncProformaReservations } from "../_stockReservationHelper";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { customerProformas, customers, insertCustomerProformaSchema, proformaStockReservations } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { validateRequest, validatedInput } from "../../../lib/validateRequest";
import { normalizeProformaDestination } from "./destination";
import { createProformaInput, deleteProformaInput, updateProformaInput } from "./customerProformaRouteSchemas";

export function registerFactoryCustomerProformaWriteRoutes(app: Express) {
  app.post("/api/factory/customer-proformas", requireAuth, validateRequest(createProformaInput), async (req, res) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const parsed = insertCustomerProformaSchema.parse({ ...req.body, companyId });
      if (req.body.destination !== undefined) {
        const destination = normalizeProformaDestination(req.body.destination);
        if (!destination) return res.status(400).json({ message: "A valid destination is required" });
        parsed.destination = destination;
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

  app.put(
    "/api/factory/customer-proformas/:id",
    requireAuth,
    validateRequest(updateProformaInput),
    async (req, res) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const { id } = validatedInput(req, updateProformaInput).params;
        const [existing] = await db
          .select()
          .from(customerProformas)
          .where(and(eq(customerProformas.id, id), eq(customerProformas.companyId, companyId)));
        if (!existing) return res.status(404).json({ message: "Proforma not found" });

        if (req.body.name && req.body.name !== existing.name) {
          const [duplicate] = await db
            .select({ id: customerProformas.id })
            .from(customerProformas)
            .where(
              and(
                eq(customerProformas.companyId, companyId),
                eq(customerProformas.customerId, existing.customerId),
                eq(customerProformas.name, req.body.name)
              )
            );
          if (duplicate) {
            return res.status(409).json({
              message: `A proforma named "${req.body.name}" already exists for this customer. Please choose a different name.`,
            });
          }
        }

        // Older proformas can be assigned a destination without editing prices.
        const updateFields: Partial<typeof customerProformas.$inferInsert> = {};
        if (req.body.name !== undefined) updateFields.name = String(req.body.name).trim();
        if (req.body.isActive !== undefined) updateFields.isActive = req.body.isActive === true;
        if (req.body.destination !== undefined) {
          const destination = normalizeProformaDestination(req.body.destination);
          if (!destination) return res.status(400).json({ message: "A valid destination is required" });
          updateFields.destination = destination;
        }
        const [updated] = await db
          .update(customerProformas)
          .set({ ...updateFields, updatedAt: new Date() })
          .where(and(eq(customerProformas.id, id), eq(customerProformas.companyId, companyId)))
          .returning();

        await syncProformaReservations(db, companyId, id);
        res.json(updated);
      } catch (error: unknown) {
        logger.error("Error updating customer proforma:", { error: error });
        res.status(400).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.delete(
    "/api/factory/customer-proformas/:id",
    requireAuth,
    validateRequest(deleteProformaInput),
    async (req, res) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const { id } = validatedInput(req, deleteProformaInput).params;

        const [proformaBefore] = await db
          .select()
          .from(customerProformas)
          .where(and(eq(customerProformas.id, id), eq(customerProformas.companyId, companyId)));
        if (proformaBefore) {
          const [custBefore] = await db
            .select({ id: customers.id, legalName: customers.legalName, deletedAt: customers.deletedAt })
            .from(customers)
            .where(eq(customers.id, proformaBefore.customerId));
          logger.info(
            `[PROFORMA DELETE] Deleting proforma id=${id} name="${proformaBefore.name}" customerId=${proformaBefore.customerId} customerName="${custBefore?.legalName}" customerDeletedAt=${custBefore?.deletedAt}`
          );
        }

        await db
          .update(customerProformas)
          .set({ isActive: false, deletedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(customerProformas.id, id), eq(customerProformas.companyId, companyId)));
        await syncProformaReservations(db, companyId, id);
        await db
          .delete(proformaStockReservations)
          .where(and(eq(proformaStockReservations.companyId, companyId), eq(proformaStockReservations.proformaId, id)));
        const [deleted] = await db
          .select()
          .from(customerProformas)
          .where(and(eq(customerProformas.id, id), eq(customerProformas.companyId, companyId)));

        if (!deleted) return res.status(404).json({ message: "Proforma not found" });

        if (proformaBefore) {
          const [custAfter] = await db
            .select({ id: customers.id, legalName: customers.legalName, deletedAt: customers.deletedAt })
            .from(customers)
            .where(eq(customers.id, proformaBefore.customerId));
          logger.info(
            `[PROFORMA DELETE] After deletion: customerId=${proformaBefore.customerId} customerName="${custAfter?.legalName}" customerDeletedAt=${custAfter?.deletedAt}`
          );
        }

        res.json({ message: "Proforma deleted" });
      } catch (error: unknown) {
        logger.error("Error deleting customer proforma:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
