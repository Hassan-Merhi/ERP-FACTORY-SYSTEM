/**
 * Capture real ERP UI video from the disposable Phase 7 CI fixture only.
 * This runner deliberately has no open-ended AI click agent and makes no
 * accounting/stock writes. Editing the tour registry requires code review.
 *
 * Output: WebM video, PNG still, WebVTT caption timing, Markdown guide.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { URL } from "node:url";
import puppeteer from "puppeteer";

const base = process.env.TRAINING_BASE_URL || "http://127.0.0.1:5000";
const username = process.env.ERP_E2E_USERNAME || "";
const password = process.env.ERP_E2E_PASSWORD || "";
const selectedTopic = process.env.TRAINING_TOPIC || "factory-overview";
const output = path.resolve("artifacts/training-videos");
const timeout = 45_000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const execFile = promisify(execFileCallback);
const CAPTION_HOLD_MS = 9_000; // Five narrated-by-text sections produce about 45 seconds per topic.
const MIN_DURATION_SECONDS = 35;
const MAX_DURATION_SECONDS = 60;

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

function assertSafeEnvironment() {
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
}

function timestamp(ms) {
  const n = Math.max(0, Math.floor(ms));
  const h = String(Math.floor(n / 3_600_000)).padStart(2, "0");
  const m = String(Math.floor(n / 60_000) % 60).padStart(2, "0");
  const s = String(Math.floor(n / 1000) % 60).padStart(2, "0");
  const rem = String(n % 1000).padStart(3, "0");
  return h + ":" + m + ":" + s + "." + rem;
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
  const selectedId = await page.evaluate(async (companyCode) => {
    const r = await fetch("/api/user/companies", { credentials: "include", cache: "no-store" });
    if (!r.ok) throw new Error("Could not read fixture company assignments.");
    const companies = await r.json();
    const company = companies.find((row) => row.companyCode === companyCode);
    const companyId = Number(company?.companyId);
    if (!Number.isInteger(companyId) || companyId <= 0) {
      throw new Error("Fixture company unavailable: " + companyCode);
    }
    const session = await fetch("/api/auth/session-company", { credentials: "include", cache: "no-store" });
    const active = session.ok ? await session.json().catch(() => ({})) : {};
    if (Number(active.companyId) !== companyId) {
      const change = await fetch("/api/auth/set-company", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ companyId }),
      });
      if (!change.ok) throw new Error("Unable to switch fixture company (" + change.status + ").");
    }
    localStorage.setItem("selectedCompanyId", String(companyId));
    return companyId;
  }, code);
  // A direct session switch does not update React's mounted CompanyProvider.
  // Reload on an ERP/Factory-neutral page before recording the target route.
  // Otherwise the old company route guard redirects valid test pages away.
  const bootstrap = await page.goto(base + "/my-settings", { waitUntil: "domcontentloaded", timeout });
  if (bootstrap && !bootstrap.ok()) {
    throw new Error("Company bootstrap failed (" + bootstrap.status() + ")");
  }
  await page.waitForSelector("#main-content", { visible: true, timeout });
  await page.waitForFunction(
    (expected) => localStorage.getItem("selectedCompanyId") === String(expected),
    { timeout },
    selectedId,
  );
  const sessionCompany = await page.evaluate(async () => {
    const result = await fetch("/api/auth/session-company", { credentials: "include", cache: "no-store" });
    if (!result.ok) throw new Error("Session company verification failed");
    return Number((await result.json()).companyId);
  });
  if (sessionCompany !== selectedId) throw new Error("Fixture session company changed during bootstrap");
  await delay(500);
}

/**
 * Puppeteer's WebM screencast can use VP9 chroma formats that Windows Media
 * Player decodes as blocks. Ship an H.264/yuv420p MP4 instead and decode every
 * frame before marking the capture as reviewable.
 */
