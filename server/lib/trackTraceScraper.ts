/**
 * trackTraceScraper.ts — track-trace.com Puppeteer scraper.
 *
 * Strategy (zero DOM interaction — guaranteed no "detached frame" errors):
 *   1. Navigate to https://www.track-trace.com/container#<number> using
 *      networkidle2 — the site reads the hash and auto-submits the search.
 *   2. Wait 10 s for AJAX / iframe rendering to complete.
 *   3. Read ALL data via page.evaluate() — returns plain JS values, holds
 *      zero ElementHandle/frame references that can go stale.
 *   4. Parse results from body text and captured JSON responses.
 *
 * Never throws — always returns a typed result.
 */

import type { Browser, HTTPResponse, Target } from "puppeteer";
import { existsSync } from "fs";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "./logger";
import { execSync } from "child_process";
import { createRequire } from "module";
import type { ParcelsAppShipment } from "./parcelsAppClient";

const _require = createRequire(import.meta.url);

function getChromiumPath(): string | null {
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (envPath && existsSync(envPath)) return envPath;
  for (const cmd of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    try {
      const p = execSync(`which ${cmd} 2>/dev/null`, { encoding: "utf8", timeout: 3000 }).trim();
      if (p && existsSync(p)) return p;
    } catch {
      /* not found */
    }
  }
  try {
    const puppeteer = _require("puppeteer");
    const p: string = typeof puppeteer.executablePath === "function" ? puppeteer.executablePath() : "";
    if (p && existsSync(p)) return p;
  } catch {
    /* not installed */
  }
  return null;
}

export interface TrackTraceResult {
  success: boolean;
  shipment: ParcelsAppShipment | null;
  blocked: boolean;
  rawResponse?: unknown;
  error?: string;
}

const SCRAPER_TIMEOUT_MS = 90_000;
const NAV_TIMEOUT_MS = 30_000;

export function isTrackTraceScraper(): boolean {
  try {
    _require.resolve("puppeteer-extra");
    _require.resolve("puppeteer-extra-plugin-stealth");
    _require.resolve("puppeteer");
    return !!getChromiumPath();
  } catch {
    return false;
  }
}

