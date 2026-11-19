// Extracted from ./orderCrudRoutes.ts to keep that module under the source-size cap.
import { logAudit } from "../../helpers/auditHelpers";
import { orderAuditIdentifier } from "./orderAuditIdentifier";
import { getErrorMessage, HttpError, sendHttpError } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { parseId } from "../../../lib/parseId";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { customerOrders } from "@shared/schema";
import { and, eq } from "drizzle-orm";
import { canViewBookingInfo, isValidBookingInfo } from "./bookingInfo";
import { registerOrderCrudRoutesPart4 } from "./registerOrderCrudRoutesPart4";

export function registerOrderCrudRoutesPart3(app: Express) {
  registerOrderCrudRoutesPart4(app);

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
