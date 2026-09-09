#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const BASE_URL = (process.env.ERP_SMOKE_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/, "");
const USERNAME = process.env.ERP_SMOKE_USERNAME || "";
const PASSWORD = process.env.ERP_SMOKE_PASSWORD || "";
const TIMEOUT_MS = Number(process.env.ERP_SMOKE_TIMEOUT_MS || 45_000);
const OUTPUT_DIR = path.resolve(
  process.env.ERP_WAVE4_SMOKE_OUTPUT_DIR || "artifacts/ux-regression-browser/mobile-wave4-regression",
);

if (!USERNAME || !PASSWORD) {
  console.error("Mobile Wave 4 browser smoke requires ERP_SMOKE_USERNAME and ERP_SMOKE_PASSWORD.");
  process.exit(1);
}

const VIEWPORTS = [
  { name: "phone-320", width: 320, height: 568, isMobile: true, hasTouch: true },
  { name: "phone-360", width: 360, height: 800, isMobile: true, hasTouch: true },
  { name: "phone-390", width: 390, height: 844, isMobile: true, hasTouch: true },
  { name: "phone-landscape", width: 844, height: 390, isMobile: true, hasTouch: true },
  { name: "tablet-768", width: 768, height: 1024, isMobile: true, hasTouch: true },
  { name: "desktop-1440", width: 1440, height: 900, isMobile: false, hasTouch: false },
];

const ROUTE_GROUPS = [
  {
    workspace: "erp",
    companyCode: "PHASE9-ERP",
    routes: [
      { path: "/tracking" },
      { path: "/accounts" },
      { path: "/daybook" },
      { path: "/vouchers" },
      { path: "/opening-stock" },
      { path: "/closing-stock-summary" },
      { path: "/import-stock-items" },
      { path: "/pos" },
    ],
  },
  {
    workspace: "factory",
    companyCode: "PHASE9-FACTORY",
    routes: [
      { path: "/factory/raw-stock" },
      { path: "/factory/location-inventory" },
      { path: "/factory/containers-hub" },
      { path: "/factory/accounts" },
      { path: "/factory/parties" },
      { path: "/factory/vouchers" },
      { path: "/factory/payroll-hub" },
      { path: "/factory/sales/loading/new" },
      { path: "/factory/stock-allocation-v5" },
      { path: "/factory/bale-tracking" },
      { path: "/factory/import" },
      { path: "/factory/bale-relabeling" },
      { path: "/factory/bale-product-images" },
    ],
  },
];

const HOVER_CRITICAL_ROUTES = new Set([
  "/factory/raw-stock",
  "/factory/sales/loading/new",
  "/factory/stock-allocation-v5",
  "/factory/bale-tracking",
  "/factory/import",
  "/factory/bale-relabeling",
  "/factory/bale-product-images",
]);

const report = {
  startedAt: new Date().toISOString(),
  viewports: VIEWPORTS,
  routeGroups: ROUTE_GROUPS.map((group) => ({
    workspace: group.workspace,
    routes: group.routes.map((route) => route.path),
  })),
  cases: [],
  failures: [],
};

function safeName(value) {
  return value.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "root";
}

function isPhoneClassViewport(viewport) {
  return viewport.width < 768 || (viewport.hasTouch && viewport.height <= 500);
}

async function settle(page) {
  await new Promise((resolve) => setTimeout(resolve, 650));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function closeLanguageOnboarding(page) {
  const selector = '[data-testid="language-onboarding-dialog"]';
  const open = await page.evaluate((dialogSelector) => {
    const dialog = document.querySelector(dialogSelector);
    if (!(dialog instanceof HTMLElement)) return false;
    const style = getComputedStyle(dialog);
    return style.display !== "none" && style.visibility !== "hidden";
  }, selector);
  if (!open) return;

  await page.click('[data-testid="language-onboarding-en"]');
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="language-onboarding-continue"]')?.hasAttribute("disabled"),
    { timeout: TIMEOUT_MS },
  );
  await page.click('[data-testid="language-onboarding-continue"]');
  await page.waitForFunction(
    (dialogSelector) => {
      const dialog = document.querySelector(dialogSelector);
      if (!(dialog instanceof HTMLElement)) return true;
      const style = getComputedStyle(dialog);
      return dialog.dataset.state === "closed" || style.display === "none" || style.visibility === "hidden";
    },
    { timeout: TIMEOUT_MS },
    selector,
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
    { timeout: TIMEOUT_MS },
  );
  await settle(page);
  await closeLanguageOnboarding(page);
}