/** Parse a date string into YYYY-MM-DD. Returns null if unparseable. */
function parseDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s || s === "-" || s === "—" || s.toLowerCase() === "n/a") return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const ddMonYYYY = s.match(/^(\d{1,2})[-/\s]([A-Za-z]{3})[-/\s](\d{4})/);
  if (ddMonYYYY) {
    const months: Record<string, string> = {
      jan: "01",
      feb: "02",
      mar: "03",
      apr: "04",
      may: "05",
      jun: "06",
      jul: "07",
      aug: "08",
      sep: "09",
      oct: "10",
      nov: "11",
      dec: "12",
    };
    const m = months[ddMonYYYY[2].toLowerCase()];
    if (m) return `${ddMonYYYY[3]}-${m}-${ddMonYYYY[1].padStart(2, "0")}`;
  }
  const monDDYYYY = s.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})/);
  if (monDDYYYY) {
    const months: Record<string, string> = {
      jan: "01",
      feb: "02",
      mar: "03",
      apr: "04",
      may: "05",
      jun: "06",
      jul: "07",
      aug: "08",
      sep: "09",
      oct: "10",
      nov: "11",
      dec: "12",
    };
    const m = months[monDDYYYY[1].toLowerCase()];
    if (m) return `${monDDYYYY[3]}-${m}-${monDDYYYY[2].padStart(2, "0")}`;
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

export async function scrapeTrackTrace(containerNumber: string): Promise<TrackTraceResult> {
  if (!isTrackTraceScraper()) {
    return { success: false, shipment: null, blocked: false, error: "Puppeteer not available" };
  }

  let browser: Browser | null = null;
  const hardStop = setTimeout(() => {
    try {
      browser?.close();
    } catch {
      /* ignore */
    }
  }, SCRAPER_TIMEOUT_MS);

  try {
    const puppeteerExtra = _require("puppeteer-extra");
    const StealthPlugin = _require("puppeteer-extra-plugin-stealth");
    puppeteerExtra.use(StealthPlugin());

    const chromePath = getChromiumPath();
    browser = (await puppeteerExtra.launch({
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
      ],
    })) as Browser;

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    );

    // Capture JSON from ANY domain — track-trace proxies carrier data or embeds
    // cross-origin iframes, so we need to catch responses from all sources.
    let capturedJson: unknown = null;
    const capturedResponses: Array<{ url: string; data: unknown }> = [];
    page.on("response", async (response: HTTPResponse) => {
      try {
        const url: string = response.url();
        // Skip noise: images, fonts, analytics, ads
        if (/\.(png|jpg|gif|svg|woff|woff2|ttf|ico|css)(\?|$)/i.test(url)) return;
        if (
          /google|doubleclick|googletag|facebook|analytics|adnxs|adsystem|flashtalking|ad-score|advertising|adserver|adtech|amazon-adsystem/i.test(
            url
          )
        )
          return;
        const ct: string = response.headers()["content-type"] ?? "";
        if (!ct.includes("json") && !ct.includes("javascript")) return;
        const json = await response.json().catch(() => null);
        if (!json || typeof json !== "object") return;
        capturedResponses.push({ url, data: json });
        // Only capture responses that look like real shipping/tracking data.
        // Require at least TWO of the maritime keywords to avoid ad payloads that
        // incidentally contain a single common word (e.g. "container" in an ad URL).
        const body = JSON.stringify(json);
        const maritimeMatches = (
          body.match(
            /\b(eta|vessel|port|transit|arrived|departed|discharged|loaded|movement|milestone|shipment|tracking|voyage|bill.of.lading|bl.number|booking)\b/gi
          ) ?? []
        ).length;
        // Also reject if it looks like an ad creative payload
        const isAdPayload = /\b(zIndex|jsVPaid|campaign|adChoice|creative|adserver|flashtalking|surveys)\b/i.test(body);
        if (maritimeMatches >= 2 && !isAdPayload && !capturedJson) capturedJson = json;
      } catch {
        /* ignore */
      }
    });

    // ── Step 1: navigate with hash URL (auto-triggers the search) ─────────────
    // track-trace.com reads window.location.hash on load and runs the search.
    // networkidle2 waits until the AJAX tracking call completes (≤2 open reqs).
    const hashUrl = `https://www.track-trace.com/container#${encodeURIComponent(containerNumber)}`;
    logger.info(`[TrackTrace] Navigating to ${hashUrl}`);
    try {
      await page.goto(hashUrl, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS });
    } catch {
      logger.info(`[TrackTrace] networkidle2 timed out — continuing with what loaded`);
    }

    // ── Step 2: wait for hash-based pre-fill, then submit via evaluate() ────────
    // track-trace.com reads the hash and pre-fills the input but does NOT
    // auto-submit. We wait 4 s for the JS to settle, then click submit entirely
    // inside page.evaluate() — returns a plain boolean, holds zero frame refs.
    logger.info(`[TrackTrace] Waiting 4 s for hash pre-fill…`);
    await new Promise((r) => setTimeout(r, 4_000));

    // Set up new-tab listener BEFORE clicking — "Track direct" opens a popup/tab
    const activeBrowser = browser;
    let newTabUrl: string | null = null;
    const newTabPromise = new Promise<string | null>((resolve) => {
      const handler = (target: Target) => {
        try {
          const url: string = target.url?.() ?? "";
          if (url && url.startsWith("http") && !url.includes("track-trace.com")) {
            activeBrowser.off("targetcreated", handler);
            resolve(url);
          }
        } catch {
          /* ignore */
        }
      };
      activeBrowser.on("targetcreated", handler);
      // Auto-resolve after 12 s if no new tab opens
      setTimeout(() => {
        activeBrowser.off("targetcreated", handler);
        resolve(null);
      }, 12_000);
    });

    // Inspect the page to find the "Track direct" link href and form action
    const pageInfo: { directHref: string | null; formAction: string | null; inputValue: string | null } = await page
      .evaluate((cn: string) => {
        const inputSels = [
          'input[name="query"]',
          'input[name="number"]',
          'input[name="container"]',
          'input[name="q"]',
          'input[name="trackingNumber"]',
          "#number",
          "#query",
          'input[type="text"]',
        ];
        let input: HTMLInputElement | null = null;
        for (const sel of inputSels) {
          const el = document.querySelector(sel) as HTMLInputElement | null;
          if (el) {
            input = el;
            break;
          }
        }

        // Ensure value is set
        if (input && !input.value) {
          input.value = cn;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }

        // Find "Track direct" link href
        const allEls = Array.from(document.querySelectorAll("a, button, input[type=submit]")) as HTMLElement[];
        const directEl = allEls.find((el) => {
          const t = (el.textContent ?? "").trim().toLowerCase();
          return t === "track direct" || t === "track" || t === "go";
        });
        const directHref = directEl instanceof HTMLAnchorElement ? directEl.href || null : null;

        const form = input?.closest("form");
        const formAction = form ? form.action || null : null;
        const inputValue = input?.value ?? null;

        return { directHref, formAction, inputValue };
      }, containerNumber)
      .catch(() => ({ directHref: null, formAction: null, inputValue: null }));

    logger.info(`[TrackTrace] pageInfo`, { pageInfo });

    // Navigate directly to the results URL if we have one; otherwise form-submit
    if (pageInfo.directHref && pageInfo.directHref !== page.url()) {
      logger.info(`[TrackTrace] Navigating directly to: ${pageInfo.directHref}`);
      try {
        await page.goto(pageInfo.directHref, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS });
      } catch {
        logger.info(`[TrackTrace] Direct nav networkidle2 timed out — continuing`);
      }
    } else {
      // Fall back: click/submit via evaluate()
      const submitResult: string = await page
        .evaluate((_cn: string): string => {
          const allLinks = Array.from(
            document.querySelectorAll("a, button, input[type=submit], input[type=button]")
          ) as HTMLElement[];
          const directBtn = allLinks.find((el) => {
            const t = (el.textContent ?? "").trim().toLowerCase();
            return t === "track direct" || t === "track" || t === "go" || t === "search";
          });
          if (directBtn) {
            directBtn.click();
            return `clicked:${directBtn.textContent?.trim()}`;
          }

          const form = (document.querySelector('input[type="text"]') as HTMLElement | null)?.closest("form");
          if (form) {
            (form as HTMLFormElement).submit();
            return "form_submitted";
          }
          return "no_submit_found";
        }, containerNumber)
        .catch(() => "evaluate_error");
      logger.info(`[TrackTrace] Submit fallback: ${submitResult}`);
    }

    // Wait for new tab OR try reading iframe contentDocument (same-origin about:blank)
    logger.info(`[TrackTrace] Waiting for new tab or iframe content (up to 12 s)…`);
    newTabUrl = await newTabPromise;
    logger.info(`[TrackTrace] New tab URL: ${newTabUrl ?? "none"}`);

    // Also try reading iframe contentDocument — works if track-trace writes
    // content into about:blank iframes via document.write() (same-origin)
    const iframeTexts: string[] = await page
      .evaluate(() =>
        Array.from(document.querySelectorAll("iframe")).map((f) => {
          try {
            return (f as HTMLIFrameElement).contentDocument?.body?.innerText?.slice(0, 2000) ?? "";
          } catch {
            return "cross-origin";
          }
        })
      )
      .catch(() => [] as string[]);
    const iframeContent = iframeTexts.filter((t) => t && t !== "cross-origin" && t.trim().length > 20).join("\n");
    if (iframeContent) logger.info(`[TrackTrace] Iframe content found: ${iframeContent.slice(0, 300)}`);

    if (newTabUrl) {
      // Navigate main page to the carrier URL that opened in the new tab
      logger.info(`[TrackTrace] Following new tab → ${newTabUrl}`);
      try {
        await page.goto(newTabUrl, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS });
      } catch {
        logger.info(`[TrackTrace] Carrier page nav timed out — continuing`);
      }
      await new Promise((r) => setTimeout(r, 6_000));
    } else if (!iframeContent) {
      await new Promise((r) => setTimeout(r, 2_000));
    }

    // ── Step 3: read everything via page.evaluate() ────────────────────────────
    // evaluate() runs JS inside the page context and returns plain JS values.
    // It does NOT hold a frame reference — safe across any internal navigation.
    const finalUrl: string = page.url();

    const debugBodyText: string = await page
      .evaluate(() => document.body?.innerText?.slice(0, 4000) ?? "")
      .catch(() => "");

    const debugHtml: string = await page
      .evaluate(() => document.documentElement?.innerHTML?.slice(0, 8000) ?? "")
      .catch(() => "");

    logger.info(`[TrackTrace] url=${finalUrl}`);
    logger.info(`[TrackTrace] ${containerNumber} body[0:400]: ${debugBodyText.slice(0, 400)}`);

    // ── Step 4: extract tracking data from the rendered page ──────────────────
    const extracted = await page
      .evaluate((cn: string) => {
        const bodyText = document.body?.innerText ?? "";

        const rows = Array.from(document.querySelectorAll("tr")).filter((tr) => {
          const text = tr.textContent ?? "";
          return (
            text.includes(cn) ||
            /transit|departed|arrived|discharged|loaded|delivered|customs|gate|on board|at sea|vessel|port/i.test(text)
          );
        });

        let bestEta: string | null = null;
        let bestStatus: string | null = null;
        let bestLocation: string | null = null;
        const events: Array<{ date: string; status: string; location: string }> = [];

        for (const row of rows.slice(0, 30)) {
          const cells = Array.from(row.querySelectorAll("td, th")).map((td) => td.textContent?.trim() ?? "");
          if (cells.length < 2) continue;

          for (const cell of cells) {
            if (
              !bestEta &&
              (/\d{1,2}[-/\s][A-Za-z]{3}[-/\s]\d{4}/.test(cell) ||
                /\d{4}-\d{2}-\d{2}/.test(cell) ||
                /[A-Za-z]{3}\s+\d{1,2}[,\s]+\d{4}/.test(cell) ||
                /\d{2}\/\d{2}\/\d{4}/.test(cell))
            ) {
              bestEta = cell;
            }
            if (
              !bestStatus &&
              /transit|departed|arrived|discharged|loaded|delivered|customs|gate out|on board|at sea/i.test(cell)
            ) {
              bestStatus = cell;
            }
          }
          const meaningful = cells.filter((c) => c.length > 2 && c !== cn && !/^\d+$/.test(c));
          if (meaningful.length > 0 && !bestLocation) {
            bestLocation = meaningful[meaningful.length - 1];
          }
        }

        // Labelled ETA fields
        if (!bestEta) {
          document.querySelectorAll("td, th, span, div, label, b, strong").forEach((el) => {
            if (!bestEta && /^eta[:\s]*$/i.test(el.textContent?.trim() ?? "")) {
              const next =
                el.nextElementSibling?.textContent?.trim() ??
                el.parentElement?.nextElementSibling?.textContent?.trim() ??
                "";
              if (next && next !== "-" && next !== "—") bestEta = next;
            }
          });
        }

        // Full-body text scan
        if (!bestEta) {
          const etaMatch = bodyText.match(
            /ETA[:\s]*([A-Za-z]{3}[\s\-/]\d{1,2}[\s\-/,\s]*\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}[\s\-/][A-Za-z]{3}[\s\-/]\d{4}|\d{2}\/\d{2}\/\d{4})/i
          );
          if (etaMatch) bestEta = etaMatch[1];
        }
        if (!bestStatus) {
          const sm = bodyText.match(
            /(In Transit|Departed|Arrived|Discharged|Loaded|Delivered|Customs|Gate Out|On Board|At Sea)/i
          );
          if (sm) bestStatus = sm[1];
        }
        if (!bestLocation) {
          const lm = bodyText.match(/(?:POD|Port of Discharge|Location)[:\s]+([A-Z][A-Za-z\s,]+?)(?:\n|$)/i);
          if (lm) bestLocation = lm[1].trim();
        }

        return { bestEta, bestStatus, bestLocation, events, pageTitle: document.title };
      }, containerNumber)
      .catch(() => ({
        bestEta: null,
        bestStatus: null,
        bestLocation: null,
        events: [],
        pageTitle: "",
      }));

    logger.info(
      `[TrackTrace] ${containerNumber}: status="${extracted.bestStatus ?? "none"}" ` +
        `eta="${extracted.bestEta ?? "none"}" location="${extracted.bestLocation ?? "none"}"`
    );

    if (!extracted.bestStatus && !extracted.bestEta && !extracted.bestLocation) {
      const isBlocked = /captcha|robot|blocked|403|access denied|verify you are human|datadome/i.test(debugBodyText);
      return {
        success: false,
        shipment: null,
        blocked: isBlocked,
        error: isBlocked ? "track-trace: bot detection triggered" : "track-trace: no tracking data found on page",
        rawResponse: {
          debugBodyText: debugBodyText.slice(0, 2000),
          debugHtml: debugHtml.slice(0, 3000),
          finalUrl,
          inputFound: true,
          resultsFound: false,
        },
      };
    }

    const eta = parseDate(extracted.bestEta);
    const status = extracted.bestStatus ?? null;
    const location = extracted.bestLocation ?? null;

    const shipment: ParcelsAppShipment = {
      trackingId: containerNumber,
      done: true,
      attributes: {
        ...(status ? { status } : {}),
        ...(location ? { location } : {}),
        ...(eta ? { estimatedArrival: eta } : {}),
      },
      states:
        extracted.events.length > 0
          ? extracted.events
          : status
            ? [{ date: new Date().toISOString().slice(0, 10), status, location: location ?? "" }]
            : [],
    };

    return {
      success: true,
      shipment,
      blocked: false,
      rawResponse: { extracted, capturedJson, finalUrl, debugBodyText: debugBodyText.slice(0, 1000) },
    };
  } catch (err: unknown) {
    const msg = getErrorMessage(err) ?? String(err);
    logger.error(`[TrackTrace] ${containerNumber}: unexpected error —`, { error: msg });
    return {
      success: false,
      shipment: null,
      blocked: false,
      error: `track-trace: ${msg}`,
      rawResponse: { crashError: msg, stage: "browser_launch_or_navigation" },
    };
  } finally {
    clearTimeout(hardStop);
    try {
      await browser?.close();
    } catch {
      /* ignore */
    }
  }
}
