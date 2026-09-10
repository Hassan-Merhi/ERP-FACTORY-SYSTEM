#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const BASE_URL = (process.env.ERP_SMOKE_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/, "");
const USERNAME = process.env.ERP_SMOKE_USERNAME || "";
const PASSWORD = process.env.ERP_SMOKE_PASSWORD || "";
const TIMEOUT_MS = Number(process.env.ERP_SMOKE_TIMEOUT_MS || 45_000);
const OUTPUT_DIR = path.resolve(
  process.env.ERP_WAVE3_SMOKE_OUTPUT_DIR || "artifacts/ux-regression-browser/mobile-wave3-erp"
);

if (!USERNAME || !PASSWORD) {
  console.error("Mobile Wave 3 browser smoke requires ERP_SMOKE_USERNAME and ERP_SMOKE_PASSWORD.");
  process.exit(1);
}

const VIEWPORTS = [
  { name: "phone-320", width: 320, height: 568, isMobile: true, hasTouch: true, phoneClass: true },
  { name: "phone-360", width: 360, height: 800, isMobile: true, hasTouch: true, phoneClass: true },
  { name: "phone-390", width: 390, height: 844, isMobile: true, hasTouch: true, phoneClass: true },
  { name: "phone-landscape", width: 844, height: 390, isMobile: true, hasTouch: true, phoneClass: true },
  { name: "tablet-768", width: 768, height: 1024, isMobile: true, hasTouch: true, phoneClass: false },
  { name: "desktop-1440", width: 1440, height: 900, isMobile: false, hasTouch: false, phoneClass: false },
];

const ROUTES = [
  { url: "/accounts", marker: "/accounts", checkHoverActions: true },
  { url: "/parties?tab=suppliers", marker: "/parties", checkHoverActions: true },
  { url: "/parties?tab=customers", marker: "/parties", checkHoverActions: true },
  { url: "/containers", marker: "/containers", checkHoverActions: true },
  { url: "/inventory?tab=by-location", marker: "/inventory" },
  { url: "/inventory?tab=on-the-way", marker: "/inventory", mobileAlternative: true },
  { url: "/stock?tab=items", marker: "/stock" },
  { url: "/stock?tab=query", marker: "/stock", mobileAlternative: true },
  { url: "/stock?tab=offload", marker: "/stock", mobileAlternative: true },
  { url: "/daybook", marker: "/daybook" },
  { url: "/transaction-journal", marker: "/transaction-journal" },
  { url: "/vouchers", marker: "/vouchers" },
  { url: "/sales-tools?tab=transfers", marker: "/sales-tools", mobileAlternative: true },
  { url: "/sales-report", marker: "/sales-report" },
  { url: "/opening-stock", marker: "/opening-stock" },
  { url: "/closing-stock-summary", marker: "/closing-stock-summary" },
  { url: "/po-import", marker: "/po-import" },
  { url: "/import-stock-items", marker: "/import-stock-items" },
  { url: "/optional-vouchers", marker: "/optional-vouchers", mobileAlternative: true },
  { url: "/barcode-manager", marker: "/barcode-manager", mobileAlternative: true },
  { url: "/deleted-items", marker: "/deleted-items", mobileAlternative: true },
  { url: "/orphaned-records", marker: "/orphaned-records", mobileAlternative: true },
  { url: "/settings", marker: "/settings", checkHoverActions: true },
];

const report = {
  startedAt: new Date().toISOString(),
  viewports: VIEWPORTS,
  routes: ROUTES.map((route) => route.url),
  cases: [],
  failures: [],
};

function safeName(value) {
  return value.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "root";
}

