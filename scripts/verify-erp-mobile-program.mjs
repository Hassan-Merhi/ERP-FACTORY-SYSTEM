#!/usr/bin/env node
/**
 * ERP mobile program route certification harness (Phases 2–10).
 *
 * Signs in once, switches to the ERP fixture company, then visits every ERP
 * route at each requested viewport and language. For each case it records
 * layout evidence that the mobile program cares about:
 *
 *   - document-level horizontal or vertical overflow (the shell scrolls inside #main-content)
 *   - visible PageHeader count (duplicate headers) and raw <h1> count
 *   - header title/action collisions and header content leaving the viewport
 *   - visible elements that escape the viewport outside a scroll container
 *   - open filter toolbars that consume too much of a phone screen
 *   - wide tables rendered on phones without a mobile representation
 *   - small interactive touch targets on phones
 *   - console errors and uncaught page errors
 *
 * With --workflows it also drives the real-device phone workflows (remediation items 1–14:
 * open the record, sheet or dialog and check its phone representation and reachable actions)
 * on every phone viewport; see scripts/lib/erp-mobile-workflows.mjs. --workflows-only skips
 * the route sweep and --workflow-ids=a,b limits the probes.
 *
 * Usage:
 *   ERP_SMOKE_USERNAME=... ERP_SMOKE_PASSWORD=... \
 *   node scripts/verify-erp-mobile-program.mjs [--routes=/a,/b] [--viewports=phone-320,desktop-1440] \
 *     [--languages=en,fr,ar] [--screenshots] [--company=PHASE9-ERP]
 *
 * The report is written to artifacts/erp-mobile-program/report.json. The exit
 * code is non-zero when any blocking layout failure is found.
 */

import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

import { awaitAuthenticatedShell, watchSignInResponses } from "./lib/browser-smoke-signin.mjs";
import { runErpMobileWorkflows } from "./lib/erp-mobile-workflows.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.length ? rest.join("=") : "true"];
  }),
);

const BASE_URL = (process.env.ERP_SMOKE_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/, "");
const USERNAME = process.env.ERP_SMOKE_USERNAME || "";
const PASSWORD = process.env.ERP_SMOKE_PASSWORD || "";
const TIMEOUT_MS = Number(process.env.ERP_SMOKE_TIMEOUT_MS || 45_000);
const OUTPUT_DIR = path.resolve(process.env.ERP_MOBILE_PROGRAM_OUTPUT_DIR || "artifacts/erp-mobile-program");
const COMPANY_CODE = args.company || process.env.ERP_MOBILE_PROGRAM_COMPANY || "PHASE9-ERP";
const TAKE_SCREENSHOTS = args.screenshots === "true" || args.screenshots === "all";
const SCREENSHOT_ALL_VIEWPORTS = args.screenshots === "all";
const EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const WORKFLOWS_ONLY = args["workflows-only"] === "true";
const RUN_WORKFLOWS = WORKFLOWS_ONLY || args.workflows === "true";
const WORKFLOW_IDS = args["workflow-ids"] ? new Set(args["workflow-ids"].split(",")) : undefined;

if (!USERNAME || !PASSWORD) {
  console.error("ERP mobile program certification requires ERP_SMOKE_USERNAME and ERP_SMOKE_PASSWORD.");
  process.exit(1);
}

const ALL_VIEWPORTS = [
  { name: "phone-320", width: 320, height: 640, isMobile: true, hasTouch: true },
  { name: "phone-360", width: 360, height: 780, isMobile: true, hasTouch: true },
  { name: "phone-393", width: 393, height: 852, isMobile: true, hasTouch: true },
  { name: "phone-412", width: 412, height: 915, isMobile: true, hasTouch: true },
  { name: "phone-landscape", width: 852, height: 393, isMobile: true, hasTouch: true },
  { name: "tablet-768", width: 768, height: 1024, isMobile: true, hasTouch: true },
  { name: "desktop-1440", width: 1440, height: 900, isMobile: false, hasTouch: false },
];

