// Extracted from ./whatsappRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { requireAuth, requireRole } from "../auth";
import { pool } from "../db";
import { requireExportAccess } from "../lib/permissionMiddleware";
import { logger } from "../lib/logger";
import { storage } from "../storage";
import { getWaSettings, sendWhatsAppFileToChatId } from "../services/whatsappService";
import { generateNetPositionExcel } from "../helpers/generateNetPositionExcel";
import { sendExportEmail } from "../services/emailService";
import { triggerDailyWhatsAppSendNow } from "../services/scheduler";
import { invalidExportDateRange } from "../services/export-excel/workbook";
import { ZipArchive } from "archiver";
import { getClientDate } from "../lib/dateUtils";

// The settings rows hold the Green API credentials and the schedules that
// decide what is sent to which group: Admin, Developer and Owner only, for
// reads too, like the rest of the export center (requireRole always admits
// Developer; it is listed for the route manifest).
const settingsAdmins = requireRole("Admin", "Developer", "Owner");
// Sending through the company WhatsApp account needs the named export permission.
const whatsappSend = requireExportAccess("exp_whatsapp_send");

export function registerWhatsAppRoutesPart2(app: Express) {
  // ── Stock + Net Position Report Settings ────────────────────────────────────

  app.get("/api/whatsapp/stock-settings", requireAuth, settingsAdmins, async (_req, res) => {
    try {
      const r = await pool.query(
        `SELECT id, company_id, recipient_id, auto_send, enabled,
                frequency, send_hour, send_day_of_week, last_sent_at
         FROM whatsapp_stock_settings ORDER BY id LIMIT 1`
      );
      if (!r.rows.length) {
        return res.json({
          companyId: null,
          recipientId: null,
          autoSend: false,
          enabled: false,
          frequency: "daily",
          sendHour: 18,
          sendDayOfWeek: 1,
          lastSentAt: null,
        });
      }
      const row = r.rows[0];
      res.json({
        companyId: row.company_id,
        recipientId: row.recipient_id,
        autoSend: row.auto_send,
        enabled: row.enabled,
        frequency: row.frequency ?? "daily",
        sendHour: row.send_hour ?? 18,
        sendDayOfWeek: row.send_day_of_week ?? 1,
        lastSentAt: row.last_sent_at ?? null,
      });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  app.put("/api/whatsapp/stock-settings", requireAuth, settingsAdmins, async (req, res) => {
    try {
      const { companyId, recipientId, autoSend, enabled, frequency, sendHour, sendDayOfWeek } = req.body as Record<
        string,
        unknown
      >;
      await pool.query(
        `INSERT INTO whatsapp_stock_settings (id, company_id, recipient_id, auto_send, enabled, frequency, send_hour, send_day_of_week)
         VALUES (1, $1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET
           company_id       = EXCLUDED.company_id,
           recipient_id     = EXCLUDED.recipient_id,
           auto_send        = EXCLUDED.auto_send,
           enabled          = EXCLUDED.enabled,
           frequency        = EXCLUDED.frequency,
           send_hour        = EXCLUDED.send_hour,
           send_day_of_week = EXCLUDED.send_day_of_week`,
        [
          companyId ?? null,
          recipientId ?? null,
          autoSend ?? false,
          enabled ?? false,
          frequency ?? "daily",
          sendHour ?? 18,
          sendDayOfWeek ?? null,
        ]
      );
      res.json({ message: "Saved" });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── Net Position Scheduled Export Settings ──────────────────────────────────

  app.get("/api/whatsapp/np-settings", requireAuth, settingsAdmins, async (_req, res) => {
    try {
      const r = await pool.query(
        `SELECT npe.id, npe.recipient_id, npe.frequency, npe.send_hour, npe.send_day_of_week,
                npe.enabled, npe.auto_send, npe.last_sent_at,
                wr.name AS recipient_name
           FROM net_position_export_settings npe
           LEFT JOIN whatsapp_recipients wr ON wr.id = npe.recipient_id
          WHERE npe.id = 1`
      );
      if (!r.rows.length) {
        return res.json({
          recipientId: null,
          recipientName: null,
          frequency: "daily",
          sendHour: 18,
          sendDayOfWeek: 1,
          enabled: false,
          autoSend: false,
          lastSentAt: null,
        });
      }
      const row = r.rows[0];
      res.json({
        recipientId: row.recipient_id,
        recipientName: row.recipient_name ?? null,
        frequency: row.frequency ?? "daily",
        sendHour: row.send_hour ?? 18,
        sendDayOfWeek: row.send_day_of_week ?? 1,
        enabled: row.enabled ?? false,
        autoSend: row.auto_send ?? false,
        lastSentAt: row.last_sent_at ?? null,
      });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  app.put("/api/whatsapp/np-settings", requireAuth, settingsAdmins, async (req, res) => {
    try {
      const { recipientId, frequency, sendHour, sendDayOfWeek, enabled, autoSend } = req.body as Record<
        string,
        unknown
      >;
      await pool.query(
        `INSERT INTO net_position_export_settings
           (id, recipient_id, frequency, send_hour, send_day_of_week, enabled, auto_send)
         VALUES (1, $1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET
           recipient_id     = EXCLUDED.recipient_id,
           frequency        = EXCLUDED.frequency,
           send_hour        = EXCLUDED.send_hour,
           send_day_of_week = EXCLUDED.send_day_of_week,
           enabled          = EXCLUDED.enabled,
           auto_send        = EXCLUDED.auto_send`,
        [
          recipientId ?? null,
          frequency ?? "daily",
          sendHour ?? 18,
          sendDayOfWeek ?? null,
          enabled ?? false,
          autoSend ?? false,
        ]
      );
      res.json({ message: "Saved" });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── Send Net Position (all companies) to group + email NOW ──────────────────
  // Full export of every company: owners/administrators only (Developer is always admitted by requireRole).
  app.post("/api/daily-export/trigger-whatsapp", requireAuth, requireRole("Admin", "Owner"), async (req, res) => {
    const { fromDate, toDate } = req.body as { fromDate?: string; toDate?: string };
    const invalidDate = invalidExportDateRange(fromDate, toDate);
    if (invalidDate) return res.status(400).json({ message: invalidDate });
    // Respond immediately — building the full ZIP and sending it can take >30 s for large
    // company sets, which would timeout the browser request.  The result is recorded in
    // daily_export_runs and is visible in the Backup Status card (auto-refreshes every 15 s).
    res.json({ started: true, message: "WhatsApp export started. Check Backup Status below for the result." });

    // Run the actual work asynchronously after the response is sent
    triggerDailyWhatsAppSendNow(fromDate || undefined, toDate || undefined)
      .then((r) => logger.info(`[ManualWhatsApp] Completed: ${r.message}`))
      .catch((e) => logger.error(`[ManualWhatsApp] Failed: ${getErrorMessage(e)}`));
  });

  app.post("/api/whatsapp/send-np-all-now", requireAuth, whatsappSend, async (req, res) => {
    const _t = Date.now();
    const _uid = req.session.userId;
    const _cid = req.session.currentCompanyId;
    try {
      logger.info("whatsapp send-np-all-now started", {
        module: "whatsapp",
        action: "sendNpAllNow",
        userId: _uid,
        companyId: _cid,
      });
      const { recipientId: reqRecipientId } = req.body as Record<string, unknown>;

      const allCompanies = await storage.getAllCompanies();
      if (!allCompanies.length) return res.status(400).json({ message: "No companies found" });

      const today = getClientDate(req);
      const year = new Date(today).getFullYear();
      const npStart = `${year}-01-01`;
      const npEnd = today;

      // Build ZIP
      const zipBuf = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const arc = new ZipArchive({ zlib: { level: 6 } });
        arc.on("data", (chunk: Buffer) => chunks.push(chunk));
        arc.on("end", () => resolve(Buffer.concat(chunks)));
        arc.on("error", reject);

        void (async () => {
          for (const company of allCompanies) {
            try {
              const buf = await generateNetPositionExcel(company.id, company.name, npStart, npEnd);
              const safe = company.name.replace(/[^a-z0-9]/gi, "_");
              arc.append(Buffer.isBuffer(buf) ? buf : Buffer.from(buf), {
                name: `NetPosition_${safe}_${npEnd}.xlsx`,
              });
            } catch (e: unknown) {
              logger.error(`[NpAllNow] Failed for ${company.name}:`, { error: getErrorMessage(e) });
            }
          }
          await arc.finalize();
        })().catch(reject);
      });

      const messages: string[] = [];

      // WhatsApp send
      const recipientId = reqRecipientId ? parseInt(String(reqRecipientId)) : null;
      const sessCompanyId = req.session.currentCompanyId;
      if (recipientId) {
        const rq = await pool.query(
          "SELECT chat_id FROM whatsapp_recipients WHERE id = $1 AND active = true AND company_id = $2",
          [recipientId, sessCompanyId]
        );
        if (rq.rows.length) {
          const chatId = rq.rows[0].chat_id as string;
          const waSettings = await getWaSettings();
          if (waSettings?.enabled) {
            const waRes = await sendWhatsAppFileToChatId(
              chatId,
              zipBuf,
              `NetPosition_AllCompanies_${today}.zip`,
              `Net Position Report — All Companies\nPeriod: ${npStart} → ${npEnd}`,
              "application/zip"
            );
            messages.push(`WhatsApp: ${waRes.success ? "sent" : waRes.error}`);
          } else {
            messages.push("WhatsApp not enabled");
          }
        } else {
          messages.push("WhatsApp recipient not found or inactive");
        }
      } else {
        messages.push("No WhatsApp group selected");
      }

      // Email send
      const emailResult = await sendExportEmail(
        zipBuf,
        today,
        allCompanies.map((c) => c.name)
      );
      messages.push(`Email: ${emailResult.success ? "sent" : emailResult.error || "failed"}`);

      logger.info("whatsapp send-np-all-now succeeded", {
        module: "whatsapp",
        action: "sendNpAllNow",
        userId: _uid,
        companyId: _cid,
        durationMs: Date.now() - _t,
      });
      res.json({ message: messages.join(" | ") });
    } catch (err: unknown) {
      logger.error("whatsapp send-np-all-now failed", {
        module: "whatsapp",
        action: "sendNpAllNow",
        userId: _uid,
        companyId: _cid,
        durationMs: Date.now() - _t,
        error: err,
      });
      logger.error("[NpAllNow] Error:", { error: getErrorMessage(err) || err });
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
