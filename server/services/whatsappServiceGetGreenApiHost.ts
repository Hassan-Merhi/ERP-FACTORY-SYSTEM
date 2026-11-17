// Extracted from ./whatsappService.ts to keep that module under the source-size cap.
import { pool } from "../db";
import { request as httpsRequest } from "node:https";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { cleanGreenApiCredential } from "./whatsappGroupSettings";

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

export type WhatsAppDeliveryOutcome = "sent" | "failed" | "uncertain";

export interface WhatsAppSendResult {
  success: boolean;
  error?: string;
  deliveryOutcome?: WhatsAppDeliveryOutcome;
}

const GREEN_API_REQUEST_TIMEOUT_MS = 30_000;

export function greenApiRequestInit(init: RequestInit): RequestInit {
  if (init.signal) return init;
  return {
    ...init,
    signal: AbortSignal.timeout(GREEN_API_REQUEST_TIMEOUT_MS),
  };
}

/**
 * Match an explicitly configured POS instance to its GREEN-API console hosts.
 * Never infer a provider host from instance ID digits. Other instances retain
 * the universal host until explicitly configured.
 */
export function getGreenApiHost(instanceId: string, media = false): string {
  const matchedPos =
    !!process.env.GREEN_API_POS_INSTANCE_ID &&
    cleanGreenApiCredential(instanceId) === cleanGreenApiCredential(process.env.GREEN_API_POS_INSTANCE_ID);
  const configured = !matchedPos
    ? undefined
    : media
      ? process.env.GREEN_API_POS_MEDIA_URL || process.env.GREEN_API_POS_API_URL
      : process.env.GREEN_API_POS_API_URL;
  if (!configured?.trim()) return "https://api.greenapi.com";
  try {
    const parsed = new URL(configured.trim());
    const host = parsed.hostname.toLowerCase();
    const allowed = /^(?:[a-z0-9-]+\.)?api\.greenapi\.com$/.test(host) || (media && host === "media.greenapi.com");
    if (
      parsed.protocol !== "https:" ||
      !allowed ||
      parsed.port ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("Invalid host");
    }
    return parsed.origin;
  } catch {
    logger.warn("[WhatsApp] Ignoring invalid configured POS GREEN API host", { media });
    return "https://api.greenapi.com";
  }
}

export function baseUrl(instanceId: string, apiToken: string, method: string, media = false): string {
  const cleanInstanceId = cleanGreenApiCredential(instanceId);
  const cleanApiToken = cleanGreenApiCredential(apiToken);
  return `${getGreenApiHost(cleanInstanceId, media)}/waInstance${cleanInstanceId}/${method}/${cleanApiToken}`;
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

// Read-only Green API requests use IPv4 to avoid Render's observed 10-second
// Undici connect timeout. Never retry POST operations (duplicate sends risk).
export async function fetchGreenApiReadOnly(
  credentials: GreenApiCredentials,
  method: string,
  init: RequestInit
): Promise<Response> {
  const endpoint = new URL(baseUrl(credentials.instanceId, credentials.apiToken, method));
  let lastCode = "NETWORK_ERROR";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await new Promise<Response>((resolve, reject) => {
        const req = httpsRequest(endpoint, { method: "GET", family: 4, timeout: 12000 }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
          res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode || 502 })));
          res.on("error", reject);
        });
        const abort = () => req.destroy(Object.assign(new Error("Request aborted"), { code: "ABORT_ERR" }));
        if (init.signal?.aborted) {
          abort();
          return;
        }
        init.signal?.addEventListener("abort", abort, { once: true });
        req.on("close", () => init.signal?.removeEventListener("abort", abort));
        req.on("timeout", () => req.destroy(Object.assign(new Error("Connection timed out"), { code: "ETIMEDOUT" })));
        req.on("error", reject);
        req.end();
      });
    } catch (error) {
      const e = error as { code?: string; cause?: { code?: string } };
      lastCode = e.code || e.cause?.code || "NETWORK_ERROR";
      logger.warn("[WhatsApp] Green API read request failed", { method, attempt, code: lastCode });
      if (init.signal?.aborted) break;
    }
  }
  throw new Error(`Green API connection failed (${lastCode}). Check provider and outbound networking.`);
}

export async function fetchGreenApiWithAuthFallback(
  credentials: GreenApiCredentials,
  method: string,
  init: RequestInit
): Promise<Response> {
  const primaryInstanceId = cleanGreenApiCredential(credentials.instanceId);
  const primaryApiToken = cleanGreenApiCredential(credentials.apiToken);
  const primary =
    init.method === "GET" && (method === "getChats" || method === "getStateInstance")
      ? await fetchGreenApiReadOnly({ instanceId: primaryInstanceId, apiToken: primaryApiToken }, method, init)
      : await fetch(baseUrl(primaryInstanceId, primaryApiToken, method), greenApiRequestInit(init));
  if (primary.status !== 401) return primary;

  const alternate = await getGreenApiAuthFallback({ instanceId: primaryInstanceId, apiToken: primaryApiToken });
  if (!alternate) return primary;

  logger.warn("[WhatsApp] Green API rejected primary credentials; retrying configured backup instance", {
    primaryInstanceId,
    fallbackInstanceId: alternate.instanceId,
    method,
  });

  const fallback =
    init.method === "GET" && (method === "getChats" || method === "getStateInstance")
      ? await fetchGreenApiReadOnly(alternate, method, init)
      : await fetch(baseUrl(alternate.instanceId, alternate.apiToken, method), greenApiRequestInit(init));
  if (fallback.ok) {
    logger.warn("[WhatsApp] Green API backup credentials accepted after primary 401", {
      primaryInstanceId,
      fallbackInstanceId: alternate.instanceId,
      method,
    });
  }
  return fallback;
}

/**
 * Uploads can encounter Undici's default 10-second TCP connect timeout on Render.
 * Use Node HTTPS for multipart uploads, with an explicit 30-second timeout and
 * IPv4 resolution. Never retry an ambiguous upload: it may already be delivered.
 */
export async function requestGreenApiUpload(
  credentials: GreenApiCredentials,
  body: Buffer,
  headers: Record<string, string | number>
): Promise<Response> {
  const endpoint = new URL(baseUrl(credentials.instanceId, credentials.apiToken, "sendFileByUpload", true));
  return new Promise<Response>((resolve, reject) => {
    const req = httpsRequest(
      endpoint,
      {
        method: "POST",
        family: 4,
        timeout: GREEN_API_REQUEST_TIMEOUT_MS,
        headers: { ...headers, "Content-Length": body.length },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const responseBody = Buffer.concat(chunks);
          resolve(new Response(responseBody, { status: res.statusCode || 502 }));
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("Green API upload connection timed out after 30 seconds")));
    req.on("error", reject);
    req.end(body);
  });
}

export async function uploadGreenApiWithAuthFallback(
  credentials: GreenApiCredentials,
  body: Buffer,
  headers: Record<string, string | number>
): Promise<Response> {
  const primary = await requestGreenApiUpload(credentials, body, headers);
  if (primary.status !== 401) return primary;
  const alternate = await getGreenApiAuthFallback(credentials);
  if (!alternate) return primary;
  logger.warn("[WhatsApp] Green API upload credentials rejected; attempting configured backup instance", {
    instanceId: cleanGreenApiCredential(credentials.instanceId),
    fallbackInstanceId: cleanGreenApiCredential(alternate.instanceId),
  });
  return requestGreenApiUpload(alternate, body, headers);
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
