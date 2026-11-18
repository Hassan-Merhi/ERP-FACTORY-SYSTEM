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

export {
  normaliseEvents,
  deriveLastStatus,
  deriveLastLocation,
  deriveLastEventDate,
  deriveEstimatedDeliveryDate,
} from "./parcelsAppNormalization";
