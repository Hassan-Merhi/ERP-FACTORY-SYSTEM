/**
 * factoryInvoiceLoadingRoutes: InvoiceLoadingScan endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import {
  customerOrders,
  factoryBales,
  factoryInvoiceLoadingSessions,
  factoryInvoiceLoadingBales,
} from "@shared/schema";
import { eq, and, or, inArray, not, sql, ne } from "drizzle-orm";

import { buildLoadingSummary, getCompanyId } from "./_helpers";
import { resultRows } from "../../../lib/queryResult";
import { z } from "zod";
import { emptyBody, emptyQuery, stringParam, validateRequest, type RequestSchemas } from "../../../lib/validateRequest";

// parseId() still checks the ids.
const scanBaleInput = {
  params: z.strictObject({ sessionId: stringParam }),
  query: emptyQuery,
  body: z.strictObject({ barcode: z.string().nullable().optional() }),
} satisfies RequestSchemas;

const removeLoadingBaleInput = {
  params: z.strictObject({ sessionId: stringParam, baleId: stringParam }),
  query: emptyQuery,
  body: emptyBody,
} satisfies RequestSchemas;

export function registerInvoiceLoadingScanRoutes(app: Express) {
  // POST /api/factory/invoice-loading-sessions/:sessionId/scan-bale
  app.post(
    "/api/factory/invoice-loading-sessions/:sessionId/scan-bale",
    requireAuth,
    validateRequest(scanBaleInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const sessionId = parseId(req.params.sessionId);

        if (sessionId === null) return res.status(400).json({ message: "Invalid id" });
        if (isNaN(sessionId)) return res.status(400).json({ message: "Invalid session ID" });

        const { barcode } = req.body;
        if (!barcode || !barcode.trim()) return res.status(400).json({ message: "Barcode is required" });

        const scanCode = barcode.trim();
        const scanLower = scanCode.toLowerCase();

        // Validate session
        const [session] = await db
          .select()
          .from(factoryInvoiceLoadingSessions)
          .where(
            and(eq(factoryInvoiceLoadingSessions.id, sessionId), eq(factoryInvoiceLoadingSessions.companyId, companyId))
          );

        if (!session) return res.status(404).json({ message: "Loading session not found" });
        if (session.status === "COMPLETED")
          return res.status(400).json({ message: "This loading session is already completed" });
        if (session.status === "CANCELLED")
          return res.status(400).json({ message: "This loading session is cancelled" });

        const invoiceId = session.invoiceId;

        // Validate invoice still finalized
        const [invoice] = await db
          .select({ id: customerOrders.id, status: customerOrders.status, companyId: customerOrders.companyId })
          .from(customerOrders)
          .where(and(eq(customerOrders.id, invoiceId), eq(customerOrders.companyId, companyId)));

        if (!invoice) return res.status(404).json({ message: "Invoice not found" });
        if (invoice.status !== "FINALIZED") return res.status(400).json({ message: "Invoice is not finalized" });

        // Look up the scanned bale by referenceNumber or baleCode (case-insensitive)
        const baleMatches = await db
          .select({
            id: factoryBales.id,
            companyId: factoryBales.companyId,
            baleCode: factoryBales.baleCode,
            referenceNumber: factoryBales.referenceNumber,
            articleCode: factoryBales.articleCode,
            productName: factoryBales.productName,
            weightKg: factoryBales.weightKg,
            status: factoryBales.status,
          })
          .from(factoryBales)
          .where(
            and(
              eq(factoryBales.companyId, companyId),
              not(inArray(factoryBales.status, ["DELETED", "REMOVED"])),
              or(
                sql`LOWER(${factoryBales.referenceNumber}) = ${scanLower}`,
                sql`LOWER(${factoryBales.baleCode}) = ${scanLower}`
              )
            )
          )
          .limit(5);

        if (baleMatches.length === 0) {
          return res.status(400).json({ message: `Bale "${scanCode}" not found in this company's inventory` });
        }

        const bale = baleMatches[0];

        // Validate bale belongs to this exact invoice (via customer_order_bales).
        // Only select the two core columns (order_id, bale_id) that have always
        // existed — avoiding parse-time failures when newer columns are absent.
        const _linkResult = await db.execute(
          sql`SELECT bale_id FROM customer_order_bales WHERE order_id = ${invoiceId} AND bale_id = ${bale.id} LIMIT 1`
        );
        const _linkRows = resultRows(_linkResult);
        const invoiceBaleLink = _linkRows.length > 0 ? { baleId: _linkRows[0].bale_id as number } : undefined;

        if (!invoiceBaleLink) {
          // FALLBACK NOTE: If finalized invoices ever exist without exact customer_order_bales rows,
          // a fallback by articleCode could be used here. For now, we require exact bale membership.
          return res.status(400).json({
            message: `Bale "${scanCode}" (ref: ${bale.referenceNumber}) is not part of this invoice`,
          });
        }

        // Check this bale has NOT already been loaded in any ACTIVE (OPEN or COMPLETED) session for this invoice
        // CANCELLED sessions do not block re-scanning.
        const [alreadyLoaded] = await db
          .select({ id: factoryInvoiceLoadingBales.id, sessionId: factoryInvoiceLoadingBales.sessionId })
          .from(factoryInvoiceLoadingBales)
          .innerJoin(
            factoryInvoiceLoadingSessions,
            eq(factoryInvoiceLoadingBales.sessionId, factoryInvoiceLoadingSessions.id)
          )
          .where(
            and(
              eq(factoryInvoiceLoadingBales.invoiceId, invoiceId),
              eq(factoryInvoiceLoadingBales.baleId, bale.id),
              ne(factoryInvoiceLoadingSessions.status, "CANCELLED")
            )
          )
          .limit(1);

        if (alreadyLoaded) {
          const isSameSession = alreadyLoaded.sessionId === sessionId;
          return res.status(400).json({
            message: isSameSession
              ? `Bale "${scanCode}" has already been scanned in this session`
              : `Bale "${scanCode}" was already loaded in a previous loading session`,
          });
        }

        // Insert
        const userId = req.user?.id ?? null;
        const username = req.user?.username ?? "";

        const [loadingBale] = await db
          .insert(factoryInvoiceLoadingBales)
          .values({
            companyId,
            sessionId,
            invoiceId,
            baleId: bale.id,
            baleReference: bale.referenceNumber,
            articleCode: bale.articleCode || null,
            productName: bale.productName || null,
            weightKg: bale.weightKg,
            scannedBy: userId || null,
            scannedByName: username,
          })
          .returning();

        const summary = await buildLoadingSummary(invoiceId, companyId, sessionId);
        res.json({ loadingBale, bale, summary });
      } catch (error: unknown) {
        logger.error("scan-bale error:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // DELETE /api/factory/invoice-loading-sessions/:sessionId/bales/:baleId
  app.delete(
    "/api/factory/invoice-loading-sessions/:sessionId/bales/:baleId",
    requireAuth,
    validateRequest(removeLoadingBaleInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const sessionId = parseId(req.params.sessionId);

        if (sessionId === null) return res.status(400).json({ message: "Invalid id" });
        const baleId = parseId(req.params.baleId);
        if (baleId === null) return res.status(400).json({ message: "Invalid id" });
        if (isNaN(sessionId) || isNaN(baleId)) return res.status(400).json({ message: "Invalid ID" });

        const [session] = await db
          .select()
          .from(factoryInvoiceLoadingSessions)
          .where(
            and(eq(factoryInvoiceLoadingSessions.id, sessionId), eq(factoryInvoiceLoadingSessions.companyId, companyId))
          );

        if (!session) return res.status(404).json({ message: "Session not found" });
        if (session.status === "CANCELLED")
          return res.status(400).json({ message: "Cannot remove bales from a cancelled session" });

        const deleted = await db
          .delete(factoryInvoiceLoadingBales)
          .where(
            and(
              eq(factoryInvoiceLoadingBales.sessionId, sessionId),
              eq(factoryInvoiceLoadingBales.baleId, baleId),
              eq(factoryInvoiceLoadingBales.companyId, companyId)
            )
          )
          .returning();

        if (deleted.length === 0) return res.status(404).json({ message: "Bale not found in this session" });

        const summary = await buildLoadingSummary(session.invoiceId, companyId, sessionId);
        res.json({ removed: deleted[0], summary });
      } catch (error: unknown) {
        logger.error("remove bale error:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
