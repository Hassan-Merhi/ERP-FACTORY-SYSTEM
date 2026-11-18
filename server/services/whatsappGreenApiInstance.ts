// Extracted from ./whatsappService.ts
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { authorizedStockTransferOrderWaWebhook } from "./security/stockTransferOrderWaWebhookAuthentication";
import { cleanGreenApiCredential } from "./whatsappGroupSettings";
import { fetchGreenApiReadOnly, fetchGreenApiWithAuthFallback } from "./whatsappGreenApiTransport";

// ─── Green API: fetch chats so the user can pick a group ──────────────────────

export interface GreenChat {
  id: string; // e.g. 120363198765432@g.us
  name: string;
  type: "group" | "contact" | string;
}

/** Green API instance states returned by getStateInstance */
export type GreenInstanceState =
  "authorized" | "notAuthorized" | "sleepMode" | "starting" | "yellowCard" | "blocked" | "suspended" | "unknown";

/**
 * Call Green API's getStateInstance to get the real connection state.
 * Returns "unknown" on any network/parse error.
 */
export async function getGreenInstanceState(instanceId: string, apiToken: string): Promise<GreenInstanceState> {
  try {
    const response = await fetchGreenApiWithAuthFallback({ instanceId, apiToken }, "getStateInstance", {
      method: "GET",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return "unknown";
    const json = await response.json().catch(() => null);
    const state: string = json?.stateInstance ?? "unknown";
    const validStates: GreenInstanceState[] = [
      "authorized",
      "notAuthorized",
      "sleepMode",
      "starting",
      "yellowCard",
      "blocked",
      "suspended",
    ];
    return validStates.includes(state as GreenInstanceState) ? (state as GreenInstanceState) : "unknown";
  } catch (error) {
    logger.warn("[WhatsApp] Green API instance status unavailable", { error: getErrorMessage(error) });
    return "unknown";
  }
}

/**
 * Security boundary for Stock Transfer Order approvals and the MAIN instance
 * status indicator. Never substitute the POS/backup credentials on HTTP 401:
 * quoted DONE replies must be tied to the instance that sent the request.
 */
export type GreenMainInstanceState = GreenInstanceState | "invalidCredentials";

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

export async function fetchGreenApiChats(instanceId: string, apiToken: string): Promise<GreenChat[]> {
  const response = await fetchGreenApiWithAuthFallback({ instanceId, apiToken }, "getChats", { method: "GET" });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Green API getChats error ${response.status}: ${body}`);
  }
  // getChats returns a JSON array of chat objects; only id is guaranteed.
  const data = (await response.json()) as Array<{ id?: string; name?: string; type?: string }>;
  return data
    .filter((c): c is { id: string; name?: string; type?: string } => Boolean(c && c.id))
    .map((c) => ({
      id: c.id,
      name: c.name || c.id,
      type: String(c.id).endsWith("@g.us") ? "group" : c.type || "contact",
    }));
}
