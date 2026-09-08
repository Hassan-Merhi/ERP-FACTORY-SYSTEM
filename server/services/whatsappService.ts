import { toArrayBuffer } from "../lib/bufferCompatibility";
/**
 * Green API (free tier) WhatsApp service.
 * Supports individual numbers and group chats.
 *
 * Chat ID formats:
 *   Individual : 243XXXXXXXXX@c.us   (country code + number, no +)
 *   Group      : 120363XXXX@g.us     (obtained from Green API getChats)
 */

import { pool } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import FormDataLib from "form-data";
import {
  getExportAttachmentSize,
  withSerializedExportAttachmentBuffer,
  type ExportAttachmentSource,
} from "../helpers/exportAttachmentSource";

export interface WaSettings {
  instanceId: string;
  apiToken: string;
  enabled: boolean;
  monthlyAutoSend: boolean;
  dailyAutoSend: boolean;
  dailyRecipientId: number | null;
}

export interface WaRecipient {
  id: number;
  chatId: string;
  name: string;
  isGroup: boolean;
  active: boolean;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

type GreenApiCredentials = Pick<WaSettings, "instanceId" | "apiToken">;

function cleanGreenApiCredential(value: unknown): string {
  // Green API puts both values directly in the request URL. Copy/paste can add
  // spaces, line breaks, BOMs or zero-width characters, all of which turn an
  // otherwise-valid credential into a provider-side 401.
  return String(value ?? "").replace(/[\s\u200B-\u200D\uFEFF]+/g, "");
}

function baseUrl(instanceId: string, apiToken: string, method: string): string {
  const cleanInstanceId = cleanGreenApiCredential(instanceId);
  const cleanApiToken = cleanGreenApiCredential(apiToken);
  return `https://api.green-api.com/waInstance${cleanInstanceId}/${method}/${cleanApiToken}`;
}

async function getGreenApiAuthFallback(current: GreenApiCredentials): Promise<GreenApiCredentials | null> {
  const currentInstanceId = cleanGreenApiCredential(current.instanceId);
  const currentApiToken = cleanGreenApiCredential(current.apiToken);
  const [main, pos] = await Promise.all([getWaSettingsById(1), getWaSettingsById(2)]);

  const alternate = [main, pos].find((candidate) => {
    if (!candidate?.enabled || !candidate.instanceId || !candidate.apiToken) return false;
    return candidate.instanceId !== currentInstanceId || candidate.apiToken !== currentApiToken;
  });

  return alternate ? { instanceId: alternate.instanceId, apiToken: alternate.apiToken } : null;
}

async function fetchGreenApiWithAuthFallback(
  credentials: GreenApiCredentials,
  method: string,
  init: RequestInit
): Promise<Response> {
  const primaryInstanceId = cleanGreenApiCredential(credentials.instanceId);
  const primaryApiToken = cleanGreenApiCredential(credentials.apiToken);
  const primary = await fetch(baseUrl(primaryInstanceId, primaryApiToken, method), init);
  if (primary.status !== 401) return primary;

  const alternate = await getGreenApiAuthFallback({ instanceId: primaryInstanceId, apiToken: primaryApiToken });
  if (!alternate) return primary;

  logger.warn("[WhatsApp] Green API rejected primary credentials; retrying configured backup instance", {
    primaryInstanceId,
    fallbackInstanceId: alternate.instanceId,
    method,
  });

  const fallback = await fetch(baseUrl(alternate.instanceId, alternate.apiToken, method), init);
  if (fallback.ok) {
    logger.warn("[WhatsApp] Green API backup credentials accepted after primary 401", {
      primaryInstanceId,
      fallbackInstanceId: alternate.instanceId,
      method,
    });
  }
  return fallback;
}

/** Normalise a plain phone number to chatId format (243XXXXXXXX → 243XXXXXXXX@c.us) */
export function normaliseChatId(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes("@")) return trimmed; // already formatted (group or individual)
  const digits = trimmed.replace(/\D/g, "");
  return `${digits}@c.us`;
}

// ─── DB reads ─────────────────────────────────────────────────────────────────

export async function getWaSettings(): Promise<WaSettings | null> {
  return getWaSettingsById(1);
}

