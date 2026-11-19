/**
 * Green API (free tier) WhatsApp service.
 * Supports individual numbers and group chats.
 *
 * Chat ID formats:
 *   Individual : 243XXXXXXXXX@c.us   (country code + number, no +)
 *   Group      : 120363XXXX@g.us     (obtained from Green API getChats)
 */

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
import {
  greenApiRequestInit,
  baseUrl,
  fetchGreenApiWithAuthFallback,
  requestGreenApiUpload,
  uploadGreenApiWithAuthFallback,
} from "./whatsappGreenApiTransport";
export {
  getGreenInstanceState,
  getStrictGreenMainInstanceState,
  getStrictGreenMainWebhookReadiness,
  fetchStrictGreenMainChats,
  fetchGreenApiChats,
} from "./whatsappGreenApiInstance";
export type {
  GreenChat,
  GreenInstanceState,
  GreenMainInstanceState,
  StoWaMainWebhookReadiness,
} from "./whatsappGreenApiInstance";
export { getGreenApiHost } from "./whatsappGreenApiTransport";
export { normaliseChatId, getWaSettings, getWaSettingsById, getActiveRecipients } from "./whatsappSettingsStore";
export type { WaSettings, WaRecipient } from "./whatsappSettingsStore";

export * from "./whatsappGroupSettings";

export type WhatsAppDeliveryOutcome = "sent" | "failed" | "uncertain";
export interface WhatsAppSendResult {
  success: boolean;
  error?: string;
  deliveryOutcome?: WhatsAppDeliveryOutcome;
}

