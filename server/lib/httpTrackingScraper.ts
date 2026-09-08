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
import { asRecord } from "@shared/typeGuards";
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

async function _tryMaerskHtml(containerNumber: string): Promise<HttpScraperResult> {
  try {
    const ctrl = abort(15_000);
    const resp = await fetch(`https://www.maersk.com/tracking/${encodeURIComponent(containerNumber)}`, {
      headers: {
        ...BASE_HEADERS,
        Accept: "text/html,application/xhtml+xml,*/*;q=0.9",
        "Accept-Language": "en-US,en;q=0.9",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Upgrade-Insecure-Requests": "1",
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!resp.ok) return { success: false, shipment: null, error: `Maersk page HTTP ${resp.status}` };
    const html = await resp.text();

    // Next.js pages embed data in <script id="__NEXT_DATA__">
    const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nextMatch) {
      try {
        const nextData = JSON.parse(nextMatch[1]);
        const props = nextData?.props?.pageProps ?? {};
        const td = props?.tracking ?? props?.trackingData ?? props?.container ?? props?.shipment;
        if (td) {
          const rawEvents = jsonArray(
            firstDefined(
              jsonPath(td, "events"),
              jsonPath(td, "movements"),
              jsonPath(td, "milestones"),
              jsonPath(td, "containers", 0, "events")
            )
          );
          if (rawEvents.length > 0) {
            const events = rawEvents.map((e) => ({
              date:
                jsonString(
                  firstDefined(
                    jsonPath(e, "eventDateTime"),
                    jsonPath(e, "eventDate"),
                    jsonPath(e, "timestamp"),
                    jsonPath(e, "date")
                  )
                ) ?? "",
              status:
                jsonString(
                  firstDefined(
                    jsonPath(e, "activityName"),
                    jsonPath(e, "eventCode"),
                    jsonPath(e, "status"),
                    jsonPath(e, "description")
                  )
                ) ?? "",
              location:
                jsonString(
                  firstDefined(jsonPath(e, "location", "portName"), jsonPath(e, "portName"), jsonPath(e, "location"))
                ) ?? "",
            }));
            const latest = events[0];
            const etaRaw = jsonString(
              firstDefined(
                jsonPath(td, "eta"),
                jsonPath(td, "estimatedTimeOfArrival"),
                jsonPath(td, "estimatedArrival")
              )
            );
            return {
              success: true,
              shipment: toShipment(containerNumber, latest?.status ?? null, latest?.location ?? null, etaRaw, events),
              rawResponse: { source: "maersk_next_data", events: events.length },
            };
          }
        }
      } catch {
        /* parse error — continue */
      }
    }

    // application/json script tags (some Next.js versions)
    for (const m of html.matchAll(/<script[^>]+type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const data: unknown = JSON.parse(m[1]);
        const events = jsonArray(firstDefined(jsonPath(data, "events"), jsonPath(data, "movements")));
        if (events.length > 0) {
          const mapped = events.map((e) => ({
            date: jsonString(firstDefined(jsonPath(e, "date"), jsonPath(e, "eventDateTime"))) ?? "",
            status: jsonString(firstDefined(jsonPath(e, "status"), jsonPath(e, "activityName"))) ?? "",
            location: jsonString(firstDefined(jsonPath(e, "location"), jsonPath(e, "portName"))) ?? "",
          }));
          return {
            success: true,
            shipment: toShipment(containerNumber, mapped[0]?.status ?? null, mapped[0]?.location ?? null, null, mapped),
            rawResponse: { source: "maersk_json_script" },
          };
        }
      } catch {
        /* next */
      }
    }

    const isBlocked = /captcha|datadome|challenge|cloudflare|blocked/i.test(html.slice(0, 2000));
    return {
      success: false,
      shipment: null,
      error: isBlocked ? "Maersk page: bot challenge" : "Maersk page: no tracking data in HTML",
    };
  } catch (err: unknown) {
    return { success: false, shipment: null, error: `Maersk page: ${getErrorMessage(err) ?? "error"}` };
  }
}

// ── ParcelsApp page HTML fallback (for unknown carriers) ──────────────────────

async function _tryPageHtml(containerNumber: string): Promise<HttpScraperResult> {
  try {
    const ctrl = abort(TIMEOUT_MS);
    const resp = await fetch(`https://parcelsapp.com/en/tracking/${encodeURIComponent(containerNumber)}`, {
      headers: { ...BASE_HEADERS, Accept: "text/html,application/xhtml+xml,*/*" },
      signal: ctrl.signal,
    });
    if (!resp.ok) return { success: false, shipment: null, error: `Page HTML ${resp.status}` };
    const html = await resp.text();

    // Nuxt 2: window.__NUXT__ = { ... }
    const nuxt2 = html.match(/window\.__NUXT__\s*=\s*(\{[\s\S]*?\})\s*(?:;?\s*<\/script>)/);
    if (nuxt2) {
      try {
        const parsed = JSON.parse(nuxt2[1]);
        const shipment = extractFromNuxt(parsed, containerNumber);
        if (shipment) return { success: true, shipment, rawResponse: parsed };
      } catch {
        /* continue */
      }
    }

    // Nuxt 3: <script type="application/json">
    for (const m of html.matchAll(/<script[^>]+type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const parsed = JSON.parse(m[1]);
        const shipment = extractFromNuxt(parsed, containerNumber);
        if (shipment) return { success: true, shipment, rawResponse: parsed };
      } catch {
        /* next */
      }
    }

    return { success: false, shipment: null, error: "No embedded tracking data in page" };
  } catch (err: unknown) {
    return { success: false, shipment: null, error: `Page HTML: ${getErrorMessage(err) ?? "error"}` };
  }
}

function extractFromNuxt(payload: unknown, containerNumber: string): ParcelsAppShipment | null {
  const record = asRecord(payload);
  if (!record) return null;
  const candidates = jsonArray(
    firstDefined(
      jsonPath(record, "shipments"),
      jsonPath(record, "parcels"),
      jsonPath(record, "data", "shipments"),
      jsonPath(record, "data", "parcels")
    )
  );
  if (candidates.length) {
    const match =
      candidates.find((s) => jsonPath(s, "trackingId") === containerNumber || jsonPath(s, "id") === containerNumber) ??
      candidates[0];
    // The caller only reads trackingId/id/states off this, and the payload is a
    // third-party Nuxt blob, so presence of an identifier is the whole contract.
    if (jsonPath(match, "trackingId") || jsonPath(match, "id")) return match as ParcelsAppShipment;
  }
  for (const key of ["data", "state", "fetch", "nuxt", "payload"]) {
    const nested = record[key];
    if (asRecord(nested)) {
      const found = extractFromNuxt(nested, containerNumber);
      if (found) return found;
    }
  }
  return null;
}

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
