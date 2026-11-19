// Extracted from ./whatsappFastSendRoutes.ts
import type { Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { locations } from "@shared/schema";
import { sendBufferFast } from "./whatsappFastSendRoutesSendBufferFast";

export async function sendUploadedPdfFast(req: Request, res: Response): Promise<void> {
  try {
    const companyId = req.session.currentCompanyId;
    if (!companyId) {
      res.status(400).json({ message: "No company selected" });
      return;
    }

    const pdfBase64 = String(req.body?.pdfBase64 || "");
    const locationId = Number(req.body?.locationId);
    if (!pdfBase64) {
      res.status(400).json({ message: "pdfBase64 is required" });
      return;
    }
    if (!Number.isInteger(locationId) || locationId <= 0) {
      res.status(400).json({ message: "locationId is required" });
      return;
    }

    const [location] = await db
      .select({ whatsappGroupChatId: locations.whatsappGroupChatId })
      .from(locations)
      .where(and(eq(locations.id, locationId), eq(locations.companyId, companyId)))
      .limit(1);
    if (!location) {
      res.status(404).json({ message: "Location not found" });
      return;
    }
    if (!location.whatsappGroupChatId) {
      res.status(400).json({ message: "No WhatsApp group configured for this location" });
      return;
    }

    const buffer = Buffer.from(pdfBase64, "base64");
    const fileName = String(req.body?.filename || "report.pdf").replace(/[^\w\s.()-]/g, "_");
    const caption = String(req.body?.caption || fileName);
    const result = await sendBufferFast(req, location.whatsappGroupChatId, buffer, fileName, caption);
    if (!result.success) {
      res.status(502).json({ message: result.error ?? "WhatsApp send failed" });
      return;
    }
    res.json({ success: true, deliveryMode: result.mode, deliveryStatus: "accepted" });
  } catch (error: unknown) {
    logger.error("[WA fast uploaded PDF] failed", { error });
    res.status(500).json({ message: getErrorMessage(error) });
  }
}
