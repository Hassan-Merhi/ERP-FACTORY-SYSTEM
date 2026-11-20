// Extracted from ./registerWhatsAppRoutesPart1.ts
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { requireAuth, requireRole } from "../auth";
import { pool } from "../db";
import { requireExportAccess } from "../lib/permissionMiddleware";
import {
  fetchGreenApiChats,
  getPosWaSettings,
  getStrictGreenMainInstanceState,
  getWaSettings,
  getWaSettingsById,
  normaliseChatId,
} from "../services/whatsappService";
import { maskGreenApiToken, submittedGreenApiToken } from "../services/whatsappSettingsStore";

// The settings rows hold the Green API credentials and the schedules that
// decide what is sent to which group: Admin, Developer and Owner only, for
// reads too, like the rest of the export center (requireRole always admits
// Developer; it is listed for the route manifest).
const settingsAdmins = requireRole("Admin", "Developer", "Owner");
// The recipient list decides which chats the company account sends to: reading
// and changing it needs the WhatsApp send permission. Chats and instance state
// stay readable by any signed-in user (many pickers use them).
const whatsappSend = requireExportAccess("exp_whatsapp_send");

export function registerWhatsAppRoutesPart3(app: Express) {
  app.get("/api/whatsapp/recipients", requireAuth, whatsappSend, async (req, res) => {
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

  app.post("/api/whatsapp/recipients", requireAuth, whatsappSend, async (req, res) => {
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

  app.put("/api/whatsapp/recipients/:id", requireAuth, whatsappSend, async (req, res) => {
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

  app.delete("/api/whatsapp/recipients/:id", requireAuth, whatsappSend, async (req, res) => {
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

  app.get("/api/whatsapp/settings/pos", requireAuth, settingsAdmins, async (_req, res) => {
    try {
      const s = await getWaSettingsById(2);
      if (!s) {
        return res.json({ instanceId: "", apiToken: "", apiTokenSet: false, enabled: true, hasCredentials: false });
      }
      res.json({
        instanceId: s.instanceId,
        apiToken: maskGreenApiToken(s.apiToken),
        apiTokenSet: !!s.apiToken,
        enabled: s.enabled,
        hasCredentials: !!(s.instanceId && s.apiToken),
      });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  app.put("/api/whatsapp/settings/pos", requireAuth, settingsAdmins, async (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const existing = await getWaSettingsById(2);

      const instanceId = body.instanceId ?? existing?.instanceId ?? "";
      // "" keeps the stored token (omitted, blank or the masked value a GET returned).
      const apiToken = submittedGreenApiToken(body.apiToken);
      const enabled = body.enabled !== undefined ? body.enabled : (existing?.enabled ?? true);

      await pool.query(
        `
        INSERT INTO whatsapp_settings (id, instance_id, api_token, enabled)
        VALUES (2, $1, $2, $3)
        ON CONFLICT (id) DO UPDATE SET
          instance_id = EXCLUDED.instance_id,
          api_token   = CASE WHEN $2 = '' THEN whatsapp_settings.api_token ELSE EXCLUDED.api_token END,
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
}
