/**
 * Capture narrated, real ERP / Factory UI training videos from the disposable
 * Phase 7 CI fixture only. This runner deliberately has no open-ended AI click
 * agent and makes no accounting/stock writes. Editing the tour registry
 * requires code review.
 *
 * Each video walks through EVERY visible control on the page (top bar,
 * sidebar, tabs, buttons, fields) with a spoken explanation, a highlight ring
 * on the control being described and matching captions. The spoken script is
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
  describeControl, describeHeading, introNarration, closingNarration,
  speakable, parseWav, joinWavClips, vttTimestamp,
} from "./training-narration.mjs";

const base = process.env.TRAINING_BASE_URL || "http://127.0.0.1:5000";
const username = process.env.ERP_E2E_USERNAME || "";
const password = process.env.ERP_E2E_PASSWORD || "";
const selectedTopic = process.env.TRAINING_TOPIC || "factory-overview";
const ttsModel = process.env.TRAINING_TTS_MODEL || "";
const ttsPython = process.env.TRAINING_TTS_PYTHON || "python3";
const ttsLengthScale = process.env.TRAINING_TTS_LENGTH_SCALE || "1.05";
const output = path.resolve("artifacts/training-videos");
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const timeout = 45_000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const execFile = promisify(execFileCallback);

// Frame capture avoids Puppeteer's FFmpeg pipe; its VP9 screencast can crash
// with EPIPE on long recordings. Frames are captured while each sentence is
// "spoken", then muxed with the narration track at exactly CAPTURE_FPS.
const CAPTURE_FPS = 2;
const SEGMENT_PAUSE_SECONDS = 0.7;
const MIN_DURATION_SECONDS = 60;
const MAX_DURATION_SECONDS = 1200;
const MAX_SEGMENTS = 170;
const MAX_TABS = 14;
const MAX_SAME_PREFIX = 2;

const TOURS = Object.freeze({
  "factory-overview": { company: "PHASE7-FACTORY", route: "/factory/production-report", title: "Factory overview", steps: ["Check the active Factory company and date range before interpreting the production report.","Read the summary totals and compare them with the visible production breakdown.","Review the available tabs and filters; a filtered view is not a new transaction.","Scroll through the records and inspect the source rows behind each summary.","Use the menu to locate detailed Factory pages. This overview never posts or changes stock."] },
  "factory-stock-entry": { company: "PHASE7-FACTORY", route: "/factory/stock-entry", title: "Factory stock entry", steps: ["Open Stock Entry and confirm the factory and production date shown.","Identify the visible stock-entry fields, including product and quantity information.","Review production rows, units and totals before entering any actual values.","Inspect available tabs and scroll to understand how entries are organized.","A real entry requires checking details before saving. This tour does not submit production."] },
  "factory-raw-materials": { company: "PHASE7-FACTORY", route: "/factory/raw-materials", title: "Raw materials", steps: ["Start on Raw Materials and verify the company and reporting context.","Locate the raw-material inventory and any visible quantity or cost columns.","Inspect the available sections, tabs and filters for different material views.","Scroll through the material rows to understand weight, cost and status information.","Check supplier and stock details before real changes. No raw stock is edited in this tour."] },
  "factory-bale-explorer": { company: "PHASE7-FACTORY", route: "/factory/bales-hub", title: "Bale Explorer", steps: ["Open Bale Explorer to understand where factory bale information is viewed.","Locate visible searches, identifiers and filtering options for finding a bale.","Check the available tabs and the data shown for sample bales.","Scroll through records to understand traceability and status without editing them.","Use the correct bale identifier when investigating issues. This recording never rescans a bale."] },
  "factory-containers": { company: "PHASE7-FACTORY", route: "/factory/containers-hub", title: "Factory containers", steps: ["Open the Containers workspace and verify that the example Factory is selected.","Find the container lists, statuses and identifying information on this screen.","Explore the available tabs or filters to distinguish loading and container views.","Scroll to see how container detail rows relate to quantity and cost information.","Review weights and charges carefully before real offloads. This tour makes no changes."] },
  "factory-stock-allocation": { company: "PHASE7-FACTORY", route: "/factory/stock-allocation-v5", title: "Stock allocation", steps: ["Open Stock Allocation and check the company and current allocation context.","Identify item quantities, customer details and any prices visible on the page.","Examine the filters and tabs that change which items are displayed.","Scroll through available item rows and compare totals with the selected view.","Verify quantities and agreed prices before actual allocation. Nothing is saved here."] },
  "factory-invoicing": { company: "PHASE7-FACTORY", route: "/factory/invoicing", title: "Factory invoicing", steps: ["Open Factory Invoicing and identify the available invoice sections.","Review customer, date and value fields shown in the current invoice view.","Inspect available tabs and filters for invoices with different statuses.","Scroll through the listed invoices and review the information needed for validation.","Actual invoices need verification before finalizing. This tutorial creates none."] },
  "factory-payroll": { company: "PHASE7-FACTORY", route: "/factory/payroll-hub", title: "Payroll and benefits", steps: ["Open Payroll and Benefits and confirm the active company and period.","Locate visible employee, attendance and payroll management sections.","Review tabs and available filters for understanding the pay period.","Scroll through payroll-related rows and check how balances and statuses are displayed.","Review supporting attendance before paying. No salary, bonus or voucher is posted here."] },
  "factory-accounts": { company: "PHASE7-FACTORY", route: "/factory/accounts", title: "Factory accounts", steps: ["Open Factory Accounts and confirm the company and selected statement period.","Locate the account balances, statement controls and ledger information.","Inspect the available tabs, search or date filters to narrow the account view.","Scroll through the ledger entries and compare movements with the displayed balance.","Real corrections require supporting transactions. This tour does not alter accounts."] },
  "factory-analytics": { company: "PHASE7-FACTORY", route: "/factory/analytics", title: "Factory analytics", steps: ["Open Factory Analytics and check which date range is being reported.","Review the key metrics and identify the totals represented on this page.","Try the available tabs or view filters to inspect another breakdown.","Scroll through charts or report sections and compare figures to their time periods.","Analytics is for analysis; verify source records before acting on these numbers."] },
  "erp-tracking": { company: "PHASE7-ERP", route: "/tracking", title: "ERP tracking", steps: ["Open ERP Tracking and confirm the correct company is active.","Locate the visible shipment, item or tracking information on this page.","Inspect the tabs and available filters to narrow the results.","Scroll through the records to understand identifiers and tracking status.","Use tracking details to investigate a movement. This guided recording changes nothing."] },
  "erp-inventory": { company: "PHASE7-ERP", route: "/inventory", title: "ERP inventory", steps: ["Open ERP Inventory and confirm the current company and location.","Review visible items, quantities and stock availability information.","Inspect the available inventory tabs, search and filtering controls.","Scroll through the item records and compare quantities across the current view.","Verify stock before transferring or adjusting inventory. This tour performs no transfer."] },
  "erp-pos": { company: "PHASE7-ERP", route: "/pos", title: "ERP point of sale", steps: ["Open Point of Sale and verify the correct company and POS context.","Locate the product list, search and available sales controls.","Inspect tabs or other visible options used to navigate POS information.","Review the sample items and prices without adding or completing an order.","An actual sale affects stock and accounts; this tour does not create a sale."] },
  "erp-vouchers": { company: "PHASE7-ERP", route: "/vouchers", title: "ERP vouchers", steps: ["Open Vouchers and identify the current company and voucher list.","Review available voucher dates, amounts and status information.","Inspect voucher tabs or filters that separate different records.","Scroll through the entries to understand how voucher history is displayed.","Review debit and credit details before posting. This demonstration posts nothing."] },
  "erp-daybook": { company: "PHASE7-ERP", route: "/daybook", title: "ERP Daybook", steps: ["Open the ERP Daybook and check the active company and selected date.","Review the listed transactions and identify the information shown per entry.","Inspect visible filters or tabs to focus on a particular date or type.","Scroll through the records to understand how daily activity is organized.","Cross-check source vouchers when investigating differences. The tour is read-only."] },
  "erp-reports": { company: "PHASE7-ERP", route: "/sales-report", title: "ERP Sales Report", steps: ["Open Sales Report and confirm the active ERP company and reporting period.","Review the visible sales totals and their units or currency.","Inspect date, category or other available report filters.","Scroll through detailed rows and compare them to the summary values.","Use this report to investigate sales; it does not create invoices or stock movements."] },
});
const chosenIds = selectedTopic === "all" ? Object.keys(TOURS) : selectedTopic.split(",").map((id) => id.trim()).filter(Boolean);
const tours = [...new Set(chosenIds)].map((id) => [id, TOURS[id]]);

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
  if (tours.some(([id, tour]) => !tour)) throw new Error("Unknown topic: " + selectedTopic);
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
 * GitHub runners.
 */
