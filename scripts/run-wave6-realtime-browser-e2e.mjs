#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const baseUrl = "http://127.0.0.1:5000";
const username = process.env.ERP_E2E_USERNAME || "";
const password = process.env.ERP_E2E_PASSWORD || "";
const posUsername = process.env.ERP_E2E_POS_USERNAME || "";
const posPassword = process.env.ERP_E2E_POS_PASSWORD || "";
const timeoutMs = Number(process.env.ERP_E2E_TIMEOUT_MS || 45_000);
const realtimeBudgetMs = Number(process.env.ERP_REALTIME_E2E_BUDGET_MS || 4_000);
const outputDir = path.resolve("artifacts/wave6-realtime-e2e");
const fixturePath = path.resolve("artifacts/phase7-browser-e2e/fixture.json");

if (!username || !password) throw new Error("ERP_E2E_USERNAME and ERP_E2E_PASSWORD are required");
if (!posUsername || !posPassword) throw new Error("ERP_E2E_POS_USERNAME and ERP_E2E_POS_PASSWORD are required");

const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8"));
const inventoryPath = `/api/locations/${fixture.erp.locationId}/inventory`;
const report = {
  baseUrl,
  startedAt: new Date().toISOString(),
  realtimeBudgetMs,
  fixture: {
    companyId: fixture.companies.erp,
    locationId: fixture.erp.locationId,
    stockItemId: fixture.erp.stockItemId,
  },
  cases: [],
  failures: [],
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function expectStatus(result, label) {
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`${label} returned ${result.status}: ${JSON.stringify(result.body)}`);
  }
}

async function browserRequest(page, method, url, body) {
  return page.evaluate(
    async ({ requestMethod, requestUrl, requestBody }) => {
      const response = await fetch(requestUrl, {
        method: requestMethod,
        credentials: "include",
        cache: "no-store",
        headers: requestBody === undefined ? undefined : { "content-type": "application/json" },
        body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
      });
      const text = await response.text();
      let parsed = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        // Keep raw text for diagnostics.
      }
      return { status: response.status, body: parsed };
    },
    { requestMethod: method, requestUrl: url, requestBody: body }
  );
}

async function completeLanguageOnboarding(page) {
  const dialogSelector = '[data-testid="language-onboarding-dialog"]';
  const visible = await page
    .evaluate((selector) => {
      const dialog = document.querySelector(selector);
      if (!(dialog instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(dialog);
      return style.display !== "none" && style.visibility !== "hidden";
    }, dialogSelector)
    .catch(() => false);
  if (!visible) return;

  await page.click('[data-testid="language-onboarding-en"]');
  await page.waitForSelector('[data-testid="language-onboarding-continue"]', { visible: true, timeout: timeoutMs });
  await page.click('[data-testid="language-onboarding-continue"]');
  await page.waitForFunction(
    (selector) => {
      const dialog = document.querySelector(selector);
      if (!(dialog instanceof HTMLElement)) return true;
      const style = window.getComputedStyle(dialog);
      return dialog.dataset.state === "closed" || style.display === "none" || style.visibility === "hidden";
    },
    { timeout: timeoutMs },
    dialogSelector
  );
}

async function login(page, loginUsername, loginPassword) {
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await page.waitForSelector('[data-testid="input-username"]', { visible: true, timeout: timeoutMs });
  await page.type('[data-testid="input-username"]', loginUsername);
  await page.type('[data-testid="input-password"]', loginPassword);
  await page.click('[data-testid="button-login"]');
  await page.waitForFunction(
    () => window.location.pathname !== "/login" && Boolean(document.getElementById("main-content")),
    { timeout: timeoutMs }
  );
  await completeLanguageOnboarding(page);
}

async function selectCompany(page, companyCode) {
  await page.evaluate(async (targetCode) => {
    const companiesResponse = await fetch("/api/user/companies", { credentials: "include", cache: "no-store" });
    if (!companiesResponse.ok) throw new Error(`Company list failed (${companiesResponse.status})`);
    const companies = await companiesResponse.json();
    const assignment = Array.isArray(companies)
      ? companies.find((company) => company.companyCode === targetCode)
      : undefined;
    const companyId = Number(assignment?.companyId);
    if (!Number.isInteger(companyId) || companyId <= 0) throw new Error(`Company ${targetCode} is unavailable`);

    const response = await fetch("/api/auth/set-company", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ companyId }),
    });
    if (!response.ok) throw new Error(`Company switch failed (${response.status})`);
    window.localStorage.setItem("selectedCompanyId", String(companyId));
  }, companyCode);
}

function normalizeInventoryPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  if (payload && Array.isArray(payload.items)) return payload.items;
  return [];
}

function quantityForItem(payload, stockItemId) {
  const rows = normalizeInventoryPayload(payload);
  const row = rows.find((candidate) => Number(candidate?.stockItemId) === Number(stockItemId));
  if (!row) throw new Error(`Stock item ${stockItemId} was missing from inventory response`);
  return Number(row.quantity);
}

function responsePath(response) {
  try {
    return new URL(response.url()).pathname;
  } catch {
    return "";
  }
}

function waitForInventoryResponse(page, { after = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      page.off("response", onResponse);
      reject(new Error(`Timed out waiting for ${inventoryPath}`));
    }, timeoutMs);

    const onResponse = async (response) => {
      if (Date.now() < after || responsePath(response) !== inventoryPath || response.status() >= 400) return;
      clearTimeout(timer);
      page.off("response", onResponse);
      let body;
      try {
        body = await response.json();
      } catch (error) {
        reject(error);
        return;
      }
      resolve({ receivedAt: Date.now(), body, status: response.status(), url: response.url() });
    };

    page.on("response", onResponse);
  });
}

