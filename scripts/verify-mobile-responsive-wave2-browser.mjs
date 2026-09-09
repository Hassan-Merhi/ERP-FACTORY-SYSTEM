#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const BASE_URL = (process.env.ERP_SMOKE_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/, "");
const USERNAME = process.env.ERP_SMOKE_USERNAME || "";
const PASSWORD = process.env.ERP_SMOKE_PASSWORD || "";
const TIMEOUT_MS = Number(process.env.ERP_SMOKE_TIMEOUT_MS || 45_000);
const OUTPUT_DIR = path.resolve(
  process.env.ERP_WAVE2_SMOKE_OUTPUT_DIR || "artifacts/ux-regression-browser/mobile-wave2-factory"
);

if (!USERNAME || !PASSWORD) {
  console.error("Mobile Wave 2 browser smoke requires ERP_SMOKE_USERNAME and ERP_SMOKE_PASSWORD.");
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

const ROUTES = [
  { path: "/factory/raw-stock", anchor: '[data-testid="production-raw-stock-page"]' },
  { path: "/factory/raw-materials", anchor: '[data-testid="production-raw-stock-page"]' },
  { path: "/factory/sales/loading/new", anchor: '[data-testid="factory-container-loading-page"]' },
  { path: "/factory/stock-allocation-v5", anchor: '[data-testid="factory-stock-allocation-v5-page"]' },
  { path: "/factory/bale-tracking", anchor: '[data-testid="factory-bale-tracking-page"]' },
  { path: "/factory/import", anchor: '[data-testid="factory-import-page"]' },
  { path: "/factory/bale-relabeling", anchor: '[data-testid="factory-bale-relabeling-page"]' },
  { path: "/factory/bale-product-images", anchor: '[data-testid="bale-product-images-page"]' },
  { path: "/factory/location-inventory", anchor: null },
];

const report = {
  startedAt: new Date().toISOString(),
  viewports: VIEWPORTS,
  routes: ROUTES.map((route) => route.path),
  cases: [],
  failures: [],
};

function safeName(value) {
  return value.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "root";
}

async function settle(page) {
  await new Promise((resolve) => setTimeout(resolve, 700));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function closeLanguageOnboarding(page) {
  const dialogSelector = '[data-testid="language-onboarding-dialog"]';
  const open = await page.evaluate((selector) => {
    const dialog = document.querySelector(selector);
    if (!(dialog instanceof HTMLElement)) return false;
    const style = getComputedStyle(dialog);
    return style.display !== "none" && style.visibility !== "hidden";
  }, dialogSelector);
  if (!open) return;

  await page.click('[data-testid="language-onboarding-en"]');
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="language-onboarding-continue"]')?.hasAttribute("disabled"),
    { timeout: TIMEOUT_MS }
  );
  await page.click('[data-testid="language-onboarding-continue"]');
  await page.waitForFunction(
    (selector) => {
      const dialog = document.querySelector(selector);
      if (!(dialog instanceof HTMLElement)) return true;
      const style = getComputedStyle(dialog);
      return dialog.dataset.state === "closed" || style.display === "none" || style.visibility === "hidden";
    },
    { timeout: TIMEOUT_MS },
    dialogSelector
  );
}

async function login(page) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
  await page.waitForSelector('[data-testid="input-username"]', { visible: true, timeout: TIMEOUT_MS });
  await page.type('[data-testid="input-username"]', USERNAME);
  await page.type('[data-testid="input-password"]', PASSWORD);
  await page.click('[data-testid="button-login"]');
  await page.waitForFunction(
    () => window.location.pathname !== "/login" && Boolean(document.getElementById("main-content")),
    { timeout: TIMEOUT_MS }
  );
  await settle(page);
  await closeLanguageOnboarding(page);
}

async function selectFactoryCompany(page) {
  await page.evaluate(async () => {
    const listResponse = await fetch("/api/user/companies", { credentials: "include", cache: "no-store" });
    if (!listResponse.ok) throw new Error(`Company list failed (${listResponse.status})`);
    const companies = await listResponse.json();
    const assignment = Array.isArray(companies)
      ? companies.find((company) => company.companyCode === "PHASE9-FACTORY")
      : undefined;
    const companyId = Number(assignment?.companyId);
    if (!Number.isInteger(companyId) || companyId <= 0) throw new Error("PHASE9-FACTORY is unavailable");

    const switchResponse = await fetch("/api/auth/set-company", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ companyId }),
    });
    if (!switchResponse.ok) throw new Error(`Company switch failed (${switchResponse.status})`);
    localStorage.setItem("selectedCompanyId", String(companyId));
  });
}

