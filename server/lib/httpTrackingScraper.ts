/**
 * httpTrackingScraper.ts — Lightweight HTTP-only multi-carrier tracker.
 *
 * Detects the carrier from the container number prefix and tries that
 * carrier's own public API endpoint directly — no browser, no quota.
 *
 * Carrier coverage:
 *   MSC       → msc.com internal tracing API
 *   Hapag-Lloyd → hapag-lloyd.com traceback API
 *   COSCO      → coscoshipping.com cargo tracking
 *   Evergreen  → evergreen-line.com tracking
 *   Yang Ming  → yangmingusa.com tracking
 *   OOCL       → oocl.com tracking
 *   (fallback)  → ParcelsApp page HTML for any other carrier
 *
 * Never throws — always returns a typed result.
 */

import type { ParcelsAppShipment } from "./parcelsAppClient";
import { getErrorMessage } from "../lib/httpHandlers";
import { firstDefined, jsonArray, jsonPath, jsonString } from "./externalJson";
import { logger } from "./logger";

export interface HttpScraperResult {
  success: boolean;
  shipment: ParcelsAppShipment | null;
  rawResponse?: unknown;
  error?: string;
}

const TIMEOUT_MS = 12_000;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const BASE_HEADERS: Record<string, string> = {
  "User-Agent": BROWSER_UA,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
};

export function isHttpScraperAvailable(): boolean {
  return true;
}

// ── Carrier prefix detection ───────────────────────────────────────────────────

