// Extracted from ./whatsappRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { requireAuth } from "../auth";
import { pool } from "../db";
import { logger } from "../lib/logger";
import { storage } from "../storage";
import {
  fetchGreenApiChats,
  getPosWaSettings,
  getStrictGreenMainInstanceState,
  getWaSettings,
  getWaSettingsById,
  normaliseChatId,
  sendWhatsAppFile,
} from "../services/whatsappService";
import { generateMonthEnds, generateNetPositionExcel } from "../helpers/generateNetPositionExcel";
import { getClientDate } from "../lib/dateUtils";

export function registerWhatsAppRoutesPart1(app: Express) {
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
      const state = await getStrictGreenMainInstanceState(s.instanceId, s.apiToken);
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
