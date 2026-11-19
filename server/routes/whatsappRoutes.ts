/**
 * WhatsApp settings & send routes (Green API)
 *
 * GET  /api/whatsapp/settings              – get credentials + flags
 * PUT  /api/whatsapp/settings              – save credentials + flags
 * GET  /api/whatsapp/recipients            – list all recipients
 * POST /api/whatsapp/recipients            – add recipient
 * PUT  /api/whatsapp/recipients/:id        – update (name, active)
 * DELETE /api/whatsapp/recipients/:id      – remove
 * GET  /api/whatsapp/chats                 – fetch chats from Green API (for group picker)
 * POST /api/whatsapp/send-net-position     – manually send current company's net position Excel
 */

import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { requireAuth } from "../auth";
import { pool } from "../db";
import { logger } from "../lib/logger";
import { storage } from "../storage";
import { sendWhatsAppFileToChatId } from "../services/whatsappService";
import { generateNetPositionExcel } from "../helpers/generateNetPositionExcel";
import { generateStockPdf } from "../helpers/generateStockPdf";
import { getClientDate } from "../lib/dateUtils";
import { registerWhatsAppRoutesPart1 } from "./registerWhatsAppRoutesPart1";
import { registerWhatsAppRoutesPart2 } from "./registerWhatsAppRoutesPart2";
import { z } from "zod";
import { emptyQuery, validateRequest, type RequestSchemas } from "../lib/validateRequest";

// Sent by client/src/pages/settings/useStockReportSectionState.ts (either may be null
// before a selection); the handler keeps its parseInt and "is required" checks.
const sendStockReportInput = {
  query: emptyQuery,
  body: z.strictObject({
    companyId: z.union([z.number(), z.string()]).nullable().optional(),
    recipientId: z.union([z.number(), z.string()]).nullable().optional(),
  }),
} satisfies RequestSchemas;

export function registerWhatsAppRoutes(app: Express) {
  registerWhatsAppRoutesPart1(app);
  registerWhatsAppRoutesPart2(app);
  registerWhatsAppRoutesPart3(app);
}

function registerWhatsAppRoutesPart3(app: Express) {
  // ── Send Stock + Net Position to one specific group ─────────────────────────

  app.post("/api/whatsapp/send-stock-report", requireAuth, validateRequest(sendStockReportInput), async (req, res) => {
    const _t = Date.now();
    const _uid = req.session.userId;
    const _cid = req.session.currentCompanyId;
    try {
      logger.info("whatsapp send-stock-report started", {
        module: "whatsapp",
        action: "sendStockReport",
        userId: _uid,
        companyId: _cid,
      });
      const { companyId: reqCompanyId, recipientId: reqRecipientId } = req.body as Record<string, unknown>;

      // Resolve company
      const companyId = reqCompanyId ? parseInt(String(reqCompanyId)) : null;
      if (!companyId) return res.status(400).json({ message: "companyId is required" });

      const allCompanies = await storage.getAllCompanies();
      const company = allCompanies.find((c) => c.id === companyId);
      if (!company) return res.status(404).json({ message: "Company not found" });

      // Resolve recipient chatId
      const recipientId = reqRecipientId ? parseInt(String(reqRecipientId)) : null;
      if (!recipientId) return res.status(400).json({ message: "recipientId is required" });

      const sessCompanyId = req.session.currentCompanyId;
      const rResult = await pool.query(
        "SELECT chat_id FROM whatsapp_recipients WHERE id = $1 AND active = true AND company_id = $2",
        [recipientId, sessCompanyId]
      );
      if (!rResult.rows.length) return res.status(404).json({ message: "Recipient not found or inactive" });
      const chatId = rResult.rows[0].chat_id as string;

      const today = getClientDate(req);
      const yearStart = `${new Date(today).getFullYear()}-01-01`;

      // 1. Stock PDF
      logger.info(`[WhatsApp] Generating stock PDF for ${company.name} (companyId=${companyId})…`);
      const {
        buffer: pdfBuf,
        pageCount,
        rowCount,
      } = await generateStockPdf(companyId, company.name, undefined, undefined, true);
      const maxExpectedPages = Math.ceil(rowCount / 20) + 5;
      logger.info(
        `[WhatsApp] Stock PDF generated: companyId=${companyId} company="${company.name}" rowCount=${rowCount} pageCount=${pageCount} maxExpectedPages=${maxExpectedPages}`
      );

      // Safety guard: refuse to send a suspiciously over-paginated PDF.
      // Root cause of the 177-page bug: PDFKit ≥0.17 exposes page.maxY as a function;
      // the old code compared doc.y + need > functionObject which is always false,
      // so ensureSpace() never added pages and PDFKit auto-broke every row.
      if (rowCount > 0 && pageCount > maxExpectedPages) {
        const message = `Refusing to send suspicious stock PDF: ${pageCount} pages for ${rowCount} rows (max expected: ${maxExpectedPages}). company="${company.name}"`;
        logger.error(`[WhatsApp] SAFETY GUARD: ${message}`);
        return res.status(500).json({ message });
      }

      const pdfName = `Stock_${company.name.replace(/[^a-z0-9]/gi, "_")}_${today}.pdf`;
      const pdfCap = "";
      logger.info(`[WhatsApp] Uploading stock PDF — chatId=${chatId} file=${pdfName} size=${pdfBuf.length}`);
      const pdfRes = await sendWhatsAppFileToChatId(chatId, pdfBuf, pdfName, pdfCap, "application/pdf");
      if (!pdfRes.success) {
        logger.error(
          `[WhatsApp] send-stock-report: PDF upload failed — chatId=${chatId} file=${pdfName} ` +
            `size=${pdfBuf.length} pageCount=${pageCount} rowCount=${rowCount} greenApiError="${pdfRes.error}"`
        );
        return res.status(502).json({ message: pdfRes.error || "Failed to send stock PDF" });
      }

      // 2. Net Position Excel (Jan 1 → today)
      logger.info(`[WhatsApp] Generating net-position Excel for ${company.name} (${yearStart}→${today})…`);
      const xlsBuf = await generateNetPositionExcel(companyId, company.name, yearStart, today);
      const xlsName = `NetPosition_${company.name.replace(/[^a-z0-9]/gi, "_")}_${today}.xlsx`;
      const xlsCap = "";
      const xlsRes = await sendWhatsAppFileToChatId(
        chatId,
        xlsBuf,
        xlsName,
        xlsCap,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      if (!xlsRes.success) {
        return res.status(502).json({ message: xlsRes.error || "Failed to send net position Excel" });
      }

      logger.info("whatsapp send-stock-report succeeded", {
        module: "whatsapp",
        action: "sendStockReport",
        userId: _uid,
        companyId: _cid,
        durationMs: Date.now() - _t,
      });
      res.json({ message: `Stock PDF + Net Position Excel sent to ${chatId}` });
    } catch (err: unknown) {
      logger.error("whatsapp send-stock-report failed", {
        module: "whatsapp",
        action: "sendStockReport",
        userId: _uid,
        companyId: _cid,
        durationMs: Date.now() - _t,
        error: err,
      });
      logger.error("[WhatsApp] send-stock-report error:", { error: err });
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
