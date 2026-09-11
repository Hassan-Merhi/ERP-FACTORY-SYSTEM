/**
 * maerskPublicProvider.ts — Maersk public tracking (no credentials required).
 *
 * Always enabled — no env vars needed. Free HTTP-only (no browser / Puppeteer).
 *
 * Attempts Maersk's undocumented public JSON endpoint. If blocked by Akamai
 * (403/captcha), returns success=false immediately and the service falls back
 * to ParcelsApp. Never retries. Never crashes the server.
 *
 * Rate-limited: max 20 minutes per container (in-process).
 */

import { asFirst, asRawEventLocationObject, asRecord, asArray, rawStr } from "./types";
import type { CarrierRawEvent, CarrierTrackResult, TrackingEvent } from "./types";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const PUBLIC_BASE = "https://www.maersk.com/api/tracking";
const PUBLIC_PAGE = "https://www.maersk.com/tracking";
const TIMEOUT_MS = 12_000;
const RATE_LIMIT_MS = 6 * 60 * 60 * 1_000; // 6 hours

const _lastAttempt = new Map<string, number>();

export function isEnabled(): boolean {
  return true;
}

function isRateLimited(containerNumber: string): boolean {
  const last = _lastAttempt.get(containerNumber);
  return !!last && Date.now() - last < RATE_LIMIT_MS;
}

const emptyBase = (containerNumber: string): CarrierTrackResult => ({
  success: false,
  provider: "maersk_public",
  carrier: "MAERSK",
  containerNumber,
  latestStatus: null,
  latestLocation: null,
  latestEventDate: null,
  latestDescription: null,
  eta: null,
  events: [],
  raw: null,
});

export async function track(containerNumber: string): Promise<CarrierTrackResult> {
  const base = emptyBase(containerNumber);

  if (!isEnabled()) {
    return { ...base, notConfigured: true, error: "maersk_public_not_enabled" };
  }

  if (isRateLimited(containerNumber)) {
    logger.info(`[MaerskPublic] ${containerNumber}: rate-limited — skipping`);
    return { ...base, error: "rate_limited" };
  }

  _lastAttempt.set(containerNumber, Date.now());

  // ── Step 1: load tracking page to obtain session cookies ──────────────────
  // Akamai/DataDome requires a real session. We GET the public tracking page
  // first (cheap, HTML only) so the server sees a session cookie chain before
  // we call the JSON API.
  let sessionCookies = "";
  try {
    const pageRes = await fetch(`${PUBLIC_PAGE}/${encodeURIComponent(containerNumber)}`, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml,*/*;q=0.9",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Upgrade-Insecure-Requests": "1",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "follow",
    });
    // Discard the body immediately — we only need the Set-Cookie headers.
    // Not consuming the body would hold the TCP connection open and leak memory.
    await pageRes.body?.cancel().catch(() => {});
    // Collect all Set-Cookie values as a single Cookie header string
    const raw = pageRes.headers.get("set-cookie") ?? "";
    sessionCookies = raw
      .split(/,(?=[^;]+?=)/) // split multiple cookies (not expires commas)
      .map((c) => c.split(";")[0].trim())
      .filter(Boolean)
      .join("; ");
    logger.info(
      `[MaerskPublic] ${containerNumber}: prefetch done — ${sessionCookies ? "cookies acquired" : "no cookies"}`
    );
  } catch {
    // Non-fatal — we still try the API without cookies
  }

  // ── Step 2: call the JSON API with the session cookies ────────────────────
  try {
    const url = `${PUBLIC_BASE}/${encodeURIComponent(containerNumber)}`;
    const res = await fetch(url, {
      headers: {
        Accept: "application/json, */*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": BROWSER_UA,
        Referer: `${PUBLIC_PAGE}/${encodeURIComponent(containerNumber)}`,
        Origin: "https://www.maersk.com",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "Cache-Control": "no-cache",
        ...(sessionCookies ? { Cookie: sessionCookies } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "follow",
    });

    if (res.status === 403 || res.status === 401 || res.status === 429) {
      logger.info(`[MaerskPublic] ${containerNumber}: blocked (HTTP ${res.status})`);
      return { ...base, blocked: true, error: `blocked_http_${res.status}` };
    }

    if (!res.ok) {
      logger.info(`[MaerskPublic] ${containerNumber}: HTTP ${res.status}`);
      return { ...base, error: `http_${res.status}` };
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      const text = (await res.text()).slice(0, 300);
      const isChallenge = /captcha|datadome|challenge|cloudflare|bot/i.test(text);
      logger.info(`[MaerskPublic] ${containerNumber}: non-JSON response${isChallenge ? " (bot challenge)" : ""}`);
      return { ...base, blocked: isChallenge, error: isChallenge ? "captcha_challenge" : "non_json_response" };
    }

    const data = await res.json();
    return parseResponse(containerNumber, data, base);
  } catch (err: unknown) {
    const isTimeout =
      (err as { name?: string }).name === "TimeoutError" || (err as { name?: string }).name === "AbortError";
    logger.info(`[MaerskPublic] ${containerNumber}: ${isTimeout ? "timeout" : (getErrorMessage(err) ?? "error")}`);
    return { ...base, error: isTimeout ? "timeout" : (getErrorMessage(err) ?? "unknown_error") };
  }
}