async function selectWorkspaceCompany(page, companyCode) {
  return page.evaluate(async (targetCode) => {
    const listResponse = await fetch("/api/user/companies", { credentials: "include", cache: "no-store" });
    if (!listResponse.ok) throw new Error(`Company list failed (${listResponse.status})`);
    const companies = await listResponse.json();
    const assignment = Array.isArray(companies)
      ? companies.find((company) => company.companyCode === targetCode)
      : undefined;
    const companyId = Number(assignment?.companyId);
    if (!Number.isInteger(companyId) || companyId <= 0) throw new Error(`${targetCode} is unavailable`);

    const switchResponse = await fetch("/api/auth/set-company", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ companyId }),
    });
    if (!switchResponse.ok) throw new Error(`Company switch failed (${switchResponse.status})`);
    localStorage.setItem("selectedCompanyId", String(companyId));
    return companyId;
  }, companyCode);
}

async function openRoute(page, route) {
  const response = await page.goto(`${BASE_URL}${route}`, {
    waitUntil: "domcontentloaded",
    timeout: TIMEOUT_MS,
  });
  await page.waitForFunction(() => Boolean(document.getElementById("main-content")), { timeout: TIMEOUT_MS });
  await settle(page);
  return response?.status() ?? null;
}

async function exerciseSafeControls(page, route) {
  const interaction = {
    focusedTextControl: null,
    comboboxExercised: false,
    scannerFocused: false,
  };

  const textSelector = await page.evaluate(() => {
    const selectors = [
      '#main-content input[type="search"]',
      '#main-content input[type="text"]',
      '#main-content input:not([type])',
      '#main-content textarea',
    ];
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return !element.hasAttribute("disabled") && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    for (const selector of selectors) {
      const element = [...document.querySelectorAll(selector)].find(visible);
      if (element instanceof HTMLElement) {
        if (!element.id) element.id = `wave4-focus-${Math.random().toString(36).slice(2)}`;
        return `#${CSS.escape(element.id)}`;
      }
    }
    return null;
  });

  if (textSelector) {
    await page.focus(textSelector);
    interaction.focusedTextControl = await page.evaluate(
      (selector) => document.activeElement === document.querySelector(selector),
      textSelector,
    );
  }

  const comboboxSelector = await page.evaluate(() => {
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return !element.hasAttribute("disabled") && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const element = [...document.querySelectorAll('#main-content [role="combobox"]')].find(visible);
    if (!(element instanceof HTMLElement)) return null;
    if (!element.id) element.id = `wave4-combobox-${Math.random().toString(36).slice(2)}`;
    return `#${CSS.escape(element.id)}`;
  });

  if (comboboxSelector) {
    await page.click(comboboxSelector);
    await page.keyboard.press("Escape");
    await settle(page);
    interaction.comboboxExercised = true;
  }

  if (route === "/factory/sales/loading/new") {
    const scanner = await page.$('[data-testid="input-scan-code"]');
    if (scanner) {
      const disabled = await page.$eval(
        '[data-testid="input-scan-code"]',
        (element) => element.hasAttribute("disabled"),
      );
      if (!disabled) {
        await page.focus('[data-testid="input-scan-code"]');
        interaction.scannerFocused = await page.evaluate(
          () => document.activeElement === document.querySelector('[data-testid="input-scan-code"]'),
        );
      }
    }
  }

  return interaction;
}

