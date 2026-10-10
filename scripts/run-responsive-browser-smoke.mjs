#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const BASE_URL = (process.env.ERP_SMOKE_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/, "");
const USERNAME = process.env.ERP_SMOKE_USERNAME || "";
const PASSWORD = process.env.ERP_SMOKE_PASSWORD || "";
const REQUIRE_EXACT_ROUTES = process.env.ERP_SMOKE_REQUIRE_EXACT_ROUTES === "1";
const TIMEOUT_MS = Number(process.env.ERP_SMOKE_TIMEOUT_MS || 45_000);
const OUTPUT_DIR = path.resolve(process.env.ERP_SMOKE_OUTPUT_DIR || "artifacts/responsive-smoke");
const AUTHENTICATED = Boolean(USERNAME && PASSWORD);

const VIEWPORTS = [
  { name: "phone-portrait", width: 390, height: 844, isMobile: true, hasTouch: true },
  { name: "phone-landscape", width: 844, height: 390, isMobile: true, hasTouch: true },
  { name: "tablet-portrait", width: 768, height: 1024, isMobile: true, hasTouch: true },
  { name: "tablet-landscape", width: 1024, height: 768, isMobile: true, hasTouch: true },
  { name: "desktop", width: 1440, height: 900, isMobile: false, hasTouch: false },
  { name: "wide-desktop", width: 1920, height: 1080, isMobile: false, hasTouch: false },
];

const DEFAULT_ROUTES = [
  "/tracking",
  "/transaction-journal",
  "/daybook",
  "/accounts",
  "/inventory",
  "/pos",
  "/vouchers",
];

const ROUTES = (process.env.ERP_SMOKE_ROUTES || DEFAULT_ROUTES.join(","))
  .split(",")
  .map((route) => route.trim())
  .filter(Boolean)
  .map((route) => (route.startsWith("/") ? route : `/${route}`));

const report = {
  baseUrl: BASE_URL,
  authenticated: AUTHENTICATED,
  requireExactRoutes: REQUIRE_EXACT_ROUTES,
  startedAt: new Date().toISOString(),
  viewports: [],
  failures: [],
};

function fileSafe(value) {
  return value.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "root";
}

async function screenshot(page, viewportName, routeName) {
  const directory = path.join(OUTPUT_DIR, viewportName);
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `${fileSafe(routeName)}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return path.relative(process.cwd(), file);
}

async function readLayout(page) {
  return page.evaluate(() => {
    const visibleRect = (element) => {
      if (!(element instanceof HTMLElement)) return null;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return null;
      if (rect.width <= 0 || rect.height <= 0) return null;
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };

    const root = document.documentElement;
    const body = document.body;
    const main = document.getElementById("main-content");
    const shell = document.querySelector('[data-slot="sidebar-wrapper"]');
    const loginButton = document.querySelector('[data-testid="button-login"]');
    const username = document.querySelector('[data-testid="input-username"]');
    const password = document.querySelector('[data-testid="input-password"]');

    return {
      path: `${window.location.pathname}${window.location.search}`,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      rootScrollWidth: root.scrollWidth,
      bodyScrollWidth: body?.scrollWidth || 0,
      horizontalOverflow: Math.max(root.scrollWidth, body?.scrollWidth || 0) > window.innerWidth + 2,
      main: visibleRect(main),
      shell: visibleRect(shell),
      loginButton: visibleRect(loginButton),
      username: visibleRect(username),
      password: visibleRect(password),
      recoveryOverlay: Boolean(document.getElementById("stale-asset-recovery")),
    };
  });
}

function assertLayout(layout, mode, label) {
  const failures = [];

  if (layout.horizontalOverflow) {
    failures.push(`${label}: root horizontal overflow (${layout.rootScrollWidth}px > ${layout.viewport.width}px)`);
  }
  if (layout.recoveryOverlay) {
    failures.push(`${label}: stale-asset recovery overlay is visible`);
  }

  if (mode === "login") {
    if (!layout.username || !layout.password || !layout.loginButton) {
      failures.push(`${label}: login controls are not all visible`);
    }
    if (layout.loginButton && layout.loginButton.height < 40) {
      failures.push(`${label}: login touch target is only ${Math.round(layout.loginButton.height)}px high`);
    }
  } else {
    if (!layout.main) failures.push(`${label}: #main-content is missing or invisible`);
    if (!layout.shell) failures.push(`${label}: responsive app shell is missing or invisible`);
    if (layout.shell && layout.shell.height < layout.viewport.height - 8) {
      failures.push(
        `${label}: app shell height ${Math.round(layout.shell.height)}px does not fill ${layout.viewport.height}px viewport`,
      );
    }
  }

  return failures;
}

