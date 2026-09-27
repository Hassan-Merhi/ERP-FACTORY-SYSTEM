#!/usr/bin/env node

/**
 * Factory Mode rendered mobile regression (Factory mobile audit, Phase 13).
 *
 * Opens the canonical Factory destinations plus seeded detail/workflow routes at phone
 * (320/360/390), touch-landscape, tablet and desktop sizes and checks the layout, touch,
 * form, dialog, sticky/fixed and navigation contracts. The Wave 4 browser smoke keeps
 * covering the Factory floor screens; this script covers the rest of Factory Mode.
 *
 * Usage (against a running build of the branch, with a non-production test account):
 *
 *   ERP_SMOKE_BASE_URL=http://127.0.0.1:5000 \
 *   ERP_SMOKE_USERNAME=... ERP_SMOKE_PASSWORD=... \
 *   node scripts/verify-factory-mobile-browser.mjs
 *
 * Optional:
 *   ERP_FACTORY_MOBILE_COMPANY_CODE   Factory company code (default PHASE9-FACTORY)
 *   ERP_FACTORY_MOBILE_ROUTES         Comma-separated route subset to run
 *   ERP_FACTORY_MOBILE_VIEWPORTS      Comma-separated viewport names to run
 *   ERP_FACTORY_MOBILE_SEEDS          JSON ids for seeded routes, e.g. {"order":12,"batch":3,"ride":5,
 *                                     "customer":4,"employee":2,"worker":9}; missing ids are resolved
 *                                     from the Factory list APIs, and routes without data are skipped
 *                                     (reported, and failing with ERP_FACTORY_MOBILE_REQUIRE_SEEDS=1).
 *   ERP_FACTORY_MOBILE_CREATE_SEEDS   1 creates the missing records (see scripts/lib/factory-mobile-fixture.mjs)
 *                                     through the Factory APIs so detail routes and tables render with rows.
 *                                     Disposable fixture databases only (CI); never use it on real data.
 *   ERP_FACTORY_MOBILE_STRICT_TABLES  1 fails phone routes whose ordinary tables still scroll sideways
 *                                     (default: reported as warnings; analytical matrices opt out
 *                                     with `data-mobile-matrix`).
 */

import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

import { awaitAuthenticatedShell, watchSignInResponses } from "./lib/browser-smoke-signin.mjs";
import { resolveFactoryMobileSeeds } from "./lib/factory-mobile-fixture.mjs";

const BASE_URL = (process.env.ERP_SMOKE_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/, "");
const USERNAME = process.env.ERP_SMOKE_USERNAME || "";
const PASSWORD = process.env.ERP_SMOKE_PASSWORD || "";
const TIMEOUT_MS = Number(process.env.ERP_SMOKE_TIMEOUT_MS || 45_000);
const COMPANY_CODE = process.env.ERP_FACTORY_MOBILE_COMPANY_CODE || "PHASE9-FACTORY";
const REQUIRE_SEEDS = process.env.ERP_FACTORY_MOBILE_REQUIRE_SEEDS === "1";
const STRICT_TABLES = process.env.ERP_FACTORY_MOBILE_STRICT_TABLES === "1";
const CREATE_SEEDS = process.env.ERP_FACTORY_MOBILE_CREATE_SEEDS === "1";
const OUTPUT_DIR = path.resolve(
  process.env.ERP_FACTORY_MOBILE_OUTPUT_DIR || "artifacts/ux-regression-browser/factory-mobile",
);

if (!USERNAME || !PASSWORD) {
  console.error("Factory mobile browser regression requires ERP_SMOKE_USERNAME and ERP_SMOKE_PASSWORD.");
  process.exit(1);
}

const ALL_VIEWPORTS = [
  { name: "phone-320", width: 320, height: 568, isMobile: true, hasTouch: true },
  { name: "phone-360", width: 360, height: 800, isMobile: true, hasTouch: true },
  { name: "phone-390", width: 390, height: 844, isMobile: true, hasTouch: true },
  { name: "phone-landscape", width: 844, height: 390, isMobile: true, hasTouch: true },
  { name: "tablet-768", width: 768, height: 1024, isMobile: true, hasTouch: true },
  { name: "desktop-1440", width: 1440, height: 900, isMobile: false, hasTouch: false },
];

