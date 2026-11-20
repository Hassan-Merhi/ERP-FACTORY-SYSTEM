// Extracted from ./whatsappRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { requireAuth, requireRole } from "../auth";
import { pool } from "../db";
import { logger } from "../lib/logger";
import { storage } from "../storage";
import {
  getPosWaSettings,
  getStrictGreenMainInstanceState,
  getWaSettings,
  sendWhatsAppFile,
} from "../services/whatsappService";
import { generateMonthEnds, generateNetPositionExcel } from "../helpers/generateNetPositionExcel";
import { getClientDate } from "../lib/dateUtils";
import { maskGreenApiToken, submittedGreenApiToken } from "../services/whatsappSettingsStore";
import { registerWhatsAppRoutesPart3 } from "./registerWhatsAppRoutesPart3";

// The settings rows hold the Green API credentials and the schedules that
// decide what is sent to which group: Admin, Developer and Owner only, for
// reads too, like the rest of the export center (requireRole always admits
// Developer; it is listed for the route manifest).
const settingsAdmins = requireRole("Admin", "Developer", "Owner");

export function registerWhatsAppRoutesPart1(app: Express) {
  // ── Settings (singleton row id=1) ──────────────────────────────────────────

  app.get("/api/whatsapp/settings", requireAuth, settingsAdmins, async (_req, res) => {
    try {
      const r = await pool.query(`
        SELECT ws.instance_id, ws.api_token, ws.enabled, ws.monthly_auto_send,
               ws.daily_auto_send, ws.daily_recipient_id,
               wr.name AS daily_recipient_name
          FROM whatsapp_settings ws
          LEFT JOIN whatsapp_recipients wr ON wr.id = ws.daily_recipient_id
         WHERE ws.id = 1
      `);
      if (!r.rows.length) {
        return res.json({ instanceId: "", apiToken: "", apiTokenSet: false, enabled: false, monthlyAutoSend: false });
      }
      const s = r.rows[0];
      res.json({
        instanceId: s.instance_id,
        apiToken: maskGreenApiToken(s.api_token),
        apiTokenSet: !!s.api_token,
        enabled: s.enabled,
        monthlyAutoSend: s.monthly_auto_send,
        dailyAutoSend: s.daily_auto_send,
        dailyRecipientId: s.daily_recipient_id,
        dailyRecipientName: s.daily_recipient_name ?? null,
        hasCredentials: !!(s.instance_id && s.api_token),
      });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  app.put("/api/whatsapp/settings", requireAuth, settingsAdmins, async (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;

      // Fetch existing row so we can preserve fields not sent by the caller
      const existing = await getWaSettings();

      const instanceId = body.instanceId ?? existing?.instanceId ?? "";
      // "" keeps the stored token (omitted, blank or the masked value a GET returned).
      const apiToken = submittedGreenApiToken(body.apiToken);
      const enabled = body.enabled !== undefined ? body.enabled : (existing?.enabled ?? false);
      const monthlyAutoSend =
        body.monthlyAutoSend !== undefined ? body.monthlyAutoSend : (existing?.monthlyAutoSend ?? false);
      const dailyAutoSend = body.dailyAutoSend !== undefined ? body.dailyAutoSend : (existing?.dailyAutoSend ?? false);
      const dailyRecipientId =
        body.dailyRecipientId !== undefined ? body.dailyRecipientId : (existing?.dailyRecipientId ?? null);

      await pool.query(
        `
        INSERT INTO whatsapp_settings (id, instance_id, api_token, enabled, monthly_auto_send, daily_auto_send, daily_recipient_id)
        VALUES (1, $1, $2, $3, $4, $5, $6)
        ON CONFLICT (id) DO UPDATE SET
          instance_id        = EXCLUDED.instance_id,
          api_token          = CASE WHEN $2 = '' THEN whatsapp_settings.api_token ELSE EXCLUDED.api_token END,
          enabled            = EXCLUDED.enabled,
          monthly_auto_send  = EXCLUDED.monthly_auto_send,
          daily_auto_send    = EXCLUDED.daily_auto_send,
          daily_recipient_id = EXCLUDED.daily_recipient_id
      `,
        [instanceId, apiToken, enabled, monthlyAutoSend, dailyAutoSend, dailyRecipientId]
      );

      res.json({ message: "Saved" });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── Recipients ─────────────────────────────────────────────────────────────

  registerWhatsAppRoutesPart3(app);

  /** Real-time state of the POS WhatsApp instance (id=2, with fallback to id=1). */
  app.get("/api/whatsapp/instance-state/pos", requireAuth, async (_req, res) => {
    try {
      const s = await getPosWaSettings();
      if (!s?.instanceId || !s?.apiToken) {
        return res.json({ state: "notConfigured" });
      }
      // Check this exact POS account only; an authorized backup account
      // must never mask an invalid POS token or unauthorized POS instance.
      const state = await getStrictGreenMainInstanceState(s.instanceId, s.apiToken);
      res.json({ state });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── Send net-position Excel manually ───────────────────────────────────────

  app.post("/api/whatsapp/send-net-position", requireAuth, async (req, res) => {
    const _t = Date.now();
    const _uid = req.session.userId;
    const _cid = req.session.currentCompanyId;
    try {
      logger.info("whatsapp send-net-position started", {
        module: "whatsapp",
        action: "sendNetPosition",
        userId: _uid,
        companyId: _cid,
      });
      const currentRole = req.session?.currentRole;
      const isAdmin = currentRole === "Admin" || currentRole === "Developer";
      const requestedCompanyId = req.body.companyId ? parseInt(req.body.companyId) : null;
      const companyId = isAdmin && requestedCompanyId ? requestedCompanyId : req.session.currentCompanyId;

      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const allCompanies = await storage.getAllCompanies();
      const company = allCompanies.find((c) => c.id === companyId);
      const companyName = company?.name || "Company";

      const endDate = (req.body.endDate as string) || getClientDate(req);
      const startDate =
        (req.body.startDate as string) ||
        (() => {
          const d = new Date(endDate);
          d.setFullYear(d.getFullYear() - 1);
          return d.toISOString().split("T")[0];
        })();

      if (generateMonthEnds(startDate, endDate).length === 0) {
        return res.status(400).json({ message: "No months in range" });
      }

      const buffer = await generateNetPositionExcel(companyId, companyName, startDate, endDate);
      const safe = companyName.replace(/[^a-z0-9]/gi, "_");
      const fileName = `NetPosition_${safe}_${endDate}.xlsx`;
      const caption = `Net Position Report — ${companyName}\nPeriod: ${startDate} → ${endDate}`;

      const result = await sendWhatsAppFile(buffer, fileName, caption);

      if (result.success) {
        logger.info("whatsapp send-net-position succeeded", {
          module: "whatsapp",
          action: "sendNetPosition",
          userId: _uid,
          companyId: _cid,
          durationMs: Date.now() - _t,
        });
        res.json({ message: `Sent to ${result.sent} recipient(s)`, ...result });
      } else {
        res.status(502).json({ message: result.errors[0] || "Send failed", ...result });
      }
    } catch (err: unknown) {
      logger.error("whatsapp send-net-position failed", {
        module: "whatsapp",
        action: "sendNetPosition",
        userId: _uid,
        companyId: _cid,
        durationMs: Date.now() - _t,
        error: err,
      });
      logger.error("[WhatsApp] send-net-position error:", { error: err });
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
