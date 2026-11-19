// Extracted from ./whatsappService.ts
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import FormDataLib from "form-data";
import {
  getExportAttachmentSize,
  withSerializedExportAttachmentBuffer,
  type ExportAttachmentSource,
} from "../helpers/exportAttachmentSource";
import { getWaSettings, getWaSettingsById, getActiveRecipients } from "./whatsappSettingsStore";
import type { WaSettings } from "./whatsappSettingsStore";
import { greenApiRequestInit, baseUrl, uploadGreenApiWithAuthFallback } from "./whatsappGreenApiTransport";

export type WhatsAppDeliveryOutcome = "sent" | "failed" | "uncertain";

export interface WhatsAppSendResult {
  success: boolean;
  error?: string;
  deliveryOutcome?: WhatsAppDeliveryOutcome;
}

/**
 * Single shared implementation for Green API sendFileByUpload.
 * Uses the `form-data` npm package (not native Web FormData / Blob).
 * form.getBuffer() + form.getHeaders() is the correct pattern for node-fetch
 * and produces well-formed multipart/form-data that Green API accepts.
 *
 * NOTE: Native Web FormData + File was tried but silently fails with Green API
 * because the boundary isn't propagated to the Content-Type header when using
 * native fetch + native FormData in Node 20 — resulting in a malformed upload
 * that Green API rejects, causing the text fallback to fire instead of the image.
 */
export async function sendGreenApiFileUpload({
  settings,
  chatId,
  buffer,
  fileName,
  caption,
  mimeType,
}: {
  settings: WaSettings;
  chatId: string;
  buffer: ExportAttachmentSource;
  fileName: string;
  caption: string;
  mimeType: string;
}): Promise<WhatsAppSendResult> {
  const sizeBytes = getExportAttachmentSize(buffer);

  return withSerializedExportAttachmentBuffer(buffer, async (materializedBuffer) => {
    // Green API still requires form-data#getBuffer(). Only the active upload
    // materializes the file-backed export; queued retries keep the reusable
    // source on disk and cannot create several multipart bodies concurrently.
    const form = new FormDataLib();
    form.append("chatId", chatId);
    if (caption) form.append("caption", caption);
    form.append("file", materializedBuffer, { filename: fileName, contentType: mimeType });

    const multipartBody = form.getBuffer();
    let response: Response;
    try {
      response = await uploadGreenApiWithAuthFallback(settings, multipartBody, form.getHeaders());
    } catch (error) {
      const message = getErrorMessage(error) || "Green API request outcome is uncertain";
      logger.error("[WA upload] Green API request outcome uncertain", {
        error: message,
        chatId,
        fileName,
        size: sizeBytes,
      });
      return { success: false, error: message, deliveryOutcome: "uncertain" };
    }

    if (!response.ok) {
      const body = await response.text();
      logger.error("[WA upload] Green API error", {
        status: response.status,
        body,
        chatId,
        fileName,
        size: sizeBytes,
      });
      return { success: false, error: `Green API ${response.status}: ${body}`, deliveryOutcome: "failed" };
    }

    const json = (await response.json().catch(() => ({}))) as unknown;
    logger.info("[WA upload] Green API response", {
      response: json,
      chatId,
      fileName,
      size: sizeBytes,
    });
    return { success: true, deliveryOutcome: "sent" };
  });
}

interface SendResult {
  chatId: string;
  success: boolean;
  error?: string;
}

/** Resolve the active WhatsApp settings for POS sending: use instance 2 if configured, else instance 1.
 *  When falling back to instance 1 we override enabled=true because POS sends are always manual —
 *  the main instance's enabled flag controls scheduled factory reports, not POS. */
export async function getPosWaSettings(): Promise<WaSettings | null> {
  const pos = await getWaSettingsById(2);
  if (pos?.instanceId && pos?.apiToken) return pos;
  const main = await getWaSettingsById(1);
  if (main?.instanceId && main?.apiToken) return { ...main, enabled: true };
  return null;
}

/**
 * Send a Stock Transfer Order approval request using precisely the configured
 * main instance. Unlike generic text sending, do NOT fall back to an alternate
 * WhatsApp account: Phase 3 must correlate the reply to this exact instance.
 * A transport failure is ambiguous and must never be automatically retried.
 */
export async function sendStockTransferOrderApprovalRequest(
  chatId: string,
  message: string
): Promise<{ outcome: "accepted" | "failed" | "uncertain"; instanceId: string; idMessage?: string; error?: string }> {
  const wa = await getWaSettings();
  if (!wa?.enabled || !wa.instanceId || !wa.apiToken) {
    return { outcome: "failed", instanceId: "", error: "The main WhatsApp instance is not enabled." };
  }
  if (!/^\d{5,25}@g\.us$/.test(chatId) || !message || message.length > 19_000) {
    return { outcome: "failed", instanceId: wa.instanceId, error: "Approval group or message is invalid." };
  }
  let response: Response;
  try {
    response = await fetch(
      baseUrl(wa.instanceId, wa.apiToken, "sendMessage"),
      greenApiRequestInit({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId, message }),
      })
    );
  } catch (error) {
    logger.error("[STO WhatsApp] Approval request outcome uncertain", { error: getErrorMessage(error) });
    return {
      outcome: "uncertain",
      instanceId: wa.instanceId,
      error: "Network outcome unknown; check WhatsApp before creating another request.",
    };
  }
  if (!response.ok) {
    logger.warn("[STO WhatsApp] Approval request rejected", { status: response.status });
    return {
      outcome: "failed",
      instanceId: wa.instanceId,
      error: `WhatsApp rejected the request (HTTP ${response.status}).`,
    };
  }
  const body = (await response.json().catch(() => null)) as { idMessage?: unknown } | null;
  if (typeof body?.idMessage !== "string" || !body.idMessage.trim()) {
    return {
      outcome: "uncertain",
      instanceId: wa.instanceId,
      error: "WhatsApp accepted the request but its message ID is unavailable.",
    };
  }
  return { outcome: "accepted", instanceId: wa.instanceId, idMessage: body.idMessage.trim() };
}

/**
 * Send a file to ALL active recipients via the main WhatsApp instance (id=1).
 * Uses the shared sendGreenApiFileUpload helper (form-data package).
 */
export async function sendWhatsAppFile(
  buffer: Buffer,
  fileName: string,
  caption: string
): Promise<{ success: boolean; sent: number; failed: number; errors: string[] }> {
  const settings = await getWaSettings();
  if (!settings?.instanceId || !settings?.apiToken) {
    return { success: false, sent: 0, failed: 0, errors: ["WhatsApp credentials not configured"] };
  }
  if (!settings.enabled) {
    return { success: false, sent: 0, failed: 0, errors: ["WhatsApp sending is disabled"] };
  }

  const recipients = await getActiveRecipients();
  if (!recipients.length) {
    return { success: false, sent: 0, failed: 0, errors: ["No active WhatsApp recipients"] };
  }

  const results = await Promise.allSettled(
    recipients.map(async (r): Promise<SendResult> => {
      const res = await sendGreenApiFileUpload({
        settings,
        chatId: r.chatId,
        buffer,
        fileName,
        caption,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      if (!res.success) throw new Error(res.error ?? "Upload failed");
      return { chatId: r.chatId, success: true };
    })
  );

  let sent = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const r of results) {
    if (r.status === "fulfilled") {
      sent++;
    } else {
      failed++;
      errors.push((r as PromiseRejectedResult).reason?.message ?? "Unknown error");
      logger.error("[WhatsApp] Send failed:", (r as PromiseRejectedResult).reason);
    }
  }

  return { success: sent > 0, sent, failed, errors };
}
