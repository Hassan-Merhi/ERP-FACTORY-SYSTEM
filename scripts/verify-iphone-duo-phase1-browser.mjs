#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

import { awaitAuthenticatedShell, watchSignInResponses } from "./lib/browser-smoke-signin.mjs";
import { discoverDuoRouteInventory } from "./lib/iphone-duo-route-inventory.mjs";
import { resolveFactoryMobileSeeds } from "./lib/factory-mobile-fixture.mjs";
import { SEEDED_ROUTES, SEED_KEYS } from "./lib/factory-mobile-routes.mjs";

const BASE_URL = (process.env.ERP_SMOKE_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/, "");
const USERNAME = process.env.ERP_SMOKE_USERNAME || "";
const PASSWORD = process.env.ERP_SMOKE_PASSWORD || "";
const AUTHENTICATED = Boolean(USERNAME && PASSWORD);
const REQUIRE_AUTHENTICATED = process.env.ERP_SMOKE_REQUIRE_AUTHENTICATED === "1";
const TIMEOUT_MS = Number(process.env.ERP_SMOKE_TIMEOUT_MS || 60_000);
const OUTPUT_DIR = path.resolve(process.env.ERP_DUO_OUTPUT_DIR || "artifacts/iphone-duo-phase1");
const REQUIRE_EXACT_ROUTES = process.env.ERP_DUO_REQUIRE_EXACT_ROUTES === "1";
const STORAGE_KEY = "erp.application-language";
const COOKIE_NAME = "erp_application_language";
const LANGUAGE_EVENT = "erp:application-language-change";

const ALL_LANGUAGES = [
  { code: "en", direction: "ltr", name: "English" },
  { code: "ar", direction: "rtl", name: "Arabic" },
  { code: "fr", direction: "ltr", name: "French" },
];
const LANGUAGES = ALL_LANGUAGES.filter((x) =>
  (process.env.ERP_DUO_LANGUAGES || "en,fr,ar").split(",").includes(x.code)
);

