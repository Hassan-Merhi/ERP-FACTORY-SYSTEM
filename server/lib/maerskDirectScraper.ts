/**
 * maerskDirectScraper.ts — Puppeteer-based Maersk tracking.
 *
 * Navigates to https://www.maersk.com/tracking/{container} with a stealth
 * headless browser, then intercepts the JSON API responses that Maersk's own
 * React app makes internally. Because the requests come from a real browser
 * session the Akamai/DataDome bot challenge is bypassed.
 *
 * Works for all Maersk-group prefixes: MAEU, MSKU, MRKU, MRSU,
 *   HASU, HJSC, HJCU, SUDU, SAFM (Hamburg Süd) etc.
 *
 * Memory strategy:
 *   - ONE shared Chrome process is kept alive across all scrape calls.
 *     Each scrape opens a new tab, uses it, then closes just the tab.
 *     This keeps memory at a flat ~300 MB instead of spiking per container.
 *   - A simple async mutex ensures only ONE scrape runs at a time, preventing
 *     concurrent Chrome tabs from stacking up.
 *   - If the shared browser crashes/disconnects it is automatically replaced
 *     on the next scrape call.
 *
 * Never throws — always returns a typed result.
 */

import type { HTTPResponse, Page } from "puppeteer";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "./logger";
import type { CarrierTrackResult, TrackingEvent } from "./trackingProviders/types";
import { acquirePuppeteerSlot } from "./puppeteerSemaphore";
import {
  getSharedBrowser,
  invalidateSharedBrowser,
  isMaerskDirectScraperAvailable,
  scheduleBrowserIdleShutdown,
} from "./maerskDirectBrowser";
import { deepScanForEta, extractFromJson, formatEtaDate } from "./maerskDirectParsing";

export { isMaerskDirectScraperAvailable } from "./maerskDirectBrowser";
export { deepScanForEta, extractFromJson, formatEtaDate } from "./maerskDirectParsing";


const SCRAPER_TIMEOUT_MS = 90_000;
const NAV_TIMEOUT_MS = 30_000;
const API_WAIT_MS = 20_000;

const emptyResult = (containerNumber: string, error: string): CarrierTrackResult => ({
  success: false,
  provider: "maersk_scraper",
  carrier: "MAERSK",
  containerNumber,
  latestStatus: null,
  latestLocation: null,
  latestEventDate: null,
  latestDescription: null,
  eta: null,
  events: [],
  raw: null,
  error,
});