/** Canonical Factory destinations (docs/factory-navigation-registry.md) and key workflows. */
const STATIC_ROUTES = [
  // Production / inventory
  "/factory/production-report",
  "/factory/stock-entry",
  "/factory/raw-materials",
  "/factory/raw-stock",
  "/factory/waste-dispatch",
  "/factory/bales-hub",
  "/factory/location-inventory",
  "/factory/containers-hub",
  "/factory/stock-allocation-v5",
  "/factory/sheets-sacks",
  "/factory/stock-query",
  // Finance / people
  "/factory/daybook",
  "/factory/accounts",
  "/factory/vouchers",
  "/factory/parties",
  "/factory/contacts",
  "/factory/payroll-hub",
  // Sales
  "/factory/invoicing",
  "/factory/sales/new",
  "/factory/sales/loading/new",
  "/factory/dispatch-batches",
  // Intelligence
  "/factory/intelligence/dashboard",
  "/factory/intelligence/kpis",
  "/factory/intelligence/alerts",
  "/factory/intelligence/supplier-hub",
  "/factory/intelligence/financial-hub",
  "/factory/intelligence/production-hub",
  "/factory/financial-snapshot",
  "/factory/net-position-details",
  "/factory/production-comparison",
  // Other
  "/factory/rental/shops",
  "/factory/rental/warehouses",
  "/factory/rental/payments",
  "/factory/settings",
  "/factory/containers/new",
  "/factory/analytics",
  "/factory/agents",
  // Forms and admin tools (Phase 10)
  "/factory/create",
  "/factory/raw-stock/recalculate",
  "/factory/customer-logos",
  "/factory/label-banners",
  "/factory/intelligence/settings",
  "/factory/chatbot-settings",
  "/factory/conflicts",
  "/factory/deleted-items",
  "/factory/import-cycle-diagnostics",
  "/factory/inventory-repair",
  "/factory/company-data-reset",
  "/my-settings",
  // Every hub section/tab, not only the default one
  "/factory/production-report?tab=production",
  "/factory/production-report?tab=comparison",
  "/factory/production-report?tab=product-comparison",
  "/factory/production-report?tab=shipping",
  "/factory/production-report?tab=sheets",
  "/factory/production-report?tab=container-tracking",
  "/factory/bales-hub?tab=barcode",
  "/factory/bales-hub?tab=products",
  "/factory/bales-hub?tab=customer-loading",
  "/factory/containers-hub?section=otw",
  "/factory/invoicing?tab=loadings",
  "/factory/invoicing?tab=pending",
  "/factory/invoicing?tab=proformas",
  "/factory/parties?section=suppliers",
  "/factory/payroll-hub?section=employees",
  "/factory/payroll-hub?section=insurance",
  "/factory/intelligence/supplier-hub?section=statement",
  "/factory/intelligence/supplier-hub?section=scores",
  "/factory/intelligence/production-hub?section=waste",
  "/factory/intelligence/production-hub?section=mix-optimizer",
  "/factory/intelligence/production-hub?section=container-tracking",
];

/**
 * Canonical top-level destinations, read from docs/factory-navigation-registry.md (the same list the
 * route-registry test guards). Escape must never navigate away from these or their hub sections.
 */
