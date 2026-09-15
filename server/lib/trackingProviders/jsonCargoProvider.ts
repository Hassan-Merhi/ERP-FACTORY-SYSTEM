/**
 * jsonCargoProvider.ts — low-level client for the JSONCargo container tracking API.
 *
 * Scope: ETA lookup ONLY, for four carriers: Maersk, Hapag-Lloyd, MSC, CMA CGM.
 * This module never logs the API key, request headers, or raw response bodies.
 *
 * Carrier resolution: per spec, JSONCargo must use the carrier/shipping-line value
 * stored on the container record (containers.trackingCarrierHint), NOT a container-
 * number-prefix guess. `normalizeJsonCargoCarrier` maps loose free text (as typed by
 * staff, e.g. "Maersk", "CMA-CGM", "Hapag Lloyd") to the exact carrier code JSONCargo
 * expects. If it can't confidently map, the caller must skip JSONCargo entirely and
 * fall back to the existing multi-provider chain.
 */

const JSONCARGO_BASE_URL = process.env.JSONCARGO_BASE_URL || "https://app.jsoncargo.com/api/v2";
const TIMEOUT_MS = 25_000;
const MAX_RETRIES = 1; // only for 429 / 5xx / network errors — never for 404/400

// Carrier codes as expected by the JSONCargo API.
export type JsonCargoCarrier = "MAERSK" | "HAPAG_LLOYD" | "MSC" | "CMA_CGM";

const CARRIER_ALIASES: Record<string, JsonCargoCarrier> = {
  maersk: "MAERSK",
  "maersk line": "MAERSK",
  maerskline: "MAERSK",
  hapag: "HAPAG_LLOYD",
  "hapag lloyd": "HAPAG_LLOYD",
  "hapag-lloyd": "HAPAG_LLOYD",
  hapaglloyd: "HAPAG_LLOYD",
  msc: "MSC",
  "mediterranean shipping": "MSC",
  "mediterranean shipping company": "MSC",
  cma: "CMA_CGM",
  cgm: "CMA_CGM",
  "cma cgm": "CMA_CGM",
  "cma-cgm": "CMA_CGM",
  cmacgm: "CMA_CGM",
};

/** Normalize free-text carrier/shipping-line hints into a JSONCargo carrier code. Returns null if unsupported/unrecognized. */
export function normalizeJsonCargoCarrier(hint: string | null | undefined): JsonCargoCarrier | null {
  if (!hint) return null;
  const key = hint
    .trim()
    .toLowerCase()
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ");
  if (!key) return null;
  if (CARRIER_ALIASES[key]) return CARRIER_ALIASES[key];
  // Fall back to substring match (e.g. "CMA CGM (France)")
  for (const [alias, code] of Object.entries(CARRIER_ALIASES)) {
    if (key.includes(alias)) return code;
  }
  return null;
}

export const SUPPORTED_CARRIERS: JsonCargoCarrier[] = ["MAERSK", "HAPAG_LLOYD", "MSC", "CMA_CGM"];

const CONTAINER_NUMBER_RE = /^[A-Z]{4}\d{7}$/;

export function isValidContainerNumber(containerNumber: string | null | undefined): boolean {
  if (!containerNumber) return false;
  return CONTAINER_NUMBER_RE.test(containerNumber.trim().toUpperCase());
}

export function isConfigured(): boolean {
  return !!process.env.JSONCARGO_API_KEY;
}

export type JsonCargoErrorCategory =
  | "not_configured"
  | "invalid_container_number"
  | "not_found"
  | "rate_limited"
  | "timeout"
  | "network_error"
  | "http_error"
  | "unexpected_response";

export interface JsonCargoTrackResult {
  success: boolean;
  eta: string | null; // ISO date string (YYYY-MM-DD) or null
  errorCategory: JsonCargoErrorCategory | null;
  errorMessage: string | null;
}

function emptyResult(errorCategory: JsonCargoErrorCategory, errorMessage: string): JsonCargoTrackResult {
  return { success: false, eta: null, errorCategory, errorMessage };
}

/** Extract a clean YYYY-MM-DD date from JSONCargo's eta_final_destination field, whatever shape it arrives in. */
function extractEtaDate(raw: unknown): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const isoMatch = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];
  const parsed = new Date(s);
  if (isNaN(parsed.getTime())) return null;
  const y = parsed.getFullYear();
  const m = String(parsed.getMonth() + 1).padStart(2, "0");
  const d = String(parsed.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function fetchOnce(containerNumber: string, carrier: JsonCargoCarrier, apiKey: string) {
  const url = `${JSONCARGO_BASE_URL}/tracking/container?container_number=${encodeURIComponent(
    containerNumber
  )}&carrier=${encodeURIComponent(carrier)}`;

  return fetch(url, {
    method: "GET",
    headers: {
      "x-api-key": apiKey,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/**
 * Look up a single container's ETA via JSONCargo.
 * Retries once on 429/5xx/network errors; never retries on 404 or 400 (invalid).
 */
export async function track(containerNumber: string, carrier: JsonCargoCarrier): Promise<JsonCargoTrackResult> {
  const apiKey = process.env.JSONCARGO_API_KEY;
  if (!apiKey) {
    return emptyResult("not_configured", "JSONCargo API key is not configured");
  }
  if (!isValidContainerNumber(containerNumber)) {
    return emptyResult("invalid_container_number", "Container number is not in a valid ISO 6346 format");
  }

  let attempt = 0;
  let lastError: JsonCargoTrackResult = emptyResult("unexpected_response", "No attempt made");

  while (attempt <= MAX_RETRIES) {
    attempt++;
    try {
      const response = await fetchOnce(containerNumber.trim().toUpperCase(), carrier, apiKey);

      if (response.status === 404) {
        return emptyResult("not_found", "Container not found by JSONCargo");
      }
      if (response.status === 400) {
        return emptyResult("invalid_container_number", "JSONCargo rejected the container number/carrier");
      }
      if (response.status === 429) {
        lastError = emptyResult("rate_limited", "JSONCargo rate limit reached");
        if (attempt <= MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        return lastError;
      }
      if (response.status >= 500) {
        lastError = emptyResult("http_error", `JSONCargo returned HTTP ${response.status}`);
        if (attempt <= MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        return lastError;
      }
      if (!response.ok) {
        return emptyResult("http_error", `JSONCargo returned HTTP ${response.status}`);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return emptyResult("unexpected_response", "JSONCargo returned malformed JSON");
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return emptyResult(
          "unexpected_response",
          "JSONCargo returned an unexpected response shape"
        );
      }
      const data = (body as { data?: unknown }).data;
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return emptyResult(
          "unexpected_response",
          "JSONCargo returned an unexpected response shape"
        );
      }

      const rawEta =
        (data as { eta_final_destination?: unknown }).eta_final_destination ?? null;
      const eta = extractEtaDate(rawEta);

      return { success: true, eta, errorCategory: null, errorMessage: null };
    } catch (err: unknown) {
      const isTimeout =
        (err as { name?: string }).name === "TimeoutError" || (err as { name?: string }).name === "AbortError";
      lastError = isTimeout
        ? emptyResult("timeout", "JSONCargo request timed out")
        : emptyResult("network_error", "Network error contacting JSONCargo");
      if (attempt <= MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      return lastError;
    }
  }

  return lastError;
}