export async function scrapeMaerskDirect(containerNumber: string): Promise<CarrierTrackResult> {
  if (!isMaerskDirectScraperAvailable()) {
    return emptyResult(containerNumber, "Puppeteer not available");
  }

  // ── Acquire global Puppeteer slot (shared with ParcelsApp scraper) ───────
  // Returns a "no_data" result immediately when the queue is full.
  logger.info(`[MaerskDirect] ${containerNumber}: waiting for Puppeteer slot…`);
  let release: () => void;
  try {
    release = await acquirePuppeteerSlot();
  } catch (err: unknown) {
    if (getErrorMessage(err) === "PUPPETEER_QUEUE_FULL") {
      logger.warn(`[MaerskDirect] ${containerNumber}: Puppeteer queue full — skipping (server busy)`);
      return emptyResult(containerNumber, "PUPPETEER_QUEUE_FULL");
    }
    throw err;
  }
  logger.info(`[MaerskDirect] ${containerNumber}: Puppeteer slot acquired`);

  let page: Page | null = null;
  const hardStop = setTimeout(() => {
    logger.warn(`[MaerskDirect] ${containerNumber}: hard timeout — closing page`);
    try {
      page?.close();
    } catch {
      /* ignore */
    }
  }, SCRAPER_TIMEOUT_MS);
  hardStop.unref?.();

  try {
    // ── Get/reuse shared browser (Option A: shared instance) ─────────────────
    const browser = await getSharedBrowser();
    page = await browser.newPage();

    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );

    // ── Intercept ALL JSON responses from maersk.com domains ─────────────────
    // No isTracking filter — we capture everything and let extractFromJson
    // decide if it contains useful data.  Logging every URL + top-level keys
    // lets us diagnose what Maersk's SPA is actually calling.
    const capturedPayloads: Array<{ url: string; data: unknown }> = [];

    page.on("response", async (response: HTTPResponse) => {
      try {
        const url: string = response.url();
        if (!/maersk\.com/i.test(url) || /\.(png|jpg|gif|svg|woff|woff2|ttf|ico|css|js)(\?|$)/i.test(url)) return;

        const status: number = response.status();
        const ct: string = response.headers()?.["content-type"] ?? "";
        if (!ct.includes("json")) return;

        const json = await response.json().catch(() => null);
        if (!json || typeof json !== "object") return;

        const topKeys =
          typeof json === "object" && !Array.isArray(json)
            ? Object.keys(json as object)
                .slice(0, 10)
                .join(",")
            : "[array]";
        const etaScan = deepScanForEta(json);
        logger.info(
          `[MaerskDirect] ${containerNumber} JSON captured: ${url.slice(0, 110)}` +
            ` status=${status} keys=[${topKeys}]` +
            (etaScan ? ` ETA_FOUND: path=${etaScan.path} val=${etaScan.value}` : "")
        );
        capturedPayloads.push({ url, data: json });
      } catch {
        /* ignore */
      }
    });

    // ── Step 1: Warm up session on Maersk homepage ────────────────────────────
    // Visiting the homepage first establishes Akamai/bot-protection cookies so
    // subsequent requests to the tracking page are treated as legitimate.
    logger.info(`[MaerskDirect] ${containerNumber}: warming up session on maersk.com…`);
    try {
      await page.goto("https://www.maersk.com", {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
    } catch {
      logger.info(`[MaerskDirect] ${containerNumber}: homepage warmup timed out — continuing`);
    }
    // Give Akamai cookies a moment to settle before hitting the tracking page.
    await new Promise((r) => setTimeout(r, 2_500));

    // ── Step 2: Navigate to Maersk's public tracking page ────────────────────
    // Use domcontentloaded — Maersk's SPA has continuous background polling
    // which means networkidle2 NEVER fires and always times out.
    const trackUrl = `https://www.maersk.com/tracking/${encodeURIComponent(containerNumber)}`;
    logger.info(`[MaerskDirect] ${containerNumber}: navigating to ${trackUrl}`);
    try {
      await page.goto(trackUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    } catch {
      logger.info(`[MaerskDirect] ${containerNumber}: domcontentloaded timed out — continuing`);
    }

    // ── Wait for API responses to arrive ─────────────────────────────────────
    logger.info(`[MaerskDirect] ${containerNumber}: waiting up to ${API_WAIT_MS / 1000}s for Maersk API data…`);
    const pollStart = Date.now();
    while (Date.now() - pollStart < API_WAIT_MS) {
      const useful = capturedPayloads.find((p) => {
        const { events, eta } = extractFromJson(p.data);
        return events.length > 0 || !!eta || !!deepScanForEta(p.data);
      });
      if (useful) break;
      await new Promise((r) => setTimeout(r, 1_000));
    }

    const finalUrl: string = page.url();
    logger.info(`[MaerskDirect] ${containerNumber}: final URL: ${finalUrl}`);
    logger.info(`[MaerskDirect] ${containerNumber}: captured ${capturedPayloads.length} JSON response(s) total`);

    // ── Parse captured API responses ──────────────────────────────────────────
    // Maersk's SPA fires several JSON calls per page (schedules, autocomplete,
    // the real tracking payload). Returning on the FIRST payload that has any
    // data risks locking onto a partial response whose ETA is missing or stale,
    // while the authoritative tracking payload arrives a moment later. Instead
    // we score EVERY captured payload and keep the richest/most authoritative
    // one: the structured "synergy" schema wins over ad-hoc shapes, a real ETA
    // beats none, and more events break ties.
    let best: {
      score: number;
      events: TrackingEvent[];
      eta: string | null;
      latestStatus: string | null;
      url: string;
      data: unknown;
      deepPath?: string;
    } | null = null;

    for (const payload of capturedPayloads) {
      const {
        events,
        eta: jsonEta,
        latestStatus: parsedStatus,
        synergy,
      } = extractFromJson(payload.data, containerNumber);

      // Also try the deep recursive scan in case extractFromJson missed a nested ETA key
      const deepEta = !jsonEta ? deepScanForEta(payload.data) : null;
      const eta = jsonEta ?? deepEta?.value ?? null;

      if (events.length === 0 && !eta) continue;

      const score = (synergy ? 1_000_000 : 0) + (eta ? 10_000 : 0) + events.length;
      if (!best || score > best.score) {
        best = {
          score,
          events,
          eta,
          latestStatus: parsedStatus,
          url: payload.url,
          data: payload.data,
          deepPath: deepEta?.path,
        };
      }
    }

    if (best) {
      const latest = best.events[0] ?? null;
      const latestActual = best.events.find((e) => e.date && e.date <= new Date()) ?? latest;
      const status = best.latestStatus ?? latestActual?.status ?? latest?.status ?? null;
      logger.info(
        `[MaerskDirect] ${containerNumber}: success from ${best.url.slice(0, 80)} — ` +
          `status=${status ?? "?"} events=${best.events.length} eta=${best.eta ?? "none"} score=${best.score}` +
          (best.deepPath ? ` (deep-scan path=${best.deepPath})` : "")
      );
      return {
        success: true,
        provider: "maersk_scraper",
        carrier: "MAERSK",
        containerNumber,
        latestStatus: status,
        latestLocation: latestActual?.location ?? latest?.location ?? null,
        latestEventDate: latestActual?.date ?? latest?.date ?? null,
        latestDescription: latestActual?.description ?? latest?.description ?? null,
        eta: best.eta,
        events: best.events,
        raw: best.data,
      };
    }

    // ── Fallback A: __NEXT_DATA__ embedded in page ────────────────────────────
    // Maersk uses Next.js; the server-side render may embed tracking data in
    // the <script id="__NEXT_DATA__"> tag even when XHR capture missed it.
    const nextDataRaw: unknown = await page
      .evaluate(() => {
        const el = document.getElementById("__NEXT_DATA__");
        if (!el) return null;
        try {
          return JSON.parse(el.textContent ?? "");
        } catch {
          return null;
        }
      })
      .catch(() => null);

    if (nextDataRaw && typeof nextDataRaw === "object") {
      const { events, eta: ndEta, latestStatus: ndStatus } = extractFromJson(nextDataRaw, containerNumber);
      const deepEta = !ndEta ? deepScanForEta(nextDataRaw) : null;
      const eta = ndEta ?? deepEta?.value ?? null;
      if (events.length > 0 || eta) {
        logger.info(
          `[MaerskDirect] ${containerNumber}: __NEXT_DATA__ hit — ` +
            `events=${events.length} eta=${eta ?? "none"}` +
            (deepEta ? ` (deep-scan path=${deepEta.path})` : "")
        );
        const latest = events[0] ?? null;
        const latestActual = events.find((e) => e.date && e.date <= new Date()) ?? latest;
        return {
          success: true,
          provider: "maersk_scraper",
          carrier: "MAERSK",
          containerNumber,
          latestStatus: ndStatus ?? latestActual?.status ?? latest?.status ?? null,
          latestLocation: latestActual?.location ?? latest?.location ?? null,
          latestEventDate: latestActual?.date ?? latest?.date ?? null,
          latestDescription: latestActual?.description ?? latest?.description ?? null,
          eta,
          events,
          raw: { source: "__NEXT_DATA__" },
        };
      }
      logger.info(`[MaerskDirect] ${containerNumber}: __NEXT_DATA__ present but no useful data`);
    } else {
      logger.info(`[MaerskDirect] ${containerNumber}: no __NEXT_DATA__ found`);
    }

    // ── Fallback B: read rendered DOM text ────────────────────────────────────
    const bodyText: string = await page.evaluate(() => document.body?.innerText?.slice(0, 8000) ?? "").catch(() => "");

    logger.info(`[MaerskDirect] ${containerNumber} DOM[0:400]: ${bodyText.slice(0, 400)}`);

    // Detect bot-challenge / error pages before attempting DOM ETA extraction
    const isBlocked = /access denied|captcha|bot.challenge|403.forbidden|challenge.required|DataDome|Akamai/i.test(
      bodyText.slice(0, 1500)
    );
    const isErrorPage = /something went wrong|unexpected error|we.re working to fix/i.test(bodyText.slice(0, 1500));

    if (isBlocked) {
      logger.info(`[MaerskDirect] ${containerNumber}: bot challenge / blocked page detected`);
      return { ...emptyResult(containerNumber, "bot_challenge"), blocked: true };
    }
    if (isErrorPage) {
      logger.info(
        `[MaerskDirect] ${containerNumber}: Maersk error page detected — no tracking data served (bot detection or backend error)`
      );
      return emptyResult(containerNumber, "maersk_error_page");
    }

    // DOM ETA labels — look for any label that explicitly means estimated arrival
    const etaMatch = bodyText.match(
      /(?:ETA|Estimated\s+(?:time\s+of\s+)?[Aa]rrival|Expected\s+[Aa]rrival|Planned\s+[Aa]rrival|Destination\s+[Aa]rrival)[:\s]+([A-Za-z]{3}\.?\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3}\.?\s+\d{4})/i
    );
    const statusMatch = bodyText.match(
      /(In Transit|Departed|Arrived|Discharged|Loaded|Delivered|Customs|Gate Out|On Board|At Sea|Vessel Arrived)/i
    );

    if (etaMatch || statusMatch) {
      const status = statusMatch?.[1] ?? null;
      const etaStr = etaMatch?.[1] ?? null;
      let eta: string | null = null;
      if (etaStr) {
        eta = formatEtaDate(
          etaStr.replace(
            /\bJan\b|\bFeb\b|\bMar\b|\bApr\b|\bMay\b|\bJun\b|\bJul\b|\bAug\b|\bSep\b|\bOct\b|\bNov\b|\bDec\b/i,
            (m) => m.slice(0, 3)
          )
        );
      }
      logger.info(
        `[MaerskDirect] ${containerNumber}: DOM label fallback — status=${status ?? "none"} eta=${eta ?? "none"}`
      );
      const fakeEvents: TrackingEvent[] = status
        ? [{ date: eta ? new Date(eta) : null, status, location: null, description: null }]
        : [];
      return {
        success: true,
        provider: "maersk_scraper",
        carrier: "MAERSK",
        containerNumber,
        latestStatus: status,
        latestLocation: null,
        latestEventDate: null,
        latestDescription: status,
        eta,
        events: fakeEvents,
        raw: { source: "dom_text", bodyText: bodyText.slice(0, 1000) },
      };
    }

    logger.info(`[MaerskDirect] ${containerNumber}: no tracking data found — 0 JSON captured, no ETA in DOM`);
    return emptyResult(containerNumber, "no_tracking_data_found");
  } catch (err: unknown) {
    const msg = getErrorMessage(err) ?? String(err);
    logger.error(`[MaerskDirect] ${containerNumber}: unexpected error`, { error: msg });

    // If the browser crashed mid-scrape, clear the shared instance so next
    // call gets a fresh one
    if (/Protocol error|Target closed|Session closed|disconnected/i.test(msg)) {
      invalidateSharedBrowser();
    }

    return emptyResult(containerNumber, `unexpected: ${msg}`);
  } finally {
    clearTimeout(hardStop);
    // Close just the tab, not the whole browser
    try {
      await page?.close();
    } catch {
      /* ignore */
    }
    release?.();
    scheduleBrowserIdleShutdown();
    logger.info(`[MaerskDirect] ${containerNumber}: Puppeteer slot released`);
  }
}