async function waitForSettledUi(page) {
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function openRoute(page, route) {
  const response = await page.goto(`${BASE_URL}${route}`, {
    waitUntil: "domcontentloaded",
    timeout: TIMEOUT_MS,
  });
  await waitForSettledUi(page);
  return response?.status() ?? null;
}

async function login(page) {
  await page.waitForSelector('[data-testid="input-username"]', { visible: true, timeout: TIMEOUT_MS });
  await page.type('[data-testid="input-username"]', USERNAME);
  await page.type('[data-testid="input-password"]', PASSWORD);
  await page.click('[data-testid="button-login"]');

  await page.waitForFunction(
    () => window.location.pathname !== "/login" && Boolean(document.getElementById("main-content")),
    { timeout: TIMEOUT_MS },
  );
  await waitForSettledUi(page);
  await dismissFirstRunPrompts(page);
}

/**
 * A fresh profile sees the language onboarding dialog (a full-screen sheet on phones, which makes
 * `#main-content` inert) and, when the company asks for one, the daily rate prompt. Neither is
 * part of the layout under test, so they are answered the way a user would.
 */
async function dismissFirstRunPrompts(page) {
  const clickIfPresent = async (selector) => {
    const handle = await page.$(selector);
    if (!handle) return false;
    await handle.click().catch(() => {});
    return true;
  };
  try {
    await page.waitForSelector('[data-testid="language-onboarding-continue"]', { visible: true, timeout: 4000 });
    await clickIfPresent('[data-testid="language-onboarding-en"]');
    await clickIfPresent('[data-testid="language-onboarding-continue"]');
  } catch {
    // No onboarding dialog for this profile.
  }
  await clickIfPresent('[data-testid="button-skip-rate"]');
  await waitForSettledUi(page);
}

const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

try {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  for (const viewport of VIEWPORTS) {
    const page = await browser.newPage();
    const viewportReport = { ...viewport, pages: [], browserErrors: [] };
    report.viewports.push(viewportReport);

    await page.setViewport({
      width: viewport.width,
      height: viewport.height,
      isMobile: viewport.isMobile,
      hasTouch: viewport.hasTouch,
      deviceScaleFactor: 1,
    });
    page.setDefaultTimeout(TIMEOUT_MS);
    page.setDefaultNavigationTimeout(TIMEOUT_MS);

    page.on("pageerror", (error) => {
      viewportReport.browserErrors.push(`pageerror: ${error.message}`);
    });
    page.on("requestfailed", (request) => {
      const type = request.resourceType();
      if (!["document", "script", "stylesheet"].includes(type)) return;
      const url = request.url();
      if (!url.startsWith(BASE_URL)) return;
      const errorText = request.failure()?.errorText || "unknown";
      if (errorText === "net::ERR_ABORTED") return;
      viewportReport.browserErrors.push(`${type} failed: ${url} (${errorText})`);
    });
    page.on("response", (response) => {
      const request = response.request();
      const type = request.resourceType();
      if (!["document", "script", "stylesheet"].includes(type)) return;
      if (!response.url().startsWith(BASE_URL)) return;
      if (response.status() >= 400) {
        viewportReport.browserErrors.push(`${type} ${response.status()}: ${response.url()}`);
      }
    });

    try {
      const loginStatus = await openRoute(page, "/login");
      const loginLayout = await readLayout(page);
      const loginLabel = `${viewport.name} /login`;
      const loginFailures = assertLayout(loginLayout, "login", loginLabel);
      const loginScreenshot = await screenshot(page, viewport.name, "login");
      viewportReport.pages.push({
        requestedRoute: "/login",
        actualRoute: loginLayout.path,
        status: loginStatus,
        screenshot: loginScreenshot,
        layout: loginLayout,
        failures: loginFailures,
      });
      report.failures.push(...loginFailures);

      if (AUTHENTICATED) {
        await login(page);

        for (const route of ROUTES) {
          const status = await openRoute(page, route);
          const layout = await readLayout(page);
          const label = `${viewport.name} ${route}`;
          const routeFailures = assertLayout(layout, "app", label);

          if (layout.path.startsWith("/login")) {
            routeFailures.push(`${label}: authenticated session returned to login`);
          }
          if (REQUIRE_EXACT_ROUTES && !layout.path.startsWith(route)) {
            routeFailures.push(`${label}: redirected to ${layout.path}`);
          }

          const routeScreenshot = await screenshot(page, viewport.name, route);
          viewportReport.pages.push({
            requestedRoute: route,
            actualRoute: layout.path,
            status,
            screenshot: routeScreenshot,
            layout,
            failures: routeFailures,
          });
          report.failures.push(...routeFailures);
        }
      }
    } catch (error) {
      viewportReport.browserErrors.push(error instanceof Error ? error.message : String(error));
    } finally {
      if (viewportReport.browserErrors.length) {
        report.failures.push(...viewportReport.browserErrors.map((error) => `${viewport.name}: ${error}`));
      }
      await page.close();
    }
  }
} finally {
  await browser.close();
}

report.finishedAt = new Date().toISOString();
report.failures = [...new Set(report.failures)];
await fs.writeFile(path.join(OUTPUT_DIR, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

if (!AUTHENTICATED) {
  console.log("Responsive login smoke completed. Set ERP_SMOKE_USERNAME and ERP_SMOKE_PASSWORD for authenticated routes.");
}

if (report.failures.length) {
  console.error(`Responsive browser smoke failed with ${report.failures.length} issue(s):`);
  for (const failure of report.failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Responsive browser smoke passed across ${VIEWPORTS.length} viewport profiles.`);
console.log(`Report: ${path.join(OUTPUT_DIR, "report.json")}`);