async function readState(page, route, viewport) {
  return page.evaluate(
    ({ currentRoute, viewportWidth, viewportHeight, phoneClass }) => {
      const root = document.documentElement;
      const body = document.body;
      const main = document.getElementById("main-content");
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
      };
      const rectOf = (element) => {
        if (!(element instanceof HTMLElement) || !visible(element)) return null;
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
      };

      const interactive = main
        ? [...main.querySelectorAll('button, input, select, textarea, [role="button"], [role="combobox"]')]
        : [];
      const criticalSelectors = [
        '[data-testid="input-scan-code"]',
        '[data-testid="button-ignore-proforma"]',
        '[data-testid="button-import-excel"]',
        '[data-testid="button-template-ref"]',
      ];
      const criticalTouchViolations = [];
      if (phoneClass) {
        for (const selector of criticalSelectors) {
          for (const element of document.querySelectorAll(selector)) {
            const rect = rectOf(element);
            if (rect && (rect.height < 44 || rect.width < 44)) {
              criticalTouchViolations.push(`${selector}:${Math.round(rect.width)}x${Math.round(rect.height)}`);
            }
          }
        }
      }

      const hoverOnlyInteractive = phoneClass
        ? interactive
            .filter((element) => {
              if (!(element instanceof HTMLElement)) return false;
              const className = String(element.className || "");
              return className.includes("opacity-0") && className.includes("group-hover");
            })
            .map((element) => element.getAttribute("data-testid") || element.getAttribute("aria-label") || element.tagName)
        : [];

      const dialogViewportViolations = [...document.querySelectorAll('[role="dialog"]')]
        .filter(visible)
        .map((element) => ({ element, rect: rectOf(element) }))
        .filter(({ rect }) => rect && (rect.x < -2 || rect.right > viewportWidth + 2 || rect.y < -2 || rect.bottom > viewportHeight + 2))
        .map(({ element, rect }) => `${element.getAttribute("data-testid") || "dialog"}:${Math.round(rect.width)}x${Math.round(rect.height)}`);

      const stickyFixedViewportViolations = main
        ? [...main.querySelectorAll("*")]
            .filter((element) => {
              if (!(element instanceof HTMLElement) || !visible(element)) return false;
              const position = getComputedStyle(element).position;
              return position === "fixed" || position === "sticky";
            })
            .map((element) => ({ element, rect: rectOf(element) }))
            .filter(({ rect }) => rect && (rect.x < -3 || rect.right > viewportWidth + 3 || rect.bottom > viewportHeight + 3))
            .map(({ element }) => element.getAttribute("data-testid") || element.getAttribute("aria-label") || element.tagName)
        : [];

      const smallTextControls = phoneClass
        ? interactive
            .filter((element) => {
              if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;
              if (!visible(element)) return false;
              if (["checkbox", "radio", "range", "file", "hidden"].includes(element.type)) return false;
              return parseFloat(getComputedStyle(element).fontSize || "0") < 16;
            })
            .map((element) => element.getAttribute("data-testid") || element.getAttribute("placeholder") || element.tagName)
        : [];

      const scanner = document.querySelector('[data-testid="input-scan-code"]');
      const scannerRect = rectOf(scanner);
      const scannerContract = scannerRect
        ? { visible: true, disabled: scanner.hasAttribute("disabled"), width: scannerRect.width, height: scannerRect.height }
        : { visible: false, disabled: false, width: 0, height: 0 };

      const loadingSetupVisible =
        visible(document.querySelector('[data-testid="select-customer"]')) &&
        visible(document.querySelector('[data-testid="select-location"]'));

      return {
        route: currentRoute,
        actualPath: `${location.pathname}${location.search}`,
        viewport: { width: viewportWidth, height: viewportHeight },
        rootScrollWidth: root.scrollWidth,
        bodyScrollWidth: body?.scrollWidth || 0,
        horizontalOverflow: Math.max(root.scrollWidth, body?.scrollWidth || 0) > viewportWidth + 2,
        mainVisible: visible(main),
        phoneLandscapeMedia: matchMedia("(hover: none) and (pointer: coarse) and (max-height: 500px)").matches,
        hoverOnlyInteractive,
        criticalTouchViolations,
        dialogViewportViolations,
        stickyFixedViewportViolations,
        smallTextControls,
        scannerContract,
        loadingSetupVisible,
      };
    },
    {
      currentRoute: route,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      phoneClass: isPhoneClassViewport(viewport),
    },
  );
}

