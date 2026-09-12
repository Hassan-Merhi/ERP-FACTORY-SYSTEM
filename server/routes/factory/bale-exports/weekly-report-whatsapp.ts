/**
 * factoryBaleExportRoutes: FactoryWeeklyReportWhatsapp endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { pool } from "../../../db";
import { requireAuth } from "../../../auth";
import {} from "drizzle-orm";
import { buildWeeklyReportExcelBuffer } from "./_helpers";

export function registerFactoryWeeklyReportWhatsappRoutes(app: Express) {
  // ── Weekly Report — WhatsApp settings & send ───────────────────────────────

  app.get("/api/factory/weekly-report-wa-settings", requireAuth, async (_req: unknown, res: import("express").Response) => {
    try {
      const r = await pool.query(
        `SELECT weekly_report_wa_group_chat_id, instance_id, api_token FROM whatsapp_settings WHERE id = 1`
      );
      const s = r.rows[0];
      res.json({
        groupChatId: s?.weekly_report_wa_group_chat_id || "",
        hasCredentials: !!(s?.instance_id && s?.api_token),
      });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  app.patch("/api/factory/weekly-report-wa-settings", requireAuth, async (req: Request, res: Response) => {
    try {
      const { groupChatId } = req.body;
      await pool.query(
        `INSERT INTO whatsapp_settings (id, weekly_report_wa_group_chat_id) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET weekly_report_wa_group_chat_id = $1`,
        [groupChatId || ""]
      );
      res.json({ success: true });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  app.post("/api/factory/send-weekly-report-whatsapp", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const r = await pool.query(
        `SELECT weekly_report_wa_group_chat_id, instance_id, api_token, enabled FROM whatsapp_settings WHERE id = 1`
      );
      const s = r.rows[0];
      if (!s?.weekly_report_wa_group_chat_id)
        return res
          .status(400)
          .json({ message: "No WhatsApp group configured for the weekly report. Please set one in settings." });
      if (!s.instance_id || !s.api_token)
        return res.status(400).json({ message: "WhatsApp credentials not configured." });
      const buf = await buildWeeklyReportExcelBuffer(companyId, "all");
      const { sendWhatsAppFileToChatId } = await import("../../../services/whatsappService");
      const result = await sendWhatsAppFileToChatId(
        s.weekly_report_wa_group_chat_id,
        buf,
        "weekly-production-report.xlsx",
        "Weekly Production Report",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      if (!result.success) return res.status(500).json({ message: result.error || "Failed to send WhatsApp message" });
      res.json({ success: true });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ───────────────────────────────────────────────
  // 7. Factory Pressing (create-and-print)
  // ───────────────────────────────────────────────
}
