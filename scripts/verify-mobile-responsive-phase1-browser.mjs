#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const BASE_URL = (process.env.ERP_SMOKE_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/, "");
const USERNAME = process.env.ERP_SMOKE_USERNAME || "";
const PASSWORD = process.env.ERP_SMOKE_PASSWORD || "";
const TIMEOUT_MS = Number(process.env.ERP_SMOKE_TIMEOUT_MS || 45_000);
const OUTPUT_DIR = path.resolve(process.env.ERP_PHASE1_SMOKE_OUTPUT_DIR || "artifacts/ux-regression-browser/mobile-phase1");

if (!USERNAME || !PASSWORD) {
  console.error("Mobile Phase 1 browser smoke requires ERP_SMOKE_USERNAME and ERP_SMOKE_PASSWORD.");
  process.exit(1);
}

const VIEWPORTS = [
  { name: "phone-320", width: 320, height: 568, isMobile: true, hasTouch: true },
  { name: "phone-360", width: 360, height: 800, isMobile: true, hasTouch: true },
  { name: "phone-390", width: 390, height: 844, isMobile: true, hasTouch: true },
  { name: "tablet-768", width: 768, height: 1024, isMobile: true, hasTouch: true },
  { name: "phone-landscape", width: 844, height: 390, isMobile: true, hasTouch: true },
  { name: "desktop-1440", width: 1440, height: 900, isMobile: false, hasTouch: false },
];

const ROUTE_GROUPS = [
  {
    workspace: "erp",
    companyCode: "PHASE9-ERP",
    routes: ["/agents", "/account-groups", "/chat"],
  },
  {
    workspace: "factory",
    companyCode: "PHASE9-FACTORY",
    routes: ["/factory/agents", "/factory/chat"],
  },
];

const report = {
  startedAt: new Date().toISOString(),
  viewports: VIEWPORTS,
  cases: [],
  failures: [],
};

function safeName(value) {
  return value.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "root";
}

async function settle(page) {
  await new Promise((resolve) => setTimeout(resolve, 800));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function closeLanguageOnboarding(page) {
  const dialogSelector = '[data-testid="language-onboarding-dialog"]';
  const dialogOpen = await page.evaluate((selector) => {
    const dialog = document.querySelector(selector);
    if (!(dialog instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(dialog);
    return style.display !== "none" && style.visibility !== "hidden";
  }, dialogSelector);

  if (!dialogOpen) return;

  await page.click('[data-testid="language-onboarding-en"]');
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="language-onboarding-continue"]')?.hasAttribute("disabled"),
    { timeout: TIMEOUT_MS },
  );

  const continueSelector = '[data-testid="language-onboarding-continue"]';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (attempt === 1) await page.click(continueSelector);
    else await page.evaluate((selector) => document.querySelector(selector)?.click(), continueSelector);

    try {
      await page.waitForFunction(
        (selector) => {
          const dialog = document.querySelector(selector);
          if (!(dialog instanceof HTMLElement)) return true;
          const style = window.getComputedStyle(dialog);
          return dialog.dataset.state === "closed" || style.display === "none" || style.visibility === "hidden";
        },
        { timeout: Math.min(TIMEOUT_MS, 5_000) },
        dialogSelector,
      );
      return;
    } catch {
      if (attempt === 3) throw new Error("Language onboarding did not close after 3 attempts");
    }
  }
}

async function login(page) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
  await page.waitForSelector('[data-testid="input-username"]', { visible: true, timeout: TIMEOUT_MS });
  await page.type('[data-testid="input-username"]', USERNAME);
  await page.type('[data-testid="input-password"]', PASSWORD);
  await page.click('[data-testid="button-login"]');
  await page.waitForFunction(
    () => window.location.pathname !== "/login" && Boolean(document.getElementById("main-content")),
    { timeout: TIMEOUT_MS },
  );
  await settle(page);
  await closeLanguageOnboarding(page);
}

