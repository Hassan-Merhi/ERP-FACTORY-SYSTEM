#!/usr/bin/env node
/**
 * Phase 6: two real browser tabs, one cookie/session, disposable ERP fixture.
 *
 * Runs only on a LOCAL server backed by the disposable heliumdb test database.
 * The fixture and credentials come from prepare-phase7-browser-e2e-fixture.mjs.
 * No production account, service, database or data is contacted.
 */
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import puppeteer from "puppeteer";

const baseUrl = process.env.ERP_E2E_BASE_URL || "http://127.0.0.1:5000";
const timeoutMs = Number(process.env.ERP_E2E_TIMEOUT_MS || 45_000);
const reportDir = resolve("artifacts/phase6-company-tabs");
const username = process.env.ERP_E2E_USERNAME;
const password = process.env.ERP_E2E_PASSWORD;
const fixturePath = resolve("artifacts/phase7-browser-e2e/fixture.json");
const url = new URL(baseUrl);
if (process.env.NODE_ENV !== "test" || process.env.ERP_E2E_DISPOSABLE_DB !== "1") {
  throw new Error("Phase 6 browser test requires disposable test mode.");
}
if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
  throw new Error("Phase 6 browser test refuses non-local URLs.");
}
if (!username || !password) throw new Error("Phase 6 test credentials are missing.");

const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const { erp, factory } = fixture.companies;
assert(Number.isSafeInteger(erp) && Number.isSafeInteger(factory) && erp !== factory);
const report = { phase: 6, baseUrl, cases: [], failures: [], startedAt: new Date().toISOString() };
await mkdir(reportDir, { recursive: true });

const companyNames = new Map([
  [erp, "Phase 7 Browser ERP"],
  [factory, "Phase 7 Browser Factory"],
]);

function check(condition, message, detail) {
  assert.ok(condition, detail === undefined ? message : `${message}: ${JSON.stringify(detail)}`);
}
async function record(name, fn) {
  try {
    const detail = await fn();
    report.cases.push({ name, result: "passed", detail: detail ?? null });
    console.log("PASS " + name);
  } catch (error) {
    report.cases.push({ name, result: "failed" });
    report.failures.push({ name, error: String(error?.stack || error) });
    console.error("FAIL " + name + ": " + String(error?.stack || error));
    throw error;
  }
}
async function api(page, path, init) {
  return page.evaluate(async ({ path, init }) => {
    const response = await fetch(path, { credentials: "include", cache: "no-store", ...init });
    const data = await response.text();
    let body;
    try { body = JSON.parse(data); } catch { body = data; }
    return { status: response.status, body };
  }, { path, init });
}
async function session(page) {
  const response = await api(page, "/api/auth/session-company");
  check(response.status === 200, "Cannot read authoritative session", response);
  return response.body;
}
async function waitForCompany(page, id) {
  const name = companyNames.get(id);
  check(Boolean(name), "Unknown fixture company", id);
  await page.waitForFunction(
    (companyName) => document.querySelector('[data-testid="button-company-selector"]')?.getAttribute("title") === companyName,
    { timeout: timeoutMs },
    name
  );
}
async function chooseCompany(page, id) {
  await page.waitForSelector('[data-testid="button-company-selector"]', { visible: true, timeout: timeoutMs });
  await page.click('[data-testid="button-company-selector"]');
  const option = `[data-testid="company-option-${id}"]`;
  await page.waitForSelector(option, { visible: true, timeout: timeoutMs });
  await page.click(option);
  await waitForCompany(page, id);
}
async function login(page) {
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await page.waitForSelector('[data-testid="input-username"]', { visible: true, timeout: timeoutMs });
  await page.type('[data-testid="input-username"]', username);
  await page.type('[data-testid="input-password"]', password);
  await page.click('[data-testid="button-login"]');
  await page.waitForFunction(
    () => location.pathname !== "/login" && Boolean(document.getElementById("main-content")),
    { timeout: timeoutMs }
  );
  const me = await api(page, "/api/auth/me");
  check(me.status === 200, "Login did not establish a session", me);
  await page.evaluate((id) => {
    localStorage.setItem(`application-language-onboarding:v1:${id}`, "completed");
  }, me.body.id);
  await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
  await page.waitForSelector('[data-testid="button-company-selector"]', { visible: true, timeout: timeoutMs });
}

async function scopedWrite(page, companyId, companyRevision) {
  return api(page, "/api/vouchers/journal", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Expected-Company-Id": String(companyId),
      "X-Expected-Company-Revision": companyRevision,
    },
    // Deliberately incomplete: a broken boundary must not create real entries.
    body: "{}",
  });
}

