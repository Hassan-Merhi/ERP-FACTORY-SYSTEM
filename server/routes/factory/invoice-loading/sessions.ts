/**
 * factoryInvoiceLoadingRoutes: InvoiceLoadingSession endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseId, parseOptionalId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import {
  customerOrders,
  customerOrderBales,
  factoryInvoiceLoadingSessions,
  factoryInvoiceLoadingBales,
} from "@shared/schema";
import { eq, and, sql, ne } from "drizzle-orm";

import { buildLoadingSummary, getCompanyId } from "./_helpers";
import { isFactorySessionLocation } from "../../helpers/companyOwnership";

export function registerInvoiceLoadingSessionRoutes(app: Express) {
  // GET /api/factory/invoices/:invoiceId/loading-summary
  app.get("/api/factory/invoices/:invoiceId/loading-summary", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const invoiceId = parseId(req.params.invoiceId);

      if (invoiceId === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(invoiceId)) return res.status(400).json({ message: "Invalid invoice ID" });

      const activeSessionId = req.query.sessionId ? (parseOptionalId(req.query.sessionId) ?? undefined) : undefined;

      const summary = await buildLoadingSummary(invoiceId, companyId, activeSessionId);
      if (!summary) return res.status(404).json({ message: "Invoice not found" });

      res.json(summary);
    } catch (error: unknown) {
      logger.error("loading-summary error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // POST /api/factory/invoices/:invoiceId/loading-sessions
  app.post("/api/factory/invoices/:invoiceId/loading-sessions", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const invoiceId = parseId(req.params.invoiceId);

      if (invoiceId === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(invoiceId)) return res.status(400).json({ message: "Invalid invoice ID" });

      // Validate invoice
      const [invoice] = await db
        .select()
        .from(customerOrders)
        .where(and(eq(customerOrders.id, invoiceId), eq(customerOrders.companyId, companyId)));

      if (!invoice) return res.status(404).json({ message: "Invoice not found" });
      if (invoice.status !== "FINALIZED") {
        return res.status(400).json({ message: "Only FINALIZED invoices can have loading sessions" });
      }

      // Check there are invoice bales
      const invoiceBales = await db
        .select({ baleId: customerOrderBales.baleId })
        .from(customerOrderBales)
        .where(eq(customerOrderBales.orderId, invoiceId));

      if (invoiceBales.length === 0) {
        return res.status(400).json({ message: "This invoice has no bales to load" });
      }

      // Check if invoice is fully loaded (all bales loaded in active sessions)
      const activeSessionRows = await db
        .select({ id: factoryInvoiceLoadingSessions.id })
        .from(factoryInvoiceLoadingSessions)
        .where(
          and(
            eq(factoryInvoiceLoadingSessions.invoiceId, invoiceId),
            eq(factoryInvoiceLoadingSessions.companyId, companyId)
          )
        );

      const activeSessions = activeSessionRows.filter(async () => true); // all sessions
      if (activeSessions.length > 0) {
        const _activeIds = activeSessions.map((s) => s.id);
        const [loadedCount] = await db
          .select({ count: sql<number>`COUNT(DISTINCT ${factoryInvoiceLoadingBales.baleId})` })
          .from(factoryInvoiceLoadingBales)
          .innerJoin(
            factoryInvoiceLoadingSessions,
            eq(factoryInvoiceLoadingBales.sessionId, factoryInvoiceLoadingSessions.id)
          )
          .where(
            and(
              eq(factoryInvoiceLoadingBales.invoiceId, invoiceId),
              ne(factoryInvoiceLoadingSessions.status, "CANCELLED")
            )
          );

        const loaded = Number(loadedCount?.count || 0);
        if (loaded >= invoiceBales.length) {
          return res
            .status(400)
            .json({ message: "This invoice is fully loaded — all bales have been assigned to loading sessions" });
        }
      }

      // Create session
      const userId = req.user?.id ?? null;
      const username = req.user?.username ?? "";
      const { locationId, truckNo, driverName, notes } = req.body;
      if (locationId && !(await isFactorySessionLocation(req.session, locationId))) {
        return res.status(400).json({ message: "Location not found" });
      }

      const [session] = await db
        .insert(factoryInvoiceLoadingSessions)
        .values({
          companyId,
          invoiceId,
          customerId: invoice.customerId,
          locationId: locationId ? parseInt(locationId) : null,
          status: "OPEN",
          truckNo: truckNo || null,
          driverName: driverName || null,
          notes: notes || null,
          createdBy: userId || null,
          createdByName: username,
        })
        .returning();

      const summary = await buildLoadingSummary(invoiceId, companyId, session.id);
      res.status(201).json({ session, summary });
    } catch (error: unknown) {
      logger.error("create loading session error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
