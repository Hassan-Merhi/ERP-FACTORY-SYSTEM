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

import type { CarrierTrackResult } from "./types";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { TIMEOUT_MS, _lastAttempt, parseResponse } from "./maerskPublicProviderHelpers";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const PUBLIC_BASE = "https://www.maersk.com/api/tracking";
const PUBLIC_PAGE = "https://www.maersk.com/tracking";
const RATE_LIMIT_MS = 6 * 60 * 60 * 1_000; // 6 hours

const RATE_LIMIT_MAX_ENTRIES = Math.max(
  100,
  Number.parseInt(process.env.TRACKING_RATE_LIMIT_MAX_ENTRIES || "5000", 10) || 5000
);

function pruneRateLimitState(now = Date.now()): void {
  for (const [containerNumber, lastAttempt] of _lastAttempt) {
    if (now - lastAttempt >= RATE_LIMIT_MS) _lastAttempt.delete(containerNumber);
  }
  while (_lastAttempt.size > RATE_LIMIT_MAX_ENTRIES) {
    const oldest = _lastAttempt.keys().next().value;
    if (oldest === undefined) break;
    _lastAttempt.delete(oldest);
  }
}

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

  const attemptAt = Date.now();
  pruneRateLimitState(attemptAt);
  _lastAttempt.delete(containerNumber);
  _lastAttempt.set(containerNumber, attemptAt);
  pruneRateLimitState(attemptAt);

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