function detectCarrier(containerNumber: string): string | null {
  const prefix = containerNumber.slice(0, 4).toUpperCase();
  // HASU = Hamburg Süd (Maersk-owned since 2017, tracked via Maersk)
  if (/^(MAEU|MSKU|MRKU|MRSU|HASU|HJSC|HJCU|SUDU|SAFM)/.test(prefix)) return "MAERSK";
  if (/^(MSCU|MSDU|MEDU|MSMU|MSWU)/.test(prefix)) return "MSC";
  if (/^(HLCU|HLXU)/.test(prefix)) return "HAPAG";
  if (/^(COSU|CBHU|CCLU|COSJ)/.test(prefix)) return "COSCO";
  if (/^(EVRU|EVRG|EMCU|EGHU)/.test(prefix)) return "EVERGREEN";
  if (/^(YMLU|YMLZ|YMMU)/.test(prefix)) return "YANGMING";
  if (/^(OOLU|OOCU|OOCL)/.test(prefix)) return "OOCL";
  if (/^(CMAU|CMDU|APZU)/.test(prefix)) return "CMA";
  return null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function abort(ms: number): AbortController {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl;
}

function toShipment(
  containerNumber: string,
  status: string | null,
  location: string | null,
  eta: string | null,
  events: Array<{ date: string; status: string; location?: string; description?: string }>
): ParcelsAppShipment {
  return {
    trackingId: containerNumber,
    done: true,
    attributes: {
      ...(status ? { status } : {}),
      ...(location ? { location } : {}),
      ...(eta ? { estimatedArrival: eta } : {}),
    },
    states: events,
  };
}

// ── MSC ────────────────────────────────────────────────────────────────────────

async function tryMsc(containerNumber: string): Promise<HttpScraperResult> {
  try {
    const ctrl = abort(TIMEOUT_MS);
    const resp = await fetch("https://www.msc.com/api/feature/tools/tracing/get-trace-results", {
      method: "POST",
      headers: {
        ...BASE_HEADERS,
        "Content-Type": "application/json",
        Origin: "https://www.msc.com",
        Referer: "https://www.msc.com/en/track-a-shipment",
      },
      body: JSON.stringify({ tracing_reference: containerNumber, language: "eng" }),
      signal: ctrl.signal,
    });
    if (!resp.ok) return { success: false, shipment: null, error: `MSC HTTP ${resp.status}` };
    const data: unknown = await resp.json();
    const activities = jsonArray(
      firstDefined(jsonPath(data, "TrackingDetails", "TrackingActivities"), jsonPath(data, "trackingActivities"))
    );
    if (!activities.length) return { success: false, shipment: null, error: "MSC: no activities" };
    const events = activities.map((a) => ({
      date: jsonString(firstDefined(jsonPath(a, "ActivityDate"), jsonPath(a, "date"))) ?? "",
      status: jsonString(firstDefined(jsonPath(a, "ActivityDescription"), jsonPath(a, "description"))) ?? "",
      location: jsonString(firstDefined(jsonPath(a, "Location"), jsonPath(a, "location"))) ?? "",
    }));
    const latest = events[0];
    // Try dedicated ETA fields first, then scan activities for an ETA event.
    let etaRaw: string | null = jsonString(
      firstDefined(
        jsonPath(data, "TrackingDetails", "ETA"),
        jsonPath(data, "TrackingDetails", "VesselETA"),
        jsonPath(data, "TrackingDetails", "EstimatedTimeOfArrival"),
        jsonPath(data, "TrackingDetails", "EstimatedArrival"),
        jsonPath(data, "eta")
      )
    );
    if (!etaRaw) {
      const etaActivity = activities.find((a) => {
        const desc = (
          jsonString(firstDefined(jsonPath(a, "ActivityDescription"), jsonPath(a, "description"))) ?? ""
        ).toLowerCase();
        return desc.includes("estimated time of arrival") || desc.includes("estimated arrival") || desc === "eta";
      });
      if (etaActivity) {
        etaRaw = jsonString(firstDefined(jsonPath(etaActivity, "ActivityDate"), jsonPath(etaActivity, "date")));
      }
    }
    const shipment = toShipment(containerNumber, latest?.status ?? null, latest?.location ?? null, etaRaw, events);
    return { success: true, shipment, rawResponse: data };
  } catch (err: unknown) {
    return { success: false, shipment: null, error: `MSC: ${getErrorMessage(err) ?? "error"}` };
  }
}

// ── Hapag-Lloyd ────────────────────────────────────────────────────────────────

async function tryHapag(containerNumber: string): Promise<HttpScraperResult> {
  try {
    const ctrl = abort(TIMEOUT_MS);
    const resp = await fetch(
      `https://www.hapag-lloyd.com/api/containertraceback/${encodeURIComponent(containerNumber)}?requestorType=website`,
      {
        headers: {
          ...BASE_HEADERS,
          Referer: "https://www.hapag-lloyd.com/en/online-business/track/track-by-container-id.html",
        },
        signal: ctrl.signal,
      }
    );
    if (!resp.ok) return { success: false, shipment: null, error: `Hapag HTTP ${resp.status}` };
    const data: unknown = await resp.json();
    const moves = jsonArray(
      firstDefined(jsonPath(data, "containerJourneys", 0, "containerMoves"), jsonPath(data, "moves"))
    );
    if (!moves.length) return { success: false, shipment: null, error: "Hapag: no moves" };
    const events = moves.map((m) => ({
      date: jsonString(firstDefined(jsonPath(m, "eventDateTime"), jsonPath(m, "date"))) ?? "",
      status:
        jsonString(
          firstDefined(jsonPath(m, "transportModeDescription"), jsonPath(m, "event"), jsonPath(m, "status"))
        ) ?? "",
      location: jsonString(firstDefined(jsonPath(m, "portOfCall"), jsonPath(m, "location"))) ?? "",
    }));
    const latest = events[0];
    const etaRaw = jsonString(firstDefined(jsonPath(data, "containerJourneys", 0, "eta"), jsonPath(data, "eta")));
    const shipment = toShipment(containerNumber, latest?.status ?? null, latest?.location ?? null, etaRaw, events);
    return { success: true, shipment, rawResponse: data };
  } catch (err: unknown) {
    return { success: false, shipment: null, error: `Hapag: ${getErrorMessage(err) ?? "error"}` };
  }
}

// ── COSCO ──────────────────────────────────────────────────────────────────────

async function tryCosco(containerNumber: string): Promise<HttpScraperResult> {
  try {
    const ctrl = abort(TIMEOUT_MS);
    const resp = await fetch(
      `https://elines.coscoshipping.com/ebusiness/cargoTracking?condition.cargoTrackNo=${encodeURIComponent(containerNumber)}`,
      {
        headers: { ...BASE_HEADERS, Referer: "https://elines.coscoshipping.com/ebusiness/cargoTracking" },
        signal: ctrl.signal,
      }
    );
    if (!resp.ok) return { success: false, shipment: null, error: `COSCO HTTP ${resp.status}` };
    const data: unknown = await resp.json();
    const detail = jsonPath(data, "data", "content", 0);
    if (!detail) return { success: false, shipment: null, error: "COSCO: no data" };
    const moves = jsonArray(firstDefined(jsonPath(detail, "movementActivities"), jsonPath(detail, "activities")));
    const events = moves.map((m) => ({
      date: jsonString(firstDefined(jsonPath(m, "eventDate"), jsonPath(m, "date"))) ?? "",
      status: jsonString(firstDefined(jsonPath(m, "activity"), jsonPath(m, "status"))) ?? "",
      location: jsonString(jsonPath(m, "location")) ?? "",
    }));
    const latest = events[0];
    const etaRaw = jsonString(firstDefined(jsonPath(detail, "estimatedArrivalDate"), jsonPath(detail, "eta")));
    const shipment = toShipment(containerNumber, latest?.status ?? null, latest?.location ?? null, etaRaw, events);
    return { success: true, shipment, rawResponse: data };
  } catch (err: unknown) {
    return { success: false, shipment: null, error: `COSCO: ${getErrorMessage(err) ?? "error"}` };
  }
}

// ── Evergreen ──────────────────────────────────────────────────────────────────

async function tryEvergreen(containerNumber: string): Promise<HttpScraperResult> {
  try {
    const ctrl = abort(TIMEOUT_MS);
    const resp = await fetch(
      `https://www.evergreen-line.com/ese/jsp/ct_tracking_info.jsp?lang=en&q=${encodeURIComponent(containerNumber)}&sType=CT`,
      {
        headers: { ...BASE_HEADERS, Referer: "https://www.evergreen-line.com/ese/jsp/cargotracking.jsp" },
        signal: ctrl.signal,
      }
    );
    if (!resp.ok) return { success: false, shipment: null, error: `Evergreen HTTP ${resp.status}` };
    const data: unknown = await resp.json();
    const moves = jsonArray(firstDefined(jsonPath(data, "EventList"), jsonPath(data, "events")));
    if (!moves.length) return { success: false, shipment: null, error: "Evergreen: no events" };
    const events = moves.map((m) => ({
      date: jsonString(firstDefined(jsonPath(m, "EventDate"), jsonPath(m, "date"))) ?? "",
      status: jsonString(firstDefined(jsonPath(m, "EventName"), jsonPath(m, "status"))) ?? "",
      location: jsonString(firstDefined(jsonPath(m, "PortName"), jsonPath(m, "location"))) ?? "",
    }));
    const latest = events[0];
    const etaRaw = jsonString(firstDefined(jsonPath(data, "ETA"), jsonPath(data, "eta")));
    const shipment = toShipment(containerNumber, latest?.status ?? null, latest?.location ?? null, etaRaw, events);
    return { success: true, shipment, rawResponse: data };
  } catch (err: unknown) {
    return { success: false, shipment: null, error: `Evergreen: ${getErrorMessage(err) ?? "error"}` };
  }
}

// ── Maersk HTML page (Next.js embedded data) ──────────────────────────────────

// ── ParcelsApp page HTML fallback (for unknown carriers) ──────────────────────

// ── Main entry point ───────────────────────────────────────────────────────────

export async function httpScrapeTracking(containerNumber: string): Promise<HttpScraperResult> {
  const carrier = detectCarrier(containerNumber);
  logger.info(`[HttpScraper] ${containerNumber}: detected carrier=${carrier ?? "unknown"}`);

  let result: HttpScraperResult;

  switch (carrier) {
    case "MSC":
      result = await tryMsc(containerNumber);
      break;
    case "HAPAG":
      result = await tryHapag(containerNumber);
      break;
    case "COSCO":
      result = await tryCosco(containerNumber);
      break;
    case "EVERGREEN":
      result = await tryEvergreen(containerNumber);
      break;
    case "MAERSK":
      // Maersk's page is SSR-less — no data in HTML.
      // The real data comes from maersk_direct (Puppeteer intercept) which
      // runs after this scraper in the provider chain.
      result = { success: false, shipment: null, error: "Maersk page: no tracking data in HTML" };
      break;
    case "CMA":
      // CMA CGM is protected by DataDome — their page/HTML yields nothing.
      // ParcelsApp API handles CMA directly and is called after this scraper.
      result = { success: false, shipment: null, error: "CMA page: DataDome protected, use ParcelsApp API" };
      break;
    default:
      // ParcelsApp removed server-side Nuxt data embedding from their page
      // HTML — tryPageHtml() now always returns "No embedded tracking data in
      // page" (99 errors/month observed).  Fast-fail here so the provider
      // chain reaches the ParcelsApp v3 API immediately instead of wasting
      // a 12-second HTTP round-trip on a request that never succeeds.
      result = { success: false, shipment: null, error: "unknown carrier: forwarding to ParcelsApp API" };
  }

  if (!result.success) {
    logger.info(`[HttpScraper] ${containerNumber}: ${result.error ?? "no data"}`);
  } else {
    logger.info(`[HttpScraper] ${containerNumber}: success via carrier=${carrier ?? "page"}`);
  }

  return result;
}
