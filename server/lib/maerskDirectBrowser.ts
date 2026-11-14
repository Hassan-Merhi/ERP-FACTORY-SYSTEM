/** Shared Maersk Puppeteer browser lifecycle and idle shutdown. */
import type { Browser } from "puppeteer";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "./logger";
import { execSync } from "child_process";
import { createRequire } from "module";
import { existingStringPath } from "./puppeteerPath";

const _require = createRequire(import.meta.url);

function getChromiumPath(): string | null {
  const envPath = existingStringPath(process.env.PUPPETEER_EXECUTABLE_PATH);
  if (envPath) return envPath;
  for (const cmd of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    try {
      const p = existingStringPath(execSync(`which ${cmd} 2>/dev/null`, { encoding: "utf8", timeout: 3000 }).trim());
      if (p) return p;
    } catch {
      /* not found */
    }
  }
  try {
    const puppeteer = _require("puppeteer");
    const candidate = typeof puppeteer.executablePath === "function" ? puppeteer.executablePath() : "";
    const bundledPath = existingStringPath(candidate);
    if (bundledPath) return bundledPath;
  } catch {
    /* not installed */
  }
  return null;
}

export function isMaerskDirectScraperAvailable(): boolean {
  try {
    _require.resolve("puppeteer-extra");
    _require.resolve("puppeteer-extra-plugin-stealth");
    _require.resolve("puppeteer");
    return !!getChromiumPath();
  } catch {
    return false;
  }
}

// ── Shared browser instance ───────────────────────────────────────────────────
// One Chrome process is reused across scrape bursts, then retired after an
// idle window so Chrome does not remain part of the server's baseline RSS.
// Replaced automatically if it crashes.

let _sharedBrowser: Browser | null = null;
let _stealthRegistered = false;
let _browserIdleTimer: ReturnType<typeof setTimeout> | null = null;

function browserIdleMs(): number {
  const parsed = Number.parseInt(String(process.env.PUPPETEER_BROWSER_IDLE_MS ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : 5 * 60 * 1000;
}

function clearBrowserIdleTimer(): void {
  if (_browserIdleTimer) clearTimeout(_browserIdleTimer);
  _browserIdleTimer = null;
}

export function scheduleBrowserIdleShutdown(): void {
  clearBrowserIdleTimer();
  if (!_sharedBrowser) return;
  _browserIdleTimer = setTimeout(() => {
    const browser = _sharedBrowser;
    _sharedBrowser = null;
    _browserIdleTimer = null;
    if (!browser) return;
    void browser.close().catch((error: unknown) => {
      logger.warn("[MaerskDirect] Idle browser shutdown failed", { error: getErrorMessage(error) });
    });
  }, browserIdleMs());
  _browserIdleTimer.unref?.();
}

export async function getSharedBrowser(): Promise<Browser> {
  clearBrowserIdleTimer();
  // If we already have a live browser, verify it's still responsive
  if (_sharedBrowser) {
    try {
      await _sharedBrowser.pages(); // lightweight liveness check
      return _sharedBrowser;
    } catch {
      logger.warn("[MaerskDirect] Shared browser disconnected — relaunching");
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
  logger.info("[MaerskDirect] Launching shared Chrome instance…");
  // puppeteer-extra is loaded through createRequire, so its launch() is untyped;
  // the handle is named as a Browser here, once, instead of leaving the module
  // level binding `any` for every later use.
  const launched: Browser = await puppeteerExtra.launch({
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
      "--disable-blink-features=AutomationControlled",
      "--window-size=1280,800",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-breakpad",
      "--disable-client-side-phishing-detection",
      "--disable-default-apps",
      "--disable-hang-monitor",
      "--disable-notifications",
      "--disable-sync",
      "--metrics-recording-only",
      "--password-store=basic",
      // Extra memory-saving flags
      "--js-flags=--max-old-space-size=256",
      "--disable-features=TranslateUI,BlinkGenPropertyTrees",
      "--renderer-process-limit=1",
    ],
  });

  _sharedBrowser = launched;

  // Auto-clear on crash so the next call relaunches cleanly
  launched.on("disconnected", () => {
    // A retired browser can finish disconnecting after a replacement has already
    // launched. Only clear shared state when this event belongs to the browser
    // that is still registered as current.
    if (_sharedBrowser === launched) {
      clearBrowserIdleTimer();
      _sharedBrowser = null;
    }
    logger.warn("[MaerskDirect] Shared browser disconnected (crash or killed)");
  });

  logger.info("[MaerskDirect] Shared Chrome instance ready");
  return launched;
}

/** Keep the same crash reset behavior as the original scraper. */
export function invalidateSharedBrowser(): void {
  _sharedBrowser = null;
}
