/**
 * parcelsAppScraper.ts — ParcelsApp website scraper via Puppeteer + stealth.
 *
 * Does NOT use the ParcelsApp API key or count against the API quota.
 * Strategy: load the real ParcelsApp tracking page in a headless Chrome with
 * the stealth plugin active, then intercept the page's own XHR/fetch response.
 * The page generates its own valid reCaptcha v3 token — we just capture the result.
 *
 * Memory management:
 *   - One Chrome process is shared across all calls (like maerskDirectScraper).
 *   - All calls are serialised through the global puppeteerSemaphore so only
 *     one browser operation runs at a time server-wide.
 *   - Each call opens a new tab, uses it, then closes just the tab.
 *   - The shared browser is kept warm between calls; it restarts automatically
 *     if it crashes.
 *
 * If reCaptcha detects the automation the API returns NO_TRACKER; we surface
 * blocked=true so the caller knows to fall back to the next provider.
 */

import type { Browser, HTTPResponse, Page } from "puppeteer";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "./logger";
import { execSync } from "child_process";
import { createRequire } from "module";
import type { ParcelsAppShipment } from "./parcelsAppClient";
import { acquirePuppeteerSlot } from "./puppeteerSemaphore";
import { existingStringPath } from "./puppeteerPath";

// createRequire lets us use require() from an ESM / "type":"module" context.
const _require = createRequire(import.meta.url);

/**
 * Returns the path to a usable Chromium binary, checking in order:
 *   1. PUPPETEER_EXECUTABLE_PATH env override
 *   2. System-installed chromium / chromium-browser / google-chrome (from Nix)
 *   3. Puppeteer's own downloaded Chrome binary
 */
function getChromiumPath(): string | null {
  // 1. Explicit env override
  const envPath = existingStringPath(process.env.PUPPETEER_EXECUTABLE_PATH);
  if (envPath) return envPath;

  // 2. System Nix / PATH binaries
  for (const cmd of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    try {
      const p = existingStringPath(execSync(`which ${cmd} 2>/dev/null`, { encoding: "utf8", timeout: 3000 }).trim());
      if (p) return p;
    } catch {
      /* not found, try next */
    }
  }

  // 3. Puppeteer bundled Chrome. Puppeteer 25+ returns a Promise here; this
  // synchronous availability probe intentionally ignores non-string candidates.
  try {
    const puppeteer = _require("puppeteer");
    const p = typeof puppeteer.executablePath === "function" ? puppeteer.executablePath() : "";
    const bundledPath = existingStringPath(p);
    if (bundledPath) return bundledPath;
  } catch {
    /* puppeteer not installed */
  }

  return null;
}

export interface ScraperResult {
  success: boolean;
  shipment: ParcelsAppShipment | null;
  /** reCaptcha / bot-detection caught us */
  blocked: boolean;
  rawResponse?: unknown;
  error?: string;
}

const SCRAPER_TIMEOUT_MS = 90_000;
const NAV_TIMEOUT_MS = 60_000;
const DATA_WAIT_MS = 25_000;

// ── Availability check ────────────────────────────────────────────────────────

export function isScraperAvailable(): boolean {
  try {
    _require.resolve("puppeteer-extra");
    _require.resolve("puppeteer-extra-plugin-stealth");
    _require.resolve("puppeteer");
    const chromePath = getChromiumPath();
    return !!chromePath;
  } catch {
    return false;
  }
}

