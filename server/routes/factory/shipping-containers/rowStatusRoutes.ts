/**
 * factoryShippingContainerRoutes: mark-done, restore and delete for a
 * shipping container row. Extracted from ./rows.ts, which registers these
 * last, in their original order.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import {
  customerOrders,
  factoryShippingContainerRows,
  factoryShippingContainerDocuments,
  customerOrderBales,
  factoryBales,
} from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { getCompanyId } from "./_helpers";
import { validateRequest, validatedInput } from "../../../lib/validateRequest";
import * as schemas from "./shippingContainerRouteSchemas";

export function registerShippingContainerRowStatusRoutes(app: Express) {
  // ── POST mark as done ─────────────────────────────────────────────────────────
  app.post(
    "/api/factory/shipping-container-rows/:id/done",
    requireAuth,
    validateRequest(schemas.markShippingRowDoneInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const { id } = validatedInput(req, schemas.markShippingRowDoneInput).params;

        const [existing] = await db
          .select({ id: factoryShippingContainerRows.id })
          .from(factoryShippingContainerRows)
          .where(and(eq(factoryShippingContainerRows.id, id), eq(factoryShippingContainerRows.companyId, companyId)));
        if (!existing) return res.status(404).json({ message: "Row not found" });

        const username: string = req.session.username || req.session.email || req.session.name || "Unknown";
        const now = new Date();

        const patch: Partial<typeof factoryShippingContainerRows.$inferInsert> = {
          isDone: true,
          doneAt: now,
          doneBy: username,
          updatedAt: now,
        };
        if (req.body.markWhatsappSent) patch.whatsappSentAt = now;

        const [updated] = await db
          .update(factoryShippingContainerRows)
          .set(patch)
          .where(eq(factoryShippingContainerRows.id, id))
          .returning();

        res.json(updated);
      } catch (error: unknown) {
        logger.error("Error marking row as done:", { error: error });
        res.status(400).json({ message: getErrorMessage(error) });
      }
    }
  );

  // ── POST restore ──────────────────────────────────────────────────────────────
  app.post(
    "/api/factory/shipping-container-rows/:id/restore",
    requireAuth,
    validateRequest(schemas.shippingRowNoBodyInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const { id } = validatedInput(req, schemas.shippingRowNoBodyInput).params;

        const [existing] = await db
          .select({ id: factoryShippingContainerRows.id })
          .from(factoryShippingContainerRows)
          .where(and(eq(factoryShippingContainerRows.id, id), eq(factoryShippingContainerRows.companyId, companyId)));
        if (!existing) return res.status(404).json({ message: "Row not found" });

        const [updated] = await db
          .update(factoryShippingContainerRows)
          .set({ isDone: false, doneAt: null, doneBy: null, whatsappSentAt: null, updatedAt: new Date() })
          .where(eq(factoryShippingContainerRows.id, id))
          .returning();

        res.json(updated);
      } catch (error: unknown) {
        logger.error("Error restoring row:", { error: error });
        res.status(400).json({ message: getErrorMessage(error) });
      }
    }
  );

  // ── DELETE a row (hard delete — also removes its documents) ──────────────────
  app.delete(
    "/api/factory/shipping-container-rows/:id",
    requireAuth,
    validateRequest(schemas.shippingRowNoBodyInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const { id } = validatedInput(req, schemas.shippingRowNoBodyInput).params;

        await db.transaction(async (tx) => {
          const [existing] = await tx
            .select({
              id: factoryShippingContainerRows.id,
              customerOrderId: factoryShippingContainerRows.customerOrderId,
            })
            .from(factoryShippingContainerRows)
            .where(and(eq(factoryShippingContainerRows.id, id), eq(factoryShippingContainerRows.companyId, companyId)));
          if (!existing) throw new Error("Row not found");

          // If the linked customer order is in LOADING state, restore bales to stock
          // and move the order back to DRAFT so they are no longer counted as loading.
          const [order] = await tx
            .select({
              id: customerOrders.id,
              status: customerOrders.status,
              proformaIdUsed: customerOrders.proformaIdUsed,
            })
            .from(customerOrders)
            .where(eq(customerOrders.id, existing.customerOrderId));

          if (order && order.status === "LOADING") {
            const bales = await tx
              .select({ baleId: customerOrderBales.baleId })
              .from(customerOrderBales)
              .where(eq(customerOrderBales.orderId, order.id));

            // Legacy orders mark bales RESERVED_FOR_ORDER; V5 keeps them IN_STOCK already.
            if (!order.proformaIdUsed && bales.length > 0) {
              for (const b of bales) {
                await tx
                  .update(factoryBales)
                  .set({ status: "IN_STOCK", updatedAt: new Date() })
                  .where(and(eq(factoryBales.id, b.baleId), eq(factoryBales.status, "RESERVED_FOR_ORDER")));
              }
            }

            // Move the order back to DRAFT so it no longer contributes to the
            // "loading" deduction in stock availability calculations.
            await tx
              .update(customerOrders)
              .set({ status: "DRAFT", updatedAt: new Date() })
              .where(eq(customerOrders.id, order.id));
          }

          // Remove attached documents first (FK constraint), then the row itself.
          await tx.delete(factoryShippingContainerDocuments).where(eq(factoryShippingContainerDocuments.scrId, id));

          await tx.delete(factoryShippingContainerRows).where(eq(factoryShippingContainerRows.id, id));
        });

        res.json({ ok: true });
      } catch (error: unknown) {
        logger.error("Error deleting shipping container row:", { error: error });
        res.status(getErrorMessage(error) === "Row not found" ? 404 : 400).json({ message: getErrorMessage(error) });
      }
    }
  );
}