const VIEWPORTS = [
  { name: "duo-cover", width: 466, height: 678, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  { name: "duo-cover-landscape", width: 678, height: 466, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  { name: "duo-inner", width: 626, height: 890, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  { name: "duo-inner-landscape", width: 890, height: 626, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  { name: "duo-split", width: 393, height: 890, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
].filter((x) =>
  (process.env.ERP_DUO_VIEWPORTS || "duo-cover,duo-cover-landscape,duo-inner,duo-inner-landscape,duo-split")
    .split(",")
    .includes(x.name)
);

if (!LANGUAGES.length || !VIEWPORTS.length) throw new Error("No iPhone Duo language or viewport profiles selected");
const inventory = await discoverDuoRouteInventory();
const role = process.env.ERP_DUO_ROLE === "POS" ? "POS" : "Developer";
const chosen = (process.env.ERP_DUO_WORKSPACES || inventory.groups.filter((group) => group.requiredRole === role)
  .map((group) => group.workspace).join(",")).split(",");
const routeFilter = (process.env.ERP_DUO_ROUTES || "").split(",").filter(Boolean);
const WORKSPACE_ROUTE_GROUPS = inventory.groups.filter((group) =>
  group.requiredRole === role && chosen.includes(group.workspace)).map((group) => ({
  workspace: group.workspace,
  companyCode: group.companyCode,
  routes: routeFilter.length
    ? group.static.filter((route) => routeFilter.some((part) => route.startsWith(part)))
    : group.static,
  parameterized: group.parameterized,
}));
if (!WORKSPACE_ROUTE_GROUPS.length) throw new Error("No workspaces match ERP_DUO_WORKSPACES and ERP_DUO_ROLE");
const report = {
  baseUrl: BASE_URL,
  workspaceRouteGroups: WORKSPACE_ROUTE_GROUPS,
  authenticatedRequired: REQUIRE_AUTHENTICATED,
  startedAt: new Date().toISOString(),
  declaredRoutes: inventory.summary,
  unresolvedParameterizedRoutes: inventory.unresolved.filter((item) => chosen.includes(item.workspace)),
  emulationNote: "Chrome CSS-pixel profiles; physical iOS Safari verification still required",
  transitions: [],
  seededRouteEvidence: [],
  cases: [],
  failures: [],
};

function matchesPattern(pattern, concreteRoute) {
  const expected = pattern.split("/");
  const actual = concreteRoute.split("?")[0].split("/");
  return expected.length === actual.length &&
    expected.every((segment, index) => segment.startsWith(":") || segment === actual[index]);
}

function fileSafe(value) {");
  const segments = pattern.split("/").map((segment) => segment.startsWith(":") ? "[^/?]+" : escape(segment));
  return new RegExp("^" + segments.join("/") + "$").test(concreteRoute.split("?")[0]);
}

function fileSafe(value) {
  return value.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "root";
}

async function waitForSettledUi(page) {
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function applyLanguage(page, language) {
  await page.evaluate(
    async ({ storageKey, cookieName, eventName, nextLanguage }) => {
      window.localStorage.setItem(storageKey, nextLanguage);
      document.cookie = `${cookieName}=${nextLanguage}; Path=/; Max-Age=31536000; SameSite=Lax`;
      window.dispatchEvent(new CustomEvent(eventName, { detail: nextLanguage }));
      // Choosing a language in the real app also saves it as the account
      // preference. Without that, the server still answers with the previous
      // language and any remount of the language provider (a transient auth
      // refetch under CI load) snaps the document back to it.
      if (!window.location.pathname.startsWith("/login")) {
        let csrfToken = null;
        try {
          const tokenResponse = await fetch("/api/csrf-token", { credentials: "include", cache: "no-store" });
          if (tokenResponse.ok) csrfToken = (await tokenResponse.json())?.csrfToken ?? null;
        } catch {
          csrfToken = null;
        }
        await fetch("/api/language-preference", {
          method: "PUT",
          credentials: "include",
          headers: { "content-type": "application/json", ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}) },
          body: JSON.stringify({ preferredLanguage: nextLanguage }),
        }).catch(() => null);
      }
    },
    {
      storageKey: STORAGE_KEY,
      cookieName: COOKIE_NAME,
      eventName: LANGUAGE_EVENT,
      nextLanguage: language,
    },
  );
  await waitForSettledUi(page);
}

async function waitForRouteUi(page) {
  await page.waitForFunction(
    () => {
      if (window.location.pathname === "/login") {
        return Boolean(
          document.querySelector('[data-testid="input-username"]') &&
            document.querySelector('[data-testid="input-password"]') &&
            document.querySelector('[data-testid="button-login"]'),
        );
      }

      return Boolean(
        document.getElementById("main-content") && document.querySelector('[data-slot="sidebar-wrapper"]'),
      );
    },
    { timeout: TIMEOUT_MS },
  );
}

async function openRoute(page, route) {
  const response = await page.goto(`${BASE_URL}${route}`, {
    waitUntil: "domcontentloaded",
    timeout: TIMEOUT_MS,
  });
  await waitForRouteUi(page);
  await waitForSettledUi(page);
  return response?.status() ?? null;
}

async function login(page) {
  await page.waitForSelector('[data-testid="input-username"]', { visible: true, timeout: TIMEOUT_MS });
  await page.type('[data-testid="input-username"]', USERNAME);
  await page.type('[data-testid="input-password"]', PASSWORD);
  // This sweep launches a fresh browser per language x viewport, so every
  // combination performs a real sign-in and the run can exhaust the login flood
  // guard's per-IP budget. Watch the response so a 429 names itself instead of
  // looking like a slow app. See scripts/lib/browser-smoke-signin.mjs.
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
  await waitForSettledUi(page);
}

async function selectWorkspaceCompany(page, companyCode) {
  return page.evaluate(async (targetCode) => {
    const companiesResponse = await fetch("/api/user/companies", { credentials: "include", cache: "no-store" });
    if (!companiesResponse.ok) throw new Error(`Company list failed (${companiesResponse.status})`);
    const companies = await companiesResponse.json();
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
    return { companyId, companyCode: targetCode };
  }, companyCode);
}

async function completeLanguageOnboarding(page, language) {
  const dialogSelector = '[data-testid="language-onboarding-dialog"]';
  const dialogOpen = await page.evaluate(
    (selector) => {
      const dialog = document.querySelector(selector);
      if (!(dialog instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(dialog);
      return style.display !== "none" && style.visibility !== "hidden";
    },
    dialogSelector,
  );

  if (!dialogOpen) return false;

  const optionSelector = `[data-testid="language-onboarding-${language}"]`;
  await page.click(optionSelector);
  await page.waitForFunction(
    (selector) => document.querySelector(selector)?.getAttribute("aria-checked") === "true",
    { timeout: Math.min(TIMEOUT_MS, 5_000) },
    optionSelector,
  );
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="language-onboarding-continue"]')?.hasAttribute("disabled"),
    { timeout: TIMEOUT_MS },
  );
  const continueSelector = '[data-testid="language-onboarding-continue"]';
  const closeAttempts = 3;
  let closed = false;
  for (let attempt = 1; attempt <= closeAttempts; attempt += 1) {
    if (attempt === 1) {
      await page.click(continueSelector);
    } else {
      await page.evaluate((selector) => document.querySelector(selector)?.click(), continueSelector);
    }

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
      closed = true;
      break;
    } catch {
      if (attempt === closeAttempts) {
        throw new Error(`Language onboarding did not close after ${closeAttempts} attempts`);
      }
    }
  }

  if (!closed) throw new Error("Language onboarding close state was not observed");
  await waitForSettledUi(page);
  return true;
}

async function activateSkipNavigation(page) {
  const selector = '[data-slot="skip-link"]';
  const available = await page.evaluate(
    (skipLinkSelector) => document.querySelector(skipLinkSelector) instanceof HTMLAnchorElement,
    selector,
  );

  if (!available) {
    return { available: false, activeElementId: "", hash: await page.evaluate(() => window.location.hash) };
  }

  await page.focus(selector);
  await page.keyboard.press("Enter");
  try {
    await page.waitForFunction(
      () => document.activeElement?.id === "main-content" && window.location.hash === "#main-content",
      { timeout: Math.min(TIMEOUT_MS, 5_000) },
    );
  } catch {
    // Return the observed state below so the release report exposes the exact failure.
  }

  return page.evaluate(() => ({
    available: true,
    activeElementId: document.activeElement instanceof HTMLElement ? document.activeElement.id : "",
    hash: window.location.hash,
  }));
}

async function readPageState(page) {
  return page.evaluate(() => {
    const visibleRect = (element) => {
      if (!(element instanceof HTMLElement)) return null;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return null;
      if (rect.width <= 0 || rect.height <= 0) return null;
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };

    const ltrSelectors = [
      "[data-article-code]",
      "[data-account-code]",
      "[data-container-number]",
      "[data-voucher-number]",
      "[data-contract-reference]",
      "[data-document-reference]",
      "[data-identifier]",
      "[data-reference]",
      "[data-currency-value]",
      "[data-money-value]",
      "[data-quantity-value]",
      "[data-date-value]",
      "[data-phone-value]",
      "[data-email-value]",
      'input[type="number"]',
      'input[inputmode="decimal"]',
      'input[inputmode="numeric"]',
      'input[type="email"]',
      'input[type="tel"]',
    ];
    const ltrViolations = [];
    for (const selector of ltrSelectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!(element instanceof HTMLElement)) continue;
        if (window.getComputedStyle(element).direction !== "ltr") {
          ltrViolations.push(selector);
          break;
        }
      }
    }

    const sidebarContainer = document.querySelector('[data-slot="sidebar-container"]');
    const sidebarRoot = sidebarContainer?.closest('[data-slot="sidebar"]');
    const sidebarRect = visibleRect(sidebarContainer);
    const sidebar = sidebarRect
      ? {
          declaredSide: sidebarRoot instanceof HTMLElement ? sidebarRoot.dataset.side || "left" : "left",
          collapsed: sidebarRoot instanceof HTMLElement && sidebarRoot.dataset.state === "collapsed",
          left: sidebarRect.x,
          right: sidebarRect.x + sidebarRect.width,
          width: sidebarRect.width,
        }
      : null;

    const root = document.documentElement;
    const body = document.body;
    return {
      path: `${window.location.pathname}${window.location.search}`,
      language: root.lang,
      direction: root.dir,
      bodyDirection: body?.dir || "",
      dataLanguage: root.dataset.applicationLanguage || "",
      dataDirection: root.dataset.applicationDirection || "",
      viewport: { width: window.innerWidth, height: window.innerHeight },
      rootScrollWidth: root.scrollWidth,
      bodyScrollWidth: body?.scrollWidth || 0,
      horizontalOverflow: Math.max(root.scrollWidth, body?.scrollWidth || 0) > window.innerWidth + 2,
      workspaceOverflow: (() => {
        const main = document.getElementById("main-content");
        return Boolean(main && main.scrollWidth > main.clientWidth + 2);
      })(),
      loginButton: visibleRect(document.querySelector('[data-testid="button-login"]')),
      username: visibleRect(document.querySelector('[data-testid="input-username"]')),
      password: visibleRect(document.querySelector('[data-testid="input-password"]')),
      main: visibleRect(document.getElementById("main-content")),
      shell: visibleRect(document.querySelector('[data-slot="sidebar-wrapper"]')),
      sidebar,
      recoveryOverlay: Boolean(document.getElementById("stale-asset-recovery")),
      notFoundPage: Boolean(document.getElementById("main-content")?.textContent?.includes("404 Page Not Found")),
      ltrViolations,
    };
  });
}

function assertSidebarEdge(state, expectedDirection, label) {
  if (!state.sidebar) return [];
  const declaredSide = state.sidebar.declaredSide === "right" ? "right" : "left";
  const expectedPhysicalSide =
    expectedDirection === "rtl" ? (declaredSide === "left" ? "right" : "left") : declaredSide;
  const tolerance = 3;
  // Since #2173 the sidebar starts collapsed below 1024px: off-canvas, translated past its edge.
  // It must then sit wholly beyond the expected edge rather than touch it.
  if (state.sidebar.collapsed) {
    if (expectedPhysicalSide === "left" && state.sidebar.right > tolerance) {
      return [`${label}: collapsed ${declaredSide} sidebar is not parked past the left edge`];
    }
    if (expectedPhysicalSide === "right" && state.sidebar.left < state.viewport.width - tolerance) {
      return [`${label}: collapsed ${declaredSide} sidebar is not parked past the right edge`];
    }
    return [];
  }
  if (expectedPhysicalSide === "left" && Math.abs(state.sidebar.left) > tolerance) {
    return [`${label}: ${declaredSide} sidebar is ${Math.round(state.sidebar.left)}px from the left edge`];
  }
  if (expectedPhysicalSide === "right" && Math.abs(state.viewport.width - state.sidebar.right) > tolerance) {
    return [
      `${label}: ${declaredSide} sidebar is ${Math.round(state.viewport.width - state.sidebar.right)}px from the right edge`,
    ];
  }
  return [];
}

function assertPage(state, expectedLanguage, expectedDirection, mode, label) {
  const failures = [];
  if (state.language !== expectedLanguage) {
    failures.push(`${label}: html lang is ${state.language || "missing"}, expected ${expectedLanguage}`);
  }
  if (state.direction !== expectedDirection || state.bodyDirection !== expectedDirection) {
    failures.push(
      `${label}: document direction is html=${state.direction || "missing"}, body=${state.bodyDirection || "missing"}, expected ${expectedDirection}`,
    );
  }
  if (state.dataLanguage !== expectedLanguage || state.dataDirection !== expectedDirection) {
    failures.push(
      `${label}: application direction metadata is ${state.dataLanguage || "missing"}/${state.dataDirection || "missing"}`,
    );
  }
  if (state.workspaceOverflow) {
    failures.push(label + ": #main-content overflows horizontally");
  }
  if (state.horizontalOverflow) {
    failures.push(`${label}: root horizontal overflow (${state.rootScrollWidth}px > ${state.viewport.width}px)`);
  }
  if (state.recoveryOverlay) failures.push(`${label}: stale-asset recovery overlay is visible`);
  if (state.notFoundPage) failures.push(`${label}: route rendered a 404 page`);
  if (state.ltrViolations.length > 0) {
    failures.push(`${label}: protected LTR selectors rendered RTL: ${state.ltrViolations.join(", ")}`);
  }

  if (mode === "login") {
    if (!state.username || !state.password || !state.loginButton) failures.push(`${label}: login controls are not all visible`);
    if (state.loginButton && state.loginButton.height < 40) {
      failures.push(`${label}: login touch target is only ${Math.round(state.loginButton.height)}px high`);
    }
  } else {
    if (!state.main) failures.push(`${label}: #main-content is missing or invisible`);
    if (!state.shell) failures.push(`${label}: application shell is missing or invisible`);
    failures.push(...assertSidebarEdge(state, expectedDirection, label));
  }

  return failures;
}

async function capture(page, language, viewport, route) {
  const directory = path.join(OUTPUT_DIR, language, viewport);
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `${fileSafe(route)}.png`);
  if (process.env.ERP_DUO_SCREENSHOTS !== "0") await page.screenshot({ path: file, fullPage: true });
  return path.relative(process.cwd(), file);
}

