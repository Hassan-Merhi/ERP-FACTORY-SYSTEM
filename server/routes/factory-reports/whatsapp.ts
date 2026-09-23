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
import { factorySettings } from "@shared/schema";
import { eq } from "drizzle-orm";

export function registerFactoryMixBatchWhatsappRoutes(app: Express, requireAuth: RequestHandler, db: Database) {
  // Shared factory image sender. Mix batches remain the default caller, while
  // other factory reports can provide their own file name/caption/identifier.
  app.post("/api/factory/send-mix-batch-image-whatsapp", requireAuth, async (req: Request, res: Response) => {
    try {
      const { imageBase64, date, fileName, caption, reportLabel, recipient, destination } = req.body ?? {};
      if (!imageBase64) return res.status(400).json({ message: "imageBase64 is required" });

      // Production Targets uses the same production WhatsApp destination that is
      // configured in Factory Settings for Worker Matrix sends. That destination
      // belongs to the POS WhatsApp instance, so keep it isolated from the normal
      // mix-batch/weekly-report sender below.
      if (recipient === "production") {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const [settings] = await db
          .select({ extraSettings: factorySettings.extraSettings })
          .from(factorySettings)
          .where(eq(factorySettings.companyId, companyId));
        const extra = (settings?.extraSettings ?? {}) as {
          productionWorkerMatrixWhatsappGroupId?: string | null;
        };
        const productionGroupChatId = String(extra.productionWorkerMatrixWhatsappGroupId ?? "").trim();

        if (!productionGroupChatId) {
          return res.status(400).json({
            message: "No Production WhatsApp group configured. Go to Factory Settings → Production WhatsApp Group.",
          });
        }

        const base64Data = String(imageBase64).replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, "base64");
        const today = date || new Date().toISOString().substring(0, 10);
        const finalFileName = String(fileName || `Production_${today}.png`).slice(0, 180);
        const finalCaption = String(caption || `Production Targets — ${today}`).trim().slice(0, 500);
        const auditLabel = String(reportLabel || finalCaption).trim().slice(0, 200);

        const { sendWhatsAppFileToChatIdPos, getWaSettingsById } = await import("../../services/whatsappService");
        const posSettings = await getWaSettingsById(2);
        if (!posSettings?.instanceId || !posSettings?.apiToken) {
          return res.status(400).json({ message: "Production WhatsApp credentials are not configured." });
        }
        if (!posSettings.enabled) {
          return res.status(400).json({ message: "Production WhatsApp sending is disabled." });
        }

        const result = await sendWhatsAppFileToChatIdPos(
          productionGroupChatId,
          buffer,
          finalFileName,
          finalCaption,
          "image/png"
        );
        if (!result.success) {
          return res.status(502).json({ message: result.error || "Failed to send production image to WhatsApp." });
        }

        try {
          await logAudit({
            userId: req.session.userId!,
            username: req.session.username || req.session.userId!,
            companyId,
            action: "send_whatsapp",
            tableName: "reports",
            recordId: null,
            recordIdentifier: auditLabel,
            changes: {
              format: { old: null, new: "image/png" },
              whatsappInstance: { old: null, new: "production-pos" },
            },
          });
        } catch (auditErr) {
          logger.error("[production-targets-wa] audit write failed:", { error: auditErr });
        }

        return res.json({
          ok: true,
          message: "Production Targets image sent to the configured Production WhatsApp group.",
          usedFallback: false,
        });
      }

      const r = await pool.query(
        `SELECT weekly_report_wa_group_chat_id, instance_id, api_token, enabled FROM whatsapp_settings WHERE id = 1`
      );
      const s = r.rows?.[0];
      const defaultGroupChatId = String(s?.weekly_report_wa_group_chat_id ?? "").trim();
      const instanceId = String(s?.instance_id ?? "").trim();
      const apiToken = String(s?.api_token ?? "").trim();
      const isAttendance = destination === "attendance" || recipient === "attendance";

      let groupChatId = defaultGroupChatId;
      if (isAttendance) {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const [settings] = await db
          .select({ extraSettings: factorySettings.extraSettings })
          .from(factorySettings)
          .where(eq(factorySettings.companyId, companyId));
        const extra = (settings?.extraSettings ?? {}) as {
          attendanceWhatsappGroupId?: string | null;
        };
        groupChatId = String(extra.attendanceWhatsappGroupId ?? "").trim();
      }

      if (!groupChatId) {
        return res.status(400).json({
          message: isAttendance
            ? "No Attendance WhatsApp group configured. Open Intelligence → Intel Settings and set the Attendance WhatsApp Group."
            : "No WhatsApp group configured. Go to Settings → Export Settings to configure one.",
        });
      }
      if (!instanceId || !apiToken) {
        return res.status(400).json({ message: "WhatsApp credentials not configured." });
      }
      if (!s.enabled) {
        return res.status(400).json({ message: "WhatsApp sending is disabled." });
      }

      // Green API credentials/group ids are copied from the console and can
      // accidentally be saved with leading/trailing whitespace. Normalize the
      // shared/default destination independently from the attendance override so
      // choosing an attendance group can never overwrite the weekly report group.
      if (
        defaultGroupChatId !== s.weekly_report_wa_group_chat_id ||
        instanceId !== s.instance_id ||
        apiToken !== s.api_token
      ) {
        await pool.query(
          `UPDATE whatsapp_settings
              SET weekly_report_wa_group_chat_id = $1,
                  instance_id = $2,
                  api_token = $3
            WHERE id = 1`,
          [defaultGroupChatId, instanceId, apiToken]
        );
      }

      const base64Data = String(imageBase64).replace(/^data:image\/\w+;base64,/, "");
      const buffer = Buffer.from(base64Data, "base64");
      const today = date || new Date().toISOString().substring(0, 10);
      const finalFileName = String(fileName || `MixBatch_${today}.png`).slice(0, 180);
      const finalCaption = String(caption || `Mix Batch Details — ${today}`).trim().slice(0, 500);
      const auditLabel = String(reportLabel || finalCaption).trim().slice(0, 200);

      const { sendWhatsAppFileToChatId, sendWhatsAppFileToChatIdPos, getWaSettingsById } = await import(
        "../../services/whatsappService"
      );

      let result = await sendWhatsAppFileToChatId(groupChatId, buffer, finalFileName, finalCaption, "image/png");
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
            recipient: isAttendance ? "attendance" : "default",
          });
          const fallbackResult = await sendWhatsAppFileToChatIdPos(
            groupChatId,
            buffer,
            finalFileName,
            finalCaption,
            "image/png"
          );
          if (fallbackResult.success) {
            result = fallbackResult;
            usedFallback = true;
          } else {
            logger.warn("[mix-batch-wa] POS instance fallback also failed", {
              groupChatId,
              recipient: isAttendance ? "attendance" : "default",
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
            recipient: isAttendance ? "attendance" : "default",
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
            recordIdentifier: auditLabel,
            changes: {
              format: { old: null, new: "image/png" },
              whatsappInstance: { old: null, new: usedFallback ? "pos-fallback" : "main" },
              reportDestination: { old: null, new: isAttendance ? "attendance" : "default" },
            },
          });
        }
      } catch (auditErr) {
        logger.error("[mix-batch-wa] audit write failed:", { error: auditErr });
      }

      const reportName = isAttendance ? "Attendance image" : "Mix batch image";
      res.json({
        ok: true,
        message: usedFallback
          ? `${reportName} sent to WhatsApp group using the backup WhatsApp instance.`
          : `${reportName} sent to WhatsApp group.`,
        usedFallback,
      });
    } catch (err: unknown) {
      logger.error("[mix-batch-wa] send error:", { error: err });
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