const registryDoc = await fs.readFile(path.resolve("docs/factory-navigation-registry.md"), "utf8");
const TOP_LEVEL_ROUTES = new Set(
  Array.from(
    (registryDoc.split("## Canonical top-level pages")[1] ?? "").split("\n## ")[0].matchAll(/\| `(\/factory\/[^`]+)` \|/g),
    (match) => match[1],
  ),
);
const isTopLevelRoute = (route) => TOP_LEVEL_ROUTES.has(route.split("?")[0]);

/**
 * A safe dialog or sheet per route (never a submit action). The regression opens it, checks it
 * fits the viewport, scrolls internally, keeps its last action reachable and keeps a focused field
 * in view, then closes it with Escape, which must not navigate.
 */
const DIALOG_TRIGGERS = [
  { route: "/factory/contacts", selector: '[data-testid="button-add-contact"]' },
  { route: "/factory/sheets-sacks", selector: '[data-testid="button-add-item"]' },
  { route: "/factory/dispatch-batches", selector: '[data-testid="button-new-dispatch-batch"]', exact: true },
  { route: "/factory/rental/shops", selector: '[data-testid="button-factory-rental-shops-add-unit"]' },
  { route: "/factory/daybook", selector: '[data-testid="factory-daybook-filters-open"]', phoneOnly: true },
  {
    route: "/factory/production-comparison",
    selector: '[data-testid="production-comparison-filters-open"]',
    phoneOnly: true,
  },
  { route: "/factory/employees/", selector: '[data-testid="button-edit-employee"]' },
  // Data-dependent: skipped (not failed) when the list has no matching row.
  {
    route: "/factory/containers-hub",
    selector: '[data-testid^="button-view-container-"]',
    exact: true,
    optional: true,
  },
  {
    route: "/factory/containers-hub?section=otw",
    selector: '[data-testid^="button-otw-edit-"], [data-testid^="button-tracking-settings-"]',
    exact: true,
    optional: true,
  },
];

/** Detail/workflow routes that need an existing record; ids resolve at runtime. */
const SEEDED_ROUTES = [
  { key: "order", path: (s) => `/factory/sales/invoices/${s.order}` },
  { key: "order", path: (s) => `/factory/invoices/${s.order}/loading-scan` },
  { key: "order", path: (s) => `/factory/sales/pending-invoices/${s.order}/verify` },
  { key: "batch", path: (s) => `/factory/dispatch-batches/${s.batch}` },
  { key: "ride", path: (s) => `/factory/dispatch-batches/${s.batch}/rides/${s.ride}/scan` },
  { key: "customer", path: (s) => `/factory/customers/${s.customer}` },
  { key: "employee", path: (s) => `/factory/employees/${s.employee}` },
  { key: "worker", path: (s) => `/factory/workers/${s.worker}` },
  { key: "proforma", path: (s) => `/factory/sales/proformas/${s.proforma}/add-line` },
  { key: "product", path: (s) => `/factory/stock-query/${s.product}` },
  { key: "productLocation", path: (s) => `/factory/bale-product-history/${s.product}/${s.location}` },
  { key: "productLocation", path: (s) => `/factory/bale-product-history/${s.product}/${s.location}/2026/all` },
  { key: "productLocation", path: (s) => `/factory/bale-product-history/${s.product}/${s.location}/2026/9` },
  { key: "account", path: (s) => `/factory/ledger-monthly/${s.account}` },
  { key: "account", path: (s) => `/factory/ledger-vouchers/${s.account}/2026/9` },
  { key: "voucher", path: (s) => `/factory/voucher-detail/${s.voucher}` },
  { key: "voucher", path: (s) => `/factory/vouchers/${s.voucher}/edit` },
  { key: "openingBalance", path: (s) => `/factory/raw-stock/opening-balance/${s.openingBalance}/edit` },
];

/** Seed keys a seeded route needs (composite keys expand to their parts). */
const SEED_KEYS = { ride: ["batch", "ride"], productLocation: ["product", "location"] };

/** Scanner routes: input at least 44px, 16px text, focusable, status visible. */
/** Escape navigation is a keyboard contract; it is checked on one phone and on desktop. */
const ESCAPE_VIEWPORTS = new Set(["phone-390", "desktop-1440"]);

const SCANNER_SELECTORS = ['[data-testid="input-scan-code"]', '[data-testid="input-barcode"]', '[data-testid="input-scan"]'];

const routeFilter = (process.env.ERP_FACTORY_MOBILE_ROUTES || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const viewportFilter = (process.env.ERP_FACTORY_MOBILE_VIEWPORTS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const VIEWPORTS = viewportFilter.length
  ? ALL_VIEWPORTS.filter((viewport) => viewportFilter.includes(viewport.name))
  : ALL_VIEWPORTS;

const report = {
  startedAt: new Date().toISOString(),
  baseUrl: BASE_URL,
  companyCode: COMPANY_CODE,
  viewports: VIEWPORTS,
  seeds: {},
  skipped: [],
  cases: [],
  warnings: [],
  failures: [],
};

function safeName(value) {
  return value.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "root";
}

function isPhoneClassViewport(viewport) {
  return viewport.width < 640 || (viewport.hasTouch && viewport.height <= 500);
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
  // Viewport pages share one cookie jar; later /login visits may already be authenticated.
  await page.waitForFunction(
    () =>
      Boolean(document.querySelector('[data-testid="input-username"]')) ||
      (window.location.pathname !== "/login" && Boolean(document.getElementById("main-content"))),
    { timeout: TIMEOUT_MS },
  );
  const needsLogin = await page.evaluate(() => {
    const input = document.querySelector('[data-testid="input-username"]');
    if (!(input instanceof HTMLElement)) return false;
    const rect = input.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  if (needsLogin) {
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
  }
  await settle(page);
  await closeLanguageOnboarding(page);
}

async function selectFactoryCompany(page) {
  return page.evaluate(async (targetCode) => {
    const listResponse = await fetch("/api/user/companies", { credentials: "include", cache: "no-store" });
    if (!listResponse.ok) throw new Error(`Company list failed (${listResponse.status})`);
    const companies = await listResponse.json();
    const assignment = Array.isArray(companies) ? companies.find((c) => c.companyCode === targetCode) : undefined;
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
  }, COMPANY_CODE);
}

/** Resolves ids for seeded routes from read-only Factory list endpoints. */
async function resolveSeeds(page, companyId) {
  let provided = {};
  try {
    provided = JSON.parse(process.env.ERP_FACTORY_MOBILE_SEEDS || "{}");
  } catch {
    throw new Error("ERP_FACTORY_MOBILE_SEEDS must be JSON");
  }
  return resolveFactoryMobileSeeds(page, { seeds: provided, createMissing: CREATE_SEEDS, companyId });
}

function plannedRoutes(seeds) {
  const routes = STATIC_ROUTES.map((routePath) => ({ path: routePath, seeded: false }));
  for (const seeded of SEEDED_ROUTES) {
    const needed = SEED_KEYS[seeded.key] ?? [seeded.key];
    if (needed.every((key) => seeds[key])) {
      routes.push({ path: seeded.path(seeds), seeded: true });
    } else {
      const label = seeded.path(Object.fromEntries(needed.map((key) => [key, `:${key}`])));
      report.skipped.push(`${label}: no ${needed.join("/")} record in ${COMPANY_CODE}`);
      if (REQUIRE_SEEDS) report.failures.push(`${label}: seeded route has no data`);
    }
  }
  return routeFilter.length
    ? routes.filter((route) => routeFilter.some((wanted) => route.path === wanted || route.path.startsWith(wanted)))
    : routes;
}

async function openRoute(page, route) {
  const response = await page.goto(`${BASE_URL}${route}`, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
  await page.waitForFunction(() => Boolean(document.getElementById("main-content")), { timeout: TIMEOUT_MS });
  await settle(page);
  return response?.status() ?? null;
}

/** Opens the phone drawer, measures it, then picks the active destination: it must close. */
async function exerciseSidebar(page, viewport) {
  if (!isPhoneClassViewport(viewport)) return null;
  const toggle = await page.$('[data-testid="button-sidebar-toggle"]');
  if (!toggle) return { opened: false, reason: "no toggle" };
  await toggle.click();
  const opened = await page
    .waitForSelector('[data-sidebar="sidebar"][data-mobile="true"]', { visible: true, timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!opened) return { opened: false, reason: "drawer did not open" };
  await settle(page);
  const state = await page.evaluate((viewportWidth) => {
    const drawer = document.querySelector('[data-sidebar="sidebar"][data-mobile="true"]');
    const rect = drawer.getBoundingClientRect();
    const controls = [...drawer.querySelectorAll("a[href], button")].filter((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden";
    });
    const smallControls = controls
      .filter((element) => element.getBoundingClientRect().height < 43.5)
      .map((element) => element.getAttribute("data-testid") || element.textContent?.trim().slice(0, 24) || element.tagName);
    const scroller = drawer.querySelector('[data-slot="sidebar-content"]') || drawer;
    const active = drawer.querySelector('a[href].font-semibold, a[aria-current="page"]');
    const activeBox = active?.getBoundingClientRect();
    const scrollerBox = scroller.getBoundingClientRect();
    return {
      width: rect.width,
      fitsViewport: rect.x >= -1 && rect.right <= viewportWidth + 1,
      horizontalScroll: scroller.scrollWidth > scroller.clientWidth + 2,
      smallControls,
      activeVisible: activeBox ? activeBox.top >= scrollerBox.top - 1 && activeBox.bottom <= scrollerBox.bottom + 1 : null,
      activeTestId: active?.getAttribute("data-testid") ?? null,
    };
  }, viewport.width);
  let closedOnSelect = null;
  if (state.activeTestId) {
    await page.click(`[data-testid="${state.activeTestId}"]`);
    closedOnSelect = await page
      .waitForFunction(() => !document.querySelector('[data-sidebar="sidebar"][data-mobile="true"][data-state="open"]'), {
        timeout: 5_000,
      })
      .then(() => true)
      .catch(() => false);
  } else {
    await page.keyboard.press("Escape");
  }
  await settle(page);
  return { opened: true, ...state, closedOnSelect };
}

async function exerciseSafeControls(page) {
  const interaction = { focusedTextControl: null, scannerFocused: null };
  const textSelector = await page.evaluate(() => {
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return !element.hasAttribute("disabled") && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const element = [
      ...document.querySelectorAll(
        '#main-content input[type="search"], #main-content input[type="text"], #main-content input:not([type]), #main-content textarea',
      ),
    ].find(visible);
    if (!(element instanceof HTMLElement)) return null;
    if (!element.id) element.id = `factory-mobile-focus-${Math.random().toString(36).slice(2)}`;
    return `#${CSS.escape(element.id)}`;
  });
  if (textSelector) {
    await page.focus(textSelector);
    interaction.focusedTextControl = await page.evaluate(
      (selector) => document.activeElement === document.querySelector(selector),
      textSelector,
    );
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  }
  for (const selector of SCANNER_SELECTORS) {
    const scanner = await page.$(`#main-content ${selector}`);
    if (!scanner) continue;
    const enabled = await scanner.evaluate((element) => !element.hasAttribute("disabled") && element.getBoundingClientRect().height > 0);
    if (!enabled) continue;
    await scanner.focus();
    interaction.scannerFocused = await scanner.evaluate((element) => document.activeElement === element);
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    break;
  }
  return interaction;
}