export async function ensureChromiumInstalled(): Promise<void> {
  if (isScraperAvailable()) return;

  // Never auto-download Chrome in production. Render's ephemeral filesystem
  // means the download is lost on every restart, wasting startup time and
  // blocking the server from accepting requests. If Chrome is not pre-installed
  // via the build or PUPPETEER_EXECUTABLE_PATH, the scraper is simply disabled.
  if (process.env.NODE_ENV === "production") {
    logger.info(
      "[Puppeteer] Production environment — skipping Chrome download. " +
        "Scraper will be disabled. Set PUPPETEER_EXECUTABLE_PATH to enable it."
    );
    return;
  }

  try {
    _require.resolve("puppeteer");
  } catch {
    logger.info("[Puppeteer] puppeteer package not found — skipping Chrome download.");
    return;
  }

  try {
    const puppeteer = _require("puppeteer");
    const candidate = typeof puppeteer.executablePath === "function" ? puppeteer.executablePath() : "";
    const p = await Promise.resolve(candidate);
    if (existingStringPath(p)) return;

    logger.info("[Puppeteer] Chrome not found — downloading…");
    execSync("npx puppeteer browsers install chrome", {
      stdio: "inherit",
      timeout: 300_000,
    });
    const chromePath = getChromiumPath();
    if (existingStringPath(chromePath)) {
      logger.info("[Puppeteer] Chrome download complete — scraper ready.");
    } else {
      logger.warn("[Puppeteer] Chrome still not found after download — scraper unavailable.");
    }
  } catch (err: unknown) {
    logger.warn("[Puppeteer] Chrome setup error:", { error: getErrorMessage(err) ?? err });
  }
}

// Backward-compatible name used by the server startup pre-warm import.
export const ensureChromiumAvailable = ensureChromiumInstalled;

// ── Shared browser instance ───────────────────────────────────────────────────
// One Chrome process is kept alive and reused across all scrape calls.
// Replaced automatically if it crashes.

let _sharedBrowser: Browser | null = null;
let _stealthRegistered = false;

async function getSharedBrowser() {
  if (_sharedBrowser) {
    try {
      await _sharedBrowser.pages(); // lightweight liveness check
      return _sharedBrowser;
    } catch {
      logger.warn("[ParcelsAppScraper] Shared browser disconnected — relaunching");
      _sharedBrowser = null;
    }
  }

  const puppeteerExtra = _require("puppeteer-extra");
  if (!_stealthRegistered) {
    const StealthPlugin = _require("puppeteer-extra-plugin-stealth");
    puppeteerExtra.use(StealthPlugin());
    _stealthRegistered = true;
  }

  const chromePath = getChromiumPath();
  logger.info("[ParcelsAppScraper] Launching shared Chrome instance…");
  _sharedBrowser = (await puppeteerExtra.launch({
    headless: true,
    ...(chromePath ? { executablePath: chromePath } : {}),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--renderer-process-limit=1", // cap renderer processes
      "--js-flags=--max-old-space-size=256",
      // Anti-detection
      "--disable-blink-features=AutomationControlled",
      "--window-size=1280,800",
      // Memory reduction
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-breakpad",
      "--disable-client-side-phishing-detection",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-domain-reliability",
      "--disable-hang-monitor",
      "--disable-infobars",
      "--disable-notifications",
      "--disable-popup-blocking",
      "--disable-print-preview",
      "--disable-renderer-backgrounding",
      "--disable-sync",
      "--disable-features=TranslateUI,BlinkGenPropertyTrees",
      "--metrics-recording-only",
      "--safebrowsing-disable-auto-update",
      "--password-store=basic",
    ],
  })) as Browser;

  const browser = _sharedBrowser;
  browser.on("disconnected", () => {
    logger.warn("[ParcelsAppScraper] Shared browser disconnected (crash or killed)");
    _sharedBrowser = null;
  });

  logger.info("[ParcelsAppScraper] Shared Chrome instance ready");
  return browser;
}

// ── Main scrape function ──────────────────────────────────────────────────────