function parseDate(raw: unknown): Date | null {
  if (!raw || typeof raw !== "string") return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Recursively search any JSON object for keys that explicitly mean ETA/estimated
 * arrival.  Used as a supplemental pass after the primary field-path extraction,
 * in case Maersk restructures their API response shape.
 * Returns the first valid YYYY-MM-DD string found, or null.
 */
const DEEP_ETA_KEY_RE =
  /^(eta|estimatedArrival|estimatedTimeOfArrival|plannedArrival|plannedArrivalDate|scheduledArrival|predictiveEstimatedArrival|latestEstimatedArrival|arrivalDate|vesselArrival|portArrival|destinationEstimatedArrival)$/i;

function deepScanForEta(obj: unknown, depth = 0): { path: string; value: string } | null {
  if (depth > 12 || !obj || typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const r = deepScanForEta(item, depth + 1);
      if (r) return r;
    }
    return null;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (DEEP_ETA_KEY_RE.test(k) && typeof v === "string" && v.trim()) {
      const d = new Date(v);
      if (!isNaN(d.getTime())) return { path: k, value: d.toISOString().slice(0, 10) };
    }
    if (v && typeof v === "object") {
      const r = deepScanForEta(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

function parseResponse(containerNumber: string, data: unknown, base: CarrierTrackResult): CarrierTrackResult {
  if (!data || typeof data !== "object") {
    return { ...base, noData: true, error: "empty_response" };
  }

  const d = asRecord(data);

  // Maersk may wrap in various shapes
  const entry = asRecord(
    (Array.isArray(data) ? asFirst(data) : null) ?? asFirst(d.containers) ?? d.shipment ?? d.trackingData ?? d
  );

  if (!entry) return { ...base, noData: true, error: "no_entry" };

  const rawEvents: unknown[] =
    (entry.events as unknown[] | undefined) ??
    (asRecord(asFirst(entry.containers)).events as unknown[] | undefined) ??
    (entry.milestones as unknown[] | undefined) ??
    (d.events as unknown[] | undefined) ??
    [];

  const events: TrackingEvent[] = (Array.isArray(rawEvents) ? (rawEvents as CarrierRawEvent[]) : [])
    .map((e): TrackingEvent => {
      const locObj = asRawEventLocationObject(e.location);
      return {
        date: parseDate(e.eventDateTime ?? e.eventDate ?? e.timestamp ?? e.date ?? null),
        status: rawStr(e.transportEventTypeCode) ?? rawStr(e.activityName) ?? rawStr(e.eventCode) ?? rawStr(e.status),
        location:
          rawStr(locObj?.portName) ??
          rawStr(locObj?.locationName) ??
          rawStr(e.portName) ??
          rawStr(e.locationName) ??
          (typeof e.location === "string" ? e.location : null),
        description: rawStr(e.description) ?? rawStr(e.eventDescription) ?? rawStr(e.activityName),
      };
    })
    .filter((e) => e.date !== null || e.status !== null)
    .sort((a, b) => {
      if (!a.date) return 1;
      if (!b.date) return -1;
      return b.date.getTime() - a.date.getTime();
    });

  const latest = events[0] ?? null;

  // For portCalls, the destination is the last entry or the one flagged isDestination.
  // portCalls[0] is the ORIGIN — never use index 0 for ETA.
  const portCalls = asArray(entry.portCalls).map(asRecord);
  const destPortCall =
    portCalls.find((p) => p.isDestination === true || p.isDestination === "true") ??
    (portCalls.length > 0 ? portCalls[portCalls.length - 1] : null);

  const portOfDischarge = asRecord(entry.portOfDischarge);
  const portCallLegs = asArray(entry.legs);
  const lastLeg = portCallLegs.length > 0 ? asRecord(portCallLegs[portCallLegs.length - 1]) : null;
  const firstContainer = asRecord(asFirst(entry.containers));

  // Destination port call fields have highest priority — they represent the
  // actual arrival ETA at the final destination, not a transit movement.
  const etaRaw =
    destPortCall?.eta ??
    destPortCall?.estimatedArrival ??
    destPortCall?.estimatedTimeOfArrival ??
    portOfDischarge.eta ??
    portOfDischarge.estimatedArrival ??
    portOfDischarge.estimatedTimeOfArrival ??
    entry.eta ??
    entry.estimatedTimeOfArrival ??
    entry.estimatedArrival ??
    entry.plannedArrivalDate ??
    entry.predictedETA ??
    entry.latestEstimatedArrival ??
    entry.scheduledArrival ??
    lastLeg?.eta ??
    lastLeg?.estimatedArrival ??
    firstContainer.eta ??
    d.eta ??
    d.estimatedTimeOfArrival ??
    null;
  const etaDate = parseDate(etaRaw);
  let eta = etaDate ? etaDate.toISOString().slice(0, 10) : null;

  // ── Supplemental: recursive deep-scan for any ETA key we may have missed ────
  // Runs only when the primary field-path chain found nothing, so it never
  // overrides an already-extracted ETA.
  let deepEtaPath: string | null = null;
  if (!eta) {
    const deepResult = deepScanForEta(data);
    if (deepResult) {
      eta = deepResult.value;
      deepEtaPath = deepResult.path;
      logger.info(
        `[MaerskPublic] ${containerNumber}: ETA from deep-scan path=${deepResult.path} val=${deepResult.value}`
      );
    }
  }

  if (!latest && !eta) {
    logger.info(`[MaerskPublic] ${containerNumber}: response parseable but no useful data`);
    return { ...base, noData: true, error: "no_useful_data", raw: data };
  }

  logger.info(
    `[MaerskPublic] ${containerNumber}: success — status=${latest?.status ?? "?"} events=${events.length}` +
      ` eta=${eta ?? "none"}${deepEtaPath ? ` (deep-scan path=${deepEtaPath})` : ""}`
  );

  return {
    ...base,
    success: true,
    latestStatus: latest?.status ?? rawStr(entry.status) ?? rawStr(entry.latestStatus),
    latestLocation: latest?.location ?? null,
    latestEventDate: latest?.date ?? null,
    latestDescription: latest?.description ?? null,
    eta,
    events,
    raw: data,
  };
}