async function transcodeAndValidate(sourceWebm, outputMp4) {
  await execFile("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", sourceWebm,
    "-map", "0:v:0", "-an", "-vf", "fps=20,format=yuv420p",
    "-c:v", "libx264", "-profile:v", "main", "-preset", "veryfast",
    "-crf", "21", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    "-t", "59", outputMp4,
  ]);
  const { stdout } = await execFile("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,pix_fmt,width,height:format=duration",
    "-of", "json", outputMp4,
  ]);
  const probe = JSON.parse(stdout);
  const stream = probe.streams?.[0];
  const durationSeconds = Number(probe.format?.duration);
  if (stream?.codec_name !== "h264" || stream?.pix_fmt !== "yuv420p" ||
      !Number.isFinite(durationSeconds) ||
      durationSeconds < MIN_DURATION_SECONDS || durationSeconds > MAX_DURATION_SECONDS) {
    throw new Error("Training video fails Windows H.264 playback or 35-60 second duration checks");
  }
  await execFile("ffmpeg", ["-hide_banner", "-v", "error", "-xerror", "-i", outputMp4, "-f", "null", "-"]);
  await fs.unlink(sourceWebm); // Keep only validated, Windows-compatible review media.
  return { durationSeconds, width: stream.width, height: stream.height, codec: "h264/yuv420p" };
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
    if (url.origin !== new URL(base).origin || !["GET", "HEAD", "OPTIONS"].includes(method)) {
      blocked.push(method + " " + url.pathname);
      return request.abort("blockedbyclient");
    }
    return request.continue();
  };
  page.on("request", onRequest);
  try {
    const response = await page.goto(base + tour.route, { waitUntil: "domcontentloaded", timeout });
    // Puppeteer returns null for same-document navigations. The ERP uses client-side
    // routing, so a null navigation response is not evidence that the page failed.
    // Still reject real HTTP failures and verify the returned HTML, authenticated
    // application shell, expected route, and meaningful visible page content.
    if (response && !response.ok()) {
      throw new Error("Page HTTP navigation failed (" + response.status() + ") at " + tour.route);
    }
    const http = await page.evaluate(async (route) => {
      const result = await fetch(route, { credentials: "include", cache: "no-store", redirect: "manual" });
      return { status: result.status, type: result.headers.get("content-type") || "" };
    }, tour.route);
    if (http.status !== 200 || !http.type.includes("text/html")) {
      throw new Error("Training page GET failed (" + http.status + ", " + http.type + ") at " + tour.route);
    }
    await page.waitForSelector("#main-content", { visible: true, timeout });
    await page.waitForFunction(() => {
      const main = document.querySelector("#main-content");
      return Boolean(main && main.textContent && main.textContent.trim().length > 20);
    }, { timeout });
    const actualPath = new URL(page.url()).pathname;
    if (actualPath !== tour.route) throw new Error("Unexpected redirect to " + actualPath + " for " + tour.route);
    await delay(1600);
    const pageDetails = await page.evaluate(() => {
      const heading = document.querySelector("h1, h2");
      const tabs = Array.from(document.querySelectorAll("[role=tab]"))
        .map((item) => item.textContent?.trim()).filter(Boolean).slice(0, 12);
      return { title: heading?.textContent?.trim().slice(0, 120) || document.title, tabs };
    });
    await page.screenshot({ path: path.join(dir, "screenshot.png"), fullPage: false });
    const videoPath = path.join(dir, "screen.webm");
    const recorder = await page.screencast({ path: videoPath, fps: 20, quality: 72 });
    const captions = ["WEBVTT", ""];
    const started = Date.now();
    try {
      for (let i = 0; i < tour.steps.length; i++) {
        const start = Date.now() - started;
        await page.evaluate(({ title, instruction, index }) => {
          let overlay = document.getElementById("training-recording-caption");
          if (!overlay) {
            overlay = document.createElement("div");
            overlay.id = "training-recording-caption";
            overlay.setAttribute("aria-hidden", "true");
            overlay.style.cssText = "position:fixed;bottom:24px;left:24px;right:24px;max-width:840px;background:rgba(9,20,42,.9);color:white;border-radius:14px;padding:18px 24px;font:600 19px system-ui;z-index:2147483647;box-shadow:0 8px 32px rgba(0,0,0,.35);pointer-events:none";
            document.body.appendChild(overlay);
          }
          overlay.textContent = title + " — Step " + (index + 1) + " of 5: " + instruction;
          const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
          window.scrollTo({ top: maxScroll * index / 4, behavior: "smooth" });
        }, { title: tour.title, instruction: tour.steps[i], index: i });
        // Approved navigation-only interaction: inspect a different visible tab.
        // Never click Save, Finalize, Approve, Delete, Pay or other write controls.
        if (i === 2) {
          const tab = await page.$("[role=tab]:not([aria-selected=true]):not([disabled])");
          if (tab) await tab.click().catch(() => undefined);
        }
        await delay(CAPTION_HOLD_MS);
        const end = Date.now() - started;
        captions.push(String(i + 1), timestamp(start) + " --> " + timestamp(end), tour.steps[i], "");
      }
    } finally {
      await recorder.stop();
      await page.evaluate(() => document.getElementById("training-recording-caption")?.remove()).catch(() => {});
    }
    const video = await transcodeAndValidate(videoPath, path.join(dir, "screen.mp4"));
    // Keep usable evidence even if an app background request was blocked.
    // The review report makes incomplete interactions visible; no write was sent.
    await fs.writeFile(path.join(dir, "captions.vtt"), captions.join("\n"));
    const steps = tour.steps.map((item, index) => String(index + 1) + ". " + item).join("\n");
    await fs.writeFile(path.join(dir, "guide.md"), "# " + tour.title + "\n\nRecorded against the disposable Phase 7 test company.\n\nPage: " + tour.route + "\n\nScreen heading: " + pageDetails.title + "\n\nVisible tabs: " + (pageDetails.tabs.join(", ") || "(none)") + "\n\n## Guided steps\n\n" + steps + "\n\n![Actual test system screenshot](screenshot.png)\n");
    return { topic: id, route: tour.route, sourceSha: process.env.GITHUB_SHA || null, durationMs: Math.round(video.durationSeconds * 1000), videoFile: "screen.mp4", codec: video.codec, resolution: `${video.width}x${video.height}`, status: "captured", blockedRequests: blocked.slice(0, 20), requiresReview: true, source: "disposable Phase 7 fixture" };
  } finally {
    page.off("request", onRequest);
    await page.setRequestInterception(false);
  }
}

assertSafeEnvironment();
await fs.mkdir(output, { recursive: true });
const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const report = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await login(page);
  for (const [id, tour] of tours) {
    try {
      report.push(await recordOne(page, id, tour));
      process.stdout.write("Captured real training UI: " + id + "\n");
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
