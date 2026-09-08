/**
 * factoryReportRoutes: FactoryMixBatchWhatsapp endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response, RequestHandler } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { pool, type Database } from "../../db";
import { logAudit } from "../_helpers";

export function registerFactoryMixBatchWhatsappRoutes(app: Express, requireAuth: RequestHandler, _db: Database) {
  // ── Send mix batch image to WhatsApp ─────────────────────────────────────
  app.post("/api/factory/send-mix-batch-image-whatsapp", requireAuth, async (req: Request, res: Response) => {
    try {
      const { imageBase64, date, fileName } = req.body ?? {};
      if (!imageBase64) return res.status(400).json({ message: "imageBase64 is required" });

      const r = await pool.query(
        `SELECT weekly_report_wa_group_chat_id, instance_id, api_token, enabled FROM whatsapp_settings WHERE id = 1`
      );
      const s = r.rows?.[0];
      const groupChatId = String(s?.weekly_report_wa_group_chat_id ?? "").trim();
      const instanceId = String(s?.instance_id ?? "").trim();
      const apiToken = String(s?.api_token ?? "").trim();

      if (!groupChatId) {
        return res
          .status(400)
          .json({ message: "No WhatsApp group configured. Go to Settings → Export Settings to configure one." });
      }
      if (!instanceId || !apiToken) {
        return res.status(400).json({ message: "WhatsApp credentials not configured." });
      }
      if (!s.enabled) {
        return res.status(400).json({ message: "WhatsApp sending is disabled." });
      }

      // Green API credentials/group ids are copied from the console and can
      // accidentally be saved with leading/trailing whitespace. That turns a
      // valid token into a 401 because the token is part of the request URL.
      // Normalize the persisted values before the shared WhatsApp service
      // re-reads row id=1 for this send.
      if (
        groupChatId !== s.weekly_report_wa_group_chat_id ||
        instanceId !== s.instance_id ||
        apiToken !== s.api_token
      ) {
        await pool.query(
          `UPDATE whatsapp_settings
              SET weekly_report_wa_group_chat_id = $1,
                  instance_id = $2,
                  api_token = $3
            WHERE id = 1`,
          [groupChatId, instanceId, apiToken]
        );
      }

      const base64Data = String(imageBase64).replace(/^data:image\/\w+;base64,/, "");
      const buffer = Buffer.from(base64Data, "base64");
      const today = date || new Date().toISOString().substring(0, 10);
      const finalFileName = String(fileName || `MixBatch_${today}.png`);
      const caption = `Mix Batch Details — ${today}`;

      const { sendWhatsAppFileToChatId, sendWhatsAppFileToChatIdPos, getWaSettingsById } = await import(
        "../../services/whatsappService"
      );

      let result = await sendWhatsAppFileToChatId(groupChatId, buffer, finalFileName, caption, "image/png");
      let usedFallback = false;

      // A 401 means the primary Green API instance cannot authenticate. If a
      // second (POS) WhatsApp instance is configured, automatically try it so
      // the user still gets the report instead of seeing an avoidable error.
      if (!result.success && /Green API 401\b/i.test(result.error || "")) {
        const posSettings = await getWaSettingsById(2);
        if (posSettings?.instanceId && posSettings?.apiToken && posSettings.enabled) {
          logger.warn("[mix-batch-wa] primary WhatsApp auth failed; trying POS instance fallback", {
            instanceId,
            groupChatId,
          });
          const fallbackResult = await sendWhatsAppFileToChatIdPos(
            groupChatId,
            buffer,
            finalFileName,
            caption,
            "image/png"
          );
          if (fallbackResult.success) {
            result = fallbackResult;
            usedFallback = true;
          } else {
            logger.warn("[mix-batch-wa] POS instance fallback also failed", {
              groupChatId,
              error: fallbackResult.error,
            });
          }
        }
      }

      if (!result.success) {
        const errorMessage = result.error || "Failed to send";
        if (/Green API 401\b/i.test(errorMessage)) {
          logger.warn("[mix-batch-wa] Green API rejected configured credentials", {
            instanceId,
            groupChatId,
          });
          return res.status(502).json({
            message:
              "WhatsApp could not authenticate with any configured Green API instance. Update the WhatsApp Instance ID/API Token in Settings, then try again.",
            code: "WHATSAPP_AUTH_REJECTED",
          });
        }
        return res.status(502).json({ message: errorMessage });
      }

      // Non-fatal: audit write must not block the WhatsApp confirmation response
      try {
        const waCompanyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (waCompanyId) {
          await logAudit({
            userId: req.session.userId!,
            username: req.session.username || req.session.userId!,
            companyId: waCompanyId,
            action: "send_whatsapp",
            tableName: "reports",
            recordId: null,
            recordIdentifier: `Mix Batch Details — ${today}`,
            changes: {
              format: { old: null, new: "image/png" },
              whatsappInstance: { old: null, new: usedFallback ? "pos-fallback" : "main" },
            },
          });
        }
      } catch (auditErr) {
        logger.error("[mix-batch-wa] audit write failed:", { error: auditErr });
      }
      res.json({
        ok: true,
        message: usedFallback
          ? "Mix batch image sent to WhatsApp group using the backup WhatsApp instance."
          : "Mix batch image sent to WhatsApp group.",
        usedFallback,
      });
    } catch (err: unknown) {
      logger.error("[mix-batch-wa] send error:", { error: err });
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