async function settle(page) {
  await new Promise((resolve) => setTimeout(resolve, 650));
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

async function selectErpCompany(page) {
  await page.evaluate(async () => {
    const listResponse = await fetch("/api/user/companies", { credentials: "include", cache: "no-store" });
    if (!listResponse.ok) throw new Error(`Company list failed (${listResponse.status})`);
    const companies = await listResponse.json();
    const assignment = Array.isArray(companies)
      ? companies.find((company) => company.companyCode === "PHASE9-ERP")
      : undefined;
    const companyId = Number(assignment?.companyId);
    if (!Number.isInteger(companyId) || companyId <= 0) throw new Error("PHASE9-ERP is unavailable");

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
  const response = await page.goto(`${BASE_URL}${route.url}`, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
  await page.waitForFunction(() => Boolean(document.getElementById("main-content")), { timeout: TIMEOUT_MS });
  await page.waitForSelector(`[data-erp-route="${route.marker}"]`, { visible: true, timeout: TIMEOUT_MS });
  await settle(page);
  return response?.status() ?? null;
}

async function readState(page, route, viewport) {
  return page.evaluate(
    ({ marker, viewportWidth, phoneClass, mobileAlternative, checkHoverActions }) => {
      const root = document.documentElement;
      const body = document.body;
      const routeRoot = document.querySelector(`[data-erp-route="${marker}"]`);
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity || "1") > 0.01 &&
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.top < innerHeight
        );
      };

      const controls = routeRoot
        ? [...routeRoot.querySelectorAll("button,input,select,textarea")].filter(visible)
        : [];
      const undersized = phoneClass
        ? controls
            .map((element) => {
              const rect = element.getBoundingClientRect();
              return {
                tag: element.tagName.toLowerCase(),
                testid: element.getAttribute("data-testid") || "",
                width: Math.round(rect.width * 10) / 10,
                height: Math.round(rect.height * 10) / 10,
              };
            })
            .filter((entry) => entry.height < 43.5)
            .slice(0, 12)
        : [];

      const hiddenActionButtons =
        checkHoverActions && routeRoot
          ? [...routeRoot.querySelectorAll('button[class*="opacity-0"]')]
              .filter((element) => {
                if (!(element instanceof HTMLElement)) return false;
                const rect = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
              })
              .filter((element) => Number(getComputedStyle(element).opacity || "1") < 0.5).length
          : 0;

      const mobileCandidates = mobileAlternative && routeRoot ? [...routeRoot.querySelectorAll('[class~="md:hidden"]')] : [];
      const desktopCandidates =
        mobileAlternative && routeRoot ? [...routeRoot.querySelectorAll('[class~="hidden"][class~="md:block"]')] : [];
      const mobileVisibleCount = mobileCandidates.filter(visible).length;
      const desktopVisibleCount = desktopCandidates.filter(visible).length;

      return {
        actualPath: `${location.pathname}${location.search}`,
        markerVisible: visible(routeRoot),
        rootScrollWidth: root.scrollWidth,
        bodyScrollWidth: body?.scrollWidth || 0,
        horizontalOverflow: Math.max(root.scrollWidth, body?.scrollWidth || 0) > viewportWidth + 2,
        touchMedia: matchMedia("(hover: none) and (pointer: coarse)").matches,
        phoneLandscapeMedia: matchMedia("(hover: none) and (pointer: coarse) and (max-height: 500px)").matches,
        undersized,
        hiddenActionButtons,
        mobileCandidateCount: mobileCandidates.length,
        desktopCandidateCount: desktopCandidates.length,
        mobileVisibleCount,
        desktopVisibleCount,
      };
    },
    {
      marker: route.marker,
      viewportWidth: viewport.width,
      phoneClass: viewport.phoneClass,
      mobileAlternative: Boolean(route.mobileAlternative),
      checkHoverActions: Boolean(route.checkHoverActions),
    }
  );
}

function assertState(state, viewport, route) {
  const failures = [];
  const label = `${viewport.name} ${route.url}`;
  if (!state.markerVisible) failures.push(`${label}: ERP route marker is not visible`);
  if (state.actualPath.startsWith("/login")) failures.push(`${label}: returned to login`);
  if (!state.actualPath.startsWith(route.marker)) failures.push(`${label}: redirected to ${state.actualPath}`);
  if (state.horizontalOverflow) {
    failures.push(
      `${label}: root horizontal overflow (${Math.max(state.rootScrollWidth, state.bodyScrollWidth)}px > ${viewport.width}px)`
    );
  }
  if (viewport.phoneClass && state.undersized.length) {
    failures.push(`${label}: undersized touch controls ${JSON.stringify(state.undersized)}`);
  }
  if (viewport.phoneClass && route.checkHoverActions && state.hiddenActionButtons > 0) {
    failures.push(`${label}: ${state.hiddenActionButtons} actionable hover-hidden button(s) remain`);
  }
  if (viewport.name === "phone-landscape" && !state.phoneLandscapeMedia) {
    failures.push(`${label}: coarse landscape-phone media query did not activate`);
  }

  if (route.mobileAlternative && state.mobileCandidateCount > 0) {
    if (viewport.phoneClass && state.mobileVisibleCount === 0) {
      failures.push(`${label}: existing mobile card/list alternative is not visible`);
    }
    if (!viewport.phoneClass && state.mobileVisibleCount > 0) {
      failures.push(`${label}: mobile card/list leaked into tablet/desktop layout`);
    }
    if (viewport.name === "phone-landscape" && state.desktopCandidateCount > 0 && state.desktopVisibleCount > 0) {
      failures.push(`${label}: desktop data view remained visible beside landscape-phone cards`);
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
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    try {
      await page.evaluateOnNewDocument(() => localStorage.setItem("erp.application-language", "en"));
      await login(page);
      await selectErpCompany(page);

      for (const route of ROUTES) {
        const status = await openRoute(page, route);
        const state = await readState(page, route, viewport);
        const failures = assertState(state, viewport, route);
        const directory = path.join(OUTPUT_DIR, viewport.name);
        await fs.mkdir(directory, { recursive: true });
        const screenshot = path.join(directory, `${safeName(route.url)}.png`);
        await page.screenshot({ path: screenshot, fullPage: true });
        report.cases.push({ viewport: viewport.name, route: route.url, status, state, screenshot, failures });
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
  console.error(`Mobile Wave 3 rendered smoke failed with ${report.failures.length} issue(s):`);
  for (const failure of report.failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Mobile Wave 3 rendered smoke passed ${report.cases.length} ERP route/viewport cases.`);
console.log(`Report: ${path.join(OUTPUT_DIR, "report.json")}`);