function dialogTriggerFor(route, viewport) {
  return DIALOG_TRIGGERS.find(
    (trigger) =>
      (trigger.exact ? route === trigger.route : route.startsWith(trigger.route)) &&
      (!trigger.phoneOnly || isPhoneClassViewport(viewport)),
  );
}

/** Opens the route's safe dialog/sheet and checks the dialog contract. */
async function exerciseDialog(page, route, viewport) {
  const trigger = dialogTriggerFor(route, viewport);
  if (!trigger) return null;
  const handle = await page.$(trigger.selector);
  const visible = handle && (await handle.evaluate((element) => element.getBoundingClientRect().height > 0));
  if (!visible) {
    return trigger.optional ? null : { trigger: trigger.selector, opened: false, reason: "trigger not visible" };
  }
  await handle.click();
  const layerSelector = '[role="dialog"]:not([data-sidebar]), [role="alertdialog"]';
  const opened = await page
    .waitForSelector(layerSelector, { visible: true, timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!opened) return { trigger: trigger.selector, opened: false, reason: "no dialog opened" };
  await settle(page);

  const measured = await page.evaluate(
    ({ selector, viewportWidth }) => {
      const dialog = [...document.querySelectorAll(selector)].find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      const visibleHeight = window.visualViewport?.height ?? window.innerHeight;
      const rect = dialog.getBoundingClientRect();
      const scrollers = [dialog, ...dialog.querySelectorAll("*")].filter((element) => {
        const style = getComputedStyle(element);
        return /auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 2;
      });
      const contentOverflows = dialog.scrollHeight > dialog.clientHeight + 2 || scrollers.length > 0;
      // Scroll every internal scroller to its end: the last action must then be reachable.
      for (const scroller of [dialog, ...scrollers]) scroller.scrollTop = scroller.scrollHeight;
      const actions = [...dialog.querySelectorAll("button")].filter((button) => {
        const box = button.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && !button.closest('[data-slot="dialog-close"]');
      });
      const lastAction = actions[actions.length - 1];
      let lastActionReachable = null;
      if (lastAction) {
        const box = lastAction.getBoundingClientRect();
        const x = Math.min(Math.max(box.left + box.width / 2, 1), viewportWidth - 1);
        const y = Math.min(Math.max(box.top + box.height / 2, 1), visibleHeight - 1);
        const hit = document.elementFromPoint(x, y);
        lastActionReachable =
          box.top >= -1 &&
          box.bottom <= visibleHeight + 1 &&
          Boolean(hit) &&
          // Disabled buttons ignore pointer hits, so the hit lands on their row instead.
          (lastAction.contains(hit) || (lastAction.disabled && hit.contains(lastAction)));
      }
      // A focused field must end up inside the visible viewport (browsers scroll it into view).
      const field = [...dialog.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea')].find(
        (element) => element.getBoundingClientRect().height > 0 && !element.disabled,
      );
      let focusedFieldVisible = null;
      if (field) {
        field.focus();
        field.scrollIntoView({ block: "nearest" });
        const box = field.getBoundingClientRect();
        focusedFieldVisible = document.activeElement === field && box.top >= -1 && box.bottom <= visibleHeight + 1;
        field.blur();
      }
      return {
        width: rect.width,
        height: rect.height,
        withinViewport: rect.left >= -2 && rect.right <= viewportWidth + 2 && rect.top >= -2 && rect.bottom <= visibleHeight + 2,
        contentOverflows,
        scrollsInternally: !contentOverflows || scrollers.length > 0 || dialog.scrollHeight > dialog.clientHeight,
        lastActionReachable,
        focusedFieldVisible,
      };
    },
    { selector: layerSelector, viewportWidth: viewport.width },
  );

  const before = await page.evaluate(() => location.pathname + location.search);
  await page.keyboard.press("Escape");
  const closed = await page
    .waitForFunction((selector) => ![...document.querySelectorAll(selector)].some((element) => element.getBoundingClientRect().height > 0), { timeout: 5_000 }, layerSelector)
    .then(() => true)
    .catch(() => false);
  await settle(page);
  const after = await page.evaluate(() => location.pathname + location.search);
  return { trigger: trigger.selector, opened: true, ...measured, closedByEscape: closed, escapeKeptRoute: before === after };
}

/** Escape with no open layer: top-level pages stay, child pages go to a Factory parent. */
async function exerciseEscape(page, route) {
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  const before = await page.evaluate(() => location.pathname);
  await page.keyboard.press("Escape");
  await settle(page);
  const after = await page.evaluate(() => location.pathname);
  return { before, after, topLevel: isTopLevelRoute(route) };
}

async function readState(page, route, viewport) {
  return page.evaluate(
    ({ currentRoute, viewportWidth, viewportHeight, phoneClass, portraitPhone, scannerSelectors }) => {
      const root = document.documentElement;
      const body = document.body;
      const main = document.getElementById("main-content");
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
      };
      const label = (element) =>
        element.getAttribute("data-testid") ||
        element.getAttribute("aria-label") ||
        element.getAttribute("placeholder") ||
        element.textContent?.trim().slice(0, 32) ||
        element.tagName;
      const inViewport = (rect) => rect.right > 0 && rect.bottom > 0 && rect.x < viewportWidth && rect.y < viewportHeight;

      const controls = main ? [...main.querySelectorAll("button, input, select, textarea, [role=combobox]")].filter(visible) : [];

      // Touch: portrait phones enforce 44px buttons and fields in the Factory workspace.
      const smallTouchTargets = portraitPhone
        ? controls
            .filter((element) => {
              if (element instanceof HTMLInputElement && ["checkbox", "radio", "range", "hidden", "file"].includes(element.type)) return false;
              if (element.getAttribute("role") === "checkbox" || element.getAttribute("role") === "switch") return false;
              if (element.closest("[data-mobile-matrix], table:not([data-mobile-cards])")) return false;
              return element.getBoundingClientRect().height < 43.5;
            })
            .map(label)
        : [];

      const hoverOnly = phoneClass
        ? controls
            .filter((element) => {
              const className = String(element.className || "");
              return className.includes("opacity-0") && className.includes("group-hover") && Number(getComputedStyle(element).opacity) === 0;
            })
            .map(label)
        : [];

      const smallTextControls = phoneClass
        ? controls
            .filter((element) => {
              if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;
              if (["checkbox", "radio", "range", "file", "hidden"].includes(element.type)) return false;
              return parseFloat(getComputedStyle(element).fontSize || "0") < 16;
            })
            .map(label)
        : [];

      // A control is only "off screen" when no intentional sideways scroller (tab strip, table
      // region) inside the workspace clips it; those are reachable by swiping the strip.
      const clippedByScroller = (element) => {
        for (let parent = element.parentElement; parent && parent !== main; parent = parent.parentElement) {
          const overflowX = getComputedStyle(parent).overflowX;
          const box = parent.getBoundingClientRect();
          if (/auto|scroll|hidden|clip/.test(overflowX) && box.x >= -2 && box.right <= viewportWidth + 2) return true;
        }
        return false;
      };
      const overflowingControls = phoneClass
        ? controls
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              return inViewport(rect) && (rect.x < -2 || rect.right > viewportWidth + 2) && !clippedByScroller(element);
            })
            .map(label)
        : [];

      const dialogViolations = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')]
        .filter(visible)
        .filter((element) => !element.matches('[data-sidebar="sidebar"]'))
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .filter(({ rect }) => rect.x < -2 || rect.right > viewportWidth + 2 || rect.y < -2 || rect.bottom > viewportHeight + 2)
        .map(({ element, rect }) => `${label(element)}:${Math.round(rect.width)}x${Math.round(rect.height)}`);

      const fixedViolations = main
        ? [...main.querySelectorAll("*")]
            .filter((element) => visible(element) && getComputedStyle(element).position === "fixed")
            .map((element) => ({ element, rect: element.getBoundingClientRect() }))
            .filter(({ rect }) => inViewport(rect) && (rect.x < -3 || rect.right > viewportWidth + 3 || rect.bottom > viewportHeight + 3))
            .map(({ element }) => label(element))
        : [];

      // Bottom action bars: nothing interactive may sit underneath them once the page is scrolled
      // to its end, and they must respect the home-indicator inset.
      const coveredByActionBar = [];
      const actionBars = main ? [...main.querySelectorAll('[data-factory-mobile-action-bar="true"]')].filter(visible) : [];
      for (const bar of actionBars) {
        if (getComputedStyle(bar).position !== "fixed") continue;
        main.scrollTop = main.scrollHeight;
        const barRect = bar.getBoundingClientRect();
        // Floating shell controls (the notes button) must not sit on the workflow actions either.
        const floating = [...document.querySelectorAll('[data-testid="button-open-user-notes"]')].filter(visible);
        for (const element of [...controls, ...floating]) {
          if (bar.contains(element)) continue;
          const rect = element.getBoundingClientRect();
          if (rect.bottom > barRect.top + 2 && rect.top < barRect.bottom - 2 && rect.right > barRect.left && rect.left < barRect.right) {
            coveredByActionBar.push(label(element));
          }
        }
        main.scrollTop = 0;
      }

      const wideTables = phoneClass
        ? [...(main?.querySelectorAll("[data-table-scroll-region], .overflow-x-auto") ?? [])]
            .filter(visible)
            .filter((region) => region.querySelector("table") && !region.closest("[data-mobile-matrix]"))
            .filter((region) => !region.querySelector('table[data-mobile-cards="true"]'))
            .filter((region) => region.scrollWidth > region.clientWidth + 4)
            .map((region) => region.getAttribute("aria-label") || region.querySelector("table")?.getAttribute("data-testid") || "table")
        : [];

      const scanner = scannerSelectors.map((selector) => main?.querySelector(selector)).find((element) => visible(element));
      const scannerRect = scanner?.getBoundingClientRect();

      return {
        route: currentRoute,
        actualPath: `${location.pathname}${location.search}`,
        rootScrollWidth: root.scrollWidth,
        bodyScrollWidth: body?.scrollWidth || 0,
        horizontalOverflow: Math.max(root.scrollWidth, body?.scrollWidth || 0) > viewportWidth + 2,
        // The workspace is the page's real scroller; it clips overflow the document never sees.
        mainScrollWidth: main?.scrollWidth ?? 0,
        mainClientWidth: main?.clientWidth ?? 0,
        mainVisible: visible(main),
        mainHasContent: Boolean(main && main.innerText.trim().length > 0),
        phoneLandscapeMedia: matchMedia("(hover: none) and (pointer: coarse) and (max-height: 500px)").matches,
        smallTouchTargets: [...new Set(smallTouchTargets)],
        hoverOnly: [...new Set(hoverOnly)],
        smallTextControls: [...new Set(smallTextControls)],
        overflowingControls: [...new Set(overflowingControls)],
        dialogViolations,
        fixedViolations: [...new Set(fixedViolations)],
        coveredByActionBar: [...new Set(coveredByActionBar)],
        wideTables,
        cardTables: main?.querySelectorAll('table[data-mobile-cards="true"]').length ?? 0,
        scanner: scannerRect
          ? {
              height: scannerRect.height,
              fontSize: parseFloat(getComputedStyle(scanner).fontSize || "0"),
              disabled: scanner.hasAttribute("disabled"),
            }
          : null,
      };
    },
    {
      currentRoute: route,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      phoneClass: isPhoneClassViewport(viewport),
      portraitPhone: viewport.width < 640,
      scannerSelectors: SCANNER_SELECTORS,
    },
  );
}