async function openWatchedInventory(page) {
  await page.goto(`${baseUrl}/inventory?tab=by-location`, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await page.waitForSelector(`[data-testid="card-location-${fixture.erp.locationId}"]`, {
    visible: true,
    timeout: timeoutMs,
  });
  const initialResponsePromise = waitForInventoryResponse(page);
  await page.click(`[data-testid="card-location-${fixture.erp.locationId}"]`);
  const initial = await initialResponsePromise;
  return { initial, initialQuantity: quantityForItem(initial.body, fixture.erp.stockItemId) };
}

async function capture(page, name) {
  const file = path.join(outputDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => undefined);
  return path.relative(process.cwd(), file);
}

async function runCase(name, page, fn) {
  const startedAt = new Date().toISOString();
  try {
    const evidence = await fn();
    const screenshot = page ? await capture(page, name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()) : null;
    report.cases.push({ name, status: "passed", startedAt, evidence, screenshot });
    console.log(`PASS ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    const screenshot = page ? await capture(page, `${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-failure`) : null;
    report.cases.push({ name, status: "failed", startedAt, error: message, screenshot });
    report.failures.push({ name, error: message });
    console.error(`FAIL ${name}: ${message}`);
  }
}

await fs.mkdir(outputDir, { recursive: true });
const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });

let watcherPage;
let posPage;
try {
  const watcherContext = await browser.createBrowserContext();
  const posContext = await browser.createBrowserContext();
  watcherPage = await watcherContext.newPage();
  posPage = await posContext.newPage();
  await watcherPage.setViewport({ width: 1440, height: 900 });
  await posPage.setViewport({ width: 1280, height: 800 });

  await login(watcherPage, username, password);
  await selectCompany(watcherPage, "PHASE7-ERP");
  await login(posPage, posUsername, posPassword);

  await runCase("two-session POS write auto-refreshes watched inventory", watcherPage, async () => {
    const { initialQuantity } = await openWatchedInventory(watcherPage);
    const watchedRequests = [];
    const onRequest = (request) => {
      try {
        if (new URL(request.url()).pathname === inventoryPath) watchedRequests.push(Date.now());
      } catch {
        // Ignore opaque URLs.
      }
    };
    watcherPage.on("request", onRequest);

    const mutationStartedAt = Date.now();
    const autoRefreshPromise = waitForInventoryResponse(watcherPage, { after: mutationStartedAt });
    const sale = await browserRequest(posPage, "POST", "/api/pos/sales", {
      locationId: fixture.erp.locationId,
      items: [{ stockItemId: fixture.erp.stockItemId, quantity: 3, rate: 25 }],
      paymentAccountType: "ledger",
      paymentAccountId: fixture.erp.cashAccountId,
      voucherDate: new Date().toISOString().slice(0, 10),
      notes: "Wave 6 realtime two-session verification",
    });
    expectStatus(sale, "POS sale");
    const mutationFinishedAt = Date.now();
    const refreshed = await autoRefreshPromise;
    await sleep(700);
    watcherPage.off("request", onRequest);

    const refreshedQuantity = quantityForItem(refreshed.body, fixture.erp.stockItemId);
    const latencyFromWriteStartMs = refreshed.receivedAt - mutationStartedAt;
    const latencyAfterMutationResponseMs = Math.max(0, refreshed.receivedAt - mutationFinishedAt);
    if (refreshedQuantity !== initialQuantity - 3) {
      throw new Error(`Auto-refresh quantity mismatch: ${initialQuantity} -> ${refreshedQuantity}`);
    }
    if (latencyFromWriteStartMs > realtimeBudgetMs) {
      throw new Error(
        `Realtime refresh exceeded ${realtimeBudgetMs}ms budget: ${latencyFromWriteStartMs}ms from write start`
      );
    }
    if (watchedRequests.length !== 1) {
      throw new Error(`Expected exactly one automatic inventory refetch after the write; observed ${watchedRequests.length}`);
    }

    return {
      initialQuantity,
      refreshedQuantity,
      automaticInventoryRequests: watchedRequests.length,
      latencyFromWriteStartMs,
      latencyAfterMutationResponseMs,
    };
  });

  await runCase("mobile inventory remains usable with realtime stack enabled", watcherPage, async () => {
    await watcherPage.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await watcherPage.goto(`${baseUrl}/inventory?tab=by-location`, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await watcherPage.waitForSelector(`[data-testid="card-location-${fixture.erp.locationId}"]`, {
      visible: true,
      timeout: timeoutMs,
    });
    const responsePromise = waitForInventoryResponse(watcherPage);
    await watcherPage.click(`[data-testid="card-location-${fixture.erp.locationId}"]`);
    const response = await responsePromise;
    const shell = await watcherPage.evaluate(() => ({
      width: window.innerWidth,
      hasMain: Boolean(document.getElementById("main-content")),
      loginVisible: Boolean(document.querySelector('[data-testid="button-login"]')),
      recoveryOverlay: Boolean(document.getElementById("stale-asset-recovery")),
    }));
    if (!shell.hasMain || shell.loginVisible || shell.recoveryOverlay) {
      throw new Error(`Mobile application shell was not healthy: ${JSON.stringify(shell)}`);
    }
    return {
      viewportWidth: shell.width,
      inventoryStatus: response.status,
      quantity: quantityForItem(response.body, fixture.erp.stockItemId),
    };
  });
} finally {
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await browser.close().catch(() => undefined);
}

if (report.failures.length > 0) {
  console.error(JSON.stringify({ status: "wave6-realtime-e2e-failed", failures: report.failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ status: "wave6-realtime-e2e-passed", report: path.join(outputDir, "report.json") }));