export async function scrapeTracking(containerNumber: string): Promise<ScraperResult> {
  if (!isScraperAvailable()) {
    return { success: false, shipment: null, blocked: false, error: "Puppeteer not installed" };
  }

  // Acquire global slot — ensures at most 1 Puppeteer operation server-wide.
  // Rejects immediately with PUPPETEER_QUEUE_FULL when too many callers are waiting.
  logger.info(`[ParcelsAppScraper] ${containerNumber}: waiting for Puppeteer slot…`);
  let release: () => void;
  try {
    release = await acquirePuppeteerSlot();
  } catch (err: unknown) {
    if (getErrorMessage(err) === "PUPPETEER_QUEUE_FULL") {
      logger.warn(`[ParcelsAppScraper] ${containerNumber}: Puppeteer queue full — skipping (server busy)`);
      return { success: false, shipment: null, blocked: false, error: "PUPPETEER_QUEUE_FULL" };
    }
    throw err;
  }
  logger.info(`[ParcelsAppScraper] ${containerNumber}: Puppeteer slot acquired`);

  let page: Page | null = null;
  const hardStop = setTimeout(() => {
    logger.warn(`[ParcelsAppScraper] ${containerNumber}: hard timeout — closing page`);
    try {
      page?.close();
    } catch {
      /* ignore */
    }
  }, SCRAPER_TIMEOUT_MS);

  try {
    const browser = await getSharedBrowser();
    page = await browser.newPage();

    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    );

    let capturedData: unknown = null;
    let isBlocked = false;

    // Intercept ParcelsApp API responses (v2 and v3, all known endpoints)
    page.on("response", async (response: HTTPResponse) => {
      const url: string = response.url();
      if (
        url.includes("parcelsapp.com") &&
        (url.includes("/api/v2/parcel") ||
          url.includes("/api/v2/shipment") ||
          url.includes("/api/v3/shipment") ||
          url.includes("/api/v3/shipments") ||
          url.includes("/api/v3/track") ||
          url.includes("/api/v3/parcel"))
      ) {
        try {
          const json = await response.json().catch(() => null);
          if (!json) return;

          // Detect bot/captcha rejection
          if (
            json?.error === "NO_TRACKER" ||
            json?.blocked === true ||
            json?.status === "blocked" ||
            (typeof json?.error === "string" && /captcha|recaptcha|bot/i.test(json.error))
          ) {
            isBlocked = true;
            return;
          }

          // Accept any response that has shipments/parcels array
          if (json?.shipments?.length || json?.parcels?.length) {
            capturedData = json;
          }
        } catch {
          // ignore parse errors on unrelated requests
        }
      }
    });

    await page.goto(`https://parcelsapp.com/en/tracking/${encodeURIComponent(containerNumber)}`, {
      waitUntil: "networkidle2",
      timeout: NAV_TIMEOUT_MS,
    });

    // Wait up to DATA_WAIT_MS for data to arrive after navigation
    const deadline = Date.now() + DATA_WAIT_MS;
    while (!capturedData && !isBlocked && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1_000));
    }

    clearTimeout(hardStop);
    try {
      await page.close();
    } catch {
      /* ignore */
    }
    page = null;
    release?.();

    if (isBlocked) {
      return {
        success: false,
        shipment: null,
        blocked: true,
        error: "reCaptcha detected automation — stealth plugin bypassed",
      };
    }

    if (!capturedData) {
      return {
        success: false,
        shipment: null,
        blocked: false,
        error: "No tracking data received from ParcelsApp page",
      };
    }

    const data = capturedData as unknown as { shipments: ParcelsAppShipment[] } & { parcels: ParcelsAppShipment[] };
    const all: ParcelsAppShipment[] = data.shipments ?? data.parcels ?? [];
    const shipment =
      all.find((s: ParcelsAppShipment) => s.trackingId === containerNumber || s.id === containerNumber) ??
      all[0] ??
      null;

    return {
      success: !!shipment,
      shipment,
      blocked: false,
      rawResponse: capturedData,
      error: shipment ? undefined : "No matching shipment in page response",
    };
  } catch (err: unknown) {
    clearTimeout(hardStop);
    if (page) {
      try {
        await page.close();
      } catch {
        /* ignore */
      }
    }
    release?.();
    return {
      success: false,
      shipment: null,
      blocked: false,
      error: `Scraper error: ${getErrorMessage(err) ?? "Unknown"}`,
    };
  }
}