function assertDialogAndEscape(label, dialog, escape) {
  const failures = [];
  if (dialog) {
    if (!dialog.opened) failures.push(`${label}: dialog ${dialog.trigger} did not open (${dialog.reason})`);
    else {
      if (!dialog.withinViewport) failures.push(`${label}: dialog outside the viewport (${Math.round(dialog.width)}x${Math.round(dialog.height)})`);
      if (!dialog.scrollsInternally) failures.push(`${label}: dialog content overflows without an internal scroller`);
      if (dialog.lastActionReachable === false) failures.push(`${label}: dialog's last action is not reachable`);
      if (dialog.focusedFieldVisible === false) failures.push(`${label}: focused dialog field is outside the visible viewport`);
      if (!dialog.closedByEscape) failures.push(`${label}: Escape did not close the dialog`);
      if (!dialog.escapeKeptRoute) failures.push(`${label}: Escape on an open dialog navigated away`);
    }
  }
  if (escape) {
    if (escape.topLevel && escape.after !== escape.before) {
      failures.push(`${label}: Escape on a top-level page navigated to ${escape.after}`);
    }
    if (!escape.after.startsWith("/factory") && !escape.after.startsWith("/my-settings")) {
      failures.push(`${label}: Escape left Factory Mode (${escape.after})`);
    }
  }
  return failures;
}