/**
 * Every ERP route reachable by an ERP user. Parameterised routes use fixture
 * ids; a missing record must still render a usable not-found/empty state.
 */
export const ERP_ROUTES = [
  "/tracking",
  "/tracking?tab=git-tracking",
  "/tracking?tab=transporter-statement",
  "/",
  "/financial-overview",
  "/inventory?tab=by-location",
  "/inventory?tab=on-the-way",
  "/inventory?tab=containers",
  "/stock?tab=items",
  "/stock?tab=query",
  "/stock?tab=offload",
  "/parties?tab=suppliers",
  "/parties?tab=customers",
  "/sales-tools?tab=transfers",
  "/sales-tools?tab=pricelist",
  "/accounts",
  "/vouchers",
  "/daybook",
  "/create",
  "/optional-vouchers",
  "/transaction-journal",
  "/location-inventory",
  "/pos",
  "/analytics",
  "/sales-report",
  "/sales-report/comparison",
  "/stock-in-sales-report",
  "/agents",
  "/payroll",
  "/containers",
  "/po-import",
  "/pos-import",
  "/pos-item-replacement",
  "/stock-transfer-order",
  "/import-stock-items",
  "/supplier-profit-check",
  "/opening-stock",
  "/closing-stock-summary",
  "/bale-ledger",
  "/barcode-manager",
  "/erp/rental/warehouses",
  "/erp/rental/shops",
  "/erp/rental/payments",
  "/conflicts",
  "/intercompany-requests",
  "/my-settings",
  "/settings",
  "/intercompany-links",
  "/orphaned-records",
  "/deleted-items",
  "/chatbot-settings",
  "/notification-settings",
  "/account-groups",
  "/test-data-import",
  "/import-cycle-diagnostics",
  "/inventory-repair",
  "/balance-repair",
  "/convergence-reconciliation",
  "/net-position-details",
  "/company-data-reset",
  "/account-migration",
  "/account-transfer",
  "/company-transfer",
  "/net-profit-report",
  "/spreadsheet",
  "/live-sheets",
  "/chat",
  "/ai-validation",
  "/ai-command-center",
];

const viewportFilter = args.viewports ? new Set(args.viewports.split(",")) : null;
const VIEWPORTS = viewportFilter ? ALL_VIEWPORTS.filter((v) => viewportFilter.has(v.name)) : ALL_VIEWPORTS;
const ROUTES = args.routes ? args.routes.split(",") : ERP_ROUTES;
const LANGUAGES = (args.languages || "en").split(",");

function safeName(value) {
  return value.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "root";
}

async function settle(page, ms = 700) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function markLanguageOnboardingComplete(page) {
  await page.evaluate(async () => {
    const me = await fetch("/api/auth/me", { credentials: "include" }).then((r) => (r.ok ? r.json() : null));
    const id = me?.id ?? me?.user?.id;
    if (id != null) window.localStorage.setItem(`application-language-onboarding:v1:${id}`, "completed");
  });
}

async function login(page) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
  await page.waitForSelector('[data-testid="input-username"]', { visible: true, timeout: TIMEOUT_MS });
  await page.type('[data-testid="input-username"]', USERNAME);
  await page.type('[data-testid="input-password"]', PASSWORD);
  const signIn = watchSignInResponses(page);
  try {
    await page.click('[data-testid="button-login"]');
    await awaitAuthenticatedShell(
      signIn,
      page.waitForFunction(
        () => window.location.pathname !== "/login" && Boolean(document.getElementById("main-content")),
        { timeout: TIMEOUT_MS },
      ),
    );
  } finally {
    signIn.stop();
  }
  await markLanguageOnboardingComplete(page);
}

