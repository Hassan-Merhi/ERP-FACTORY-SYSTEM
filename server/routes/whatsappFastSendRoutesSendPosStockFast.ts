// Extracted from ./whatsappFastSendRoutes.ts to keep that module under the source-size cap.
import type { Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { getClientDate } from "../lib/dateUtils";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { generateStockPdf } from "../helpers/generateStockPdf";
import { companies, locations } from "@shared/schema";
import { resolvePosLocationId, sendBufferFast } from "./whatsappFastSendRoutesSendBufferFast";

export async function sendPosStockFast(req: Request, res: Response): Promise<void> {
  const startedAt = Date.now();
  try {
    const companyId = req.session.currentCompanyId;
    if (!companyId) {
      res.status(400).json({ message: "No company selected" });
      return;
    }

    const locationId = await resolvePosLocationId(req, companyId);
    if (!locationId) {
      res.status(400).json({ message: "No location found for this user" });
      return;
    }

    const [location, company] = await Promise.all([
      db
        .select({ id: locations.id, name: locations.name, whatsappGroupChatId: locations.whatsappGroupChatId })
        .from(locations)
        .where(and(eq(locations.id, locationId), eq(locations.companyId, companyId)))
        .limit(1)
        .then((rows) => rows[0]),
      db
        .select({ name: companies.name })
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1)
        .then((rows) => rows[0]),
    ]);

    if (!location) {
      res.status(404).json({ message: "Location not found" });
      return;
    }
    if (!location.whatsappGroupChatId) {
      res.status(400).json({ message: "No WhatsApp group configured for this location" });
      return;
    }

    const companyName = company?.name || "Company";
    const {
      buffer: pdfBuffer,
      pageCount,
      rowCount,
    } = await generateStockPdf(companyId, companyName, locationId, location.name);

    const maxAllowedPages = Math.ceil(rowCount / 20) + 5;
    if (pageCount > maxAllowedPages) {
      res.status(500).json({
        message: `PDF pagination error detected: ${pageCount} pages generated for ${rowCount} stock items (expected ≤${maxAllowedPages}). Report not sent to WhatsApp.`,
      });
      return;
    }

    const dateStr = getClientDate(req);
    const safeName = `${location.name} STK ${companyName} ${dateStr}`.replace(/[^\w\s.()-]/g, "_").trim();
    const caption = `Stock Report — ${location.name}`;
    const result = await sendBufferFast(
      req,
      location.whatsappGroupChatId,
      pdfBuffer,
      `${safeName}.pdf`,
      caption,
      "application/pdf"
    );

    if (!result.success) {
      res.status(502).json({ message: result.error ?? "WhatsApp send failed" });
      return;
    }

    logger.info("POS stock WhatsApp send accepted", {
      module: "whatsappFastSend",
      action: "sendStock",
      companyId,
      locationId,
      mode: result.mode,
      durationMs: Date.now() - startedAt,
    });
    res.json({ success: true, deliveryMode: result.mode, deliveryStatus: "accepted" });
  } catch (error: unknown) {
    logger.error("[WA fast stock] failed", { error });
    res.status(500).json({ message: getErrorMessage(error) });
  }
}
