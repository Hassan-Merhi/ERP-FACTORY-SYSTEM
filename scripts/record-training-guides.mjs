/**
 * Capture narrated, real ERP / Factory UI training videos from the disposable
 * Phase 7 CI fixture only. This runner deliberately has no open-ended AI click
 * agent and makes no accounting/stock writes. Editing the tour registry
 * requires code review.
 *
 * Each video walks through EVERY control of the page with a spoken
 * explanation, a highlight ring, a smoothly moving pointer and captions. Menus,
 * dropdown lists and dialogs are opened so the controls hidden inside them are
 * explained too, and safe demonstrations (typing into a search box, choosing an
 * option from a list) show what each one does. The shared top bar and sidebar
 * are explained once, in the overview video of each mode. The spoken script is
 * generated deterministically from the real controls (scripts/training-
 * narration.mjs) and voiced offline by a local Piper model.
 *
 * Output per topic: screen.mp4 (H.264 + AAC), screenshot.png, captions.vtt,
 * guide.md (full transcript) and an entry in report.json.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { URL, fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import {
  describeControl, describeHeading, introNarration, closingNarration, sharedChromeNarration,
  layerIntro, demoNarration, speakable, parseWav, joinWavClips, vttTimestamp,
} from "./training-narration.mjs";
import { enumerateScreen, measurePageData, openLayerType, locateAndScroll, paintOverlay, CURSOR_SVG } from "./training-screen.mjs";

const base = process.env.TRAINING_BASE_URL || "http://127.0.0.1:5000";
const username = process.env.ERP_E2E_USERNAME || "";
const password = process.env.ERP_E2E_PASSWORD || "";
const selectedTopic = process.env.TRAINING_TOPIC || "factory-overview";
const ttsModel = process.env.TRAINING_TTS_MODEL || "";
const ttsPython = process.env.TRAINING_TTS_PYTHON || "python3";
const ttsLengthScale = process.env.TRAINING_TTS_LENGTH_SCALE || "0.95";
const output = path.resolve("artifacts/training-videos");
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const timeout = 45_000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const execFile = promisify(execFileCallback);

// Frame capture avoids Puppeteer's FFmpeg pipe; its VP9 screencast can crash
// with EPIPE on long recordings. Screen frames are captured while each sentence
// is "spoken" and muxed with the narration at CAPTURE_FPS; the pointer is then
// composited by FFmpeg at OUTPUT_FPS so it glides instead of jumping.
const CAPTURE_FPS = 2;
// 12 fps keeps the pointer smooth while the screen itself changes at
// CAPTURE_FPS; with CRF 27 a narrated page tour stays a few MB, so a full
// all-pages set fits the private store comfortably.
const OUTPUT_FPS = 12;
const SEGMENT_PAUSE_SECONDS = 0.35;
const CURSOR_TRAVEL_SECONDS = 0.6;
const MIN_DURATION_SECONDS = 60;
// Per-page caps; the nightly all-pages recording sets shorter limits so every
// page fits in its shard.
const MAX_DURATION_SECONDS = Number(process.env.TRAINING_MAX_SECONDS || 1200);
const MAX_SEGMENTS = Number(process.env.TRAINING_MAX_SEGMENTS || 220);
const MAX_TABS = 14;
const MAX_LAYERS = 12;
const MAX_LAYER_CONTROLS = 14;
const MAX_SAME_PREFIX = 2;

const TOURS = Object.freeze({
  "factory-overview": { explainsSharedChrome: true, company: "PHASE7-FACTORY", route: "/factory/production-report", title: "Factory overview", steps: ["Check the active Factory company and date range before interpreting the production report.","Read the summary totals and compare them with the visible production breakdown.","Review the available tabs and filters; a filtered view is not a new transaction.","Scroll through the records and inspect the source rows behind each summary.","Use the menu to locate detailed Factory pages. This overview never posts or changes stock."] },
  "factory-stock-entry": { company: "PHASE7-FACTORY", route: "/factory/stock-entry", title: "Factory stock entry", steps: ["Open Stock Entry and confirm the factory and production date shown.","Identify the visible stock-entry fields, including product and quantity information.","Review production rows, units and totals before entering any actual values.","Inspect available tabs and scroll to understand how entries are organized.","A real entry requires checking details before saving. This tour does not submit production."] },
  "factory-raw-materials": { company: "PHASE7-FACTORY", route: "/factory/raw-materials", title: "Raw materials", steps: ["Start on Raw Materials and verify the company and reporting context.","Locate the raw-material inventory and any visible quantity or cost columns.","Inspect the available sections, tabs and filters for different material views.","Scroll through the material rows to understand weight, cost and status information.","Check supplier and stock details before real changes. No raw stock is edited in this tour."] },
  "factory-bale-explorer": { company: "PHASE7-FACTORY", route: "/factory/bales-hub", title: "Bale Explorer", steps: ["Open Bale Explorer to understand where factory bale information is viewed.","Locate visible searches, identifiers and filtering options for finding a bale.","Check the available tabs and the data shown for sample bales.","Scroll through records to understand traceability and status without editing them.","Use the correct bale identifier when investigating issues. This recording never rescans a bale."] },
  "factory-containers": { company: "PHASE7-FACTORY", route: "/factory/containers-hub", title: "Factory containers", steps: ["Open the Containers workspace and verify that the example Factory is selected.","Find the container lists, statuses and identifying information on this screen.","Explore the available tabs or filters to distinguish loading and container views.","Scroll to see how container detail rows relate to quantity and cost information.","Review weights and charges carefully before real offloads. This tour makes no changes."] },
  "factory-stock-allocation": { company: "PHASE7-FACTORY", route: "/factory/stock-allocation-v5", title: "Stock allocation", steps: ["Open Stock Allocation and check the company and current allocation context.","Identify item quantities, customer details and any prices visible on the page.","Examine the filters and tabs that change which items are displayed.","Scroll through available item rows and compare totals with the selected view.","Verify quantities and agreed prices before actual allocation. Nothing is saved here."] },
  "factory-invoicing": { company: "PHASE7-FACTORY", route: "/factory/invoicing", title: "Factory invoicing", steps: ["Open Factory Invoicing and identify the available invoice sections.","Review customer, date and value fields shown in the current invoice view.","Inspect available tabs and filters for invoices with different statuses.","Scroll through the listed invoices and review the information needed for validation.","Actual invoices need verification before finalizing. This tutorial creates none."] },
  "factory-payroll": { company: "PHASE7-FACTORY", route: "/factory/payroll-hub", title: "Payroll and benefits", steps: ["Open Payroll and Benefits and confirm the active company and period.","Locate visible employee, attendance and payroll management sections.","Review tabs and available filters for understanding the pay period.","Scroll through payroll-related rows and check how balances and statuses are displayed.","Review supporting attendance before paying. No salary, bonus or voucher is posted here."] },
  "factory-accounts": { company: "PHASE7-FACTORY", route: "/factory/accounts", title: "Factory accounts", steps: ["Open Factory Accounts and confirm the company and selected statement period.","Locate the account balances, statement controls and ledger information.","Inspect the available tabs, search or date filters to narrow the account view.","Scroll through the ledger entries and compare movements with the displayed balance.","Real corrections require supporting transactions. This tour does not alter accounts."] },
  "factory-analytics": { company: "PHASE7-FACTORY", route: "/factory/analytics", title: "Factory analytics", steps: ["Open Factory Analytics and check which date range is being reported.","Review the key metrics and identify the totals represented on this page.","Try the available tabs or view filters to inspect another breakdown.","Scroll through charts or report sections and compare figures to their time periods.","Analytics is for analysis; verify source records before acting on these numbers."] },
  "erp-tracking": { explainsSharedChrome: true, company: "PHASE7-ERP", route: "/tracking", title: "ERP tracking", steps: ["Open ERP Tracking and confirm the correct company is active.","Locate the visible shipment, item or tracking information on this page.","Inspect the tabs and available filters to narrow the results.","Scroll through the records to understand identifiers and tracking status.","Use tracking details to investigate a movement. This guided recording changes nothing."] },
  "erp-inventory": { company: "PHASE7-ERP", route: "/inventory", title: "ERP inventory", steps: ["Open ERP Inventory and confirm the current company and location.","Review visible items, quantities and stock availability information.","Inspect the available inventory tabs, search and filtering controls.","Scroll through the item records and compare quantities across the current view.","Verify stock before transferring or adjusting inventory. This tour performs no transfer."] },
  "erp-pos": { company: "PHASE7-ERP", route: "/pos", title: "ERP point of sale", steps: ["Open Point of Sale and verify the correct company and POS context.","Locate the product list, search and available sales controls.","Inspect tabs or other visible options used to navigate POS information.","Review the sample items and prices without adding or completing an order.","An actual sale affects stock and accounts; this tour does not create a sale."] },
  "erp-vouchers": { company: "PHASE7-ERP", route: "/vouchers", title: "ERP vouchers", steps: ["Open Vouchers and identify the current company and voucher list.","Review available voucher dates, amounts and status information.","Inspect voucher tabs or filters that separate different records.","Scroll through the entries to understand how voucher history is displayed.","Review debit and credit details before posting. This demonstration posts nothing."] },
  "erp-daybook": { company: "PHASE7-ERP", route: "/daybook", title: "ERP Daybook", steps: ["Open the ERP Daybook and check the active company and selected date.","Review the listed transactions and identify the information shown per entry.","Inspect visible filters or tabs to focus on a particular date or type.","Scroll through the records to understand how daily activity is organized.","Cross-check source vouchers when investigating differences. The tour is read-only."] },
  "erp-reports": { company: "PHASE7-ERP", route: "/sales-report", title: "ERP Sales Report", steps: ["Open Sales Report and confirm the active ERP company and reporting period.","Review the visible sales totals and their units or currency.","Inspect date, category or other available report filters.","Scroll through detailed rows and compare them to the summary values.","Use this report to investigate sales; it does not create invoices or stock movements."] },
});


// TRAINING_TOPIC: "all" (the curated tours), "all-pages" (every page the fixture
// Developer can open in each training company), or comma-separated topic ids.
const chosenIds =
  selectedTopic === "all" || selectedTopic === "all-pages"
    ? []
    : [...new Set(selectedTopic.split(",").map((id) => id.trim()).filter(Boolean))];
const wantsDiscovery = selectedTopic === "all-pages" || chosenIds.some((id) => !TOURS[id]);
// TRAINING_SHARD="i/n" records every n-th selected page, starting at i (0-based).
const shardMatch = /^(\d+)\/(\d+)$/.exec(process.env.TRAINING_SHARD || "");
const shardIndex = shardMatch ? Number(shardMatch[1]) : 0;
const shardCount = shardMatch ? Math.max(1, Number(shardMatch[2])) : 1;
const allowPartial = process.env.TRAINING_ALLOW_PARTIAL === "1";

/** Same id rule as Help & Training (client/src/training/helpTrainingTopics.ts). */
const CURATED_ID_BY_ROUTE = new Map(Object.entries(TOURS).map(([id, tour]) => [tour.route, id]));
function topicIdForRoute(route) {
  const pathOnly = route.split(/[?#]/, 1)[0] || "/";
  const curated = CURATED_ID_BY_ROUTE.get(pathOnly);
  if (curated) return curated;
  return ("page-" + pathOnly.replace(/^\/+/, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()).slice(0, 80);
}

// Developer and maintenance tools are not taught in training videos.
const SKIPPED_ROUTE = /\/(help-training|settings|my-settings|chat|chatbot-settings|spreadsheet|live-sheets|company-data-reset|deleted-items|orphaned-records|conflicts|inventory-repair|balance-repair|import-cycle-diagnostics|location-inventory-mockup|ai-command-center|ai-validation|create|accounting)(\/|$)/;
const DISCOVERY_COMPANIES = [
  { code: "PHASE7-FACTORY", home: "/factory/production-report" },
  { code: "PHASE7-ERP", home: "/tracking" },
  { code: "PHASE7-SP", home: "/sp" },
];

function genericSteps(title) {
  return [
    "Open " + title + " from the sidebar and confirm the training company shown at the top.",
    "Read the totals and the list of records shown for the selected period.",
    "Use the tabs, search and filters to narrow what is on screen.",
    "Open a record to see its details. This recording never saves or posts anything.",
  ];
}

/** Every sidebar page the fixture Developer can open in each training company. */
async function discoverTours(page) {
  const found = new Map();
  for (const company of DISCOVERY_COMPANIES) {
    try {
      await selectFixtureCompany(page, company.code);
      await page.goto(base + company.home, { waitUntil: "domcontentloaded", timeout });
      await page.waitForSelector("#main-content", { visible: true, timeout });
      await delay(1500);
      // Open collapsed sidebar sections so every link is in the document.
      for (let round = 0; round < 3; round++) {
        const opened = await page.evaluate(() => {
          const closed = [...document.querySelectorAll('button[data-testid^="button-section-"][aria-expanded="false"]')];
          closed.forEach((button) => button.click());
          return closed.length;
        });
        if (!opened) break;
        await delay(400);
      }
      const links = await page.evaluate(() =>
        [...document.querySelectorAll('a[data-testid^="link-"][href]')].map((link) => ({
          href: link.getAttribute("href") || "",
          title: (link.textContent || "").replace(/\s+/g, " ").trim(),
        }))
      );
      for (const link of links) {
        if (!link.href.startsWith("/") || !link.title) continue;
        const route = link.href.split(/[?#]/, 1)[0];
        // Record pages, not individual records (e.g. a recently opened /containers/3).
        if (SKIPPED_ROUTE.test(route) || /\/\d+(\/|$)/.test(route)) continue;
        const id = topicIdForRoute(route);
        if (found.has(id)) continue;
        found.set(id, TOURS[id] ?? { company: company.code, route, title: link.title, steps: genericSteps(link.title), discovered: true });
      }
    } catch (error) {
      process.stderr.write("Page discovery failed for " + company.code + ": " + String(error?.message || error) + "\n");
    }
  }
  return found;
}

let tours = chosenIds.map((id) => [id, TOURS[id]]);

async function assertSafeEnvironment() {
  const url = new URL(base);
  if (url.origin !== "http://127.0.0.1:5000" && url.origin !== "http://localhost:5000") {
    throw new Error("Training recorder only accepts the local disposable CI application on port 5000.");
  }
  if (process.env.NODE_ENV !== "test" || process.env.ERP_E2E_DISPOSABLE_DB !== "1" ||
      process.env.TRAINING_SANDBOX_VERIFIED !== "1") {
    throw new Error("Training recording requires verified disposable test mode; refusing any live environment.");
  }
  if (!username || !password) throw new Error("The ephemeral Phase 7 fixture credentials are required.");
  if (!wantsDiscovery && selectedTopic !== "all" && tours.some(([, tour]) => !tour)) throw new Error("Unknown topic: " + selectedTopic);
  // Narration is mandatory: a silent video is not a valid training recording.
  if (!ttsModel || !ttsModel.endsWith(".onnx")) throw new Error("TRAINING_TTS_MODEL must point to the Piper voice .onnx file");
  await fs.access(ttsModel);
  await fs.access(ttsModel + ".json");
}

async function login(page) {
  await page.goto(base + "/login", { waitUntil: "domcontentloaded", timeout });
  await page.waitForSelector('[data-testid="input-username"]', { timeout, visible: true });
  await page.type('[data-testid="input-username"]', username);
  await page.type('[data-testid="input-password"]', password);
  await page.click('[data-testid="button-login"]');
  await page.waitForFunction(() => location.pathname !== "/login" && Boolean(document.querySelector("#main-content")), { timeout });
  const dialog = await page.$('[data-testid="language-onboarding-dialog"]');
  if (dialog && await dialog.isVisible()) {
    await page.click('[data-testid="language-onboarding-en"]');
    await page.click('[data-testid="language-onboarding-continue"]');
  }
}

async function selectFixtureCompany(page, code) {
  // First leave the previous company's route. Its mounted Factory/ERP provider
  // may otherwise write the stale company back to the shared login session
  // during a live cross-company transition.
  const neutral = await page.goto(base + "/my-settings", { waitUntil: "domcontentloaded", timeout });
  if (neutral && !neutral.ok()) throw new Error("Neutral company bootstrap failed (" + neutral.status() + ")");
  await page.waitForSelector("#main-content", { visible: true, timeout });

  const selectedId = await page.evaluate(async (companyCode) => {
    const r = await fetch("/api/user/companies", { credentials: "include", cache: "no-store" });
    if (!r.ok) throw new Error("Could not read fixture company assignments.");
    const companies = await r.json();
    const company = companies.find((row) => row.companyCode === companyCode);
    const companyId = Number(company?.companyId);
    if (!Number.isInteger(companyId) || companyId <= 0) {
      throw new Error("Fixture company unavailable: " + companyCode);
    }
    return companyId;
  }, code);

  // A direct session switch does not update React's mounted CompanyProvider.
  // Retry only the harmless fixture-company selection on the neutral page.
  // Never proceed to record until BOTH server session and localStorage agree.
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.evaluate(async (companyId) => {
      const session = await fetch("/api/auth/session-company", { credentials: "include", cache: "no-store" });
      if (!session.ok) throw new Error("Could not inspect fixture company session");
      const active = await session.json();
      if (Number(active.companyId) !== companyId) {
        const change = await fetch("/api/auth/set-company", {
          method: "POST", credentials: "include", headers: { "content-type": "application/json" },
          body: JSON.stringify({ companyId }),
        });
        if (!change.ok) throw new Error("Unable to switch fixture company (" + change.status + ").");
      }
      localStorage.setItem("selectedCompanyId", String(companyId));
    }, selectedId);

    const bootstrap = await page.goto(base + "/my-settings", { waitUntil: "domcontentloaded", timeout });
    if (bootstrap && !bootstrap.ok()) throw new Error("Company bootstrap failed (" + bootstrap.status() + ")");
    await page.waitForSelector("#main-content", { visible: true, timeout });
    await delay(500); // Allow React's company provider to settle after reload.

    const correct = await page.evaluate(async (companyId) => {
      const session = await fetch("/api/auth/session-company", { credentials: "include", cache: "no-store" });
      if (!session.ok) throw new Error("Session company verification failed");
      const active = await session.json();
      return Number(active.companyId) === companyId &&
        localStorage.getItem("selectedCompanyId") === String(companyId);
    }, selectedId);
    if (correct) return;
    if (attempt < 3) process.stdout.write("Retrying neutral fixture company bootstrap for " + code + " (" + attempt + "/3)\n");
  }
  throw new Error("Fixture session company would not settle on " + code + " after 3 verified attempts");
}


/**
 * Render the captured, real authenticated screen frames plus the narration
 * track to an H.264 / AAC MP4. We do NOT keep an open FFmpeg stdin pipe or a
 * Puppeteer screencast process; both can produce EPIPE/zero-byte recordings on
 * GitHub runners. The pointer is composited from cursor.png at OUTPUT_FPS using
 * the per-frame positions in the sendcmd track, so it moves smoothly even
 * though the screen itself is captured at CAPTURE_FPS.
 */
async function encodeAndValidate(framesDir, narrationWav, expectedSeconds, outputMp4) {
  await execFile("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-framerate", String(CAPTURE_FPS), "-start_number", "0",
    "-i", path.join(framesDir, "frame-%05d.jpg"),
    "-i", path.join(framesDir, "cursor.png"),
    "-i", narrationWav,
    "-filter_complex",
    "[0:v]fps=" + OUTPUT_FPS + ",sendcmd=f=" + path.join(framesDir, "cursor.cmd").replace(/([\\':])/g, "\\$1") + "[screen];" +
    "[screen][1:v]overlay@cur=x=-40:y=-40:eval=frame:format=auto[pointer];" +
    "[pointer]scale=in_range=full:out_range=limited,format=yuv420p[out]",
    "-map", "[out]", "-map", "2:a:0",
    "-c:v", "libx264", "-profile:v", "main", "-preset", "veryfast",
    "-crf", "27", "-pix_fmt", "yuv420p", "-color_range", "tv",
    "-c:a", "aac", "-b:a", "96k", "-ar", "48000", "-ac", "1",
    "-shortest", "-movflags", "+faststart", outputMp4,
  ]);
  const { stdout } = await execFile("ffprobe", [
    "-v", "error", "-show_entries",
    "stream=codec_type,codec_name,pix_fmt,width,height,nb_frames:format=duration",
    "-of", "json", outputMp4,
  ]);
  const probe = JSON.parse(stdout);
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  const durationSeconds = Number(probe.format?.duration);
  if (video?.codec_name !== "h264" || video?.pix_fmt !== "yuv420p" || audio?.codec_name !== "aac" ||
      !Number.isFinite(durationSeconds) || Math.abs(durationSeconds - expectedSeconds) > 1 ||
      durationSeconds < MIN_DURATION_SECONDS || durationSeconds > MAX_DURATION_SECONDS ||
      Number(video.nb_frames) < durationSeconds * (OUTPUT_FPS - 1)) {
    throw new Error("Training video failed H.264 + AAC narration, full-frame or " + MIN_DURATION_SECONDS + "-" + MAX_DURATION_SECONDS + " second validation");
  }
  // Actually decode every frame: ffprobe metadata alone is not a playback test.
  await execFile("ffmpeg", ["-hide_banner", "-v", "error", "-xerror", "-i", outputMp4, "-f", "null", "-"]);
  return { durationSeconds, width: video.width, height: video.height, codec: "h264/yuv420p+aac" };
}

const DEMO_TEXT = "P7";
// Controls whose click would leave the page, print, download or destroy
// something are explained but never pressed, even on the disposable fixture.
const NEVER_CLICK = /\b(print|export|download|log ?out|sign out|delete|remove|void|reverse|cancel|save|post|submit|confirm|finali[sz]e|approve|pay|send|email|upload|close)\b/i;
const NEVER_CLICK_TESTID = /^(export|print|button-remove|button-delete|button-save|button-submit|button-post|button-confirm|button-logout|button-sidebar-logout)/;
const LAYER_PRIORITY = /\b(import|select|choose|account|item|product|customer|supplier|new|add|create|edit|settings|actions?|filters?|columns?|more|options?|menu|template|period|range)\b/i;

/**
 * Safe, reversible demonstrations. Typing into a search box, opening a menu,
 * list or dialog, and choosing an entry from an opened list only change what
 * is displayed on the disposable fixture; the capture pass clears the text,
 * closes the layer or reloads the page afterwards. Nothing is ever submitted
 * or saved, and every non-GET request stays blocked at the network layer.
 */
function demoFor(row) {
  if (row.disabled) return null;
  const label = (row.label || row.placeholder || "").toLowerCase();
  if ((row.tag === "input" || row.tag === "textarea") && !["date", "month", "number", "checkbox", "file", "time"].includes(row.type) && /search|find|filter/.test(label)) return "type";
  if (row.region === "layer") return null;
  if (row.region !== "main") return null;
  if (row.tag === "button" && !/^tab-/.test(row.testid) && row.role !== "tab" &&
      (row.testid.startsWith("select-") || (row.haspopup && row.haspopup !== "false") || /^(filters?|columns?)$/.test(label))) return "open";
  return null;
}

/** Buttons and selectors in the main area that may reveal hidden controls. */
function explorable(row) {
  if (row.region !== "main" || row.disabled || row.kind !== "control") return false;
  if (row.role === "tab" || /^tab-/.test(row.testid) || row.tag === "a" || row.tag === "input" || row.tag === "textarea" || row.tag === "select") return false;
  if (!(row.tag === "button" || row.role === "button" || row.role === "combobox")) return false;
  const label = row.label || row.placeholder || "";
  return !NEVER_CLICK.test(label) && !NEVER_CLICK_TESTID.test(row.testid);
}

/** The one entry inside an opened layer that is safe to choose as a demonstration. */
function pickTarget(rows) {
  const option = rows.find((row) => row.kind === "control" && row.role === "option" && !row.disabled && !row.selected);
  if (option) return option;
  return rows.find((row) => row.kind === "control" && row.tag === "button" && !row.disabled && /^(select|choose|import|use|apply|pick)\b/i.test(row.label) && !NEVER_CLICK.test(row.label.replace(/^(select|choose|import|use|apply|pick)\b/i, ""))) || null;
}

const keyOf = (row) => row.region + "|" + (row.testid || row.tag + ":" + row.label);
/** A spoken name for a control, falling back to its test id for icon-only buttons. */
const nameOf = (row) => row.label || row.testid.replace(/^(button|input|select|checkbox|toggle|link|card)-/, "").replace(/-\d+$/, "").replace(/-/g, " ").trim() || "this icon button";
const locator = (row) => ({ testid: row.testid, label: row.label, region: row.region, tag: row.tag, kind: row.kind, level: row.level });

async function clickTab(page, testid) {
  // Only select an already-visible UI tab. Never submit ERP or Factory
  // transactions, and keep all network writes blocked.
  const tab = await page.$('[data-testid="' + testid + '"]');
  if (tab) await tab.click().catch(() => undefined);
  await delay(1200);
}

/** Scroll a control into view and click its centre with the real mouse. */
async function clickControl(page, row) {
  const rect = await page.evaluate(locateAndScroll, locator(row));
  if (!rect) return false;
  await delay(150);
  await page.mouse.click(rect.x + Math.min(rect.width - 8, Math.max(8, rect.width * 0.5)), rect.y + rect.height / 2).catch(() => undefined);
  await delay(900);
  return true;
}

/** Close whatever layer is open without triggering the app's Escape-goes-back. */
async function closeLayers(page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const type = await page.evaluate(openLayerType).catch(() => "");
    if (!type) return true;
    if (type === "dialog") {
      const closeButton = await page.$("[role=dialog][data-state=open] button[aria-label*='lose' i], [role=dialog][data-state=open] [data-testid*='close' i], [role=alertdialog] button[aria-label*='lose' i]");
      if (closeButton) { await closeButton.click().catch(() => undefined); await delay(400); continue; }
    }
    await page.keyboard.press("Escape").catch(() => undefined);
    await delay(400);
  }
  return !(await page.evaluate(openLayerType).catch(() => ""));
}

/** Discover every control, exploring each visible tab and each hidden layer, and build the spoken script. */
async function planNarration(page, tour, route, openRoute) {
  const mode = tour.company === "PHASE7-FACTORY" ? "factory" : "erp";
  const explainChrome = tour.explainsSharedChrome === true;
  const first = await page.evaluate(enumerateScreen, {});
  const segments = [{ id: "intro", kind: "intro", text: introNarration(tour, mode, first.heading, first.subtitle), tabPath: [] }];
  for (const step of tour.steps.slice(0, 4)) segments.push({ id: "overview-" + segments.length, kind: "overview", text: step, tabPath: [] });
  if (!explainChrome) {
    const overview = Object.values(TOURS).find((candidate) => candidate.explainsSharedChrome && candidate.company === tour.company);
    segments.push({ id: "chrome", kind: "note", text: sharedChromeNarration(mode, overview ? overview.title : "overview"), tabPath: [] });
  }
  const seen = new Set();
  const prefixCount = new Map();
  const tabQueue = [];
  const layerQueue = [];
  const tabPath = [];
  let tabLabel = "";
  let explored = 0;
  let visited = 0;
  const nextId = () => "s" + segments.length;
  const ingest = (rows) => {
    for (const row of rows) {
      if (segments.length >= MAX_SEGMENTS - 1) return;
      if (!explainChrome && row.region !== "main") continue;
      const key = row.kind + "|" + keyOf(row);
      if (seen.has(key)) continue;
      seen.add(key);
      if (row.kind === "heading") {
        segments.push({ ...row, id: nextId(), text: describeHeading(row.label, row.level), tabPath: [...tabPath], tabLabel, layer: null });
        continue;
      }
      const prefix = row.testid.replace(/-\d+$/, "");
      if (row.testid !== prefix) {
        const count = (prefixCount.get(prefix) || 0) + 1;
        prefixCount.set(prefix, count);
        if (count > MAX_SAME_PREFIX) continue;
      }
      const demo = demoFor(row);
      const text = describeControl(row) + (row.testid !== prefix && prefixCount.get(prefix) === MAX_SAME_PREFIX ? " The rows below work the same way." : "") + demoNarration(demo, row.label, DEMO_TEXT);
      segments.push({ ...row, id: nextId(), text, demo, tabPath: [...tabPath], tabLabel, layer: null });
      const isTab = row.role === "tab" || /^tab-/.test(row.testid);
      if (isTab && row.region === "main" && row.testid && !row.selected && !tabQueue.some((item) => item.testid === row.testid)) {
        // Remember which parent tabs were open when this tab was discovered so
        // nested tab strips (for example Workers > Payroll) can be re-opened
        // before the queued tab is visited and before its controls are replayed.
        tabQueue.push({ testid: row.testid, label: row.label, parentPath: [...tabPath] });
      } else if (explorable(row) && !layerQueue.some((item) => keyOf(item.row) === keyOf(row))) {
        layerQueue.push({ row, segmentId: segments[segments.length - 1].id, parentPath: [...tabPath], tabLabel, priority: LAYER_PRIORITY.test(row.label) || demo === "open" ? 1 : 0 });
      }
    }
  };
  ingest(first.rows);
  while (tabQueue.length && explored < MAX_TABS) {
    const next = tabQueue.shift();
    explored++;
    if (tabPath.join("/") !== next.parentPath.join("/")) {
      // Restore the parent tab context this tab was discovered under.
      for (const parent of next.parentPath) await clickTab(page, parent);
      tabPath.splice(0, tabPath.length, ...next.parentPath);
    }
    const tab = await page.$('[data-testid="' + next.testid + '"]');
    if (!tab) continue;
    await tab.click().catch(() => undefined);
    await delay(1200);
    if (new URL(page.url()).pathname !== route) {
      // A tab-styled link left the page: never follow it, return to the tour route.
      await openRoute();
      tabPath.splice(0, tabPath.length);
      continue;
    }
    tabPath.push(next.testid);
    visited++;
    tabLabel = next.label;
    ingest((await page.evaluate(enumerateScreen, {})).rows);
  }

  // Open the hidden layers: menus, dropdown lists and dialogs behind the
  // main-area buttons, most useful ones first, and script what is inside.
  layerQueue.sort((a, b) => b.priority - a.priority);
  let layersExplored = 0;
  let hiddenControls = 0;
  for (const candidate of layerQueue.slice(0, MAX_LAYERS)) {
    if (segments.length >= MAX_SEGMENTS - 4) break;
    await openRoute();
    for (const parent of candidate.parentPath) await clickTab(page, parent);
    tabPath.splice(0, tabPath.length, ...candidate.parentPath);
    const clicked = await clickControl(page, candidate.row);
    if (!clicked) continue;
    if (new URL(page.url()).pathname !== route) continue;
    const layer = await page.evaluate(enumerateScreen, { layerOnly: true });
    if (!layer.layerType) continue;
    const rows = layer.rows.filter((row) => row.kind === "control" ? row.label || row.testid : row.label).slice(0, MAX_LAYER_CONTROLS);
    const parentIndex = segments.findIndex((segment) => segment.id === candidate.segmentId);
    const parent = segments[parentIndex];
    parent.demo = "open";
    parent.keepOpen = true;
    if (!/Let me open it/.test(parent.text)) parent.text += demoNarration("open", parent.label, DEMO_TEXT);
    const ref = { key: keyOf(candidate.row), row: locator(candidate.row), type: layer.layerType };
    const inserted = [{ id: "layer" + layersExplored, kind: "layer-intro", text: layerIntro(nameOf(candidate.row), layer.layerType, rows.filter((row) => row.kind === "control").length, layer.heading), tabPath: [...tabPath], tabLabel, layer: ref, parentLabel: nameOf(candidate.row) }];
    const pick = pickTarget(rows);
    for (const row of rows) {
      const key = row.kind + "|" + keyOf(row) + "|" + ref.key;
      if (seen.has(key)) continue;
      seen.add(key);
      if (row.kind === "heading") {
        inserted.push({ ...row, id: "layer" + layersExplored + "h" + inserted.length, text: describeHeading(row.label, row.level), tabPath: [...tabPath], tabLabel, layer: ref, parentLabel: nameOf(candidate.row) });
        continue;
      }
      const demo = row === pick ? "pick" : demoFor(row);
      inserted.push({ ...row, id: "layer" + layersExplored + "c" + inserted.length, text: describeControl(row) + demoNarration(demo, row.label, DEMO_TEXT), demo, tabPath: [...tabPath], tabLabel, layer: ref, parentLabel: nameOf(candidate.row), resetAfter: demo === "pick" });
      hiddenControls++;
    }
    // A chosen option usually closes the list, so it must be the last thing
    // shown inside this layer.
    const pickIndex = inserted.findIndex((segment) => segment.demo === "pick");
    if (pickIndex >= 0) inserted.push(...inserted.splice(pickIndex, 1));
    segments.splice(parentIndex + 1, 0, ...inserted);
    layersExplored++;
    await closeLayers(page);
  }
  await openRoute();
  segments.forEach((segment, index) => { segment.id = segment.kind === "intro" || segment.kind === "closing" ? segment.id : "n" + index; });
  segments.push({ id: "closing", kind: "closing", text: closingNarration(tour), tabPath: [], layer: null });
  return { segments, tabsExplored: visited, layersExplored, hiddenControls, sharedChromeExplained: explainChrome };
}

async function synthesizeNarration(segments, clipsDir) {
  const script = segments.map((segment) => ({ id: segment.id, text: speakable(segment.text) }));
  const scriptFile = path.join(clipsDir, "narration.json");
  await fs.writeFile(scriptFile, JSON.stringify(script));
  const { stdout } = await execFile(ttsPython, [
    path.join(scriptsDir, "training-narration-tts.py"),
    "--model", ttsModel, "--input", scriptFile, "--output-dir", clipsDir, "--length-scale", ttsLengthScale,
  ], { maxBuffer: 16 * 1024 * 1024 });
  const summary = JSON.parse(stdout);
  if (!Array.isArray(summary.clips) || summary.clips.length !== segments.length) throw new Error("Narration synthesis returned an incomplete clip set");
  for (const segment of segments) {
    segment.wav = parseWav(await fs.readFile(path.join(clipsDir, segment.id + ".wav")));
    segment.frames = Math.max(2, Math.ceil((segment.wav.durationSeconds + SEGMENT_PAUSE_SECONDS) * CAPTURE_FPS));
    segment.targetSeconds = segment.frames / CAPTURE_FPS;
  }
}

/** Pointer positions for every output frame, written as an FFmpeg sendcmd track. */
class CursorTrack {
  constructor() { this.lines = []; this.last = null; }
  at(seconds, x, y) {
    const px = Math.round(x) - 5;
    const py = Math.round(y) - 3;
    if (this.last && this.last.x === px && this.last.y === py) return;
    this.last = { x: px, y: py };
    const t = seconds.toFixed(3);
    this.lines.push(t + " overlay@cur x " + px + "; " + t + " overlay@cur y " + py + ";");
  }
  glide(startSeconds, from, to, durationSeconds) {
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const steps = Math.max(1, Math.round(durationSeconds * OUTPUT_FPS));
    for (let step = 0; step <= steps; step++) {
      const t = ease(step / steps);
      this.at(startSeconds + step / OUTPUT_FPS, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    }
  }
}

async function recordOne(page, id, tour) {
  await selectFixtureCompany(page, tour.company);
  const dir = path.join(output, id);
  await fs.mkdir(dir, { recursive: true });
  let blocked = [];
  await page.setRequestInterception(true);
  const onRequest = (request) => {
    const method = request.method().toUpperCase();
    const url = new URL(request.url());
    // Inline data:/blob: assets (icons, generated previews) never reach the network.
    if (url.protocol === "data:" || url.protocol === "blob:") return request.continue();
    if (url.origin !== new URL(base).origin || !["GET", "HEAD", "OPTIONS"].includes(method)) {
      blocked.push(method + " " + url.pathname);
      return request.abort("blockedbyclient");
    }
    return request.continue();
  };
  page.on("request", onRequest);
  const openRoute = async () => {
    const response = await page.goto(base + tour.route, { waitUntil: "domcontentloaded", timeout });
    // Puppeteer returns null for same-document navigations. The ERP uses client-side
    // routing, so a null navigation response is not evidence that the page failed.
    if (response && !response.ok()) {
      throw new Error("Page HTTP navigation failed (" + response.status() + ") at " + tour.route);
    }
    await page.waitForSelector("#main-content", { visible: true, timeout });
    await page.waitForFunction(() => {
      const main = document.querySelector("#main-content");
      return Boolean(main && main.textContent && main.textContent.trim().length > 20);
    }, { timeout });
    const actualPath = new URL(page.url()).pathname;
    if (actualPath !== tour.route) throw new Error("Unexpected redirect to " + actualPath + " for " + tour.route);
    await delay(1600);
  };
  try {
    await openRoute();
    // Still reject real HTTP failures and verify the returned HTML, authenticated
    // application shell, expected route, and meaningful visible page content.
    const http = await page.evaluate(async (route) => {
      const result = await fetch(route, { credentials: "include", cache: "no-store", redirect: "manual" });
      return { status: result.status, type: result.headers.get("content-type") || "" };
    }, tour.route);
    if (http.status !== 200 || !http.type.includes("text/html")) {
      throw new Error("Training page GET failed (" + http.status + ", " + http.type + ") at " + tour.route);
    }
    const pageDetails = await page.evaluate(enumerateScreen, {});
    // A training video of an empty screen teaches nothing. With
    // TRAINING_REQUIRE_DATA=1 (set once the demo data is seeded) a tour of a
    // page that shows no data fails instead of being published.
    const data = await page.evaluate(measurePageData);
    if (process.env.TRAINING_REQUIRE_DATA === "1" && !tour.allowEmpty && data.dataRows === 0 && data.emptyMessages.length > 0) {
      throw new Error("Page shows no demo data (" + data.emptyMessages.join("; ") + ") at " + tour.route);
    }
    await page.screenshot({ path: path.join(dir, "screenshot.png"), fullPage: false });

    // Pass 1: discover every control (exploring tabs and hidden layers) and write the script.
    const plan = await planNarration(page, tour, tour.route, openRoute);
    const { segments } = plan;
    const framesDir = await fs.mkdtemp(path.join(os.tmpdir(), "erp-training-frames-"));
    const clipsDir = await fs.mkdtemp(path.join(os.tmpdir(), "erp-training-voice-"));
    let video;
    const missingHighlights = [];
    try {
      await synthesizeNarration(segments, clipsDir);
      let plannedSeconds = segments.reduce((sum, segment) => sum + segment.targetSeconds, 0);
      while (plannedSeconds > MAX_DURATION_SECONDS - 2 && segments.length > 3) {
        // Keep intro and closing; drop the last explained control until it fits.
        const [dropped] = segments.splice(segments.length - 2, 1);
        plannedSeconds -= dropped.targetSeconds;
      }
      await fs.writeFile(path.join(framesDir, "cursor.png"), cursorImage);
      // Pass 2: replay on a fresh page state and capture frames while narrating.
      await openRoute();
      const captions = ["WEBVTT", ""];
      const track = new CursorTrack();
      let frameNumber = 0;
      let appliedPath = "";
      let openLayer = "";
      let elapsed = 0;
      let cursor = { x: 720, y: 450 };
      track.at(0, cursor.x, cursor.y);
      const restore = async (segment) => {
        await openRoute();
        for (const testid of segment.tabPath) await clickTab(page, testid);
        appliedPath = segment.tabPath.join("/");
        openLayer = "";
      };
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const layerKey = segment.layer ? segment.layer.key : "";
        if (openLayer && openLayer !== layerKey) {
          // Leave the menu, list or dialog of the previous control.
          if (!(await closeLayers(page))) await restore(segment);
          openLayer = "";
        }
        if (segment.tabPath.length && segment.tabPath.join("/") !== appliedPath) {
          // Tab paths can branch (Employees tab, then back to a Workers sub-tab),
          // so replay the whole path whenever it differs from the one on screen.
          for (const testid of segment.tabPath) await clickTab(page, testid);
          appliedPath = segment.tabPath.join("/");
        }
        if (layerKey && openLayer !== layerKey) {
          // Re-open the layer this control lives in (its parent was clicked in pass 1).
          await clickControl(page, segment.layer.row);
          openLayer = (await page.evaluate(openLayerType).catch(() => "")) ? layerKey : "";
        }
        let rect = null;
        if (segment.kind === "control" || segment.kind === "heading") {
          rect = await page.evaluate(locateAndScroll, locator(segment));
          if (!rect) missingHighlights.push(segment.testid || segment.label);
          await delay(200);
        } else if (!layerKey) {
          await page.evaluate(() => document.querySelector("#main-content")?.scrollTo({ top: 0, behavior: "instant" }));
        }
        const title = segment.kind === "heading" ? "Section: " + segment.label
          : segment.kind === "layer-intro" ? "Inside: " + segment.parentLabel
          : segment.kind === "control" ? (layerKey ? "In " + segment.parentLabel + ": " : "") + (segment.role === "tab" || /^tab-/.test(segment.testid) ? "Tab: " : segment.role === "option" ? "Choice: " : segment.tag === "input" || segment.tag === "select" || segment.tag === "textarea" ? "Field: " : segment.tag === "a" ? "Link: " : "Button: ") + (segment.label || segment.testid)
          : tour.title;
        // The pointer glides to the control at full frame rate, hovers it for
        // real (hover styles show), then performs the reversible demo if any.
        const from = { ...cursor };
        const target = rect ? { x: rect.x + Math.min(rect.width - 8, Math.max(8, rect.width * 0.5)), y: rect.y + rect.height / 2 } : from;
        if (rect) { track.glide(elapsed, from, target, CURSOR_TRAVEL_SECONDS); cursor = target; }
        const travelFrames = rect ? Math.min(Math.ceil(CURSOR_TRAVEL_SECONDS * CAPTURE_FPS), Math.max(1, segment.frames - 1)) : 0;
        let demoActive = false;
        for (let frame = 0; frame < segment.frames; frame++) {
          if (rect && frame === travelFrames) await page.mouse.move(cursor.x, cursor.y).catch(() => undefined);
          let click = null;
          if (segment.demo && rect && frame === travelFrames + 1) {
            click = { x: cursor.x, y: cursor.y };
            demoActive = true;
            await page.mouse.click(cursor.x, cursor.y).catch(() => undefined);
            if (segment.demo === "type") await page.keyboard.type(DEMO_TEXT, { delay: 60 }).catch(() => undefined);
            await delay(700);
            if (segment.keepOpen) openLayer = (await page.evaluate(openLayerType).catch(() => "")) ? keyOf(segment) : "";
            if (segment.demo === "pick" && segment.layer) {
              // The chosen entry closed its list: highlight the field it filled instead.
              rect = (await page.evaluate(locateAndScroll, segment.layer.row)) || rect;
            }
          }
          await page.evaluate(paintOverlay, { rect, title, text: segment.text, index: i + 1, total: segments.length, pulse: frame % 2 === 0, click });
          await page.screenshot({
            path: path.join(framesDir, "frame-" + String(frameNumber++).padStart(5, "0") + ".jpg"),
            type: "jpeg", quality: 74, fullPage: false,
          });
        }
        if (demoActive && segment.demo === "type") {
          // Undo the demonstration: clear the typed text with the field still focused.
          await page.mouse.click(cursor.x, cursor.y).catch(() => undefined);
          const focused = await page.evaluate(() => /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || "")).catch(() => false);
          if (focused) {
            await page.keyboard.down("Control").catch(() => undefined);
            await page.keyboard.press("KeyA").catch(() => undefined);
            await page.keyboard.up("Control").catch(() => undefined);
            await page.keyboard.press("Backspace").catch(() => undefined);
          }
          await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
          await delay(200);
        } else if (demoActive && segment.demo === "open" && !segment.keepOpen) {
          // The app treats a bare Escape on the page body as "go back", so the
          // layer is only closed while it is actually open.
          await closeLayers(page);
        }
        if (segment.resetAfter || new URL(page.url()).pathname !== tour.route) {
          // A chosen option changed the form, or a key press left the page:
          // reload the untouched screen and replay the tab path.
          await restore(segment);
        }
        captions.push(String(i + 1), vttTimestamp(elapsed) + " --> " + vttTimestamp(elapsed + segment.targetSeconds), segment.text, "");
        elapsed += segment.targetSeconds;
      }
      await fs.writeFile(path.join(framesDir, "cursor.cmd"), track.lines.join("\n") + "\n");
      const narrationWav = path.join(clipsDir, "narration.wav");
      await fs.writeFile(narrationWav, joinWavClips(segments.map((segment) => ({ wav: segment.wav, targetSeconds: segment.targetSeconds }))));
      video = await encodeAndValidate(framesDir, narrationWav, elapsed, path.join(dir, "screen.mp4"));
      await fs.writeFile(path.join(dir, "captions.vtt"), captions.join("\n"));
      await fs.writeFile(path.join(dir, "guide.md"), buildGuide(tour, pageDetails, segments, video, plan));
      return {
        topic: id, route: tour.route, dataRows: data.dataRows, sourceSha: process.env.GITHUB_SHA || null,
        durationMs: Math.round(video.durationSeconds * 1000), videoFile: "screen.mp4", codec: video.codec,
        resolution: `${video.width}x${video.height}`, narration: "piper-offline", narratedSegments: segments.length,
        explainedControls: segments.filter((segment) => segment.kind === "control").length,
        hiddenControlsExplained: segments.filter((segment) => segment.kind === "control" && segment.layer).length,
        layersExplored: plan.layersExplored, tabsExplored: plan.tabsExplored, sharedChromeExplained: plan.sharedChromeExplained,
        demonstrations: segments.filter((segment) => segment.demo).length,
        missingHighlights: missingHighlights.slice(0, 20), status: "captured", blockedRequests: blocked.slice(0, 20),
        requiresReview: true, source: "disposable Phase 7 fixture",
      };
    } finally {
      await page.evaluate(() => document.getElementById("training-recording-layer")?.remove()).catch(() => {});
      await fs.rm(framesDir, { recursive: true, force: true });
      await fs.rm(clipsDir, { recursive: true, force: true });
    }
  } finally {
    page.off("request", onRequest);
    await page.setRequestInterception(false);
  }
}

function buildGuide(tour, pageDetails, segments, video, plan) {
  const lines = ["# " + tour.title, "", "Recorded against the disposable Phase 7 test company.", "",
    "Page: " + tour.route, "", "Screen heading: " + pageDetails.heading, "",
    "Narrated video: screen.mp4 (" + Math.round(video.durationSeconds) + " seconds, " + segments.filter((s) => s.kind === "control").length + " controls explained, " +
    plan.layersExplored + " hidden menus, lists or dialogs opened)", "",
    plan.sharedChromeExplained ? "This video also explains the top bar and sidebar shared by every screen." : "The shared top bar and sidebar are explained in the overview video of this mode.", "",
    "## Guided steps", "", ...tour.steps.map((step, index) => String(index + 1) + ". " + step), "", "## Full transcript", ""];
  let group = "";
  for (const segment of segments) {
    const area = segment.layer ? 'Inside "' + segment.parentLabel + '"'
      : segment.kind === "control" || segment.kind === "heading" ? ({ header: "Top bar", sidebar: "Sidebar", main: "Main area", floating: "Floating controls" })[segment.region] : "";
    const name = area === "Main area" && segment.tabLabel ? area + " (" + segment.tabLabel + " tab)" : area;
    if (name && name !== group) { group = name; lines.push("", "### " + group, ""); }
    const label = segment.kind === "control" ? "**" + (segment.label || segment.testid) + "** — " : segment.kind === "heading" ? "_" + segment.label + "_ — " : "";
    lines.push("- " + label + segment.text);
  }
  lines.push("", "![Actual test system screenshot](screenshot.png)", "");
  return lines.join("\n");
}

await assertSafeEnvironment();
await fs.mkdir(output, { recursive: true });
const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const report = [];
let cursorImage;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  // Printing, pop-ups and downloads make no sense in a recording and could hang
  // the headless browser, so they are neutralised before any page script runs.
  await page.evaluateOnNewDocument(() => { window.print = () => undefined; window.open = () => null; });
  const session = await page.createCDPSession();
  await session.send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => undefined);
  await page.setContent("<html><body style='margin:0;background:transparent'>" + CURSOR_SVG + "</body></html>");
  cursorImage = await page.screenshot({ type: "png", omitBackground: true, clip: { x: 0, y: 0, width: 28, height: 28 } });
  await login(page);
  if (selectedTopic === "all") tours = Object.entries(TOURS);
  if (wantsDiscovery) {
    const discovered = await discoverTours(page);
    tours =
      selectedTopic === "all-pages"
        ? [...discovered.entries()]
        : chosenIds.map((id) => [id, TOURS[id] ?? discovered.get(id)]);
    process.stdout.write("Discovered " + discovered.size + " training page(s): " + [...discovered.keys()].join(", ") + "\n");
    const unknown = tours.filter(([, tour]) => !tour).map(([id]) => id);
    if (unknown.length) throw new Error("Unknown topic(s): " + unknown.join(", "));
  }
  tours = tours.filter((_, index) => index % shardCount === shardIndex);
  process.stdout.write("Recording " + tours.length + " page(s) in shard " + shardIndex + "/" + shardCount + ": " + tours.map(([id]) => id).join(", ") + "\n");
  for (const [id, tour] of tours) {
    const startedAt = Date.now();
    try {
      const entry = await recordOne(page, id, tour);
      report.push(entry);
      process.stdout.write("Captured narrated training UI: " + id + " (" + Math.round(entry.durationMs / 1000) + "s video, " +
        entry.explainedControls + " controls, " + entry.hiddenControlsExplained + " hidden, " + Math.round((Date.now() - startedAt) / 1000) + "s to record)\n");
    } catch (err) {
      report.push({ topic: id, status: "failed", reason: String(err?.message || err) });
      process.stderr.write("Training recording failed for " + id + ": " + String(err?.message || err) + "\n");
    }
  }
} finally {
  await browser.close();
  // Parallel shards are merged into one review folder, so each writes its own report.
  const reportName = shardCount > 1 ? "report-" + shardIndex + ".json" : "report.json";
  await fs.writeFile(path.join(output, reportName), JSON.stringify(report, null, 2));
}
const capturedCount = report.filter((item) => item.status === "captured").length;
if (allowPartial ? capturedCount === 0 && report.length > 0 : report.some((item) => item.status !== "captured")) {
  process.exitCode = 1;
}
