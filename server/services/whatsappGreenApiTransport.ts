// Extracted from ./whatsappService.ts
import { request as httpsRequest } from "node:https";
import { logger } from "../lib/logger";
import { cleanGreenApiCredential } from "./whatsappGroupSettings";
import { getWaSettingsById } from "./whatsappSettingsStore";
import type { WaSettings } from "./whatsappSettingsStore";

// ─── helpers ──────────────────────────────────────────────────────────────────

export type GreenApiCredentials = Pick<WaSettings, "instanceId" | "apiToken">;

export const GREEN_API_REQUEST_TIMEOUT_MS = 30_000;

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

export async function getGreenApiAuthFallback(current: GreenApiCredentials): Promise<GreenApiCredentials | null> {
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
