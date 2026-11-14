/** Shared WhatsApp text and workbook delivery API. */
import FormDataLib from "form-data";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import type { ExportAttachmentSource } from "../helpers/exportAttachmentSource";
import {
  greenApiRequestInit,
  baseUrl,
  fetchGreenApiWithAuthFallback,
  requestGreenApiUpload,
  getWaSettings,
  getWaSettingsById,
  getActiveRecipients,
  type WaSettings,
  type WhatsAppSendResult,
} from "./whatsappGreenApiCore";
import { sendGreenApiFileUpload } from "./whatsappGreenApiUpload";

export * from "./whatsappGreenApiCore";
export * from "./whatsappContainerSettings";

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
  message: string,
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
    response = await fetch(baseUrl(wa.instanceId, wa.apiToken, "sendMessage"), greenApiRequestInit({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, message }),
    }));
  } catch (error) {
    logger.error("[STO WhatsApp] Approval request outcome uncertain", { error: getErrorMessage(error) });
    return { outcome: "uncertain", instanceId: wa.instanceId, error: "Network outcome unknown; check WhatsApp before creating another request." };
  }
  if (!response.ok) {
    logger.warn("[STO WhatsApp] Approval request rejected", { status: response.status });
    return { outcome: "failed", instanceId: wa.instanceId, error: `WhatsApp rejected the request (HTTP ${response.status}).` };
  }
  const body = (await response.json().catch(() => null)) as { idMessage?: unknown } | null;
  if (typeof body?.idMessage !== "string" || !body.idMessage.trim()) {
    return { outcome: "uncertain", instanceId: wa.instanceId, error: "WhatsApp accepted the request but its message ID is unavailable." };
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
  if (!settings?.enabled || !settings.instanceId || !settings.apiToken ||
      settings.instanceId !== expectedInstanceId) {
    return { outcome: "failed", error: "Original approval WhatsApp instance is no longer configured." };
  }
  if (!/^[0-9]{5,25}@(g[.]us|c[.]us)$/.test(chatId) ||
      !Buffer.isBuffer(workbook) || !workbook.length || workbook.length > 15 * 1024 * 1024 ||
      !/^[A-Za-z0-9_.-]{1,200}[.]xlsx$/.test(filename) || caption.length > 900) {
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
      chatId, fileSize: workbook.length, error: getErrorMessage(error),
    });
    return { outcome: "uncertain", error: "Upload timed out or connection failed; check WhatsApp before retrying." };
  }
  if (!response.ok) {
    // A 5xx or rate-limit response might be returned after acceptance. Never
    // automatically retry such an ambiguous provider response.
    if (response.status >= 500 || response.status === 429 || response.status === 408) {
      return { outcome: "uncertain", error: "GREEN API returned an ambiguous upload response (" + response.status + ")." };
    }
    return { outcome: "failed", error: "GREEN API rejected the upload (HTTP " + response.status + ")." };
  }
  const body = await response.json().catch(() => null) as { idMessage?: unknown } | null;
  if (typeof body?.idMessage !== "string" ||
      !/^[A-Za-z0-9_.:-]{6,160}$/.test(body.idMessage)) {
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

// ─── Containers WhatsApp settings ────────────────────────────────────────────
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
