// Extracted from ./whatsappService.ts to keep that module under the source-size cap.
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { authorizedStockTransferOrderWaWebhook } from "./security/stockTransferOrderWaWebhookAuthentication";
import FormDataLib from "form-data";
import {
  type ExportAttachmentSource,
  getExportAttachmentSize,
  withSerializedExportAttachmentBuffer,
} from "../helpers/exportAttachmentSource";
import { cleanGreenApiCredential } from "./whatsappGroupSettings";
import {
  baseUrl,
  fetchGreenApiReadOnly,
  getWaSettings,
  greenApiRequestInit,
  uploadGreenApiWithAuthFallback,
  type GreenChat,
  type GreenInstanceState,
  type GreenMainInstanceState,
  type WaSettings,
  type WhatsAppSendResult,
} from "./whatsappServiceGetGreenApiHost";

export async function getStrictGreenMainInstanceState(
  instanceId: string,
  apiToken: string
): Promise<GreenMainInstanceState> {
  if (!cleanGreenApiCredential(instanceId) || !cleanGreenApiCredential(apiToken)) {
    return "invalidCredentials";
  }
  try {
    const response = await fetchGreenApiReadOnly({ instanceId, apiToken }, "getStateInstance", {
      method: "GET",
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 401 || response.status === 403) return "invalidCredentials";
    if (!response.ok) return "unknown";
    const body = (await response.json().catch(() => null)) as { stateInstance?: unknown } | null;
    const state = body?.stateInstance;
    const allowed: GreenInstanceState[] = [
      "authorized",
      "notAuthorized",
      "sleepMode",
      "starting",
      "yellowCard",
      "blocked",
      "suspended",
    ];
    return typeof state === "string" && allowed.includes(state as GreenInstanceState)
      ? (state as GreenInstanceState)
      : "unknown";
  } catch {
    // Do not log the provider URL or credentials (GREEN API uses token-in-URL).
    logger.warn("[STO WA] Main WhatsApp authorization check unavailable");
    return "unknown";
  }
}

/**
 * Read-only GREEN API webhook readiness for the MAIN WhatsApp account.
 * Do not mutate provider settings or expose its callback bearer token, API
 * token, full URL, or linked phone number to clients/logs. Other integrations
 * might already use a webhook URL and require fan-out to preserve them.
 */
export type StoWaMainWebhookReadiness = {
  incomingWebhookEnabled: boolean;
  outgoingPhoneWebhookEnabled: boolean;
  webhookUrlConfigured: boolean;
  webhookEndpointMatches: boolean;
  webhookTokenMatches: boolean;
  webhookHost: string | null;
  mainAccountChatId: string | null; // server-only; never return to browser
};

export async function getStrictGreenMainWebhookReadiness(
  instanceId: string,
  apiToken: string
): Promise<StoWaMainWebhookReadiness> {
  const response = await fetchGreenApiReadOnly({ instanceId, apiToken }, "getSettings", {
    method: "GET",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error("GREEN API main instance settings unavailable (HTTP " + response.status + ")");
  const raw: unknown = await response.json().catch(() => null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("GREEN API returned invalid main instance settings.");
  }
  const provider = raw as Record<string, unknown>;
  const webhookUrl = typeof provider.webhookUrl === "string" ? provider.webhookUrl.trim() : "";
  const bearer = typeof provider.webhookUrlToken === "string" ? provider.webhookUrlToken : "";
  let webhookEndpointMatches = false;
  let webhookHost: string | null = null;
  if (webhookUrl) {
    try {
      const parsed = new URL(webhookUrl);
      if (parsed.protocol === "https:" && parsed.username === "" && parsed.password === "") {
        webhookHost = parsed.hostname;
        webhookEndpointMatches =
          ["hmdinternationalgroup.com", "www.hmdinternationalgroup.com", "erp-pos-system-copy.onrender.com"].includes(
            parsed.hostname
          ) &&
          parsed.pathname.replace(/[/]$/, "") === "/api/stock-transfer-order/wa-approval/webhook" &&
          parsed.search === "" &&
          parsed.hash === "" &&
          !parsed.port;
      }
    } catch {
      /* malformed or secret-bearing URL: report only a boolean */
    }
  }
  return {
    incomingWebhookEnabled: provider.incomingWebhook === "yes",
    outgoingPhoneWebhookEnabled: provider.outgoingMessageWebhook === "yes",
    webhookUrlConfigured: Boolean(webhookUrl),
    webhookEndpointMatches,
    webhookTokenMatches: authorizedStockTransferOrderWaWebhook(bearer),
    webhookHost,
    mainAccountChatId:
      typeof provider.wid === "string" && /^[1-9][0-9]{6,14}@c[.]us$/.test(provider.wid) ? provider.wid : null,
  };
}

/** Read only chats from the exact main instance, without POS fallback. */
export async function fetchStrictGreenMainChats(instanceId: string, apiToken: string): Promise<GreenChat[]> {
  const response = await fetchGreenApiReadOnly({ instanceId, apiToken }, "getChats", {
    method: "GET",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    throw new Error(
      response.status === 401 || response.status === 403
        ? "Main WhatsApp credentials are rejected by GREEN API."
        : "Unable to verify the approval group on the main WhatsApp instance."
    );
  }
  const data: unknown = await response.json().catch(() => null);
  if (!Array.isArray(data)) throw new Error("Main WhatsApp returned an invalid chat list.");
  return data
    .filter(
      (c): c is { id: string; name?: string; type?: string } =>
        c !== null && typeof c === "object" && typeof (c as { id?: unknown }).id === "string"
    )
    .map((c) => ({
      id: c.id,
      name: typeof c.name === "string" && c.name ? c.name : c.id,
      type: c.id.endsWith("@g.us") ? "group" : typeof c.type === "string" ? c.type : "contact",
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
