/**
 * GIT routes - WhatsApp group settings and the send endpoints for transfer, agent-duty and container reports.
 *
 * Registered by ./index.ts in the same order as the original single file;
 * Express resolves first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { requireAuth, requireRole } from "../../auth";
import multer from "multer";
import { z } from "zod";
import { emptyQuery, stringParam, validateRequest, type RequestSchemas } from "../../lib/validateRequest";

const INVALID_IMAGE_PAYLOAD = "Invalid image payload. Only JPEG and PNG data URLs are accepted.";

const transferWaSettingsInput = {
  // The handler parses the id itself (parseInt + isNaN).
  params: z.strictObject({ companyId: stringParam }),
  query: emptyQuery,
  body: z.strictObject({ groupChatId: z.string().optional() }),
} satisfies RequestSchemas;

const agentDutyWaSettingsInput = {
  query: emptyQuery,
  // Agent name -> WhatsApp group chat id ("" while unassigned).
  body: z.strictObject({ groups: z.record(z.string(), z.string()).optional() }),
} satisfies RequestSchemas;

const sendAgentDutyWhatsappInput = {
  query: emptyQuery,
  // Multipart form fields beside the `image` file (agentCardWaSend.ts), or JSON with imageBase64.
  body: z
    .strictObject({
      imageBase64: z.string().optional(),
      agentName: z.string().optional(),
      fileName: z.string().optional(),
    })
    .optional(),
} satisfies RequestSchemas;

const containersWaSettingsInput = {
  query: emptyQuery,
  body: z.strictObject({
    groupChatId: z.string().optional(),
    scheduleEnabled: z.boolean().optional(),
    scheduleHour: z.union([z.number(), z.string()]).optional(),
  }),
} satisfies RequestSchemas;

const sendContainersWhatsappInput = {
  query: emptyQuery,
  // {} sends the PDF report; TabTruckLocationModel sends a rendered image instead.
  body: z.strictObject({ imageBase64: z.string().optional(), fileName: z.string().optional() }).optional(),
} satisfies RequestSchemas;

export function registerGitWhatsappRoutes(app: Express) {
  const agentDutyImageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 },
  });

  // ── Stock Transfer WhatsApp Settings ────────────────────────────────────────

  app.get("/api/git/transfer-wa-settings", requireAuth, async (req: Request, res: Response) => {
    try {
      const { getAllCompanyTransferWaSettings, getWaSettings } = await import("../../services/whatsappService");
      const [companies, main] = await Promise.all([getAllCompanyTransferWaSettings(), getWaSettings()]);
      res.json({
        companies,
        hasCredentials: !!(main?.instanceId && main?.apiToken),
        waEnabled: main?.enabled ?? false,
      });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  app.patch(
    "/api/git/transfer-wa-settings/:companyId",
    requireAuth,
    requireRole("Admin", "Developer", "Owner"),
    validateRequest(transferWaSettingsInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = parseInt(req.params.companyId, 10);
        if (isNaN(companyId)) return res.status(400).json({ message: "Invalid companyId" });
        const { groupChatId = "" } = req.body;
        const { setCompanyTransferWaGroupChatId } = await import("../../services/whatsappService");
        await setCompanyTransferWaGroupChatId(companyId, String(groupChatId));
        res.json({ ok: true });
      } catch (err: unknown) {
        res.status(500).json({ message: getErrorMessage(err) });
      }
    }
  );

  // ── Agent Duty WhatsApp Settings ─────────────────────────────────────────────

  app.get("/api/git/agent-duty-wa-settings", requireAuth, async (_req: Request, res: Response) => {
    try {
      const { getAgentDutyWaCredentials, getWaSettings } = await import("../../services/whatsappService");
      const [settings, main] = await Promise.all([getAgentDutyWaCredentials(), getWaSettings()]);
      res.json({
        groups: settings?.groups ?? {},
        hasCredentials: !!(main?.instanceId && main?.apiToken),
        waEnabled: main?.enabled ?? false,
      });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  app.patch(
    "/api/git/agent-duty-wa-settings",
    requireAuth,
    requireRole("Admin", "Developer", "Owner"),
    validateRequest(agentDutyWaSettingsInput),
    async (req: Request, res: Response) => {
      try {
        const { groups = {} } = req.body;
        const { updateAgentDutyWaGroups } = await import("../../services/whatsappService");
        await updateAgentDutyWaGroups(groups);
        res.json({ ok: true });
      } catch (err: unknown) {
        res.status(500).json({ message: getErrorMessage(err) });
      }
    }
  );

  app.post(
    "/api/git/send-agent-duty-whatsapp",
    requireAuth,
    requireRole("Admin", "Developer", "Owner"),
    agentDutyImageUpload.single("image"),
    validateRequest(sendAgentDutyWhatsappInput),
    async (req: Request, res: Response) => {
      try {
        const { imageBase64, agentName, fileName } = req.body ?? {};
        if ((!req.file && !imageBase64) || !agentName) {
          return res.status(400).json({ message: "imageBase64 and agentName are required." });
        }
        const { getAgentDutyWaCredentials, sendWhatsAppFileToChatId } = await import("../../services/whatsappService");
        const settings = await getAgentDutyWaCredentials();
        if (!settings) return res.status(400).json({ message: "WhatsApp not configured." });
        const groupChatId = settings.groups[agentName] ?? settings.groups[agentName.toLowerCase()] ?? null;
        if (!groupChatId) {
          return res.status(400).json({
            message: `No WhatsApp group configured for agent "${agentName}". Configure it in Settings → Agent Duty WA.`,
          });
        }
        if (!settings.instanceId || !settings.apiToken) {
          return res.status(400).json({ message: "WhatsApp credentials not configured." });
        }
        if (!settings.enabled) {
          return res.status(400).json({ message: "WhatsApp sending is disabled." });
        }

        let buffer: Buffer;
        let mimeType: "image/jpeg" | "image/png" = "image/png";

        if (req.file) {
          const uploadedMime = String(req.file.mimetype || "").toLowerCase();
          if (uploadedMime !== "image/jpeg" && uploadedMime !== "image/png") {
            return res.status(400).json({ message: INVALID_IMAGE_PAYLOAD });
          }
          mimeType = uploadedMime;
          buffer = req.file.buffer;
        } else {
          const dataUrl = String(imageBase64);
          const match = dataUrl.match(/^data:(image\/(?:jpeg|jpg|png));base64,([A-Za-z0-9+/=]+)$/);
          if (!match) {
            return res.status(400).json({ message: INVALID_IMAGE_PAYLOAD });
          }
          mimeType = match[1] === "image/png" ? "image/png" : "image/jpeg";
          buffer = Buffer.from(match[2], "base64");
        }

        if (buffer.length === 0) {
          return res.status(400).json({ message: "Image payload is empty." });
        }

        const today = new Date().toISOString().substring(0, 10);
        const ext = mimeType === "image/jpeg" ? "jpg" : "png";
        const fallbackName = `AgentDuty_${agentName}_${today}.${ext}`;
        let finalFileName = String(fileName || req.file?.originalname || fallbackName);
        if (!finalFileName.toLowerCase().match(new RegExp(`\\.(?:${ext}|jpeg)$`))) {
          finalFileName = finalFileName.replace(/\.[^.]+$/, "") + `.${ext}`;
        }
        const caption = "";
        const result = await sendWhatsAppFileToChatId(groupChatId, buffer, finalFileName, caption, mimeType);
        if (!result.success) return res.status(500).json({ message: result.error || "Failed to send" });
        res.json({ ok: true, message: `Sent to WhatsApp group for ${agentName}.` });
      } catch (err: unknown) {
        logger.error("[AgentDutyWA] send error:", { error: err });
        res.status(500).json({ message: getErrorMessage(err) });
      }
    }
  );

  // ── Containers WhatsApp Settings ────────────────────────────────────────────

  app.get("/api/git/containers-wa-settings", requireAuth, async (req: Request, res: Response) => {
    try {
      const { getContainersWaSettings, getWaSettings } = await import("../../services/whatsappService");
      const [settings, main] = await Promise.all([getContainersWaSettings(), getWaSettings()]);
      res.json({
        groupChatId: settings?.groupChatId ?? "",
        scheduleEnabled: settings?.scheduleEnabled ?? false,
        scheduleHour: settings?.scheduleHour ?? 8,
        lastSentAt: settings?.lastSentAt ?? null,
        hasCredentials: !!(main?.instanceId && main?.apiToken),
        waEnabled: main?.enabled ?? false,
      });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  app.patch(
    "/api/git/containers-wa-settings",
    requireAuth,
    requireRole("Admin", "Developer", "Owner"),
    validateRequest(containersWaSettingsInput),
    async (req: Request, res: Response) => {
      try {
        const { groupChatId = "", scheduleEnabled = false, scheduleHour = 8 } = req.body;
        const { updateContainersWaSettings } = await import("../../services/whatsappService");
        await updateContainersWaSettings(String(groupChatId), Boolean(scheduleEnabled), Number(scheduleHour));
        res.json({ ok: true });
      } catch (err: unknown) {
        res.status(500).json({ message: getErrorMessage(err) });
      }
    }
  );

  // ── Send containers table to WhatsApp ───────────────────────────────────────

  app.post(
    "/api/git/send-containers-whatsapp",
    requireAuth,
    requireRole("Admin", "Developer", "Owner"),
    validateRequest(sendContainersWhatsappInput),
    async (req: Request, res: Response) => {
      try {
        const { imageBase64, fileName } = req.body ?? {};
        const { getContainersWaSettings, sendWhatsAppFileToChatId } = await import("../../services/whatsappService");
        const settings = await getContainersWaSettings();

        if (!settings?.groupChatId) {
          return res
            .status(400)
            .json({ message: "No WhatsApp group configured. Go to Settings → Containers WhatsApp to configure it." });
        }
        if (!settings.instanceId || !settings.apiToken) {
          return res.status(400).json({ message: "WhatsApp credentials not configured." });
        }
        if (!settings.enabled) {
          return res.status(400).json({ message: "WhatsApp sending is disabled." });
        }

        let buffer: Buffer;
        let finalFileName: string;
        let mimeType: string;
        const today = new Date().toISOString().substring(0, 10);

        if (imageBase64) {
          const dataUrlStr = String(imageBase64);

          // Require a well-formed data URL with a supported image MIME type.
          const mimeMatch = dataUrlStr.match(/^data:(image\/(?:jpeg|jpg|png));base64,([A-Za-z0-9+/=]+)$/);
          if (!mimeMatch) {
            return res.status(400).json({ message: INVALID_IMAGE_PAYLOAD });
          }

          const detectedMime = mimeMatch[1].toLowerCase();
          const base64Data = mimeMatch[2];

          if (!base64Data) {
            return res.status(400).json({ message: "Image payload is empty." });
          }

          const isJpeg = detectedMime === "image/jpeg" || detectedMime === "image/jpg";
          mimeType = isJpeg ? "image/jpeg" : "image/png";
          const ext = isJpeg ? "jpg" : "png";

          buffer = Buffer.from(base64Data, "base64");

          if (buffer.length === 0) {
            return res.status(400).json({ message: "Decoded image buffer is empty." });
          }

          // Server-side size guard: reject decoded images above 2 MB.
          if (buffer.length > 2 * 1024 * 1024) {
            return res.status(413).json({
              message: "WhatsApp image is too large. Maximum allowed decoded image size is 2 MB.",
            });
          }

          // Use caller-supplied filename if provided, normalised to the correct extension.
          const supplied = String(fileName || "").trim();
          finalFileName = supplied || `Containers_${today}.${ext}`;
          if (!finalFileName.toLowerCase().endsWith(`.${ext}`)) {
            finalFileName = finalFileName.replace(/\.[^.]+$/, "") + `.${ext}`;
          }
        } else {
          const { generateContainersPdf } = await import("../../helpers/generateContainersPdf");
          const pdf = await generateContainersPdf();
          buffer = pdf.buffer;
          finalFileName = `Containers_${today}.pdf`;
          mimeType = "application/pdf";
        }

        const caption = "";
        const result = await sendWhatsAppFileToChatId(settings.groupChatId, buffer, finalFileName, caption, mimeType);
        if (!result.success) {
          return res.status(500).json({ message: result.error || "Failed to send" });
        }
        res.json({ ok: true, message: "Sent to WhatsApp group." });
      } catch (err: unknown) {
        logger.error("[ContainersWA] send error:", { error: err });
        res.status(500).json({ message: getErrorMessage(err) });
      }
    }
  );
}