async function selectCompany(page, companyCode) {
  await page.evaluate(async (targetCode) => {
    const listResponse = await fetch("/api/user/companies", { credentials: "include", cache: "no-store" });
    if (!listResponse.ok) throw new Error(`Company list failed (${listResponse.status})`);
    const companies = await listResponse.json();
    const assignment = Array.isArray(companies)
      ? companies.find((company) => company.companyCode === targetCode)
      : undefined;
    const companyId = Number(assignment?.companyId);
    if (!Number.isInteger(companyId) || companyId <= 0) throw new Error(`Company ${targetCode} is unavailable`);
    const switchResponse = await fetch("/api/auth/set-company", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ companyId }),
    });
    if (!switchResponse.ok) throw new Error(`Company switch failed (${switchResponse.status})`);
    window.localStorage.setItem("selectedCompanyId", String(companyId));
  }, companyCode);
}

async function setLanguage(page, language) {
  await page.evaluate(async (next) => {
    const csrf = await fetch("/api/csrf-token", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    const headers = { "content-type": "application/json" };
    if (csrf?.csrfToken) headers["x-csrf-token"] = csrf.csrfToken;
    await fetch("/api/language-preference", {
      method: "PUT",
      credentials: "include",
      headers,
      body: JSON.stringify({ preferredLanguage: next }),
    });
    for (const key of Object.keys(window.localStorage)) {
      if (/language/i.test(key) && !key.startsWith("application-language-onboarding")) {
        window.localStorage.setItem(key, next);
      }
    }
  }, language);
}

async function openRoute(page, route) {
  const response = await page.goto(`${BASE_URL}${route}`, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
  await page.waitForFunction(() => Boolean(document.getElementById("main-content")), { timeout: TIMEOUT_MS });
  // Wait for lazy route chunks and first data fetches to settle.
  await page
    .waitForFunction(
      () =>
        !document.querySelector('[data-testid="app-loading-state"], [aria-busy="true"]') ||
        document.querySelector('[data-testid="page-header"], h1'),
      { timeout: 15_000 },
    )
    .catch(() => undefined);
  await settle(page, 900);
  return response?.status() ?? null;
}

async function readLayout(page, viewport) {
  return page.evaluate((vp) => {
    const vw = window.innerWidth;
    const isPhone = vw < 640;
    const main = document.getElementById("main-content");
    const visible = (el) => {
      if (!(el instanceof Element)) return false;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const describe = (el) => {
      const testId = el.getAttribute("data-testid");
      const text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
      return `${el.tagName.toLowerCase()}${testId ? `[${testId}]` : ""}${text ? ` "${text}"` : ""}`;
    };
    const inScrollContainer = (el) => {
      let node = el.parentElement;
      while (node && node !== document.body) {
        const style = window.getComputedStyle(node);
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX) && node.scrollWidth >= node.clientWidth) {
          const rect = node.getBoundingClientRect();
          if (rect.right <= vw + 2) return true;
        }
        node = node.parentElement;
      }
      return false;
    };

    const root = document.documentElement;
    const overflowWidth = Math.max(root.scrollWidth, document.body?.scrollWidth || 0);
    // The ERP shell scrolls inside #main-content; the document itself must not scroll.
    const overflowHeight = root.scrollHeight;

    const headers = [...document.querySelectorAll('[data-testid="page-header"]')].filter(visible);
    const rawH1 = main
      ? [...main.querySelectorAll("h1")].filter((h) => visible(h) && !h.closest('[data-testid="page-header"]'))
      : [];

    const headerIssues = [];
    for (const header of headers) {
      const title = header.querySelector('[data-testid="text-page-title"]');
      const titleRect = title?.getBoundingClientRect();
      const controls = [...header.querySelectorAll("button, a, [role=combobox], input, select")].filter(visible);
      for (const control of controls) {
        const rect = control.getBoundingClientRect();
        if (rect.right > vw + 1 || rect.left < -1) headerIssues.push(`header control off-screen: ${describe(control)}`);
        if (
          titleRect &&
          !title.contains(control) &&
          rect.left < titleRect.right - 1 &&
          rect.right > titleRect.left + 1 &&
          rect.top < titleRect.bottom - 1 &&
          rect.bottom > titleRect.top + 1
        ) {
          headerIssues.push(`header control overlaps title: ${describe(control)}`);
        }
      }
      if (titleRect && (titleRect.right > vw + 1 || titleRect.left < -1)) headerIssues.push("header title off-screen");
    }

    const escaped = [];
    if (main) {
      for (const el of main.querySelectorAll("*")) {
        if (escaped.length >= 8) break;
        if (!visible(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.right > vw + 2 || rect.left < -2) {
          if (inScrollContainer(el)) continue;
          if (el.closest('[data-radix-popper-content-wrapper], [role="dialog"], .sr-only')) continue;
          escaped.push(`${describe(el)} (${Math.round(rect.left)}→${Math.round(rect.right)})`);
        }
      }
    }

    const wideTables = [];
    if (isPhone && main) {
      for (const table of main.querySelectorAll("table")) {
        if (!visible(table)) continue;
        const rect = table.getBoundingClientRect();
        if (rect.width > vw + 8) {
          const headerCells = table.querySelectorAll("thead th").length;
          wideTables.push({ width: Math.round(rect.width), columns: headerCells, label: describe(table).slice(0, 60) });
        }
      }
    }

    const smallTargets = [];
    if (isPhone && main) {
      for (const el of main.querySelectorAll("button, a[href], [role=button], [role=tab], [role=checkbox]")) {
        if (!visible(el)) continue;
        if (el.closest("table, [data-radix-popper-content-wrapper]")) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 24 || rect.height < 24) smallTargets.push(describe(el));
        if (smallTargets.length >= 10) break;
      }
    }

    // Filter toolbars that eat the phone viewport.
    const filterBlocks = [];
    if (isPhone && main) {
      for (const el of main.querySelectorAll('[role="search"], [data-core-erp-filters], [data-erp-filter-bar]')) {
        if (!visible(el)) continue;
        const rect = el.getBoundingClientRect();
        filterBlocks.push({ height: Math.round(rect.height), ratio: Number((rect.height / window.innerHeight).toFixed(2)) });
      }
    }

    const headerHeight = headers[0] ? Math.round(headers[0].getBoundingClientRect().height) : null;
    const bottomNav = document.querySelector('[data-testid="erp-mobile-bottom-nav"]');
    return {
      viewport: vp.name,
      path: `${window.location.pathname}${window.location.search}`,
      horizontalOverflow: overflowWidth > vw + 2,
      overflowWidth,
      verticalOverflow: overflowHeight > window.innerHeight + 2,
      overflowHeight,
      headerCount: headers.length,
      rawH1Count: rawH1.length,
      rawH1: rawH1.map((h) => (h.textContent || "").trim().slice(0, 50)),
      headerHeight,
      headerIssues,
      escaped,
      wideTables,
      smallTargets,
      filterBlocks,
      bottomNavVisible: visible(bottomNav),
      dir: document.documentElement.dir || "ltr",
      title: headers[0]?.querySelector('[data-testid="text-page-title"]')?.textContent?.trim() || rawH1[0]?.textContent?.trim() || "",
    };
  }, viewport);
}

function classify(result) {
  const blocking = [];
  const warnings = [];
  if (result.horizontalOverflow) blocking.push(`document horizontal overflow (${result.overflowWidth}px)`);
  if (result.verticalOverflow) blocking.push(`document vertical overflow (${result.overflowHeight}px)`);
  if (result.headerCount > 1) blocking.push(`${result.headerCount} visible page headers`);
  for (const issue of result.headerIssues) blocking.push(issue);
  for (const escaped of result.escaped) warnings.push(`escapes viewport: ${escaped}`);
  if (result.headerCount === 0 && result.rawH1Count > 0) warnings.push(`legacy h1 header: ${result.rawH1.join(" | ")}`);
  for (const table of result.wideTables) warnings.push(`wide table on phone: ${table.width}px/${table.columns} cols`);
  for (const block of result.filterBlocks)
    if (block.ratio > 0.45) warnings.push(`filter area uses ${Math.round(block.ratio * 100)}% of phone height`);
  if (result.smallTargets.length) warnings.push(`small touch targets: ${result.smallTargets.slice(0, 4).join(", ")}`);
  if (result.consoleErrors?.length) warnings.push(`console errors: ${result.consoleErrors.slice(0, 2).join(" | ")}`);
  return { blocking, warnings };
}

const report = {
  startedAt: new Date().toISOString(),
  baseUrl: BASE_URL,
  company: COMPANY_CODE,
  cases: [],
  workflows: [],
};

await fs.mkdir(OUTPUT_DIR, { recursive: true });
const browser = await puppeteer.launch({
  headless: true,
  executablePath: EXECUTABLE_PATH,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text().slice(0, 200));
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${String(error?.message || error).slice(0, 200)}`));

  await page.setViewport({ width: 1280, height: 900 });
  await login(page);
  await selectCompany(page, COMPANY_CODE);

  for (const language of LANGUAGES) {
    await setLanguage(page, language);
    for (const viewport of VIEWPORTS) {
      await page.setViewport({
        width: viewport.width,
        height: viewport.height,
        isMobile: viewport.isMobile,
        hasTouch: viewport.hasTouch,
        deviceScaleFactor: 1,
      });
      for (const route of WORKFLOWS_ONLY ? [] : ROUTES) {
        consoleErrors.length = 0;
        let result;
        let navigationRetried = false;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try {
            const status = await openRoute(page, route);
            result = { route, language, status, ...(await readLayout(page, viewport)) };
            break;
          } catch (error) {
            // A navigation timeout (the shell never mounted) is retried once and
            // recorded; layout findings are never retried.
            result = { route, language, viewport: viewport.name, error: String(error?.message || error) };
            if (attempt === 1) {
              navigationRetried = true;
              consoleErrors.length = 0;
            }
          }
        }
        result.navigationRetried = navigationRetried;
        result.consoleErrors = consoleErrors.filter((e) => !/Failed to load resource|favicon|AISStream|\[vite\]|Vite server|WebSocket (connection|closed without opened)/i.test(e));
        const { blocking, warnings } = result.error ? { blocking: [result.error], warnings: [] } : classify(result);
        result.blocking = blocking;
        result.warnings = warnings;
        report.cases.push(result);
        const mark = blocking.length ? "FAIL" : warnings.length ? "WARN" : "PASS";
        console.log(`${mark} ${language} ${viewport.name} ${route}${blocking.length ? ` :: ${blocking.join("; ")}` : ""}`);
        if (TAKE_SCREENSHOTS && (SCREENSHOT_ALL_VIEWPORTS || viewport.width < 900)) {
          await page
            .screenshot({
              path: path.join(OUTPUT_DIR, `${language}-${viewport.name}-${safeName(route)}.png`),
              fullPage: false,
            })
            .catch(() => undefined);
        }
      }

      // Workflow probes run where the phone layout applies: narrow phones and phone landscape.
      if (RUN_WORKFLOWS && viewport.isMobile && (viewport.width < 640 || viewport.height <= 500)) {
        const results = await runErpMobileWorkflows(page, {
          baseUrl: BASE_URL,
          timeoutMs: TIMEOUT_MS,
          settle,
          only: WORKFLOW_IDS,
        });
        for (const result of results) {
          report.workflows.push({ language, viewport: viewport.name, ...result });
          const detail = result.failures.length ? ` :: ${result.failures.join("; ")}` : result.reason ? ` (${result.reason})` : "";
          console.log(`${result.status.toUpperCase()} workflow#${result.item} ${language} ${viewport.name} ${result.id}${detail}`);
        }
      }
    }
  }
} finally {
  await browser.close();
}

report.finishedAt = new Date().toISOString();
report.summary = {
  cases: report.cases.length,
  failures: report.cases.filter((c) => c.blocking.length).length,
  warnings: report.cases.filter((c) => !c.blocking.length && c.warnings.length).length,
  workflows: report.workflows.length,
  workflowFailures: report.workflows.filter((w) => w.status === "fail").length,
  workflowSkipped: report.workflows.filter((w) => w.status === "skipped").length,
};
await fs.writeFile(path.join(OUTPUT_DIR, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.summary));
process.exit(report.summary.failures || report.summary.workflowFailures ? 1 : 0);