async function openRoute(page, route) {
  const response = await page.goto(`${BASE_URL}${route.path}`, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
  await page.waitForFunction(() => Boolean(document.getElementById("main-content")), { timeout: TIMEOUT_MS });
  if (route.anchor) await page.waitForSelector(route.anchor, { visible: true, timeout: TIMEOUT_MS });
  await settle(page);
  return response?.status() ?? null;
}

async function readState(page, route, viewport) {
  return page.evaluate(
    ({ currentRoute, anchorSelector, viewportWidth }) => {
      const root = document.documentElement;
      const body = document.body;
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };

      const state = {
        route: currentRoute,
        actualPath: `${location.pathname}${location.search}`,
        viewportWidth,
        rootScrollWidth: root.scrollWidth,
        bodyScrollWidth: body?.scrollWidth || 0,
        horizontalOverflow: Math.max(root.scrollWidth, body?.scrollWidth || 0) > viewportWidth + 2,
        mainVisible: visible(document.getElementById("main-content")),
        anchorVisible: anchorSelector ? visible(document.querySelector(anchorSelector)) : true,
        rawMobileVisible: false,
        rawDesktopVisible: false,
        imageDeleteMobileContract: false,
      };

      if (currentRoute === "/factory/raw-stock" || currentRoute === "/factory/raw-materials") {
        const mobileList = document.querySelector('[data-testid="raw-stock-mobile-list"]');
        state.rawMobileVisible = visible(mobileList);
        const desktopContainer = mobileList?.nextElementSibling;
        state.rawDesktopVisible = visible(desktopContainer);
      }

      if (currentRoute === "/factory/bale-product-images") {
        const pageRoot = document.querySelector('[data-testid="bale-product-images-page"]');
        state.imageDeleteMobileContract = Boolean(pageRoot);
      }

      return state;
    },
    { currentRoute: route.path, anchorSelector: route.anchor, viewportWidth: viewport.width }
  );
}

function assertState(state, viewport, route) {
  const failures = [];
  const label = `${viewport.name} ${route.path}`;
  if (!state.mainVisible) failures.push(`${label}: main content is not visible`);
  if (!state.anchorVisible) failures.push(`${label}: route anchor is not visible`);
  if (state.actualPath.startsWith("/login")) failures.push(`${label}: returned to login`);
  if (!state.actualPath.startsWith(route.path)) failures.push(`${label}: redirected to ${state.actualPath}`);
  if (state.horizontalOverflow) {
    failures.push(
      `${label}: root horizontal overflow (${Math.max(state.rootScrollWidth, state.bodyScrollWidth)}px > ${state.viewportWidth}px)`
    );
  }

  if (route.path === "/factory/raw-stock" || route.path === "/factory/raw-materials") {
    if (viewport.width < 768 && !state.rawMobileVisible) failures.push(`${label}: mobile Raw Stock list is not visible`);
    if (viewport.width >= 768 && state.rawMobileVisible) failures.push(`${label}: mobile Raw Stock list leaked into md+ layout`);
    if (viewport.width >= 768 && !state.rawDesktopVisible) failures.push(`${label}: desktop Raw Stock table is not visible`);
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
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    try {
      await page.evaluateOnNewDocument(() => localStorage.setItem("erp.application-language", "en"));
      await login(page);
      await selectFactoryCompany(page);

      for (const route of ROUTES) {
        const status = await openRoute(page, route);
        const state = await readState(page, route, viewport);
        const failures = assertState(state, viewport, route);
        const directory = path.join(OUTPUT_DIR, viewport.name);
        await fs.mkdir(directory, { recursive: true });
        const screenshot = path.join(directory, `${safeName(route.path)}.png`);
        await page.screenshot({ path: screenshot, fullPage: true });
        report.cases.push({ viewport: viewport.name, route: route.path, status, state, screenshot, failures });
        report.failures.push(...failures);
      }
    } catch (error) {
      report.failures.push(`${viewport.name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      report.failures.push(...pageErrors.map((error) => `${viewport.name}: pageerror: ${error}`));
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
  console.error(`Mobile Wave 2 rendered smoke failed with ${report.failures.length} issue(s):`);
  for (const failure of report.failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Mobile Wave 2 rendered smoke passed ${report.cases.length} Factory route/viewport cases.`);
console.log(`Report: ${path.join(OUTPUT_DIR, "report.json")}`);
