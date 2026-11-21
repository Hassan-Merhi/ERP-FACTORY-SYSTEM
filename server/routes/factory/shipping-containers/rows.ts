/**
 * factoryShippingContainerRoutes: ShippingContainerRow endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import {
  customerOrders,
  customers,
  factoryShippingContainerRows,
  factoryShippingContainerDocuments,
  customerOrderBales,
  factoryBales,
} from "@shared/schema";
import { eq, and, desc, isNull, sql } from "drizzle-orm";
import { getCompanyId } from "./_helpers";
import { registerShippingContainerRowRoutesPart1 } from "./registerShippingContainerRowRoutesPart1";

export function registerShippingContainerRowRoutes(app: Express) {
  // ── GET available-invoices for dropdown ──────────────────────────────────────
  // Must be registered BEFORE /:id routes so Express doesn't treat "available-invoices" as an id.
  app.get(
    "/api/factory/shipping-container-rows/available-invoices",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const rows = await db
          .select({
            id: customerOrders.id,
            invoiceNumber: customerOrders.invoiceNumber,
            customerName: customers.legalName,
            customerPhone: customers.phone,
            status: customerOrders.status,
            orderDate: customerOrders.orderDate,
            loadingDate: customerOrders.loadingStartedAt,
            finalizedDate: customerOrders.loadingFinalizedAt,
            containerNumber: customerOrders.containerNumber,
            shippingCompany: customerOrders.shippingCompany,
            destination: customerOrders.destination,
            grandTotal: customerOrders.grandTotal,
            alreadyHasRow: sql<boolean>`EXISTS (
            SELECT 1 FROM factory_shipping_container_rows fscr
            WHERE fscr.customer_order_id = ${customerOrders.id}
              AND fscr.company_id = ${companyId}
          )`,
          })
          .from(customerOrders)
          .leftJoin(customers, eq(customerOrders.customerId, customers.id))
          .where(
            and(
              eq(customerOrders.companyId, companyId),
              isNull(customerOrders.deletedAt),
              sql`${customerOrders.status} = ANY(ARRAY['LOADING','PENDING_VERIFICATION','VERIFIED','FINALIZED'])`
            )
          )
          .orderBy(desc(customerOrders.createdAt));

        res.json(rows);
      } catch (error: unknown) {
        logger.error("Error fetching available invoices:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // ── POST sync: auto-create backing rows for all active orders ────────────────
  // Called on page load — idempotent, uses unique constraint to skip duplicates.
  app.post("/api/factory/shipping-container-rows/sync", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const orders = await db
        .select({ id: customerOrders.id, orderDate: customerOrders.orderDate })
        .from(customerOrders)
        .where(
          and(
            eq(customerOrders.companyId, companyId),
            isNull(customerOrders.deletedAt),
            sql`${customerOrders.status} = ANY(ARRAY['LOADING','PENDING_VERIFICATION','VERIFIED','FINALIZED'])`,
            sql`NOT EXISTS (
            SELECT 1 FROM factory_shipping_container_rows fscr
            WHERE fscr.customer_order_id = ${customerOrders.id}
              AND fscr.company_id = ${companyId}
          )`
          )
        );

      if (orders.length > 0) {
        await db
          .insert(factoryShippingContainerRows)
          .values(
            orders.map((o) => ({
              companyId,
              customerOrderId: o.id,
              orderDate: o.orderDate || new Date().toISOString().slice(0, 10),
            }))
          )
          .onConflictDoNothing();
      }

      res.json({ created: orders.length });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  registerShippingContainerRowRoutesPart1(app);

  // ── POST mark as done ─────────────────────────────────────────────────────────
  app.post("/api/factory/shipping-container-rows/:id/done", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });

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
  });

  // ── POST restore ──────────────────────────────────────────────────────────────
  app.post("/api/factory/shipping-container-rows/:id/restore", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });

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
  });

  // ── DELETE a row (hard delete — also removes its documents) ──────────────────
  app.delete("/api/factory/shipping-container-rows/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });

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
  });
}