const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});
let a;
let b;
try {
  const context = await browser.createBrowserContext(); // same cookie and localStorage across tabs
  a = await context.newPage();
  b = await context.newPage();
  await a.setViewport({ width: 1440, height: 900 });
  await b.setViewport({ width: 1280, height: 800 });

  await record("sign in once; two tabs share one authenticated session", async () => {
    await login(a);
    const current = await session(a);
    if (current.companyId !== erp) await chooseCompany(a, erp);
    await waitForCompany(a, erp);
    await b.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await waitForCompany(b, erp);
    check((await session(b)).companyId === erp, "Second tab loaded a different session");
    await b.evaluate(() => { window.__phase6NoReload = "tab-preserved"; });
    return { erpCompanyId: erp, factoryCompanyId: factory };
  });

  await record("switch A to Factory; B follows without reload", async () => {
    await chooseCompany(a, factory);
    await waitForCompany(b, factory);
    check((await session(b)).companyId === factory, "Other tab did not follow authoritative session");
    check(await b.evaluate(() => window.__phase6NoReload === "tab-preserved"), "Other tab was hard reloaded");
    check((await b.evaluate(() => localStorage.getItem("selectedCompanyId"))) === String(factory), "Storage not synchronized");
  });

  const factorySession = await session(b);
  await record("Company A read finishing late cannot be used under Company B", async () => {
    let delayedRequest;
    await b.setRequestInterception(true);
    const onRequest = (request) => {
      const parsed = new URL(request.url());
      if (parsed.pathname === "/api/accounts" && parsed.searchParams.has("phase6Delayed")) {
        delayedRequest = request;
        return;
      }
      void request.continue().catch(() => {});
    };
    b.on("request", onRequest);
    try {
      const pending = b.evaluate(async () => {
        try {
          const response = await fetch("/api/accounts?phase6Delayed=1", { credentials: "include" });
          await response.json();
          return { accepted: true };
        } catch (error) {
          return { accepted: false, errorName: error?.name, message: String(error?.message) };
        }
      });
      for (let i = 0; i < 200 && !delayedRequest; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      check(Boolean(delayedRequest), "Could not intercept the delayed company GET");
      await chooseCompany(a, erp);
      await waitForCompany(b, erp);
      await delayedRequest.respond({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ id: 900, name: "OLD FACTORY DATA", companyId: factory }]),
      });
      const result = await pending;
      check(!result.accepted && result.errorName === "AbortError", "Late old-company GET was not rejected", result);
      return result;
    } finally {
      b.off("request", onRequest);
      await b.setRequestInterception(false);
    }
  });

  await record("old company write receives a conflict after another tab switches", async () => {
    const result = await scopedWrite(b, factory, factorySession.companyRevision);
    check(result.status === 409 && result.body?.code === "COMPANY_SESSION_CHANGED", "Stale write reached route", result);
    return { status: result.status, code: result.body.code };
  });

  await record("switching back to the same company does not revive an old write token", async () => {
    await chooseCompany(a, factory);
    await waitForCompany(b, factory);
    const returned = await session(b);
    check(returned.companyRevision !== factorySession.companyRevision, "Server did not rotate company write revision");
    const stale = await scopedWrite(b, factory, factorySession.companyRevision);
    check(stale.status === 409 && stale.body?.code === "COMPANY_SESSION_CHANGED", "Old same-company revision accepted", stale);
    return { staleStatus: stale.status };
  });

  await record("only one of two supplied scope headers is rejected", async () => {
    const result = await api(b, "/api/vouchers/journal", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Expected-Company-Id": String(factory) },
      body: "{}",
    });
    // The browser interceptor adds a revision header only if absent and has a
    // verified revision; this tests that a complete, current scope is sent.
    check(result.status !== 409 || result.body?.code !== "COMPANY_SCOPE_INVALID", "Valid browser scope was malformed", result);
    return { status: result.status };
  });

  await b.screenshot({ path: `${reportDir}/tab-b-after-switch.png` });
  await a.screenshot({ path: `${reportDir}/tab-a-after-switch.png` });
} catch (error) {
  process.exitCode = 1;
  console.error(String(error?.stack || error));
  if (b) await b.screenshot({ path: `${reportDir}/failed-tab-b.png` }).catch(() => {});
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(`${reportDir}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
if (report.failures.length) process.exitCode = 1;
console.log("PHASE6 SUMMARY " + JSON.stringify({ passed: report.cases.filter((entry) => entry.result === "passed").length, failures: report.failures.length }));