async function encodeAndValidate(framesDir, narrationWav, expectedSeconds, outputMp4) {
  await execFile("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-framerate", String(CAPTURE_FPS), "-start_number", "0",
    "-i", path.join(framesDir, "frame-%05d.jpg"),
    "-i", narrationWav,
    "-map", "0:v:0", "-map", "1:a:0",
    "-vf", "fps=20,scale=in_range=full:out_range=limited,format=yuv420p",
    "-c:v", "libx264", "-profile:v", "main", "-preset", "veryfast",
    "-crf", "21", "-pix_fmt", "yuv420p", "-color_range", "tv",
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
      Number(video.nb_frames) < durationSeconds * 19) {
    throw new Error("Training video failed H.264 + AAC narration, full-frame or " + MIN_DURATION_SECONDS + "-" + MAX_DURATION_SECONDS + " second validation");
  }
  // Actually decode every frame: ffprobe metadata alone is not a playback test.
  await execFile("ffmpeg", ["-hide_banner", "-v", "error", "-xerror", "-i", outputMp4, "-f", "null", "-"]);
  return { durationSeconds, width: video.width, height: video.height, codec: "h264/yuv420p+aac" };
}

/** Enumerate the visible controls and section headings of the current screen. */
function enumerateScreen() {
  const CONTROLS = "button, a[href], [role=tab], [role=button], input, select, textarea, [role=combobox], [role=switch], [role=checkbox], [role=menuitem], summary";
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  };
  // innerText keeps the visual line breaks between child elements, so a button
  // rendered as "Loading" + badge "0" yields "Loading" / "0" instead of "Loading0".
  const textLines = (el) => String(el.innerText || el.textContent || "").split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const text = (el) => {
    const explicit = el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder");
    if (explicit) return { label: explicit.replace(/\s+/g, " ").trim().slice(0, 90), description: "", count: "" };
    const lines = textLines(el);
    let label = lines[0] || "";
    let count = "";
    const rest = lines.slice(1);
    if (rest.length && /^\(?\d+\)?$/.test(rest[0])) count = rest.shift().replace(/[()]/g, "");
    const glued = label.match(/^(.*\S)\s*\((\d+)\)$/) || label.match(/^([A-Za-z][A-Za-z &/-]*[A-Za-z])(\d+)$/);
    if (glued) { label = glued[1].trim(); count = glued[2]; }
    return { label: label.slice(0, 90), description: rest.join(" ").slice(0, 160), count };
  };
  const region = (el) => el.closest("[data-sidebar=sidebar]") ? "sidebar"
    : el.closest("#main-content") ? "main"
    : el.closest("header") ? "header" : "floating";
  const rows = [];
  const seen = new Set();
  const push = (el, kind) => {
    if (seen.has(el)) return;
    seen.add(el);
    const { label, description, count } = text(el);
    if (!label && !el.getAttribute("data-testid")) return;
    if (/^skip to main content$/i.test(label)) return;
    const role = el.getAttribute("role") || "";
    const siblings = kind === "control" && role !== "tab" && !/^tab-/.test(el.getAttribute("data-testid") || "") && el.parentElement
      ? Array.from(el.parentElement.children).filter((child) => child !== el && /^(BUTTON|A)$/.test(child.tagName) && visible(child)).map((child) => text(child).label).filter(Boolean).slice(0, 6)
      : [];
    rows.push({
      kind, region: region(el), tag: el.tagName.toLowerCase(), role,
      type: el.getAttribute("type") || "",
      label, description, count, testid: el.getAttribute("data-testid") || "",
      disabled: Boolean(el.disabled) || el.getAttribute("aria-disabled") === "true",
      selected: el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-current") === "page" || el.getAttribute("data-active") === "true" || el.getAttribute("data-state") === "active",
      pressed: el.getAttribute("aria-pressed") === "true" || el.getAttribute("data-state") === "on" || el.getAttribute("aria-checked") === "true",
      expanded: el.hasAttribute("aria-expanded") ? el.getAttribute("aria-expanded") : null,
      haspopup: el.getAttribute("aria-haspopup") || "",
      group: siblings.length >= 2 ? siblings : [],
      value: el.tagName === "SELECT" ? (el.selectedOptions?.[0]?.textContent || "").trim() : "",
      placeholder: el.getAttribute("placeholder") || "",
      href: el.getAttribute("href") || "",
      level: kind === "heading" ? el.tagName.toLowerCase() : "",
    });
  };
  const header = Array.from(document.querySelectorAll("header " + CONTROLS.split(", ").join(", header "))).filter((el) => !el.closest("#main-content") && !el.closest("[data-sidebar=sidebar]") && visible(el));
  header.forEach((el) => push(el, "control"));
  Array.from(document.querySelectorAll("[data-sidebar=sidebar] " + CONTROLS.split(", ").join(", [data-sidebar=sidebar] "))).filter(visible).forEach((el) => push(el, "control"));
  Array.from(document.querySelectorAll(CONTROLS)).filter((el) => visible(el) && region(el) === "floating").forEach((el) => push(el, "control"));
  Array.from(document.querySelectorAll("#main-content h2, #main-content h3, " + CONTROLS.split(", ").map((s) => "#main-content " + s).join(", "))).filter(visible).forEach((el) => push(el, /^H[23]$/.test(el.tagName) ? "heading" : "control"));
  const h1 = document.querySelector("#main-content h1");
  const subtitle = h1?.parentElement?.querySelector("p")?.textContent?.replace(/\s+/g, " ").trim() || "";
  return { rows, heading: h1?.textContent?.replace(/\s+/g, " ").trim() || document.title, subtitle };
}