export async function getWaSettingsById(id: number): Promise<WaSettings | null> {
  const res = await pool.query(
    "SELECT instance_id, api_token, enabled, monthly_auto_send, daily_auto_send, daily_recipient_id FROM whatsapp_settings WHERE id = $1",
    [id]
  );
  if (!res.rows?.length) return null;
  const r = res.rows[0];
  return {
    instanceId: cleanGreenApiCredential(r.instance_id),
    apiToken: cleanGreenApiCredential(r.api_token),
    enabled: r.enabled ?? false,
    monthlyAutoSend: r.monthly_auto_send ?? false,
    dailyAutoSend: r.daily_auto_send ?? false,
    dailyRecipientId: r.daily_recipient_id ?? null,
  };
}

export async function getActiveRecipients(): Promise<WaRecipient[]> {
  const res = await pool.query(
    "SELECT id, chat_id, name, is_group, active FROM whatsapp_recipients WHERE active = true ORDER BY id"
  );
  return (res.rows || []).map((r) => ({
    id: r.id,
    chatId: r.chat_id,
    name: r.name,
    isGroup: r.is_group,
    active: r.active,
  }));
}

// ─── Green API: fetch chats so the user can pick a group ──────────────────────

export interface GreenChat {
  id: string; // e.g. 120363198765432@g.us
  name: string;
  type: "group" | "contact" | string;
}

/** Green API instance states returned by getStateInstance */
export type GreenInstanceState = "authorized" | "notAuthorized" | "sleepMode" | "starting" | "yellowCard" | "unknown";

/**
 * Call Green API's getStateInstance to get the real connection state.
 * Returns "unknown" on any network/parse error.
 */
export async function getGreenInstanceState(instanceId: string, apiToken: string): Promise<GreenInstanceState> {
  try {
    const response = await fetchGreenApiWithAuthFallback(
      { instanceId, apiToken },
      "getStateInstance",
      { method: "GET", signal: AbortSignal.timeout(8000) }
    );
    if (!response.ok) return "unknown";
    const json = await response.json().catch(() => null);
    const state: string = json?.stateInstance ?? "unknown";
    const validStates: GreenInstanceState[] = ["authorized", "notAuthorized", "sleepMode", "starting", "yellowCard"];
    return validStates.includes(state as GreenInstanceState) ? (state as GreenInstanceState) : "unknown";
  } catch {
    return "unknown";
  }
}

export async function fetchGreenApiChats(instanceId: string, apiToken: string): Promise<GreenChat[]> {
  const response = await fetchGreenApiWithAuthFallback({ instanceId, apiToken }, "getChats", { method: "GET" });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Green API getChats error ${response.status}: ${body}`);
  }
  const data = (await response.json()) as any[];
  return data
    .filter((c) => c && c.id)
    .map((c) => ({
      id: c.id,
      name: c.name || c.id,
      type: c.type || (String(c.id).endsWith("@g.us") ? "group" : "contact"),
    }));
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
}): Promise<{ success: boolean; error?: string }> {
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
    const response = await fetchGreenApiWithAuthFallback(
      settings,
      "sendFileByUpload",
      {
        method: "POST",
        body: toArrayBuffer(multipartBody),
        headers: form.getHeaders(),
      }
    );

    if (!response.ok) {
      const body = await response.text();
      logger.error("[WA upload] Green API error", {
        status: response.status,
        body,
        chatId,
        fileName,
        size: sizeBytes,
      });
      return { success: false, error: `Green API ${response.status}: ${body}` };
    }

    const json = (await response.json().catch(() => ({}))) as unknown;
    logger.info("[WA upload] Green API response", {
      response: json,
      chatId,
      fileName,
      size: sizeBytes,
    });
    return { success: true };
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

/** Send a file by URL via the POS instance (id=2 with fallback to id=1).
 *  Uses Green API's sendFileByUrl — more reliable than multipart upload. */
export async function sendWhatsAppFileByUrlToChatIdPos(
  chatId: string,
  fileUrl: string,
  fileName: string,
  caption: string
): Promise<{ success: boolean; error?: string }> {
  const settings = await getPosWaSettings();
  if (!settings?.instanceId || !settings?.apiToken) {
    return { success: false, error: "WhatsApp credentials not configured" };
  }
  if (!settings.enabled) {
    return { success: false, error: "WhatsApp sending is disabled" };
  }

  const response = await fetchGreenApiWithAuthFallback(settings, "sendFileByUrl", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId, urlFile: fileUrl, fileName, caption }),
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
): Promise<{ success: boolean; error?: string }> {
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

export interface ContainersWaSettings {
  groupChatId: string;
  scheduleEnabled: boolean;
  scheduleHour: number;
  lastSentAt: string | null;
  instanceId: string;
  apiToken: string;
  enabled: boolean;
}

export async function getContainersWaSettings(): Promise<ContainersWaSettings | null> {
  const res = await pool.query(
    `SELECT instance_id, api_token, enabled,
            containers_wa_group_chat_id,
            containers_wa_schedule_enabled,
            containers_wa_schedule_hour,
            containers_wa_last_sent_at
     FROM whatsapp_settings WHERE id = 1`
  );
  if (!res.rows?.length) return null;
  const r = res.rows[0];
  return {
    instanceId: cleanGreenApiCredential(r.instance_id),
    apiToken: cleanGreenApiCredential(r.api_token),
    enabled: r.enabled ?? false,
    groupChatId: r.containers_wa_group_chat_id ?? "",
    scheduleEnabled: r.containers_wa_schedule_enabled ?? false,
    scheduleHour: r.containers_wa_schedule_hour ?? 8,
    lastSentAt: r.containers_wa_last_sent_at ? new Date(r.containers_wa_last_sent_at).toISOString() : null,
  };
}

export async function updateContainersWaSettings(
  groupChatId: string,
  scheduleEnabled: boolean,
  scheduleHour: number
): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_settings
     SET containers_wa_group_chat_id      = $1,
         containers_wa_schedule_enabled   = $2,
         containers_wa_schedule_hour      = $3
     WHERE id = 1`,
    [groupChatId, scheduleEnabled, scheduleHour]
  );
}