const TRANSITION_ROUTES = new Set([
  "/", "/tracking", "/daybook", "/factory/stock-entry", "/factory/stock-allocation-v5",
  "/factory/monthly-production-matrix", "/factory/production-bonuses",
  "/properties/rentals", "/retail/pos", "/retail/inventory", "/pos-containers", "/sp/reports",
]);
const TRANSITION_PROFILES = [
  { name: "duo-cover", width: 466, height: 678, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  { name: "duo-inner", width: 626, height: 890, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  { name: "duo-inner-landscape", width: 890, height: 626, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  { name: "duo-split", width: 393, height: 890, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
];
async function verifyDuoTransitions(page, language, sourceViewport, group, route, originalPath) {
  if (process.env.ERP_DUO_TRANSITIONS !== "1" || !TRANSITION_ROUTES.has(route)) return;
  const before = await page.evaluate(() => {
    const input = document.querySelector('input[type="search"],input[type="text"]');
    return input instanceof HTMLInputElement ? { name: input.name, value: input.value } : null;
  });
  try {
    for (const target of TRANSITION_PROFILES) {
      await page.setViewport(target);
      await waitForSettledUi(page);
      const state = await readPageState(page);
      const errors = [];
      if (state.path !== originalPath) errors.push("unexpected route change");
      if (!state.main || !state.shell) errors.push("workspace disappeared");
      if (state.horizontalOverflow) errors.push("root horizontal overflow");
      const after = await page.evaluate(() => {
        const main = document.getElementById("main-content");
        const input = document.querySelector('input[type="search"],input[type="text"]');
        return {
          overflow: Boolean(main && main.scrollWidth > main.clientWidth + 2),
          field: input instanceof HTMLInputElement ? { name: input.name, value: input.value } : null,
        };
      });
      if (after.overflow) errors.push("main workspace horizontal overflow");
      if (before && after.field && before.name === after.field.name && before.value !== after.field.value)
        errors.push("filter value lost on resize");
      const screenshot = await capture(page, language.code, "transition-" + target.name, group.workspace + "-" + route);
      report.transitions.push({ workspace: group.workspace, route, from: sourceViewport.name,
        to: target.name, failures: errors, screenshot });
      report.failures.push(
        ...errors.map((reason) => group.workspace + " " + route + " -> " + target.name + ": " + reason)
      );
    }
  } finally {
    await page.setViewport(sourceViewport);
    await waitForSettledUi(page);
  }
}

await fs.mkdir(OUTPUT_DIR, { recursive: true });

for (const language of LANGUAGES) {
  for (const viewport of VIEWPORTS) {
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    try {
      const page = await browser.newPage();
      const browserErrors = [];
      await page.setViewport(viewport);
      page.setDefaultTimeout(TIMEOUT_MS);
      page.setDefaultNavigationTimeout(TIMEOUT_MS);

      await page.evaluateOnNewDocument(
        ({ storageKey, nextLanguage }) => window.localStorage.setItem(storageKey, nextLanguage),
        { storageKey: STORAGE_KEY, nextLanguage: language.code },
      );

      page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
      page.on("requestfailed", (request) => {
        if (!["document", "script", "stylesheet"].includes(request.resourceType())) return;
        if (!request.url().startsWith(BASE_URL)) return;
        const errorText = request.failure()?.errorText || "unknown";
        if (errorText !== "net::ERR_ABORTED") browserErrors.push(`${request.resourceType()} failed: ${errorText}`);
      });
      page.on("response", (response) => {
        if (!["document", "script", "stylesheet"].includes(response.request().resourceType())) return;
        if (response.url().startsWith(BASE_URL) && response.status() >= 400) {
          browserErrors.push(`${response.request().resourceType()} ${response.status()}: ${response.url()}`);
        }
      });

      try {
        const loginStatus = await openRoute(page, "/login");
        await applyLanguage(page, language.code);
        const loginState = await readPageState(page);
        const loginLabel = `${language.name} ${viewport.name} /login`;
        const loginFailures = assertPage(loginState, language.code, language.direction, "login", loginLabel);
        const loginScreenshot = await capture(page, language.code, viewport.name, "/login");
        report.cases.push({
          language: language.code,
          viewport: viewport.name,
          requestedRoute: "/login",
          status: loginStatus,
          state: loginState,
          screenshot: loginScreenshot,
          failures: loginFailures,
        });
        report.failures.push(...loginFailures);

        if (AUTHENTICATED) {
          await login(page);
          await applyLanguage(page, language.code);
          const languageOnboardingCompleted = await completeLanguageOnboarding(page, language.code);
          for (const group of WORKSPACE_ROUTE_GROUPS) {
            let selectedWorkspaceCompany;
            try { selectedWorkspaceCompany = await selectWorkspaceCompany(page, group.companyCode); }
            catch (error) {
              const message = group.workspace + ": fixture selection failed: " +
                (error instanceof Error ? error.message : String(error));
              report.failures.push(message);
              report.cases.push({ workspace: group.workspace, classification: "fixture-unavailable", error: message });
              continue;
            }
            const seededDetailRoutes = [];
            if (group.workspace === "factory" && !routeFilter.length) {
              try {
                const ids = await resolveFactoryMobileSeeds(page, {
                  companyId: selectedWorkspaceCompany.companyId,
                  createMissing: false,
                });
                for (const definition of SEEDED_ROUTES) {
                  const keys = SEED_KEYS[definition.key] || [definition.key];
                  if (!keys.every((key) => Number.isInteger(ids[key]) && ids[key] > 0)) continue;
                  seededDetailRoutes.push(definition.path(ids));
                }
              } catch (error) {
                report.failures.push("Factory dynamic fixture lookup failed: " + String(error));
              }
            }
            for (const route of [...new Set([...group.routes, ...seededDetailRoutes])]) {
              try {
              const status = await openRoute(page, route);
              await applyLanguage(page, language.code);
              const state = await readPageState(page);
              const label = `${language.name} ${viewport.name} ${group.workspace} ${route}`;
              const failures = assertPage(state, language.code, language.direction, "app", label);
              if (state.path.startsWith("/login")) failures.push(`${label}: authenticated session returned to login`);
              const redirected = state.path.split("?")[0] !== route.split("?")[0];
              if (REQUIRE_EXACT_ROUTES && redirected) {
                failures.push(`${label}: redirected to ${state.path}`);
              }

              const skipNavigation = await activateSkipNavigation(page);
              if (!skipNavigation.available) failures.push(`${label}: skip navigation link is missing`);
              if (skipNavigation.available && skipNavigation.activeElementId !== "main-content") {
                failures.push(
                  `${label}: skip navigation focused ${skipNavigation.activeElementId || "nothing"} instead of main-content`,
                );
              }
              if (skipNavigation.available && skipNavigation.hash !== "#main-content") {
                failures.push(`${label}: skip navigation did not preserve the #main-content hash`);
              }

              const screenshot = await capture(page, language.code, viewport.name, `${group.workspace}-${route}`);
              report.cases.push({
                language: language.code,
                viewport: viewport.name,
                workspace: group.workspace,
                requestedRoute: route,
                selectedWorkspaceCompany,
                status,
                state,
                languageOnboardingCompleted,
                skipNavigation,
                screenshot,
                classification: redirected ? "redirect" : "rendered",
                redirectTarget: redirected ? state.path : null,
                failures,
              });
              report.failures.push(...failures);
              if (seededDetailRoutes.includes(route) && !redirected)
                report.seededRouteEvidence.push({ workspace: group.workspace, route, language: language.code,
                  viewport: viewport.name, failures });
              await verifyDuoTransitions(page, language, viewport, group, route, state.path);
              } catch (error) {
                const message = language.name + " " + viewport.name + " " + group.workspace + " " +
                  route + ": " + (error instanceof Error ? error.message : String(error));
                report.failures.push(message);
                report.cases.push({ language: language.code, viewport: viewport.name, workspace: group.workspace,
                  requestedRoute: route, classification: "route-exception", error: message });
              }
            }
          }
        }
      } catch (error) {
        browserErrors.push(error instanceof Error ? error.message : String(error));
      } finally {
        report.failures.push(...browserErrors.map((error) => `${language.name} ${viewport.name}: ${error}`));
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }
}

if (REQUIRE_AUTHENTICATED && !AUTHENTICATED) {
  report.failures.push(
    "Authenticated browser coverage is required, but ERP_SMOKE_USERNAME and ERP_SMOKE_PASSWORD were not provided.",
  );
}

report.finishedAt = new Date().toISOString();
const successfulSeeded = report.seededRouteEvidence
  .filter((entry) => !entry.failures.length).map((entry) => entry.route);
report.unresolvedParameterizedRoutes = report.unresolvedParameterizedRoutes.filter((item) =>
  !successfulSeeded.some((route) => matchesPattern(item.route, route)));
report.coverage = {
  staticDeclared: WORKSPACE_ROUTE_GROUPS.reduce((n, group) => n + group.routes.length, 0),
  dynamicWithoutSeeds: report.unresolvedParameterizedRoutes.length,
  seededDetailCases: report.seededRouteEvidence.length,
  auditedCases: report.cases.filter((item) => Boolean(item.workspace) && item.classification === "rendered").length,
  redirectedCases: report.cases.filter((item) => item.classification === "redirect").length,
  transitions: report.transitions.length,
};
if (process.env.ERP_DUO_REQUIRE_COMPLETE === "1" && report.coverage.dynamicWithoutSeeds)
  report.failures.push("Parameterized routes require seeded records; see unresolvedParameterizedRoutes.");
if (process.env.ERP_DUO_REQUIRE_COMPLETE === "1" && report.coverage.redirectedCases)
  report.failures.push("Full certification blocked: routes redirected; see cases classification.");
if (process.env.ERP_DUO_REQUIRE_COMPLETE === "1" && !report.coverage.auditedCases)
  report.failures.push("No authenticated page checks were performed.");
report.failures = [...new Set(report.failures)];
await fs.writeFile(path.join(OUTPUT_DIR, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

if (!AUTHENTICATED) {
  const message = "Authenticated route checks were skipped because ERP_SMOKE_USERNAME and ERP_SMOKE_PASSWORD were not provided.";
  if (REQUIRE_AUTHENTICATED) console.error(message);
  else console.log(message);
}

if (report.failures.length > 0) {
  console.error(`Duo full-system browser audit failed with ${report.failures.length} issue(s):`);
  for (const failure of report.failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Duo full-system browser audit passed for ${LANGUAGES.length} languages and ${VIEWPORTS.length} viewport profiles.`);
console.log(`Report: ${path.join(OUTPUT_DIR, "report.json")}`);