function assertCase(state, viewport, route, interaction, sidebar) {
  const failures = [];
  const warnings = [];
  const label = `${viewport.name} ${route}`;
  const phoneClass = isPhoneClassViewport(viewport);
  const expectedPath = route.split("?")[0];

  if (!state.mainVisible || !state.mainHasContent) failures.push(`${label}: main content is not visible`);
  if (state.actualPath.startsWith("/login")) failures.push(`${label}: session returned to login`);
  if (!state.actualPath.startsWith(expectedPath)) failures.push(`${label}: redirected to ${state.actualPath}`);
  if (state.horizontalOverflow) {
    failures.push(`${label}: page-level horizontal overflow (${Math.max(state.rootScrollWidth, state.bodyScrollWidth)}px)`);
  }
  if (state.mainScrollWidth > state.mainClientWidth + 2) {
    failures.push(`${label}: workspace scrolls sideways (${state.mainScrollWidth}px content in ${state.mainClientWidth}px)`);
  }
  if (viewport.name === "phone-landscape" && !state.phoneLandscapeMedia) failures.push(`${label}: landscape-phone contract inactive`);
  if (viewport.name === "tablet-768" && state.phoneLandscapeMedia) failures.push(`${label}: landscape-phone contract leaked into tablet`);
  if (state.hoverOnly.length) failures.push(`${label}: hover-only controls: ${state.hoverOnly.join(", ")}`);
  if (state.smallTouchTargets.length) failures.push(`${label}: touch targets below 44px: ${state.smallTouchTargets.join(", ")}`);
  if (state.smallTextControls.length) failures.push(`${label}: text controls below 16px: ${state.smallTextControls.join(", ")}`);
  if (state.overflowingControls.length) failures.push(`${label}: controls outside the viewport: ${state.overflowingControls.join(", ")}`);
  if (state.dialogViolations.length) failures.push(`${label}: dialog escaped viewport: ${state.dialogViolations.join(", ")}`);
  if (phoneClass && state.fixedViolations.length) failures.push(`${label}: fixed control escaped viewport: ${state.fixedViolations.join(", ")}`);
  if (state.coveredByActionBar.length) failures.push(`${label}: content under the mobile action bar: ${state.coveredByActionBar.join(", ")}`);
  if (state.wideTables.length) {
    (STRICT_TABLES ? failures : warnings).push(`${label}: ordinary tables still scroll sideways: ${state.wideTables.join(", ")}`);
  }
  if (interaction.focusedTextControl === false) failures.push(`${label}: visible text control did not keep focus`);
  if (state.scanner && phoneClass) {
    if (state.scanner.height < 43.5) failures.push(`${label}: scanner input only ${Math.round(state.scanner.height)}px tall`);
    if (state.scanner.fontSize < 16) failures.push(`${label}: scanner input text below 16px`);
    if (!state.scanner.disabled && interaction.scannerFocused === false) failures.push(`${label}: scanner input not focusable`);
  }
  if (sidebar) {
    if (!sidebar.opened) failures.push(`${label}: phone navigation drawer did not open (${sidebar.reason})`);
    else {
      if (!sidebar.fitsViewport) failures.push(`${label}: navigation drawer wider than the viewport (${Math.round(sidebar.width)}px)`);
      if (sidebar.horizontalScroll) failures.push(`${label}: navigation drawer scrolls sideways`);
      if (sidebar.smallControls.length) failures.push(`${label}: drawer controls below 44px: ${sidebar.smallControls.join(", ")}`);
      if (sidebar.closedOnSelect === false) failures.push(`${label}: drawer stayed open after choosing a destination`);
      if (sidebar.activeVisible === false) warnings.push(`${label}: active destination not scrolled into view in the drawer`);
    }
  }
  return { failures, warnings };
}

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });

