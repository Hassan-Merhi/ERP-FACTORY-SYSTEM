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
import { and, eq, sql } from "drizzle-orm";
import { resultRows } from "../../../lib/queryResult";
import { canViewBookingInfo, isValidBookingInfo } from "./bookingInfo";
import { registerOrderCrudRoutesPart4 } from "./registerOrderCrudRoutesPart4";

import { z } from "zod";
import { emptyQuery, idParams, validateRequest, type RequestSchemas } from "../../../lib/validateRequest";

// The handler keeps its 1-200 character check and its booking-info role rule.
const createLoadingAgentInput = {
  query: emptyQuery,
  body: z.strictObject({ name: z.string().optional() }),
} satisfies RequestSchemas;

// The handler keeps its "orderDate is required" check.
const orderDateInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({ orderDate: z.string().optional() }),
} satisfies RequestSchemas;

// Text or null per field; the handler keeps its length checks, the saved-agent
// lookup and the booking-info role rule (an empty value from staff is ignored).
const shippingText = z.string().nullable().optional();
const assignContainerInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({
    containerNumber: shippingText,
    shippingCompany: shippingText,
    containerNotes: shippingText,
    bookingInfo: shippingText,
    agentName: shippingText,
    destination: shippingText,
  }),
} satisfies RequestSchemas;

export function registerOrderCrudRoutesPart3(app: Express) {
  registerOrderCrudRoutesPart4(app);

  // Company-scoped, reusable shipping agent names. Same visibility as booking info.
  app.get("/api/factory/loading-agents", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!canViewBookingInfo(req.session)) return res.status(403).json({ message: "Not authorized" });
      const result = await db.execute(sql`
        SELECT name FROM factory_loading_agents WHERE company_id = ${companyId}
        ORDER BY lower(name), id
      `);
      res.json(resultRows(result).map((row) => String(row.name)));
    } catch (error: unknown) {
      logger.error("Error listing loading agents:", { error });
      sendHttpError(res, error);
    }
  });

  app.post(
    "/api/factory/loading-agents",
    requireAuth,
    validateRequest(createLoadingAgentInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        if (!canViewBookingInfo(req.session)) return res.status(403).json({ message: "Not authorized" });
        const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
        if (!name || name.length > 200) return res.status(400).json({ message: "Agent name must be 1-200 characters" });
        const result = await db.execute(sql`
        INSERT INTO factory_loading_agents (company_id, name)
        VALUES (${companyId}, ${name})
        ON CONFLICT (company_id, lower(name)) DO UPDATE SET name = factory_loading_agents.name
        RETURNING name
      `);
        res.status(201).json({ name: String(resultRows(result)[0].name) });
      } catch (error: unknown) {
        logger.error("Error creating loading agent:", { error });
        sendHttpError(res, error);
      }
    }
  );

  app.patch(
    "/api/factory/customer-orders/:id/date",
    requireAuth,
    validateRequest(orderDateInput),
    async (req: Request, res: Response) => {
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
    }
  );

  // Single source of truth for the Invoicing table, loading form, shipping
  // containers, tracking and invoice detail. Never mirror these values into a
  // separate display-only table.
  app.post(
    "/api/factory/customer-orders/:id/assign-container",
    requireAuth,
    validateRequest(assignContainerInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const orderId = parseId(req.params.id);
        if (orderId === null) return res.status(400).json({ message: "Invalid id" });
        const { containerNumber, shippingCompany, containerNotes, bookingInfo, agentName, destination } =
          req.body || {};
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
        if (agentName !== undefined && !canViewBookingInfo(req.session)) {
          return res.status(403).json({ message: "Only Admin, Owner or Developer can edit agent" });
        }
        const normalizedAgent = normalizeText(agentName, 200, "Agent");
        if (normalizedAgent) {
          const matching = await db.execute(sql`
          SELECT name FROM factory_loading_agents WHERE company_id = ${companyId}
          AND lower(name) = lower(${normalizedAgent}) LIMIT 1
        `);
          if (!resultRows(matching).length) {
            return res.status(400).json({ message: "Select an agent from the saved list" });
          }
        }
        const normalizedDestination = normalizeText(destination, 500, "Destination");
        const updateData: Partial<typeof customerOrders.$inferInsert> = {};
        if (normalizedContainer !== undefined) updateData.containerNumber = normalizedContainer;
        if (normalizedShipping !== undefined) updateData.shippingCompany = normalizedShipping;
        if (normalizedNotes !== undefined) updateData.containerNotes = normalizedNotes;
        if (normalizedBooking !== undefined) updateData.bookingInfo = normalizedBooking;
        if (normalizedAgent !== undefined) updateData.agentName = normalizedAgent;
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
            "agentName",
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
        res.json(canViewBookingInfo(req.session) ? updated : { ...updated, bookingInfo: null, agentName: null });
      } catch (error: unknown) {
        logger.error("Error updating container details:", { error });
        sendHttpError(res, error);
      }
    }
  );
}
