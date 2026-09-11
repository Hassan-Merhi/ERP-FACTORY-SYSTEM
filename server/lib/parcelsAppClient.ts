/**
 * parcelsAppClient.ts — ParcelsApp v3 API client.
 *
 * Two-step async flow:
 *  1. POST /api/v3/shipments/tracking  →  { uuid, done, shipments[], fromCache }
 *  2. GET  /api/v3/shipments/tracking?uuid=&apiKey=  (poll until done)
 *
 * API key must be set in process.env.PARCELSAPP_API_KEY.
 * Never log or expose the key to the frontend.
 */
import { logger } from "./logger";
import { getErrorMessage } from "../lib/httpHandlers";

const BASE_URL = process.env.PARCELSAPP_API_BASE_URL || "https://parcelsapp.com/api/v3";

const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_ATTEMPTS = 18; // 90 seconds max

export interface ParcelsAppEvent {
  date: string | null;
  status: string | null;
  location: string | null;
  description: string | null;
}

export interface ParcelsAppShipment {
  trackingId: string;
  /** Alternate id some ParcelsApp payloads use instead of trackingId */
  id?: string;
  done: boolean;
  fromCache?: boolean;
  // ParcelsApp normally returns attributes as an array of {l, val} objects,
  // but malformed/partial entries are possible and must be tolerated.
  attributes?:
    | Array<{ l?: unknown; val?: unknown; [k: string]: unknown }>
    | {
        status?: string;
        location?: string;
        description?: string;
        weight?: string;
        origin?: string;
        destination?: string;
        estimatedDeliveryDate?: string;
        estimatedDelivery?: string;
        deliveryDate?: string;
        expectedDelivery?: string;
        estimatedArrival?: string;
        arrivalDate?: string;
        eta?: string;
        [key: string]: string | undefined;
      };
  // Top-level ETA / delivery fields ParcelsApp may return directly on the shipment
  estimatedArrival?: string;
  estimatedDeliveryDate?: string;
  estimatedDelivery?: string;
  eta?: string;
  delivered_by?: string;
  states?: Array<{
    date: string;
    status: string;
    location?: string;
    description?: string;
  }>;
  status?: string;
  error?: string;
}

export interface ParcelsAppResult {
  done: boolean;
  uuid: string;
  fromCache: boolean;
  shipments: ParcelsAppShipment[];
  rawResponse: unknown;
}

export interface ParcelsAppTrackResult {
  success: boolean;
  shipment: ParcelsAppShipment | null;
  rawResponse: unknown;
  error?: string;
  timedOut?: boolean;
}

function getApiKey(): string | null {
  return process.env.PARCELSAPP_API_KEY || null;
}

/**
 * Initiates a tracking request. Returns UUID + any cached results.
 */