// ─── Shared upload helper (form-data package — the only reliable method) ──────

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
async function sendGreenApiFileUpload({
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

// ─── Send file ────────────────────────────────────────────────────────────────

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
 * Phase 5: send ONE approved cost-free Stock Transfer Order workbook through
 * the SAME main GREEN API instance that sent the approval request.
 *
 * Never fall back to another instance and NEVER retry an ambiguous POST.
 * Provider success is only "accepted by GREEN API", not proof of delivery to
 * a human WhatsApp client. The immutable delivery ledger owns retries.
 */
export async function sendApprovedStockTransferOrderWorkbook(
  expectedInstanceId: string,
  chatId: string,
  workbook: Buffer,
  filename: string,
  caption: string
): Promise<{
  outcome: "accepted" | "failed" | "uncertain";
  idMessage?: string;
  error?: string;
}> {
  const settings = await getWaSettings();
  if (!settings?.enabled || !settings.instanceId || !settings.apiToken || settings.instanceId !== expectedInstanceId) {
    return { outcome: "failed", error: "Original approval WhatsApp instance is no longer configured." };
  }
  if (
    !/^[0-9]{5,25}@(g[.]us|c[.]us)$/.test(chatId) ||
    !Buffer.isBuffer(workbook) ||
    !workbook.length ||
    workbook.length > 15 * 1024 * 1024 ||
    !/^[A-Za-z0-9_.-]{1,200}[.]xlsx$/.test(filename) ||
    caption.length > 900
  ) {
    return { outcome: "failed", error: "Invalid approved workbook or WhatsApp recipient." };
  }
  const form = new FormDataLib();
  form.append("chatId", chatId);
  form.append("caption", caption);
  form.append("file", workbook, {
    filename,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  let response: Response;
  try {
    response = await requestGreenApiUpload(settings, form.getBuffer(), form.getHeaders());
  } catch (error) {
    logger.warn("[STO WA] Approved Excel upload outcome uncertain", {
      chatId,
      fileSize: workbook.length,
      error: getErrorMessage(error),
    });
    return { outcome: "uncertain", error: "Upload timed out or connection failed; check WhatsApp before retrying." };
  }
  if (!response.ok) {
    // A 5xx or rate-limit response might be returned after acceptance. Never
    // automatically retry such an ambiguous provider response.
    if (response.status >= 500 || response.status === 429 || response.status === 408) {
      return {
        outcome: "uncertain",
        error: "GREEN API returned an ambiguous upload response (" + response.status + ").",
      };
    }
    return { outcome: "failed", error: "GREEN API rejected the upload (HTTP " + response.status + ")." };
  }
  const body = (await response.json().catch(() => null)) as { idMessage?: unknown } | null;
  if (typeof body?.idMessage !== "string" || !/^[A-Za-z0-9_.:-]{6,160}$/.test(body.idMessage)) {
    return { outcome: "uncertain", error: "GREEN API accepted the file but did not return a usable message ID." };
  }
  return { outcome: "accepted", idMessage: body.idMessage };
}

/** Send a plain text message to one specific chatId */
export async function sendWhatsAppTextToChatId(
  chatId: string,
  message: string
): Promise<{ success: boolean; error?: string }> {
  const settings = await getWaSettings();
  if (!settings?.instanceId || !settings?.apiToken) {
    return { success: false, error: "WhatsApp credentials not configured" };
  }
  if (!settings.enabled) {
    return { success: false, error: "WhatsApp sending is disabled" };
  }

  const response = await fetchGreenApiWithAuthFallback(settings, "sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId, message }),
  });
  if (!response.ok) {
    const body = await response.text();
    return { success: false, error: `Green API ${response.status}: ${body}` };
  }
  return { success: true };
}

/**
 * Send a file directly to a WhatsApp chat via Green API's sendFileByUpload.
 * POS instance (id=2 with fallback to id=1).
 * Uses the shared sendGreenApiFileUpload helper (form-data package).
 */
export async function sendWhatsAppFileByUploadPos(
  chatId: string,
  fileBuffer: Buffer,
  fileName: string,
  caption: string,
  mimeType: string = "application/pdf"
): Promise<{ success: boolean; error?: string }> {
  const settings = await getPosWaSettings();
  if (!settings?.instanceId || !settings?.apiToken) {
    return { success: false, error: "WhatsApp credentials not configured" };
  }
  if (!settings.enabled) {
    return { success: false, error: "WhatsApp sending is disabled" };
  }
  return sendGreenApiFileUpload({ settings, chatId, buffer: fileBuffer, fileName, caption, mimeType });
}

/** Send a plain text message via the POS instance (id=2 with fallback to id=1) */
export async function sendWhatsAppTextToChatIdPos(
  chatId: string,
  message: string
): Promise<{ success: boolean; error?: string }> {
  const settings = await getPosWaSettings();
  if (!settings?.instanceId || !settings?.apiToken) {
    return { success: false, error: "WhatsApp credentials not configured" };
  }
  if (!settings.enabled) {
    return { success: false, error: "WhatsApp sending is disabled" };
  }

  const response = await fetchGreenApiWithAuthFallback(settings, "sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId, message }),
  });
  if (!response.ok) {
    const body = await response.text();
    return { success: false, error: `Green API ${response.status}: ${body}` };
  }
  return { success: true };
}

/** Send a plain text message to ALL active recipients */
export async function sendWhatsAppText(
  message: string
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

  let sent = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const r of recipients) {
    try {
      const response = await fetchGreenApiWithAuthFallback(settings, "sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: r.chatId, message }),
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Green API ${response.status}: ${body}`);
      }
      sent++;
    } catch (e: unknown) {
      failed++;
      errors.push(getErrorMessage(e) ?? "Unknown error");
      logger.error("[WhatsApp] Text send failed:", { error: e });
    }
  }

  return { success: sent > 0, sent, failed, errors };
}

/**
 * Send a file via the POS WhatsApp instance (id=2 with fallback to id=1).
 * Uses the shared sendGreenApiFileUpload helper (form-data package).
 */
export async function sendWhatsAppFileToChatIdPos(
  chatId: string,
  buffer: Buffer,
  fileName: string,
  caption: string,
  mimeType = "application/pdf"
): Promise<{ success: boolean; error?: string }> {
  const settings = await getPosWaSettings();
  if (!settings?.instanceId || !settings?.apiToken) {
    return { success: false, error: "WhatsApp credentials not configured" };
  }
  if (!settings.enabled) {
    return { success: false, error: "WhatsApp sending is disabled" };
  }
  return sendGreenApiFileUpload({ settings, chatId, buffer, fileName, caption, mimeType });
}

/**
 * Send a file to a specific chatId via the main WhatsApp instance (id=1).
 * Uses the shared sendGreenApiFileUpload helper (form-data package).
 */
export async function sendWhatsAppFileToChatId(
  chatId: string,
  buffer: ExportAttachmentSource,
  fileName: string,
  caption: string,
  mimeType = "application/octet-stream"
): Promise<WhatsAppSendResult> {
  const settings = await getWaSettings();
  if (!settings?.instanceId || !settings?.apiToken) {
    return { success: false, error: "WhatsApp credentials not configured" };
  }
  if (!settings.enabled) {
    return { success: false, error: "WhatsApp sending is disabled" };
  }
  return sendGreenApiFileUpload({ settings, chatId, buffer, fileName, caption, mimeType });
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
