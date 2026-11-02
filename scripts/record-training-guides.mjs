/**
 * Capture real ERP UI video from the disposable Phase 7 CI fixture only.
 * This runner deliberately has no open-ended AI click agent and makes no
 * accounting/stock writes. Editing the tour registry requires code review.
 *
 * Output: WebM video, PNG still, WebVTT caption timing, Markdown guide.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";
import puppeteer from "puppeteer";

const base = process.env.TRAINING_BASE_URL || "http://127.0.0.1:5000";
const username = process.env.ERP_E2E_USERNAME || "";
const password = process.env.ERP_E2E_PASSWORD || "";
const selectedTopic = process.env.TRAINING_TOPIC || "factory-overview";
const output = path.resolve("artifacts/training-videos");
const timeout = 45_000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TOURS = Object.freeze({
  "factory-overview": { company: "PHASE7-FACTORY", route: "/factory/production-report", title: "Factory overview", steps: ["This is the real Factory overview.", "Review the current production report and its available filters.", "Use the sidebar to move to your authorized Factory page."] },
  "factory-stock-entry": { company: "PHASE7-FACTORY", route: "/factory/stock-entry", title: "Factory stock entry", steps: ["Open the actual Stock Entry workspace.", "Review the form and production details without saving anything.", "Scroll through the available production information."] },
  "factory-raw-materials": { company: "PHASE7-FACTORY", route: "/factory/raw-materials", title: "Raw materials", steps: ["Review the real Raw Materials workspace.", "Inspect the available sections and cost context.", "Practice changing records only in an approved training exercise."] },
  "factory-bale-explorer": { company: "PHASE7-FACTORY", route: "/factory/bales-hub", title: "Bale Explorer", steps: ["Locate the Bale Explorer in Factory Mode.", "Use the visible search and navigation controls to understand traceability.", "This tour never updates or relabels a bale."] },
  "factory-containers": { company: "PHASE7-FACTORY", route: "/factory/containers-hub", title: "Factory containers", steps: ["Open Containers in the actual system.", "Review the sample container and loading sections.", "Do not finalize or verify any live container as part of a training recording."] },
  "factory-stock-allocation": { company: "PHASE7-FACTORY", route: "/factory/stock-allocation-v5", title: "Stock allocation", steps: ["Open the Stock Allocation workspace.", "Inspect quantities, filters and prices in the disposable data set.", "No allocations or proformas are saved by this tour."] },
  "factory-invoicing": { company: "PHASE7-FACTORY", route: "/factory/invoicing", title: "Factory invoicing", steps: ["Open Invoicing in Factory Mode.", "Review invoice sections and the available data columns.", "No invoice is created or finalized during this tour."] },
  "factory-payroll": { company: "PHASE7-FACTORY", route: "/factory/payroll-hub", title: "Payroll and benefits", steps: ["Open Payroll & Benefits.", "Review worker management and attendance sections.", "This training recording never edits attendance or posts payroll."] },
  "factory-accounts": { company: "PHASE7-FACTORY", route: "/factory/accounts", title: "Factory accounts", steps: ["Open Factory Accounts.", "Locate the statement, date range and ledger controls.", "No vouchers or balances are changed."] },
  "factory-analytics": { company: "PHASE7-FACTORY", route: "/factory/analytics", title: "Factory analytics", steps: ["Open Analytics in the real Factory interface.", "Review the displayed KPIs and reporting periods.", "Use the filters available to your role."] },
  "erp-tracking": { company: "PHASE7-ERP", route: "/tracking", title: "ERP tracking", steps: ["Open Tracking inside the ERP.", "Review available tracking sections.", "Find the filters and navigation."] },
  "erp-inventory": { company: "PHASE7-ERP", route: "/inventory", title: "ERP inventory", steps: ["Open the actual ERP Inventory hub.", "Review the sample items and inventory locations.", "No stock transfer is made."] },
  "erp-pos": { company: "PHASE7-ERP", route: "/pos", title: "ERP point of sale", steps: ["Open the ERP POS screen.", "Locate products and sales controls.", "This tour does not complete a sale."] },
  "erp-vouchers": { company: "PHASE7-ERP", route: "/vouchers", title: "ERP vouchers", steps: ["Open ERP Vouchers.", "Review available voucher history and posting controls.", "No accounting entries are posted."] },
  "erp-daybook": { company: "PHASE7-ERP", route: "/daybook", title: "ERP Daybook", steps: ["Open the Daybook.", "Review the date and transaction filters.", "No journal transactions are changed."] },
  "erp-reports": { company: "PHASE7-ERP", route: "/sales-report", title: "ERP Sales Report", steps: ["Open Sales Report.", "Review the available period and scope filters.", "This tour is read-only."] },
});
const tours = selectedTopic === "all" ? Object.entries(TOURS) : [[selectedTopic, TOURS[selectedTopic]]];

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
  await page.evaluate(async (companyCode) => {
    const r = await fetch("/api/user/companies", { credentials: "include", cache: "no-store" });
    if (!r.ok) throw new Error("Could not read fixture company assignments.");
    const companies = await r.json();
    const company = companies.find((row) => row.companyCode === companyCode);
    if (!company?.companyId) throw new Error("Fixture company unavailable: " + companyCode);
    const change = await fetch("/api/auth/set-company", {
      method: "POST", credentials: "include", headers: { "content-type": "application/json" },
      body: JSON.stringify({ companyId: company.companyId })
    });
    if (!change.ok) throw new Error("Unable to switch fixture company.");
    localStorage.setItem("selectedCompanyId", String(company.companyId));
  }, code);
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
    if (!response?.ok()) throw new Error("Page failed to load (" + response?.status() + ")");
    await page.waitForSelector("#main-content", { visible: true, timeout });
    await delay(1600);
    const actualPath = new URL(page.url()).pathname;
    if (actualPath !== tour.route) throw new Error("Unexpected redirect to " + actualPath + " for " + tour.route);
    const pageDetails = await page.evaluate(() => {
      const heading = document.querySelector("h1, h2");
      const tabs = Array.from(document.querySelectorAll("[role=tab]"))
        .map((item) => item.textContent?.trim()).filter(Boolean).slice(0, 12);
      return { title: heading?.textContent?.trim().slice(0, 120) || document.title, tabs };
    });
    await page.screenshot({ path: path.join(dir, "screenshot.png"), fullPage: false });
    const videoPath = path.join(dir, "screen.webm");
    const recorder = await page.screencast({ path: videoPath, fps: 20, quality: 38 });
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
          overlay.textContent = title + " — " + (index + 1) + ". " + instruction;
          window.scrollTo({ top: index === 0 ? 0 : index === 1 ? Math.max(0, document.documentElement.scrollHeight / 3) : document.documentElement.scrollHeight, behavior: "smooth" });
        }, { title: tour.title, instruction: tour.steps[i], index: i });
        // Approved navigation-only interaction: inspect a different visible tab.
        // Never click Save, Finalize, Approve, Delete, Pay or other write controls.
        if (i === 1) {
          const tabs = await page.$("[role=tab]:not([aria-selected=true]):not([disabled])");
          if (tabs.length) {
            await tabs[0].click().catch(() => undefined);
          }
        }
        await delay(2600);
        const end = Date.now() - started;
        captions.push(String(i + 1), timestamp(start) + " --> " + timestamp(end), tour.steps[i], "");
      }
    } finally {
      await recorder.stop();
      await page.evaluate(() => document.getElementById("training-recording-caption")?.remove()).catch(() => {});
    }
    // Keep usable evidence even if an app background request was blocked.
    // The review report makes incomplete interactions visible; no write was sent.
    await fs.writeFile(path.join(dir, "captions.vtt"), captions.join("\n"));
    const steps = tour.steps.map((item, index) => String(index + 1) + ". " + item).join("\n");
    await fs.writeFile(path.join(dir, "guide.md"), "# " + tour.title + "\n\nRecorded against the disposable Phase 7 test company.\n\nPage: " + tour.route + "\n\nScreen heading: " + pageDetails.title + "\n\nVisible tabs: " + (pageDetails.tabs.join(", ") || "(none)") + "\n\n## Guided steps\n\n" + steps + "\n\n![Actual test system screenshot](screenshot.png)\n");
    return { topic: id, route: tour.route, durationMs: Date.now() - started, status: "captured", blockedRequests: blocked.slice(0, 20), requiresReview: true, source: "disposable Phase 7 fixture" };
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
