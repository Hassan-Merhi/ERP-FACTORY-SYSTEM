#!/usr/bin/env node
/**
 * Authenticated Factory theme visual smoke: disposable CI company only.
 * Real Factory pages, three responsive viewports, light + dark appearance.
 * No business mutations: company context selection and read-only navigation.
 */
import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";
import { awaitAuthenticatedShell, signInWithOneRetry, watchSignInResponses } from "./lib/browser-smoke-signin.mjs";

const base = (process.env.ERP_SMOKE_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/, "");
const username = process.env.ERP_SMOKE_USERNAME || "";
const password = process.env.ERP_SMOKE_PASSWORD || "";
const company = process.env.ERP_FACTORY_MOBILE_COMPANY_CODE || "PHASE9-FACTORY";
const output = path.resolve(process.env.FACTORY_THEME_AUTH_QA_OUTPUT || "artifacts/ux-regression-browser/factory-theme-light-dark");
const timeout = Number(process.env.ERP_SMOKE_TIMEOUT_MS || 45000);
const viewports = [
  { name: "phone-390", width: 390, height: 844, isMobile: true, hasTouch: true },
  { name: "tablet-768", width: 768, height: 1024, isMobile: true, hasTouch: true },
  { name: "desktop-1440", width: 1440, height: 900, isMobile: false, hasTouch: false },
];
const routes = [
  "/factory/location-inventory",
  "/factory/production-report?tab=production",
  "/factory/invoicing?tab=pending",
  "/factory/containers-hub",
  "/factory/financial-snapshot",
  "/factory/payroll-hub?section=insurance",
];
if (!username || !password) {
  throw new Error("Set ERP_SMOKE_USERNAME and ERP_SMOKE_PASSWORD for the disposable test account");
}
const result = { startedAt: new Date().toISOString(), company, viewports, routes, cases: [], failures: [] };
const fail = (reason) => result.failures.push(reason);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
try {
  const page = await browser.newPage();
  await signInWithOneRetry(async () => {
    await page.goto(base + "/login", { waitUntil: "domcontentloaded", timeout });
    await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="input-username"]')) || Boolean(document.getElementById("main-content")), { timeout });
    const input = await page.$('[data-testid="input-username"]');
    if (input) {
      await input.type(username);
      await page.type('[data-testid="input-password"]', password);
      const watcher = watchSignInResponses(page);
      try {
        await page.click('[data-testid="button-login"]');
        await awaitAuthenticatedShell(watcher, page.waitForFunction(() => window.location.pathname !== "/login" && Boolean(document.getElementById("main-content")), { timeout }));
      } finally { watcher.stop(); }
    }
  }, "Factory theme browser login");
  const onboarding = await page.$('[data-testid="language-onboarding-dialog"]');
  if (onboarding && await onboarding.isVisible()) {
    await page.click('[data-testid="language-onboarding-en"]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="language-onboarding-continue"]')?.hasAttribute("disabled"), { timeout });
    await page.click('[data-testid="language-onboarding-continue"]');
    await sleep(500);
  }
  await page.evaluate(async (companyCode) => {
    const response = await fetch("/api/user/companies", { credentials: "include", cache: "no-store" });
    if (!response.ok) throw new Error("Company list request failed: " + response.status);
    const companies = await response.json();
    const match = Array.isArray(companies) ? companies.find((row) => row.companyCode === companyCode) : undefined;
    if (!match?.companyId) throw new Error("Factory fixture company is missing: " + companyCode);
    const selected = await fetch("/api/auth/set-company", {
      method: "POST", credentials: "include", headers: { "content-type": "application/json" },
      body: JSON.stringify({ companyId: match.companyId }),
    });
    if (!selected.ok) throw new Error("Factory fixture switch failed: " + selected.status);
    localStorage.setItem("selectedCompanyId", String(match.companyId));
  }, company);

  await fs.mkdir(output, { recursive: true });
  for (const viewport of viewports) {
    await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
    for (const route of routes) {
      await page.goto(base + route, { waitUntil: "domcontentloaded", timeout });
      await page.waitForFunction(() => document.documentElement.dataset.appShell === "factory" && Boolean(document.getElementById("main-content")), { timeout });
      await sleep(850);
      const expected = new URL(route, base).pathname;
      if (new URL(page.url()).pathname !== expected) fail(viewport.name + " " + route + ": redirected to " + page.url());
      for (const mode of ["light", "dark"]) {
        await page.evaluate((appearance) => {
          document.documentElement.classList.remove("light", "dark");
          document.documentElement.classList.add(appearance);
        }, mode);
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const measured = await page.evaluate(() => {
          const root = document.documentElement;
          const a = document.createElement("span");
          const b = document.createElement("span");
          a.className = "bg-blue-500";
          b.className = "bg-violet-500";
          document.body.append(a, b);
          const blue = getComputedStyle(a).backgroundColor;
          const violet = getComputedStyle(b).backgroundColor;
          a.remove();
          b.remove();
          const viewportWidth = window.innerWidth;
          return {
            shell: root.dataset.appShell || "",
            hue: getComputedStyle(root).getPropertyValue("--factory-hue").trim(),
            dark: root.classList.contains("dark"),
            blue, violet, viewportWidth,
            mainContent: Boolean(document.getElementById("main-content")),
          };
        });
        const id = viewport.name + "/" + route + "/" + mode;
        if (measured.shell !== "factory" || measured.hue !== "217") fail(id + ": Factory shell/theme marker missing");
        if (measured.dark !== (mode === "dark")) fail(id + ": requested appearance not applied");
        if (measured.blue !== measured.violet) fail(id + ": violet alias is not blue");
        const name = mode + "-" + viewport.name + "-" + route.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") + ".png";
        await page.screenshot({ path: path.join(output, name), fullPage: false });
        result.cases.push({ id, ...measured, screenshot: name });
        console.log("PASS " + id);
      }
    }
  }
} finally { await browser.close(); }
await fs.mkdir(output, { recursive: true });
await fs.writeFile(path.join(output, "report.json"), JSON.stringify(result, null, 2) + "\n");
if (result.failures.length) {
  result.failures.forEach((reason) => console.error("FAIL " + reason));
  process.exitCode = 1;
} else {
  console.log("PASS: " + result.cases.length + " authenticated Factory appearance cases");
}