/** Find the element described by a segment and scroll it into view. */
function locateAndScroll(segment) {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
  const text = (el) => (el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 90);
  let el = null;
  if (segment.testid) {
    const matches = Array.from(document.querySelectorAll('[data-testid="' + segment.testid.replace(/"/g, '\\"') + '"]')).filter(visible);
    el = matches[0] || null;
  }
  if (!el && segment.label) {
    const scope = segment.region === "sidebar" ? "[data-sidebar=sidebar] " : segment.region === "main" ? "#main-content " : "";
    const selector = segment.kind === "heading" ? scope + segment.level : scope + (segment.tag || "*");
    el = Array.from(document.querySelectorAll(selector)).find((candidate) => visible(candidate) && text(candidate) === segment.label) || null;
  }
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  const rect = el.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

/** Draw the highlight ring, callout and caption bar for the current sentence. */
function paintOverlay({ rect, title, text, index, total, pulse }) {
  let layer = document.getElementById("training-recording-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "training-recording-layer";
    layer.setAttribute("aria-hidden", "true");
    layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;font-family:system-ui,Segoe UI,sans-serif";
    layer.innerHTML = '<div id="trl-ring"></div><div id="trl-chip"></div><div id="trl-caption"></div><div id="trl-step"></div>';
    document.body.appendChild(layer);
  }
  const ring = layer.querySelector("#trl-ring");
  const chip = layer.querySelector("#trl-chip");
  const caption = layer.querySelector("#trl-caption");
  const step = layer.querySelector("#trl-step");
  if (rect) {
    const pad = 6;
    const left = Math.max(0, rect.x - pad);
    const top = Math.max(0, rect.y - pad);
    const width = Math.min(innerWidth - left, rect.width + pad * 2);
    const height = Math.min(innerHeight - top, rect.height + pad * 2);
    ring.style.cssText = "position:fixed;left:" + left + "px;top:" + top + "px;width:" + width + "px;height:" + height +
      "px;border:" + (pulse ? 4 : 3) + "px solid #ff7a00;border-radius:10px;box-shadow:0 0 0 " + (pulse ? 6 : 4) +
      "px rgba(255,122,0,.28),0 0 24px rgba(255,122,0,.5)";
    const chipTop = top > 44 ? top - 38 : top + height + 8;
    chip.style.cssText = "position:fixed;left:" + left + "px;top:" + chipTop + "px;background:#ff7a00;color:#111;font:700 15px/1 system-ui;padding:8px 12px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.3);white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis";
    chip.textContent = title;
  } else {
    ring.style.cssText = "display:none";
    chip.style.cssText = "display:none";
  }
  caption.style.cssText = "position:fixed;left:24px;right:24px;bottom:20px;margin:0 auto;max-width:1100px;background:rgba(9,20,42,.94);color:#fff;border-radius:14px;padding:16px 22px;font:600 20px/1.35 system-ui;box-shadow:0 8px 32px rgba(0,0,0,.4)";
  caption.textContent = text;
  step.style.cssText = "position:fixed;right:24px;top:72px;background:rgba(9,20,42,.9);color:#fff;border-radius:999px;padding:6px 14px;font:600 13px system-ui";
  step.textContent = "Explaining " + index + " of " + total;
}

/** Discover every control, exploring each visible tab, and build the spoken script. */
async function planNarration(page, tour, route) {
  const mode = tour.company === "PHASE7-FACTORY" ? "factory" : "erp";
  const first = await page.evaluate(enumerateScreen);
  const segments = [{ id: "intro", kind: "intro", text: introNarration(tour, mode, first.heading, first.subtitle), tabPath: [] }];
  for (const step of tour.steps.slice(0, 4)) segments.push({ id: "overview-" + segments.length, kind: "overview", text: step, tabPath: [] });
  const seen = new Set();
  const prefixCount = new Map();
  const tabQueue = [];
  const tabPath = [];
  let tabLabel = "";
  let explored = 0;
  const ingest = (rows) => {
    for (const row of rows) {
      if (segments.length >= MAX_SEGMENTS - 1) return;
      const key = row.kind + "|" + row.region + "|" + (row.testid || row.tag + ":" + row.label);
      if (seen.has(key)) continue;
      seen.add(key);
      if (row.kind === "heading") {
        segments.push({ ...row, id: "s" + segments.length, text: describeHeading(row.label, row.level), tabPath: [...tabPath], tabLabel });
        continue;
      }
      const prefix = row.testid.replace(/-\d+$/, "");
      if (row.testid !== prefix) {
        const count = (prefixCount.get(prefix) || 0) + 1;
        prefixCount.set(prefix, count);
        if (count > MAX_SAME_PREFIX) continue;
      }
      const text = describeControl(row) + (row.testid !== prefix && prefixCount.get(prefix) === MAX_SAME_PREFIX ? " The rows below work the same way." : "");
      segments.push({ ...row, id: "s" + segments.length, text, tabPath: [...tabPath], tabLabel });
      const isTab = row.role === "tab" || /^tab-/.test(row.testid);
      if (isTab && row.region === "main" && row.testid && !row.selected && !tabQueue.some((item) => item.testid === row.testid)) tabQueue.push({ testid: row.testid, label: row.label });
    }
  };
  ingest(first.rows);
  while (tabQueue.length && explored < MAX_TABS) {
    const next = tabQueue.shift();
    explored++;
    const tab = await page.$('[data-testid="' + next.testid + '"]');
    if (!tab) continue;
    await tab.click().catch(() => undefined);
    await delay(1200);
    if (new URL(page.url()).pathname !== route) {
      // A tab-styled link left the page: never follow it, return to the tour route.
      await page.goto(base + route, { waitUntil: "domcontentloaded", timeout });
      await page.waitForSelector("#main-content", { visible: true, timeout });
      await delay(1000);
      continue;
    }
    tabPath.push(next.testid);
    tabLabel = next.label;
    ingest((await page.evaluate(enumerateScreen)).rows);
  }
  segments.push({ id: "closing", kind: "closing", text: closingNarration(tour), tabPath: [] });
  return { segments, tabsExplored: tabPath.length };
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
    segment.frames = Math.max(3, Math.ceil((segment.wav.durationSeconds + SEGMENT_PAUSE_SECONDS) * CAPTURE_FPS));
    segment.targetSeconds = segment.frames / CAPTURE_FPS;
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
    const pageDetails = await page.evaluate(enumerateScreen);
    await page.screenshot({ path: path.join(dir, "screenshot.png"), fullPage: false });

    // Pass 1: discover every control (exploring visible tabs) and write the script.
    const { segments, tabsExplored } = await planNarration(page, tour, tour.route);
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
      // Pass 2: replay on a fresh page state and capture frames while narrating.
      await openRoute();
      const captions = ["WEBVTT", ""];
      let frameNumber = 0;
      let clicksDone = 0;
      let elapsed = 0;
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        for (; clicksDone < segment.tabPath.length; clicksDone++) {
          // Only select an already-visible UI tab. Never submit ERP or Factory
          // transactions, and keep all network writes blocked.
          const tab = await page.$('[data-testid="' + segment.tabPath[clicksDone] + '"]');
          if (tab) await tab.click().catch(() => undefined);
          await delay(1200);
        }
        let rect = null;
        if (segment.kind === "control" || segment.kind === "heading") {
          rect = await page.evaluate(locateAndScroll, { testid: segment.testid, label: segment.label, region: segment.region, tag: segment.tag, kind: segment.kind, level: segment.level });
          if (!rect) missingHighlights.push(segment.testid || segment.label);
          await delay(250);
        } else {
          await page.evaluate(() => document.querySelector("#main-content")?.scrollTo({ top: 0, behavior: "instant" }));
        }
        const title = segment.kind === "heading" ? "Section: " + segment.label
          : segment.kind === "control" ? (segment.role === "tab" || /^tab-/.test(segment.testid) ? "Tab: " : segment.tag === "input" || segment.tag === "select" || segment.tag === "textarea" ? "Field: " : segment.tag === "a" ? "Link: " : "Button: ") + (segment.label || segment.testid)
          : tour.title;
        for (let frame = 0; frame < segment.frames; frame++) {
          await page.evaluate(paintOverlay, { rect, title, text: segment.text, index: i + 1, total: segments.length, pulse: frame % 2 === 0 });
          await page.screenshot({
            path: path.join(framesDir, "frame-" + String(frameNumber++).padStart(5, "0") + ".jpg"),
            type: "jpeg", quality: 74, fullPage: false,
          });
        }
        captions.push(String(i + 1), vttTimestamp(elapsed) + " --> " + vttTimestamp(elapsed + segment.targetSeconds), segment.text, "");
        elapsed += segment.targetSeconds;
      }
      const narrationWav = path.join(clipsDir, "narration.wav");
      await fs.writeFile(narrationWav, joinWavClips(segments.map((segment) => ({ wav: segment.wav, targetSeconds: segment.targetSeconds }))));
      video = await encodeAndValidate(framesDir, narrationWav, elapsed, path.join(dir, "screen.mp4"));
      await fs.writeFile(path.join(dir, "captions.vtt"), captions.join("\n"));
      await fs.writeFile(path.join(dir, "guide.md"), buildGuide(tour, pageDetails, segments, video));
      return {
        topic: id, route: tour.route, sourceSha: process.env.GITHUB_SHA || null,
        durationMs: Math.round(video.durationSeconds * 1000), videoFile: "screen.mp4", codec: video.codec,
        resolution: `${video.width}x${video.height}`, narration: "piper-offline", narratedSegments: segments.length,
        explainedControls: segments.filter((segment) => segment.kind === "control").length, tabsExplored,
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

function buildGuide(tour, pageDetails, segments, video) {
  const lines = ["# " + tour.title, "", "Recorded against the disposable Phase 7 test company.", "",
    "Page: " + tour.route, "", "Screen heading: " + pageDetails.heading, "",
    "Narrated video: screen.mp4 (" + Math.round(video.durationSeconds) + " seconds, " + segments.filter((s) => s.kind === "control").length + " controls explained)", "",
    "## Guided steps", "", ...tour.steps.map((step, index) => String(index + 1) + ". " + step), "", "## Full transcript", ""];
  let group = "";
  for (const segment of segments) {
    const area = segment.kind === "control" || segment.kind === "heading" ? ({ header: "Top bar", sidebar: "Sidebar", main: "Main area", floating: "Floating controls" })[segment.region] : "";
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
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await login(page);
  for (const [id, tour] of tours) {
    const startedAt = Date.now();
    try {
      const entry = await recordOne(page, id, tour);
      report.push(entry);
      process.stdout.write("Captured narrated training UI: " + id + " (" + Math.round(entry.durationMs / 1000) + "s video, " +
        entry.explainedControls + " controls, " + Math.round((Date.now() - startedAt) / 1000) + "s to record)\n");
    } catch (err) {
      report.push({ topic: id, status: "failed", reason: String(err?.message || err) });
      process.stderr.write("Training recording failed for " + id + ": " + String(err?.message || err) + "\n");
    }
  }
} finally {
  await browser.close();
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
}
if (report.some((item) => item.status !== "captured")) process.exitCode = 1;
