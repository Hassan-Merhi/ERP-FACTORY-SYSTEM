// Extracted from ./orderCrudRoutes.ts to keep that module under the source-size cap.
import { logAudit } from "../../helpers/auditHelpers";
import { orderAuditIdentifier } from "./orderAuditIdentifier";
import { getErrorMessage, HttpError, sendHttpError } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { parseId } from "../../../lib/parseId";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { customerOrderBales, customerOrders, factoryBales } from "@shared/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { linkOrderProformaAtomically, LinkOrderProformaError } from "./linkProformaAtomic";
import { canViewBookingInfo, isValidBookingInfo } from "./bookingInfo";

export function registerOrderCrudRoutesPart3(app: Express) {
  app.patch("/api/factory/customer-orders/:id/link-proforma", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const orderId = parseId(req.params.id);

      if (orderId === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(orderId)) return res.status(400).json({ message: "Invalid order ID" });

      const { proformaId } = req.body;
      // proformaId may be null/0 to unlink
      const isUnlink = proformaId == null || proformaId === 0 || proformaId === "0";
      const proformaIdInt = isUnlink ? null : parseInt(proformaId);
      if (!isUnlink && (proformaIdInt === null || isNaN(proformaIdInt!)))
        return res.status(400).json({ message: "Invalid proformaId" });

      // Lock, checks and write run in one transaction (see linkProformaAtomic.ts):
      // a link made during loading is reference-only and re-linking the same
      // proforma keeps the order's expected plan.
      res.json(await linkOrderProformaAtomically({ companyId, orderId, proformaId: proformaIdInt }));
    } catch (error: unknown) {
      if (error instanceof LinkOrderProformaError) {
        return res.status(error.status).json(error.details ?? { message: error.message });
      }
      logger.error("Error linking proforma to loading:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // PATCH /api/factory/customer-orders/:id/loading-note — update the free-text
  // note on a loading order (works on any non-cancelled status so floor staff
  // can add or edit notes at any point during the loading lifecycle).
  app.patch("/api/factory/customer-orders/:id/loading-note", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const orderId = parseId(req.params.id);

      if (orderId === null) return res.status(400).json({ message: "Invalid id" });
      const { note } = req.body;

      const [order] = await db
        .select()
        .from(customerOrders)
        .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)));
      if (!order) return res.status(404).json({ message: "Loading not found" });

      // Phase 21 (B): the write and its audit commit together.
      const updated = await db.transaction(async (tx) => {
        const [written] = await tx
          .update(customerOrders)
          .set({ containerNotes: note?.trim() || null, updatedAt: new Date() })
          .where(eq(customerOrders.id, orderId))
          .returning();

        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || req.session.userId!,
            companyId,
            action: "update",
            tableName: "factory_customer_orders",
            recordId: orderId,
            recordIdentifier: orderAuditIdentifier(order, orderId),
            changes: { loadingNote: { old: order.containerNotes ?? null, new: note?.trim() || null } },
          },
          tx
        );
        return written;
      });
      res.json({ success: true, order: updated });
    } catch (error: unknown) {
      logger.error("Error updating loading note:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/factory/customer-orders/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const orderId = parseId(req.params.id);

      if (orderId === null) return res.status(400).json({ message: "Invalid id" });

      await db.transaction(async (tx) => {
        const [order] = await tx
          .select()
          .from(customerOrders)
          .where(
            and(
              eq(customerOrders.id, orderId),
              eq(customerOrders.companyId, companyId),
              isNull(customerOrders.deletedAt)
            )
          )
          .for("update");
        // Both conditions are caller errors, and throwing plain Errors from
        // inside the transaction meant the catch reported them as 500s. The
        // checks stay inside the transaction so the row stays locked between
        // the read and the soft-delete.
        if (!order) throw new HttpError(404, "Order not found");

        if (order.status === "FINALIZED") {
          throw new HttpError(409, "Cannot delete a finalized invoice. Cancel it first if needed.");
        }

        // Soft-delete: release bales back to stock so they can be re-sold,
        // but preserve order/lines/charges/bale links so the order can be
        // restored from Settings → Deleted Items (note: bales currently in
        // stock will need to be re-reserved manually after restore).
        const bales = await tx
          .select({ baleId: customerOrderBales.baleId })
          .from(customerOrderBales)
          .where(eq(customerOrderBales.orderId, orderId));
        const baleIds = [
          ...new Set(bales.map((b) => b.baleId).filter((id): id is number => Number.isSafeInteger(id) && id > 0)),
        ];
        // A soft-deleted loading is no longer an active allocation. Release its
        // physical bales, but never make a bale available when a different
        // non-deleted order still owns it (e.g. an already verified invoice).
        if (baleIds.length > 0) {
          await tx
            .update(factoryBales)
            .set({ status: "IN_STOCK", updatedAt: new Date() })
            .where(
              and(
                eq(factoryBales.companyId, companyId),
                isNull(factoryBales.deletedAt),
                inArray(factoryBales.id, baleIds),
                sql`NOT EXISTS (
                SELECT 1 FROM customer_order_bales cob
                JOIN customer_orders co ON co.id = cob.order_id
                WHERE cob.bale_id = ${factoryBales.id}
                  AND co.company_id = ${companyId}
                  AND co.id <> ${orderId}
                  AND co.deleted_at IS NULL
                  AND co.status <> 'CANCELLED'
              )`
              )
            );
        }

        await tx
          .update(customerOrders)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(customerOrders.id, orderId),
              eq(customerOrders.companyId, companyId),
              isNull(customerOrders.deletedAt)
            )
          );
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || req.session.userId!,
            companyId,
            action: "delete",
            tableName: "factory_customer_orders",
            recordId: orderId,
            recordIdentifier: `Order #${orderId}`,
            changes: null,
          },
          tx
        );
      });

      res.json({ success: true, message: "Order moved to Deleted Items; eligible bales returned to stock" });
    } catch (error: unknown) {
      logger.error("Error deleting customer order:", { error: error });
      sendHttpError(res, error);
    }
  });

  app.patch("/api/factory/customer-orders/:id/date", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const orderId = parseId(req.params.id);

      if (orderId === null) return res.status(400).json({ message: "Invalid id" });
      const { orderDate } = req.body;
      if (!orderDate) return res.status(400).json({ message: "orderDate is required" });

      const [order] = await db
        .select()
        .from(customerOrders)
        .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)));
      if (!order) return res.status(404).json({ message: "Order not found" });
      if (order.status !== "DRAFT")
        return res.status(400).json({ message: "Only DRAFT orders can have their date changed" });

      // Phase 21 (B): the write and its audit commit together.
      const updated = await db.transaction(async (tx) => {
        const [written] = await tx
          .update(customerOrders)
          .set({ orderDate, updatedAt: new Date() })
          .where(eq(customerOrders.id, orderId))
          .returning();

        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || req.session.userId!,
            companyId,
            action: "update",
            tableName: "factory_customer_orders",
            recordId: orderId,
            recordIdentifier: orderAuditIdentifier(order, orderId),
            changes: { orderDate: { old: order.orderDate ?? null, new: orderDate } },
          },
          tx
        );
        return written;
      });
      res.json(updated);
    } catch (error: unknown) {
      logger.error("Error updating order date:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  // Single source of truth for the Invoicing table, loading form, shipping
  // containers, tracking and invoice detail. Never mirror these values into a
  // separate display-only table.
  app.post("/api/factory/customer-orders/:id/assign-container", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const orderId = parseId(req.params.id);
      if (orderId === null) return res.status(400).json({ message: "Invalid id" });
      const { containerNumber, shippingCompany, containerNotes, bookingInfo, destination } = req.body || {};
      // Existing loading forms may submit an empty bookingInfo along with
      // unrelated changes. Treat that as omitted for non-privileged staff;
      // never let them change or clear the private stored value.
      let requestedBookingInfo: unknown = bookingInfo;
      if (bookingInfo !== undefined && !canViewBookingInfo(req.session)) {
        if (bookingInfo === "" || bookingInfo === null) {
          requestedBookingInfo = undefined;
        } else {
          return res.status(403).json({ message: "Only Admin, Owner or Developer can edit booking info" });
        }
      }

      const normalizeText = (value: unknown, max: number, field: string): string | null | undefined => {
        if (value === undefined) return undefined;
        if (value === null) return null;
        if (typeof value !== "string" || value.length > max) {
          throw new HttpError(400, `${field} must be text up to ${max} characters`);
        }
        return value.trim() || null;
      };
      const normalizedContainer = normalizeText(containerNumber, 100, "Container");
      const normalizedShipping = normalizeText(shippingCompany, 200, "Shipping company");
      const normalizedNotes = normalizeText(containerNotes, 10000, "Notes");
      if (requestedBookingInfo !== undefined && !isValidBookingInfo(requestedBookingInfo)) {
        return res.status(400).json({ message: "Booking info must be text up to 2000 characters" });
      }
      const normalizedBooking = normalizeText(requestedBookingInfo, 2000, "Booking info");
      const normalizedDestination = normalizeText(destination, 500, "Destination");
      const updateData: Partial<typeof customerOrders.$inferInsert> = {};
      if (normalizedContainer !== undefined) updateData.containerNumber = normalizedContainer;
      if (normalizedShipping !== undefined) updateData.shippingCompany = normalizedShipping;
      if (normalizedNotes !== undefined) updateData.containerNotes = normalizedNotes;
      if (normalizedBooking !== undefined) updateData.bookingInfo = normalizedBooking;
      if (normalizedDestination !== undefined) updateData.destination = normalizedDestination;
      if (!Object.keys(updateData).length) return res.status(400).json({ message: "No fields to update" });

      const updated = await db.transaction(async (tx) => {
        const [order] = await tx
          .select()
          .from(customerOrders)
          .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)))
          .for("update");
        if (!order || order.deletedAt) throw new HttpError(404, "Loading not found");

        const changes: Record<string, { old: string | null; new: string | null }> = {};
        const fieldNames = [
          "containerNumber",
          "shippingCompany",
          "containerNotes",
          "bookingInfo",
          "destination",
        ] as const;
        for (const field of fieldNames) {
          if (updateData[field] !== undefined && updateData[field] !== (order[field] || null)) {
            changes[field] = { old: order[field] ?? null, new: updateData[field] as string | null };
          }
        }
        if (!Object.keys(changes).length) return order;
        const [written] = await tx
          .update(customerOrders)
          .set({ ...updateData, updatedAt: new Date() })
          .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)))
          .returning();
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || req.session.userId!,
            companyId,
            action: "update",
            tableName: "factory_customer_orders",
            recordId: orderId,
            recordIdentifier: orderAuditIdentifier(order, orderId),
            changes,
          },
          tx
        );
        return written;
      });
      // Booking information is private even when the caller edits other fields.
      res.json(canViewBookingInfo(req.session) ? updated : { ...updated, bookingInfo: null });
    } catch (error: unknown) {
      logger.error("Error updating container details:", { error });
      sendHttpError(res, error);
    }
  });
}