async function selectCompany(page, companyCode) {
  await page.evaluate(async (targetCode) => {
    const listResponse = await fetch("/api/user/companies", { credentials: "include", cache: "no-store" });
    if (!listResponse.ok) throw new Error(`Company list failed (${listResponse.status})`);
    const companies = await listResponse.json();
    const assignment = Array.isArray(companies) ? companies.find((company) => company.companyCode === targetCode) : undefined;
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

async function openRoute(page, route) {
  const response = await page.goto(`${BASE_URL}${route}`, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
  await page.waitForFunction(() => Boolean(document.getElementById("main-content")), { timeout: TIMEOUT_MS });
  await settle(page);
  return response?.status() ?? null;
}

async function readState(page, route) {
  return page.evaluate((currentRoute) => {
    const root = document.documentElement;
    const body = document.body;
    const viewportWidth = window.innerWidth;
    const visibleRect = (element) => {
      if (!(element instanceof HTMLElement)) return null;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) return null;
      return { width: rect.width, height: rect.height, x: rect.x, y: rect.y };
    };

    const state = {
      route: currentRoute,
      actualPath: `${window.location.pathname}${window.location.search}`,
      viewportWidth,
      rootScrollWidth: root.scrollWidth,
      bodyScrollWidth: body?.scrollWidth || 0,
      horizontalOverflow: Math.max(root.scrollWidth, body?.scrollWidth || 0) > viewportWidth + 2,
      main: visibleRect(document.getElementById("main-content")),
      anchorVisible: false,
      paneWidth: null,
      flexDirection: null,
    };

    if (currentRoute.endsWith("/agents") || currentRoute === "/agents") {
      const anchor = document.querySelector('[data-testid="button-add-agent"]');
      const pane = anchor?.closest(".w-72");
      state.anchorVisible = Boolean(visibleRect(anchor));
      state.paneWidth = visibleRect(pane)?.width ?? null;
    } else if (currentRoute === "/account-groups") {
      const anchor = document.querySelector('[data-testid="button-create-group"]');
      const pane = anchor?.closest(".w-72");
      state.anchorVisible = Boolean(visibleRect(anchor));
      state.paneWidth = visibleRect(pane)?.width ?? null;
    } else if (currentRoute.endsWith("/chat") || currentRoute === "/chat") {
      const chat = document.querySelector('[data-testid="chat-page"]');
      const pane = chat?.querySelector(":scope > .w-64");
      state.anchorVisible = Boolean(visibleRect(chat));
      state.paneWidth = visibleRect(pane)?.width ?? null;
      state.flexDirection = chat instanceof HTMLElement ? window.getComputedStyle(chat).flexDirection : null;
    }

    return state;
  }, route);
}

function assertState(state, viewport, route) {
  const failures = [];
  const label = `${viewport.name} ${route}`;
  if (!state.main) failures.push(`${label}: main content is not visible`);
  if (state.actualPath.startsWith("/login")) failures.push(`${label}: authenticated session returned to login`);
  if (!state.actualPath.startsWith(route)) failures.push(`${label}: redirected to ${state.actualPath}`);
  if (state.horizontalOverflow) {
    failures.push(`${label}: root horizontal overflow (${Math.max(state.rootScrollWidth, state.bodyScrollWidth)}px > ${state.viewportWidth}px)`);
  }
  if (!state.anchorVisible) failures.push(`${label}: critical route anchor is not visible`);
  if (state.paneWidth !== null && state.paneWidth > state.viewportWidth + 2) {
    failures.push(`${label}: legacy navigation pane is ${Math.round(state.paneWidth)}px wide for ${state.viewportWidth}px viewport`);
  }
  if (route.endsWith("/chat") || route === "/chat") {
    const shouldStack = viewport.width <= 767;
    if (shouldStack && state.flexDirection !== "column") {
      failures.push(`${label}: chat is ${state.flexDirection || "unknown"} instead of stacked column layout`);
    }
    if (!shouldStack && state.flexDirection === "column") {
      failures.push(`${label}: tablet/desktop chat unexpectedly uses the phone column layout`);
    }
  }
  return failures;
}

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });

try {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  for (const viewport of VIEWPORTS) {
    const page = await browser.newPage();
    page.setDefaultTimeout(TIMEOUT_MS);
    page.setDefaultNavigationTimeout(TIMEOUT_MS);
    await page.setViewport(viewport);
    const browserErrors = [];
    page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));

    try {
      await page.evaluateOnNewDocument(() => window.localStorage.setItem("erp.application-language", "en"));
      await login(page);

      for (const group of ROUTE_GROUPS) {
        await selectCompany(page, group.companyCode);
        for (const route of group.routes) {
          const status = await openRoute(page, route);
          const state = await readState(page, route);
          const failures = assertState(state, viewport, route);
          const directory = path.join(OUTPUT_DIR, viewport.name, group.workspace);
          await fs.mkdir(directory, { recursive: true });
          const screenshot = path.join(directory, `${safeName(route)}.png`);
          await page.screenshot({ path: screenshot, fullPage: true });
          report.cases.push({ viewport: viewport.name, workspace: group.workspace, route, status, state, screenshot, failures });
          report.failures.push(...failures);
        }
      }
    } catch (error) {
      report.failures.push(`${viewport.name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      report.failures.push(...browserErrors.map((error) => `${viewport.name}: ${error}`));
      await page.close();
    }
  }
} finally {
  await browser.close();
}

report.finishedAt = new Date().toISOString();
report.failures = [...new Set(report.failures)];
await fs.writeFile(path.join(OUTPUT_DIR, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

if (report.failures.length > 0) {
  console.error(`Mobile Phase 1 browser smoke failed with ${report.failures.length} issue(s):`);
  for (const failure of report.failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Mobile Phase 1 browser smoke passed ${report.cases.length} rendered route/viewport cases.`);
console.log(`Report: ${path.join(OUTPUT_DIR, "report.json")}`);