try {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  let routes = null;

  for (const viewport of VIEWPORTS) {
    const page = await browser.newPage();
    page.setDefaultTimeout(TIMEOUT_MS);
    page.setDefaultNavigationTimeout(TIMEOUT_MS);
    await page.setViewport({ width: viewport.width, height: viewport.height, isMobile: viewport.isMobile, hasTouch: viewport.hasTouch });
    await page.evaluateOnNewDocument(() => localStorage.setItem("erp.application-language", "en"));
    const pageErrors = [];
    let stage = "initialize";
    let currentRoute = null;
    page.on("pageerror", (error) => pageErrors.push(error.message));

    try {
      stage = "authenticate";
      await login(page);
      stage = `select ${COMPANY_CODE}`;
      const companyId = await selectFactoryCompany(page);
      if (!routes) {
        stage = "resolve seeded records";
        report.seeds = await resolveSeeds(page, companyId);
        routes = plannedRoutes(report.seeds);
      }
      for (const [index, route] of routes.entries()) {
        currentRoute = route.path;
        try {
          stage = `open ${route.path}`;
          const status = await openRoute(page, route.path);
          stage = `exercise ${route.path}`;
          const interaction = await exerciseSafeControls(page);
          stage = `inspect ${route.path}`;
          const state = await readState(page, route.path, viewport);
          const directory = path.join(OUTPUT_DIR, viewport.name);
          await fs.mkdir(directory, { recursive: true });
          const screenshot = path.join(directory, `${safeName(route.path)}.png`);
          stage = `screenshot ${route.path}`;
          await page.screenshot({ path: screenshot, fullPage: true });
          // The drawer is exercised on a sample of routes per viewport to keep the run bounded.
          stage = `sidebar ${route.path}`;
          const sidebar = index % 6 === 0 ? await exerciseSidebar(page, viewport) : null;
          stage = `dialog ${route.path}`;
          const dialog = await exerciseDialog(page, route.path, viewport);
          // Escape may navigate, so it runs last; the next route opens fresh.
          stage = `escape ${route.path}`;
          const escape = ESCAPE_VIEWPORTS.has(viewport.name) ? await exerciseEscape(page, route.path) : null;
          const { failures, warnings } = assertCase(state, viewport, route.path, interaction, sidebar);
          failures.push(...assertDialogAndEscape(`${viewport.name} ${route.path}`, dialog, escape));
          report.cases.push({
            viewport: viewport.name,
            companyId,
            route: route.path,
            seeded: route.seeded,
            status,
            interaction,
            sidebar,
            dialog,
            escape,
            state,
            screenshot: path.relative(process.cwd(), screenshot),
            failures,
            warnings,
          });
          report.failures.push(...failures);
          report.warnings.push(...warnings);
        } catch (error) {
          report.failures.push(
            `${viewport.name} ${route.path} [${stage}]: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      currentRoute = null;
    } catch (error) {
      const routeLabel = currentRoute ? ` ${currentRoute}` : "";
      report.failures.push(`${viewport.name}${routeLabel} [${stage}]: ${error instanceof Error ? error.message : String(error)}`);
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
report.warnings = [...new Set(report.warnings)];
await fs.writeFile(path.join(OUTPUT_DIR, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

for (const skipped of report.skipped) console.warn(`skipped: ${skipped}`);
for (const warning of report.warnings) console.warn(`warning: ${warning}`);

if (report.failures.length > 0) {
  console.error(`Factory mobile browser regression failed with ${report.failures.length} issue(s):`);
  for (const failure of report.failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Factory mobile browser regression passed ${report.cases.length} route/viewport cases.`);
