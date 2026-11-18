// Extracted from ./whatsappFastSendRoutes.ts to keep that module under the source-size cap.
import type { Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { logger } from "../lib/logger";
import { getPosWaSettings, getWaSettingsById, sendWhatsAppFileByUploadPos } from "../services/whatsappService";
import { userCompanyRoles } from "@shared/schema";
import {
  fastAttachments,
  formatGreenApiFailure,
  isGreenApiQuotaFailure,
  resolvePublicBaseUrl,
  sendFileByUrlAttempt,
} from "./whatsappFastSendRoutesSendFileByUrlAttempt";

export async function sendBufferFast(
  req: Request,
  chatId: string,
  buffer: Buffer,
  fileName: string,
  caption: string,
  contentType = "application/pdf"
): Promise<{ success: boolean; error?: string; mode: "url" | "upload" }> {
  const publicBaseUrl = resolvePublicBaseUrl(req);
  const settings = await getPosWaSettings();
  if (!settings?.instanceId || !settings?.apiToken) {
    return { success: false, error: "WhatsApp credentials not configured", mode: "upload" };
  }
  if (!settings.enabled) {
    return { success: false, error: "WhatsApp sending is disabled", mode: "upload" };
  }

  // Prefer multipart upload because Green API receives the actual file bytes in
  // the same request. The URL fast path only means "queued" and may fetch the
  // temporary file much later, which previously produced false-success results
  // when the capability URL had already expired.
  const uploadPrimary = await sendWhatsAppFileByUploadPos(chatId, buffer, fileName, caption, contentType);
  if (uploadPrimary.success) {
    logger.info("[WA fast send] Green API accepted direct upload", {
      chatId,
      fileName,
      instanceId: settings.instanceId,
      size: buffer.length,
    });
    return { success: true, mode: "upload" };
  }

  logger.warn("[WA fast send] Direct upload failed; trying URL fallback", {
    chatId,
    fileName,
    instanceId: settings.instanceId,
    uploadError: uploadPrimary.error,
  });

  if (!publicBaseUrl) {
    return {
      success: false,
      error: uploadPrimary.error || "WhatsApp direct upload failed and no public fallback URL is available",
      mode: "upload",
    };
  }

  const primaryAttempt = await sendFileByUrlAttempt({
    publicBaseUrl,
    settings,
    chatId,
    buffer,
    fileName,
    caption,
    contentType,
  });
  if (primaryAttempt.success) return { success: true, mode: "url" };

  logger.warn("[WA fast send] URL fallback rejected", {
    chatId,
    fileName,
    instanceId: settings.instanceId,
    status: primaryAttempt.status,
    quotaFailure: isGreenApiQuotaFailure(primaryAttempt.status, primaryAttempt.body),
  });

  // Green API's Developer plan can return HTTP 466 when the active instance has
  // exhausted its allowed correspondents. If a second ERP WhatsApp instance is
  // configured, try it immediately before giving up.
  if (isGreenApiQuotaFailure(primaryAttempt.status, primaryAttempt.body)) {
    const [mainSettings, posSettings] = await Promise.all([getWaSettingsById(1), getWaSettingsById(2)]);
    const alternate = [mainSettings, posSettings].find(
      (candidate) =>
        !!candidate?.instanceId &&
        !!candidate?.apiToken &&
        candidate.instanceId !== settings.instanceId &&
        candidate.apiToken !== settings.apiToken
    );

    if (alternate?.instanceId && alternate.apiToken) {
      const alternateAttempt = await sendFileByUrlAttempt({
        publicBaseUrl,
        settings: alternate,
        chatId,
        buffer,
        fileName,
        caption,
        contentType,
      });
      if (alternateAttempt.success) {
        logger.warn("[WA fast send] Queued URL fallback through alternate WhatsApp instance", {
          chatId,
          fileName,
          primaryInstanceId: settings.instanceId,
          alternateInstanceId: alternate.instanceId,
        });
        return { success: true, mode: "url" };
      }
    }
  }

  return {
    success: false,
    error: formatGreenApiFailure(primaryAttempt, uploadPrimary.error),
    mode: "url",
  };
}

export function serveFastAttachment(req: Request, res: Response): void {
  const entry = fastAttachments.get(req.params.token);
  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) fastAttachments.delete(req.params.token);
    logger.warn("[WA fast send] Provider requested an expired or missing attachment", {
      method: req.method,
      tokenPrefix: req.params.token?.slice(0, 8),
    });
    res.status(404).end();
    return;
  }

  res.setHeader("Content-Type", entry.contentType);
  res.setHeader("Content-Length", String(entry.buffer.length));
  res.setHeader("Content-Disposition", `inline; filename="${entry.fileName.replace(/[\r\n"]/g, "_")}"`);
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  logger.info("[WA fast send] Provider fetched queued attachment", {
    method: req.method,
    fileName: entry.fileName,
    size: entry.buffer.length,
    tokenPrefix: req.params.token?.slice(0, 8),
  });
  if (req.method === "HEAD") {
    res.status(200).end();
    return;
  }
  res.status(200).send(entry.buffer);
}

export async function resolvePosLocationId(req: Request, companyId: number): Promise<number | null> {
  const requested = Number(req.body?.locationId);
  if (Number.isInteger(requested) && requested > 0) return requested;

  const userId = req.session.userId;
  if (!userId) return null;
  const [role] = await db
    .select({ assignedLocationId: userCompanyRoles.assignedLocationId })
    .from(userCompanyRoles)
    .where(and(eq(userCompanyRoles.userId, userId), eq(userCompanyRoles.companyId, companyId)))
    .limit(1);
  return role?.assignedLocationId ?? null;
}