async function initiateTracking(
  trackingId: string,
  destinationCountry: string | null | undefined = "United States",
  carrier?: string
): Promise<{ uuid: string; done: boolean; shipments: ParcelsAppShipment[]; fromCache: boolean }> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("PARCELSAPP_API_KEY is not configured");

  const shipmentEntry: Record<string, string> = {
    trackingId,
    destinationCountry: destinationCountry ?? "United States",
  };
  if (carrier) shipmentEntry.carrier = carrier;

  const body = {
    shipments: [shipmentEntry],
    language: "en",
    apiKey,
  };

  const res = await fetch(`${BASE_URL}/shipments/tracking`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`ParcelsApp POST failed: ${res.status} ${txt.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    uuid?: string;
    done?: boolean;
    shipments?: ParcelsAppShipment[];
    fromCache?: boolean;
    error?: string;
  };

  // ParcelsApp occasionally returns {"error":"BUSY"} when its workers are
  // saturated — throw a typed error so callers can retry.
  if (data.error === "BUSY") {
    const e = new Error("ParcelsApp POST: server busy (BUSY)") as Error & { isBusy: boolean };
    e.isBusy = true;
    throw e;
  }

  // ParcelsApp has three valid POST response shapes:
  //  A. { uuid, done:false }           → need to poll
  //  B. { done:true, shipments }       → cache hit, use immediately (uuid may be absent)
  //  C. { shipments } (no uuid, done not set) → data already available, treat as done
  // Only throw if there is truly nothing usable.
  const hasShipments = (data.shipments?.length ?? 0) > 0;
  if (!data.uuid && !data.done && !hasShipments) {
    throw new Error(`ParcelsApp POST: no uuid in response (raw=${JSON.stringify(data).slice(0, 120)})`);
  }

  // If shipments are present but uuid / done are missing, treat as immediately done.
  const effectiveDone = data.done ?? hasShipments;

  return {
    uuid: data.uuid ?? "",
    done: effectiveDone,
    shipments: data.shipments ?? [],
    fromCache: data.fromCache ?? false,
  };
}

/**
 * Polls for a tracking result by UUID. Returns when done or times out.
 */
async function pollTracking(uuid: string): Promise<{ done: boolean; shipments: ParcelsAppShipment[] }> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("PARCELSAPP_API_KEY is not configured");

  const url = `${BASE_URL}/shipments/tracking?uuid=${encodeURIComponent(uuid)}&apiKey=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`ParcelsApp GET failed: ${res.status} ${txt.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    done?: boolean;
    shipments?: ParcelsAppShipment[];
  };

  return {
    done: data.done ?? false,
    shipments: data.shipments ?? [],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Full track-and-poll flow for a single container number.
 * Initiates, then polls up to POLL_MAX_ATTEMPTS×POLL_INTERVAL_MS.
 * @param carrier  Optional carrier/shipping-line hint (e.g. "MAERSK", "MSC"). Sent as
 *                 the `carrier` field in the ParcelsApp request body, separate from
 *                 `destinationCountry`.
 */
export async function trackContainer(
  containerNumber: string,
  destinationCountry = "United States",
  carrier?: string
): Promise<ParcelsAppTrackResult> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return {
      success: false,
      shipment: null,
      rawResponse: null,
      error: "PARCELSAPP_API_KEY is not configured",
    };
  }

  let rawResponse: unknown = null;

  // Retry on BUSY up to 3 times with a 6-second back-off, then proceed.
  const MAX_BUSY_RETRIES = 3;
  const BUSY_RETRY_DELAY_MS = 6_000;

  async function initiateWithRetry() {
    for (let attempt = 0; attempt <= MAX_BUSY_RETRIES; attempt++) {
      try {
        return await initiateTracking(containerNumber, destinationCountry, carrier);
      } catch (err: unknown) {
        if ((err as { isBusy?: boolean }).isBusy && attempt < MAX_BUSY_RETRIES) {
          logger.warn(
            `[ParcelsApp] ${containerNumber}: BUSY — retry ${attempt + 1}/${MAX_BUSY_RETRIES} in ${BUSY_RETRY_DELAY_MS / 1000}s`
          );
          await sleep(BUSY_RETRY_DELAY_MS);
          continue;
        }
        throw err;
      }
    }
    // unreachable — loop always returns or throws — but TS needs this
    throw new Error("initiateWithRetry: unexpected exit");
  }

  try {
    const initiated = await initiateWithRetry();
    rawResponse = initiated;

    if (initiated.done) {
      const shipment =
        initiated.shipments.find((s) => s.trackingId === containerNumber) ?? initiated.shipments[0] ?? null;
      return {
        success: true,
        shipment,
        rawResponse: initiated,
        timedOut: false,
      };
    }

    // Poll until done — also track the best partial shipment seen so far
    let bestShipment: ParcelsAppShipment | null = null;

    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      await sleep(POLL_INTERVAL_MS);
      try {
        const polled = await pollTracking(initiated.uuid);
        rawResponse = polled;

        // Keep the richest shipment seen across all polls
        const candidate = polled.shipments.find((s) => s.trackingId === containerNumber) ?? polled.shipments[0] ?? null;
        if (candidate && (candidate.states?.length ?? 0) >= (bestShipment?.states?.length ?? 0)) {
          bestShipment = candidate;
        }

        if (polled.done) {
          return {
            success: true,
            shipment: bestShipment,
            rawResponse: polled,
            timedOut: false,
          };
        }
      } catch (pollErr: unknown) {
        logger.warn(`[ParcelsApp] Poll attempt ${attempt + 1} error: ${getErrorMessage(pollErr)}`);
      }
    }

    // Timed out — but if we received any shipment data during polling, use it
    if (bestShipment) {
      logger.warn(
        `[ParcelsApp] ${containerNumber}: timed out but returning partial data (${bestShipment.states?.length ?? 0} events)`
      );
      return {
        success: true,
        shipment: bestShipment,
        rawResponse,
        timedOut: true,
      };
    }

    return {
      success: false,
      shipment: null,
      rawResponse,
      error: "Tracking request timed out after polling",
      timedOut: true,
    };
  } catch (err: unknown) {
    return {
      success: false,
      shipment: null,
      rawResponse,
      error: getErrorMessage(err) ?? "Unknown error",
    };
  }
}

/**
 * Normalises the raw states array from a ParcelsApp shipment into our event shape.
 */
export function normaliseEvents(shipment: ParcelsAppShipment): ParcelsAppEvent[] {
  if (!shipment.states?.length) return [];
  return shipment.states.map((s) => ({
    date: s.date ?? null,
    status: s.status ?? null,
    location: s.location ?? null,
    description: s.description ?? null,
  }));
}

function getShipmentAttribute(shipment: ParcelsAppShipment, key: string): string | undefined {
  const attributes = shipment.attributes;
  if (!attributes) return undefined;

  const normalizedKey = key.trim().toLowerCase();
  if (Array.isArray(attributes)) {
    for (const attribute of attributes) {
      if (!attribute || typeof attribute !== "object") continue;
      const label = typeof attribute.l === "string" ? attribute.l.trim() : "";
      if (!label || label.toLowerCase() !== normalizedKey) continue;
      return typeof attribute.val === "string" ? attribute.val : undefined;
    }
    return undefined;
  }

  const exactValue = attributes[key];
  if (typeof exactValue === "string") return exactValue;
  const matchingKey = Object.keys(attributes).find((attributeKey) => attributeKey.toLowerCase() === normalizedKey);
  if (!matchingKey) return undefined;
  const value = attributes[matchingKey];
  return typeof value === "string" ? value : undefined;
}

/**
 * Derives a simple last-known status string from the shipment attributes or latest state.
 */
export function deriveLastStatus(shipment: ParcelsAppShipment): string | null {
  const firstState = shipment.states?.[0];
  return getShipmentAttribute(shipment, "status") ?? firstState?.status ?? null;
}

/**
 * Derives a simple last-known location string from the shipment attributes or latest state.
 */
export function deriveLastLocation(shipment: ParcelsAppShipment): string | null {
  const firstState = shipment.states?.[0];
  return getShipmentAttribute(shipment, "location") ?? firstState?.location ?? null;
}

/**
 * Derives the latest event date from the first state.
 */
export function deriveLastEventDate(shipment: ParcelsAppShipment): Date | null {
  const raw = shipment.states?.[0]?.date;
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Derives the estimated delivery date from shipment attributes.
 * Checks multiple field names since ParcelsApp varies by carrier/version.
 * Returns an ISO date string (YYYY-MM-DD) or null if not available.
 */
export function deriveEstimatedDeliveryDate(shipment: ParcelsAppShipment): string | null {
  // Helper: parse and return YYYY-MM-DD if valid, else null.
  const tryDate = (raw: unknown): string | null => {
    if (!raw || typeof raw !== "string") return null;
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  };

  const todayStr = new Date().toISOString().slice(0, 10);

  // 1. Check top-level shipment fields that ParcelsApp returns directly.
  //    Try explicitly-named ETA fields first, then delivered_by as a future-only fallback.
  //    delivered_by is excluded here; it's checked at the end only when it's a future date.
  const topLevel = [
    shipment.estimatedArrival,
    shipment.estimatedDeliveryDate,
    shipment.estimatedDelivery,
    shipment.eta,
    (shipment as unknown as ParcelsAppShipment & { estimatedTimeOfArrival: unknown }).estimatedTimeOfArrival,
    (shipment as unknown as ParcelsAppShipment & { scheduledArrival: unknown }).scheduledArrival,
    (shipment as unknown as ParcelsAppShipment & { plannedArrival: unknown }).plannedArrival,
    (shipment as unknown as ParcelsAppShipment & { predictedETA: unknown }).predictedETA,
    (shipment as unknown as ParcelsAppShipment & { ETA: unknown }).ETA,
  ];
  for (const raw of topLevel) {
    const d = tryDate(raw);
    if (d) return d;
  }

  // 2. Normalise attributes to a plain key→value dict.
  //    ParcelsApp returns attributes as an array of {l, val} objects in the real
  //    API response; legacy / test callers may pass a plain dict.
  const rawAttrs = shipment.attributes;
  let attrsDict: Record<string, string> = {};
  if (Array.isArray(rawAttrs)) {
    for (const entry of rawAttrs) {
      if (typeof entry?.l === "string" && typeof entry.val === "string") {
        attrsDict[entry.l] = entry.val;
      }
    }
  } else if (rawAttrs && typeof rawAttrs === "object") {
    attrsDict = rawAttrs as Record<string, string>;
  }

  // Known ETA field names inside the attributes dict.
  const knownEtaKeys = [
    "estimatedDeliveryDate",
    "estimatedDelivery",
    "expectedDelivery",
    "estimatedArrival",
    "estimatedTimeOfArrival",
    "scheduledArrival",
    "plannedArrival",
    "plannedArrivalDate",
    "predictedETA",
    "eta",
    "ETA",
  ];
  for (const key of knownEtaKeys) {
    const d = tryDate(attrsDict[key]);
    if (d) return d;
  }

  // Catch-all: scan attribute keys for unambiguous ETA/estimated-arrival terms.
  // Explicitly excluded patterns: actual, ata, discharge, berth, gate, loaded,
  // departed, movement — those all describe past events, not future ETAs.
  const etaKeyPattern =
    /^(eta|estimatedArrival|estimatedDelivery|expectedDelivery|scheduledArrival|plannedArrival|predictedETA)/i;
  for (const [key, val] of Object.entries(attrsDict)) {
    if (!val || !etaKeyPattern.test(key)) continue;
    const d = tryDate(val);
    if (d) return d;
  }

  // Last resort: ParcelsApp sometimes puts the predicted arrival in `delivered_by`.
  // It can also be a past actual-delivery date, so only use it when the date is
  // strictly in the future (> today).  This is the ONLY circumstance where we
  // use delivered_by — never for containers that have already been delivered.
  const deliveredByRaw = shipment.delivered_by as string | undefined;
  if (deliveredByRaw) {
    const d = tryDate(deliveredByRaw);
    if (d && d > todayStr) {
      logger.info(`[ParcelsApp] deriveEDD: using delivered_by=${deliveredByRaw} as future ETA (${d})`);
      return d;
    }
  }

  // Last-resort: when the latest event's status text explicitly describes
  // an estimated arrival/ETA (e.g. "Estimated Time of Arrival, Vessel: …"),
  // that event's own date IS the ETA.  We only use future (or today) dates
  // to avoid mistaking past events for ETAs.
  const latestState = shipment.states?.[0];
  if (latestState?.date && latestState?.status) {
    const sLower = latestState.status.toLowerCase();
    const isEtaEvent =
      sLower.includes("estimated time of arrival") ||
      sLower.includes("estimated arrival") ||
      sLower === "eta" ||
      sLower.startsWith("eta ");
    if (isEtaEvent) {
      const d = tryDate(latestState.date);
      if (d && d >= todayStr) {
        logger.info(`[ParcelsApp] deriveEDD: using event status "${latestState.status}" date=${d} as ETA`);
        return d;
      }
    }
  }

  // Actual-arrival fallback: once a container has discharged/arrived at
  // destination there will be no future ETA field anywhere in the response.
  // Rather than falling back to a stale old DB date, find the most recent
  // discharge or arrival event and use its date as the actual arrival date.
  // states[] is ordered newest-first, so the first match is the latest event.
  const arrivalPattern = /discharg|import discharg|arrived|arrival at destination|port arrival|delivered/i;
  const states = shipment.states ?? [];
  for (const state of states) {
    if (!state.date) continue;
    const textToCheck = `${state.status ?? ""} ${state.description ?? ""}`;
    if (arrivalPattern.test(textToCheck)) {
      const d = tryDate(state.date);
      if (d) {
        logger.info(`[ParcelsApp] deriveEDD: actual arrival event "${state.status}" → arrivalDate=${d}`);
        return d;
      }
    }
  }

  // No ETA found — return null so the caller preserves whatever is in the DB.
  return null;
}

/**
 * Tests the API key by calling the account endpoint.
 * Returns { ok, plan, limit, current } or { ok: false, error }.
 */
export async function testConnection(): Promise<{
  ok: boolean;
  plan?: string;
  limit?: number;
  current?: number;
  resetDate?: string;
  error?: string;
}> {
  const apiKey = getApiKey();
  if (!apiKey) return { ok: false, error: "PARCELSAPP_API_KEY is not configured" };

  try {
    const res = await fetch(`${BASE_URL}/account?apiKey=${encodeURIComponent(apiKey)}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as {
      plan?: string;
      limit?: number;
      current?: number;
      resetDate?: string;
    };
    return {
      ok: true,
      plan: data.plan,
      limit: data.limit,
      current: data.current,
      resetDate: data.resetDate,
    };
  } catch (err: unknown) {
    return { ok: false, error: getErrorMessage(err) ?? "Unknown error" };
  }
}
