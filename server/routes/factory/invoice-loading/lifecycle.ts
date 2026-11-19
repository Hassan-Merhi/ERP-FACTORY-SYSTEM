/**
 * factoryInvoiceLoadingRoutes: InvoiceLoadingLifecycle endpoints.
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
import { factoryInvoiceLoadingSessions, factoryInvoiceLoadingBales } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";

import { buildLoadingSummary, getCompanyId } from "./_helpers";
import { z } from "zod";
import { emptyBody, emptyQuery, stringParam, validateRequest, type RequestSchemas } from "../../../lib/validateRequest";

// parseId() still checks the id.
const loadingSessionActionInput = {
  params: z.strictObject({ sessionId: stringParam }),
  query: emptyQuery,
  body: emptyBody,
} satisfies RequestSchemas;

export function registerInvoiceLoadingLifecycleRoutes(app: Express) {
  // POST /api/factory/invoice-loading-sessions/:sessionId/complete
  app.post(
    "/api/factory/invoice-loading-sessions/:sessionId/complete",
    requireAuth,
    validateRequest(loadingSessionActionInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const sessionId = parseId(req.params.sessionId);

        if (sessionId === null) return res.status(400).json({ message: "Invalid id" });
        if (isNaN(sessionId)) return res.status(400).json({ message: "Invalid session ID" });

        const [session] = await db
          .select()
          .from(factoryInvoiceLoadingSessions)
          .where(
            and(eq(factoryInvoiceLoadingSessions.id, sessionId), eq(factoryInvoiceLoadingSessions.companyId, companyId))
          );

        if (!session) return res.status(404).json({ message: "Session not found" });
        if (session.status !== "OPEN") return res.status(400).json({ message: "Session is not OPEN" });

        // Require at least 1 scanned bale
        const [countRow] = await db
          .select({ count: sql<number>`COUNT(*)` })
          .from(factoryInvoiceLoadingBales)
          .where(eq(factoryInvoiceLoadingBales.sessionId, sessionId));

        if (Number(countRow?.count || 0) === 0) {
          return res.status(400).json({ message: "Cannot complete a loading session with no scanned bales" });
        }

        const [updated] = await db
          .update(factoryInvoiceLoadingSessions)
          .set({ status: "COMPLETED", completedAt: new Date(), updatedAt: new Date() })
          .where(eq(factoryInvoiceLoadingSessions.id, sessionId))
          .returning();

        const summary = await buildLoadingSummary(session.invoiceId, companyId, sessionId);
        res.json({ session: updated, summary });
      } catch (error: unknown) {
        logger.error("complete session error:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // POST /api/factory/invoice-loading-sessions/:sessionId/cancel
  app.post(
    "/api/factory/invoice-loading-sessions/:sessionId/cancel",
    requireAuth,
    validateRequest(loadingSessionActionInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const sessionId = parseId(req.params.sessionId);

        if (sessionId === null) return res.status(400).json({ message: "Invalid id" });
        if (isNaN(sessionId)) return res.status(400).json({ message: "Invalid session ID" });

        const [session] = await db
          .select()
          .from(factoryInvoiceLoadingSessions)
          .where(
            and(eq(factoryInvoiceLoadingSessions.id, sessionId), eq(factoryInvoiceLoadingSessions.companyId, companyId))
          );

        if (!session) return res.status(404).json({ message: "Session not found" });
        if (session.status !== "OPEN") return res.status(400).json({ message: "Session is not OPEN" });

        // Keep bale rows for audit history — only mark session as CANCELLED
        const [updated] = await db
          .update(factoryInvoiceLoadingSessions)
          .set({ status: "CANCELLED", cancelledAt: new Date(), updatedAt: new Date() })
          .where(eq(factoryInvoiceLoadingSessions.id, sessionId))
          .returning();

        const summary = await buildLoadingSummary(session.invoiceId, companyId);
        res.json({ session: updated, summary });
      } catch (error: unknown) {
        logger.error("cancel session error:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // ── Export helpers ─────────────────────────────────────────────────────────

  /** Apply a solid fill to a cell */

  // ── Export endpoints ───────────────────────────────────────────────────────
}
