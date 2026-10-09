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
import {
  getWaSettings,
  getWaSettingsById,
  getPosWaSettings,
  normaliseChatId,
  fetchGreenApiChats,
  sendWhatsAppFile,
  sendWhatsAppFileToChatId,
  getGreenInstanceState,
} from "../services/whatsappService";
import { generateNetPositionExcel, generateMonthEnds } from "../helpers/generateNetPositionExcel";
import { generateStockPdf } from "../helpers/generateStockPdf";
import { sendExportEmail } from "../services/emailService";
import { triggerDailyWhatsAppSendNow } from "../services/scheduler";
import { ZipArchive } from "archiver";
import { getClientDate } from "../lib/dateUtils";

export function registerWhatsAppRoutes(app: Express) {
  // ── Settings (singleton row id=1) ──────────────────────────────────────────

  app.get("/api/whatsapp/settings", requireAuth, async (_req, res) => {
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
        return res.json({ instanceId: "", apiToken: "", enabled: false, monthlyAutoSend: false });
      }
      const s = r.rows[0];
      res.json({
        instanceId: s.instance_id,
        apiToken: s.api_token ? "••••••" : "",
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

  app.put("/api/whatsapp/settings", requireAuth, async (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;

      // Fetch existing row so we can preserve fields not sent by the caller
      const existing = await getWaSettings();

      const instanceId = body.instanceId ?? existing?.instanceId ?? "";
      const apiToken = body.apiToken ?? existing?.apiToken ?? "";
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
          api_token          = CASE WHEN $2 = '' OR $2 = '••••••' THEN whatsapp_settings.api_token ELSE EXCLUDED.api_token END,
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

  app.get("/api/whatsapp/recipients", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const result = await pool.query(
        "SELECT id, chat_id, name, is_group, active FROM whatsapp_recipients WHERE company_id = $1 ORDER BY id",
        [companyId]
      );
      res.json(
        result.rows.map((r) => ({
          id: r.id,
          chatId: r.chat_id,
          name: r.name,
          isGroup: r.is_group,
          active: r.active,
        }))
      );
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  app.post("/api/whatsapp/recipients", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { chatId: rawChatId, name } = req.body as { chatId: string; name?: string };
      if (!rawChatId?.trim()) return res.status(400).json({ message: "chatId is required" });

      const chatId = normaliseChatId(rawChatId);
      const isGroup = chatId.endsWith("@g.us");
      const label = name?.trim() || chatId;

      const result = await pool.query(
        `INSERT INTO whatsapp_recipients (company_id, chat_id, name, is_group, active)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (company_id, chat_id) DO UPDATE SET name = $3, active = true
         RETURNING id, chat_id, name, is_group, active`,
        [companyId, chatId, label, isGroup]
      );
      const r = result.rows[0];
      res.json({ id: r.id, chatId: r.chat_id, name: r.name, isGroup: r.is_group, active: r.active });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  app.put("/api/whatsapp/recipients/:id", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseInt(req.params.id);
      const { name, active } = req.body as { name?: string; active?: boolean };
      const result = await pool.query(
        `UPDATE whatsapp_recipients SET
           name   = COALESCE($1, name),
           active = COALESCE($2, active)
         WHERE id = $3 AND company_id = $4`,
        [name ?? null, active ?? null, id, companyId]
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ message: "Recipient not found" });
      }
      res.json({ message: "Updated" });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  app.delete("/api/whatsapp/recipients/:id", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseInt(req.params.id);
      const result = await pool.query("DELETE FROM whatsapp_recipients WHERE id = $1 AND company_id = $2", [
        id,
        companyId,
      ]);
      if (result.rowCount === 0) {
        return res.status(404).json({ message: "Recipient not found" });
      }
      res.json({ message: "Deleted" });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── Fetch chats from Green API (for group picker) ──────────────────────────

  app.get("/api/whatsapp/chats", requireAuth, async (_req, res) => {
    try {
      const s = await getWaSettings();
      if (!s?.instanceId || !s?.apiToken) {
        return res.status(400).json({ message: "WhatsApp credentials not configured" });
      }
      const chats = await fetchGreenApiChats(s.instanceId, s.apiToken);
      res.json(chats);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── POS WhatsApp instance (id=2) settings & chats ──────────────────────────

  app.get("/api/whatsapp/settings/pos", requireAuth, async (_req, res) => {
    try {
      const s = await getWaSettingsById(2);
      if (!s) {
        return res.json({ instanceId: "", apiToken: "", enabled: true, hasCredentials: false });
      }
      res.json({
        instanceId: s.instanceId,
        apiToken: s.apiToken ? "••••••" : "",
        enabled: s.enabled,
        hasCredentials: !!(s.instanceId && s.apiToken),
      });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  app.put("/api/whatsapp/settings/pos", requireAuth, async (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const existing = await getWaSettingsById(2);

      const instanceId = body.instanceId ?? existing?.instanceId ?? "";
      const apiToken = body.apiToken ?? existing?.apiToken ?? "";
      const enabled = body.enabled !== undefined ? body.enabled : (existing?.enabled ?? true);

      await pool.query(
        `
        INSERT INTO whatsapp_settings (id, instance_id, api_token, enabled)
        VALUES (2, $1, $2, $3)
        ON CONFLICT (id) DO UPDATE SET
          instance_id = EXCLUDED.instance_id,
          api_token   = CASE WHEN $2 = '' OR $2 = '••••••' THEN whatsapp_settings.api_token ELSE EXCLUDED.api_token END,
          enabled     = EXCLUDED.enabled
      `,
        [instanceId, apiToken, enabled]
      );

      res.json({ message: "Saved" });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  app.get("/api/whatsapp/chats/pos", requireAuth, async (_req, res) => {
    try {
      const s = await getPosWaSettings();
      if (!s?.instanceId || !s?.apiToken) {
        return res.status(400).json({ message: "POS WhatsApp credentials not configured" });
      }
      const chats = await fetchGreenApiChats(s.instanceId, s.apiToken);
      res.json(chats);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── Instance state checks ──────────────────────────────────────────────────

  /** Real-time state of the main WhatsApp instance (id=1). */
  app.get("/api/whatsapp/instance-state/main", requireAuth, async (_req, res) => {
    try {
      const s = await getWaSettings();
      if (!s?.instanceId || !s?.apiToken) {
        return res.json({ state: "notConfigured" });
      }
      const state = await getGreenInstanceState(s.instanceId, s.apiToken);
      res.json({ state });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  /** Real-time state of the POS WhatsApp instance (id=2, with fallback to id=1). */
  app.get("/api/whatsapp/instance-state/pos", requireAuth, async (_req, res) => {
    try {
      const s = await getPosWaSettings();
      if (!s?.instanceId || !s?.apiToken) {
        return res.json({ state: "notConfigured" });
      }
      const state = await getGreenInstanceState(s.instanceId, s.apiToken);
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

  // ── Stock + Net Position Report Settings ────────────────────────────────────

  app.get("/api/whatsapp/stock-settings", requireAuth, async (_req, res) => {
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

  app.put("/api/whatsapp/stock-settings", requireAuth, async (req, res) => {
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

  app.get("/api/whatsapp/np-settings", requireAuth, async (_req, res) => {
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

  app.put("/api/whatsapp/np-settings", requireAuth, async (req, res) => {
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

  app.post("/api/daily-export/trigger-whatsapp", requireAuth, async (req, res) => {
    const { fromDate, toDate } = req.body as { fromDate?: string; toDate?: string };

    // Respond immediately — building the full ZIP and sending it can take >30 s for large
    // company sets, which would timeout the browser request.  The result is recorded in
    // daily_export_runs and is visible in the Backup Status card (auto-refreshes every 15 s).
    res.json({ started: true, message: "WhatsApp export started. Check Backup Status below for the result." });

    // Run the actual work asynchronously after the response is sent
    triggerDailyWhatsAppSendNow(fromDate || undefined, toDate || undefined)
      .then((r) => logger.info(`[ManualWhatsApp] Completed: ${r.message}`))
      .catch((e) => logger.error(`[ManualWhatsApp] Failed: ${getErrorMessage(e)}`));
  });

  app.post("/api/whatsapp/send-np-all-now", requireAuth, async (req, res) => {
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

  // ── Send Stock + Net Position to one specific group ─────────────────────────

  app.post("/api/whatsapp/send-stock-report", requireAuth, async (req, res) => {
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