export async function markContainersWaSent(): Promise<void> {
  await pool.query(`UPDATE whatsapp_settings SET containers_wa_last_sent_at = NOW() WHERE id = 1`);
}

// ─── Agent Duty WhatsApp Settings ────────────────────────────────────────────

export async function getAgentDutyWaGroups(): Promise<Record<string, string>> {
  const res = await pool.query(
    `SELECT instance_id, api_token, enabled, agent_duty_wa_groups FROM whatsapp_settings WHERE id = 1`
  );
  if (!res.rows?.length) return {};
  const r = res.rows[0];
  return {
    groups: r.agent_duty_wa_groups ?? {},
    instanceId: cleanGreenApiCredential(r.instance_id),
    apiToken: cleanGreenApiCredential(r.api_token),
    enabled: r.enabled ?? false,
  } as unknown as Record<string, string>;
}

export async function getAgentDutyWaCredentials(): Promise<{
  groups: Record<string, string>;
  instanceId: string;
  apiToken: string;
  enabled: boolean;
} | null> {
  const res = await pool.query(
    `SELECT instance_id, api_token, enabled, agent_duty_wa_groups FROM whatsapp_settings WHERE id = 1`
  );
  if (!res.rows?.length) return null;
  const r = res.rows[0];
  return {
    groups: r.agent_duty_wa_groups ?? {},
    instanceId: cleanGreenApiCredential(r.instance_id),
    apiToken: cleanGreenApiCredential(r.api_token),
    enabled: r.enabled ?? false,
  };
}

export async function updateAgentDutyWaGroups(groups: Record<string, string>): Promise<void> {
  await pool.query(`UPDATE whatsapp_settings SET agent_duty_wa_groups = $1 WHERE id = 1`, [JSON.stringify(groups)]);
}

// ── Stock Transfer WhatsApp Settings (per-company) ──────────────────────────

export async function getCompanyTransferWaGroupChatId(companyId: number): Promise<string> {
  const res = await pool.query(`SELECT transfer_wa_group_chat_id FROM companies WHERE id = $1`, [companyId]);
  return res.rows[0]?.transfer_wa_group_chat_id ?? "";
}

export async function setCompanyTransferWaGroupChatId(companyId: number, groupChatId: string): Promise<void> {
  await pool.query(`UPDATE companies SET transfer_wa_group_chat_id = $1 WHERE id = $2`, [
    groupChatId || null,
    companyId,
  ]);
}

export async function getAllCompanyTransferWaSettings(): Promise<
  Array<{ companyId: number; companyName: string; groupChatId: string }>
> {
  const res = await pool.query(
    `SELECT id, name, COALESCE(transfer_wa_group_chat_id, '') AS group_chat_id
     FROM companies WHERE active = true ORDER BY name`
  );
  return res.rows.map((r) => ({
    companyId: r.id,
    companyName: r.name,
    groupChatId: r.group_chat_id ?? "",
  }));
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