function assertState(state, viewport, route, interaction) {
  const failures = [];
  const label = `${viewport.name} ${route}`;
  const phoneClass = isPhoneClassViewport(viewport);
  const expectedPath = route.split("?")[0];

  if (!state.mainVisible) failures.push(`${label}: main content is not visible`);
  if (state.actualPath.startsWith("/login")) failures.push(`${label}: authenticated session returned to login`);
  if (!state.actualPath.startsWith(expectedPath)) failures.push(`${label}: redirected to ${state.actualPath}`);
  if (state.horizontalOverflow) {
    failures.push(`${label}: root horizontal overflow (${Math.max(state.rootScrollWidth, state.bodyScrollWidth)}px > ${state.viewport.width}px)`);
  }
  if (viewport.name === "phone-landscape" && !state.phoneLandscapeMedia) {
    failures.push(`${label}: landscape-phone coarse-pointer contract did not activate`);
  }
  if (viewport.name === "tablet-768" && state.phoneLandscapeMedia) {
    failures.push(`${label}: landscape-phone media contract leaked into tablet`);
  }
  if (phoneClass && HOVER_CRITICAL_ROUTES.has(route) && state.hoverOnlyInteractive.length > 0) {
    failures.push(`${label}: hover-only touch-critical controls remain: ${state.hoverOnlyInteractive.join(", ")}`);
  }
  if (state.criticalTouchViolations.length > 0) {
    failures.push(`${label}: critical controls below 44px: ${state.criticalTouchViolations.join(", ")}`);
  }
  if (state.dialogViewportViolations.length > 0) {
    failures.push(`${label}: dialog escaped viewport: ${state.dialogViewportViolations.join(", ")}`);
  }
  if (phoneClass && state.stickyFixedViewportViolations.length > 0) {
    failures.push(`${label}: sticky/fixed control escaped phone viewport: ${state.stickyFixedViewportViolations.join(", ")}`);
  }
  if (state.smallTextControls.length > 0) {
    failures.push(`${label}: phone text controls below 16px: ${state.smallTextControls.join(", ")}`);
  }
  if (interaction.focusedTextControl === false) failures.push(`${label}: visible text control did not retain focus`);

  if (route === "/factory/sales/loading/new") {
    if (!state.scannerContract.visible && !state.loadingSetupVisible) {
      failures.push(`${label}: neither loading setup nor scanner state is visible`);
    }
    if (state.scannerContract.visible && state.scannerContract.height < 44) {
      failures.push(`${label}: scanner input is only ${Math.round(state.scannerContract.height)}px tall`);
    }
    if (state.scannerContract.visible && !state.scannerContract.disabled && !interaction.scannerFocused) {
      failures.push(`${label}: enabled scanner input could not receive focus`);
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
    await page.setViewport({
      width: viewport.width,
      height: viewport.height,
      isMobile: viewport.isMobile,
      hasTouch: viewport.hasTouch,
    });
    await page.evaluateOnNewDocument(() => localStorage.setItem("erp.application-language", "en"));
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    try {
      await login(page);
      for (const group of ROUTE_GROUPS) {
        const companyId = await selectWorkspaceCompany(page, group.companyCode);
        for (const route of group.routes) {
          const status = await openRoute(page, route.path);
          const interaction = await exerciseSafeControls(page, route.path);
          const state = await readState(page, route.path, viewport);
          const failures = assertState(state, viewport, route.path, interaction);
          const directory = path.join(OUTPUT_DIR, viewport.name, group.workspace);
          await fs.mkdir(directory, { recursive: true });
          const screenshot = path.join(directory, `${safeName(route.path)}.png`);
          await page.screenshot({ path: screenshot, fullPage: true });
          report.cases.push({
            viewport: viewport.name,
            workspace: group.workspace,
            companyId,
            route: route.path,
            status,
            interaction,
            state,
            screenshot: path.relative(process.cwd(), screenshot),
            failures,
          });
          report.failures.push(...failures);
        }
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
  console.error(`Mobile Wave 4 rendered regression failed with ${report.failures.length} issue(s):`);
  for (const failure of report.failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Mobile Wave 4 rendered regression passed ${report.cases.length} route/viewport cases.`);
console.log(`Report: ${path.join(OUTPUT_DIR, "report.json")}`);
