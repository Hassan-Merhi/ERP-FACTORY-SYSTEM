#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import puppeteer from "puppeteer";

const { Pool } = pg;

const baseUrl = "http://127.0.0.1:5000";
const databaseUrl = process.env.DATABASE_URL || "";
const username = process.env.ERP_E2E_USERNAME || "";
const password = process.env.ERP_E2E_PASSWORD || "";
const posUsername = process.env.ERP_E2E_POS_USERNAME || "";
const posPassword = process.env.ERP_E2E_POS_PASSWORD || "";
const timeoutMs = Number(process.env.ERP_E2E_TIMEOUT_MS || 45_000);
const outputDir = path.resolve("artifacts/phase7-browser-e2e");
const fixturePath = path.join(outputDir, "fixture.json");

if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!username || !password) throw new Error("ERP_E2E_USERNAME and ERP_E2E_PASSWORD are required");
if (!posUsername || !posPassword) throw new Error("ERP_E2E_POS_USERNAME and ERP_E2E_POS_PASSWORD are required");

let database;
try {
  database = new URL(databaseUrl);
} catch {
  throw new Error("DATABASE_URL is invalid");
}
if (!new Set(["localhost", "127.0.0.1", "::1"]).has(database.hostname)) {
  throw new Error(`refusing to run Phase 7 E2E against a non-local database host (${database.hostname})`);
}

const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8"));
const pool = new Pool({ connectionString: databaseUrl });
const report = {
  baseUrl,
  startedAt: new Date().toISOString(),
  fixture: {
    companies: fixture.companies,
    erp: fixture.erp,
    factory: fixture.factory,
    supplierPartner: fixture.supplierPartner,
  },
  cases: [],
  failures: [],
};

function fileSafe(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function expectStatus(result, label, predicate = (status) => status >= 200 && status < 300) {
  if (!predicate(result.status)) {
    throw new Error(`${label} returned ${result.status}: ${JSON.stringify(result.body)}`);
  }
}

async function waitForSettledUi(page) {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
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
        // Keep the raw response body for diagnostics.
      }
      return {
        status: response.status,
        ok: response.ok,
        body: parsed,
        headers: Object.fromEntries(response.headers.entries()),
      };
    },
    { requestMethod: method, requestUrl: url, requestBody: body },
  );
}

async function queryOne(text, values = []) {
  const result = await pool.query(text, values);
  if (!result.rows[0]) throw new Error(`Expected one database row for query: ${text}`);
  return result.rows[0];
}

async function login(page, loginUsername, loginPassword) {
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await page.waitForSelector('[data-testid="input-username"]', { visible: true, timeout: timeoutMs });
  await page.type('[data-testid="input-username"]', loginUsername);
  await page.type('[data-testid="input-password"]', loginPassword);
  await page.click('[data-testid="button-login"]');
  await page.waitForFunction(
    () => window.location.pathname !== "/login" && Boolean(document.getElementById("main-content")),
    { timeout: timeoutMs },
  );
  await waitForSettledUi(page);
  await completeLanguageOnboarding(page);
}

async function completeLanguageOnboarding(page) {
  const dialogSelector = '[data-testid="language-onboarding-dialog"]';
  const open = await page.evaluate((selector) => {
    const dialog = document.querySelector(selector);
    if (!(dialog instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(dialog);
    return style.display !== "none" && style.visibility !== "hidden";
  }, dialogSelector);
  if (!open) return;

  await page.click('[data-testid="language-onboarding-en"]');
  // Continue is intentionally never gated on the background preference save, so
  // wait for the button itself rather than for a disabled attribute to clear.
  // The old wait hung for the full timeout whenever that save was slow, which
  // is what made the two login-bearing cases flaky.
  await page.waitForSelector('[data-testid="language-onboarding-continue"]', {
    visible: true,
    timeout: timeoutMs,
  });
  await page.click('[data-testid="language-onboarding-continue"]');
  await page.waitForFunction(
    (selector) => {
      const dialog = document.querySelector(selector);
      if (!(dialog instanceof HTMLElement)) return true;
      const style = window.getComputedStyle(dialog);
      return dialog.dataset.state === "closed" || style.display === "none" || style.visibility === "hidden";
    },
    { timeout: timeoutMs },
    dialogSelector,
  );
  await waitForSettledUi(page);
}

async function selectCompany(page, companyCode) {
  const result = await page.evaluate(async (targetCode) => {
    const companiesResponse = await fetch("/api/user/companies", {
      credentials: "include",
      cache: "no-store",
    });
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
    const body = await switchResponse.json().catch(() => null);
    if (!switchResponse.ok) throw new Error(`Company switch failed (${switchResponse.status}): ${JSON.stringify(body)}`);
    window.localStorage.setItem("selectedCompanyId", String(companyId));
    return { companyId, companyCode: targetCode };
  }, companyCode);
  return result;
}

async function openRoute(page, route) {
  const response = await page.goto(`${baseUrl}${route}`, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  // Wait for the shell (or a definite failure state) instead of racing a fixed
  // delay: the first load after a company switch can outlast one second.
  await page
    .waitForFunction(
      () =>
        Boolean(document.getElementById("main-content")) ||
        Boolean(document.getElementById("stale-asset-recovery")) ||
        Boolean(document.querySelector('[data-testid="button-login"]')),
      { timeout: timeoutMs },
    )
    .catch(() => undefined);
  await waitForSettledUi(page);
  if (!response || response.status() >= 400) throw new Error(`${route} returned HTTP ${response?.status() ?? "unknown"}`);

  const state = await page.evaluate(() => ({
    path: `${window.location.pathname}${window.location.search}`,
    hasMain: Boolean(document.getElementById("main-content")),
    recoveryOverlay: Boolean(document.getElementById("stale-asset-recovery")),
    loginVisible: Boolean(document.querySelector('[data-testid="button-login"]')),
  }));
  if (!state.hasMain || state.recoveryOverlay || state.loginVisible || state.path.startsWith("/login")) {
    throw new Error(`Application shell failed on ${route}: ${JSON.stringify(state)}`);
  }
  return state;
}

async function setLanguage(page, language) {
  await page.evaluate((nextLanguage) => {
    window.localStorage.setItem("erp.application-language", nextLanguage);
    document.cookie = `erp_application_language=${nextLanguage}; Path=/; Max-Age=31536000; SameSite=Lax`;
    window.dispatchEvent(new CustomEvent("erp:application-language-change", { detail: nextLanguage }));
  }, language);
  await waitForSettledUi(page);
}

// ── UI interaction helpers ─────────────────────────────────────────────────
// The cases above drive the API from inside an authenticated page. The wave 4
// cases below drive the rendered UI itself — taps, typing, Radix selects — at
// desktop and phone viewports, then check the database, so a broken form,
// hidden control or mobile-only layout bug fails here even when the API is fine.

const PHONE_VIEWPORT = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

function testId(id) {
  return `[data-testid="${id}"]`;
}

async function tapTestId(page, id) {
  const handle = await page.waitForSelector(testId(id), { visible: true, timeout: timeoutMs });
  await handle.click();
  await waitForSettledUi(page);
}

async function typeTestId(page, id, text) {
  const handle = await page.waitForSelector(testId(id), { visible: true, timeout: timeoutMs });
  await handle.click();
  await page.keyboard.type(text);
  await waitForSettledUi(page);
}

/** Replace a field's value rather than appending to what the form prefilled. */
async function replaceTestIdValue(page, id, text) {
  const handle = await page.waitForSelector(testId(id), { visible: true, timeout: timeoutMs });
  await handle.evaluate((element) => {
    element.focus();
    element.select?.();
  });
  await page.keyboard.press("Backspace");
  await page.keyboard.type(text);
  await waitForSettledUi(page);
}

/** Pick an option from an open Radix select with a real pointer click. */
async function pickOption(page, label) {
  await page.waitForSelector('[role="option"]', { visible: true, timeout: timeoutMs });
  for (const option of await page.$$('[role="option"]')) {
    const text = await option.evaluate((element) => element.textContent?.trim());
    if (text === label) {
      await option.click();
      await waitForSettledUi(page);
      return;
    }
  }
  throw new Error(`Select option "${label}" was not offered`);
}

async function waitForText(page, selector, expected) {
  await page.waitForFunction(
    (sel, text) => Boolean(document.querySelector(sel)?.textContent?.includes(text)),
    { timeout: timeoutMs },
    selector,
    expected,
  );
}

async function assertNoHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) throw new Error(`${label} scrolls horizontally by ${overflow}px at phone width`);
}

async function capture(page, name) {
  if (!page || page.isClosed()) return null;
  const file = path.join(outputDir, `${fileSafe(name)}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => undefined);
  return path.relative(process.cwd(), file);
}

async function runCase(name, page, fn) {
  const startedAt = new Date().toISOString();
  try {
    const evidence = await fn();
    const screenshot = await capture(page, name);
    report.cases.push({ name, status: "passed", startedAt, evidence, screenshot });
    console.log(`PASS ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    const screenshot = await capture(page, `${name}-failure`);
    report.cases.push({ name, status: "failed", startedAt, error: message, screenshot });
    report.failures.push({ name, error: message });
    console.error(`FAIL ${name}: ${message}`);
  }
}

await fs.mkdir(outputDir, { recursive: true });
const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

let devPage;
try {
  devPage = await browser.newPage();
  await devPage.setViewport({ width: 1440, height: 900 });

  await runCase("login and authenticated shell", devPage, async () => {
    await login(devPage, username, password);
    const auth = await browserRequest(devPage, "GET", "/api/auth/me");
    expectStatus(auth, "auth/me");
    const shell = await openRoute(devPage, "/tracking");
    return { username: auth.body?.username, path: shell.path };
  });

  await runCase("ERP POS sale updates inventory", devPage, async () => {
    await selectCompany(devPage, "PHASE7-ERP");
    const before = await queryOne(
      `SELECT quantity FROM inventory WHERE company_id = $1 AND location_id = $2 AND stock_item_id = $3`,
      [fixture.companies.erp, fixture.erp.locationId, fixture.erp.stockItemId],
    );
    const sale = await browserRequest(devPage, "POST", "/api/pos/sales", {
      locationId: fixture.erp.locationId,
      items: [{ stockItemId: fixture.erp.stockItemId, quantity: 4, rate: 25 }],
      paymentAccountType: "ledger",
      paymentAccountId: fixture.erp.cashAccountId,
      voucherDate: new Date().toISOString().slice(0, 10),
      notes: "Phase 7 browser E2E POS sale",
    });
    expectStatus(sale, "POS sale");
    const after = await queryOne(
      `SELECT quantity FROM inventory WHERE company_id = $1 AND location_id = $2 AND stock_item_id = $3`,
      [fixture.companies.erp, fixture.erp.locationId, fixture.erp.stockItemId],
    );
    if (Number(after.quantity) !== Number(before.quantity) - 4) {
      throw new Error(`POS inventory delta mismatch: before=${before.quantity}, after=${after.quantity}`);
    }
    await openRoute(devPage, "/pos");
    return { before: Number(before.quantity), after: Number(after.quantity) };
  });

  await runCase("ERP stock transfer updates both locations", devPage, async () => {
    await selectCompany(devPage, "PHASE7-ERP");
    const beforeSource = await queryOne(
      `SELECT quantity FROM inventory WHERE company_id = $1 AND location_id = $2 AND stock_item_id = $3`,
      [fixture.companies.erp, fixture.erp.locationId, fixture.erp.stockItemId],
    );
    const beforeDestination = await queryOne(
      `SELECT quantity FROM inventory WHERE company_id = $1 AND location_id = $2 AND stock_item_id = $3`,
      [fixture.companies.erp, fixture.erp.location2Id, fixture.erp.stockItemId],
    );
    const transfer = await browserRequest(devPage, "POST", "/api/stock-transfers", {
      sourceLocationId: fixture.erp.locationId,
      destinationLocationId: fixture.erp.location2Id,
      items: [
        {
          stockItemId: fixture.erp.stockItemId,
          quantity: 7,
          sourceLocationId: fixture.erp.locationId,
        },
      ],
      notes: "Phase 7 browser E2E stock transfer",
      voucherDate: new Date().toISOString().slice(0, 10),
    });
    expectStatus(transfer, "Stock transfer");
    const afterSource = await queryOne(
      `SELECT quantity FROM inventory WHERE company_id = $1 AND location_id = $2 AND stock_item_id = $3`,
      [fixture.companies.erp, fixture.erp.locationId, fixture.erp.stockItemId],
    );
    const afterDestination = await queryOne(
      `SELECT quantity FROM inventory WHERE company_id = $1 AND location_id = $2 AND stock_item_id = $3`,
      [fixture.companies.erp, fixture.erp.location2Id, fixture.erp.stockItemId],
    );
    if (Number(afterSource.quantity) !== Number(beforeSource.quantity) - 7) {
      throw new Error(`Source transfer delta mismatch: ${beforeSource.quantity} -> ${afterSource.quantity}`);
    }
    if (Number(afterDestination.quantity) !== Number(beforeDestination.quantity) + 7) {
      throw new Error(`Destination transfer delta mismatch: ${beforeDestination.quantity} -> ${afterDestination.quantity}`);
    }
    await openRoute(devPage, "/sales-tools?tab=transfers");
    return {
      source: [Number(beforeSource.quantity), Number(afterSource.quantity)],
      destination: [Number(beforeDestination.quantity), Number(afterDestination.quantity)],
    };
  });

  await runCase("ERP journal voucher stays balanced", devPage, async () => {
    await selectCompany(devPage, "PHASE7-ERP");
    const journal = await browserRequest(devPage, "POST", "/api/vouchers/journal", {
      voucherDate: new Date().toISOString().slice(0, 10),
      notes: "Phase 7 browser E2E journal",
      entries: [
        {
          type: "DR",
          accountType: "ledger",
          accountId: fixture.erp.cashAccountId,
          amount: "125",
          narration: "Phase 7 debit",
        },
        {
          type: "CR",
          accountType: "ledger",
          accountId: fixture.erp.salesAccountId,
          amount: "125",
          narration: "Phase 7 credit",
        },
      ],
    });
    expectStatus(journal, "Journal voucher");
    const voucherId = Number(journal.body?.voucher?.id ?? journal.body?.voucherId ?? journal.body?.id);
    if (!Number.isInteger(voucherId) || voucherId <= 0) throw new Error("Journal response did not include a voucher id");
    const totals = await queryOne(
      `SELECT COALESCE(SUM(debit_amount::numeric), 0) AS debit,
              COALESCE(SUM(credit_amount::numeric), 0) AS credit
       FROM voucher_entries WHERE voucher_id = $1`,
      [voucherId],
    );
    if (Math.abs(Number(totals.debit) - Number(totals.credit)) > 0.001 || Number(totals.debit) !== 125) {
      throw new Error(`Journal is not balanced at 125: ${JSON.stringify(totals)}`);
    }
    await openRoute(devPage, "/vouchers");
    return { voucherId, debit: Number(totals.debit), credit: Number(totals.credit) };
  });

  await runCase("Factory offload and reverse round trip", devPage, async () => {
    await selectCompany(devPage, "PHASE7-FACTORY");
    const offload = await browserRequest(devPage, "POST", "/api/factory/raw-stock/offload", {
      containerId: fixture.factory.containerId,
      receivedKg: "100",
      costPerKg: "2",
      currencyCode: "USD",
      fxRateToUsd: "1",
      freight: "0",
      otherCharges: "0",
      dutyStatus: "NONE",
      offloadDate: new Date().toISOString().slice(0, 10),
      idempotencyKey: `phase7-browser-offload-${fixture.factory.containerId}`,
    });
    expectStatus(offload, "Factory offload");
    const afterOffload = await queryOne(
      `SELECT c.status, c.actual_received_kg,
              COALESCE(rs.received_kg::numeric, 0) AS raw_received_kg
       FROM factory_containers c
       LEFT JOIN factory_raw_stock rs ON rs.container_id = c.id
       WHERE c.id = $1`,
      [fixture.factory.containerId],
    );
    if (afterOffload.status !== "OFFLOADED" || Number(afterOffload.raw_received_kg) !== 100) {
      throw new Error(`Factory offload state mismatch: ${JSON.stringify(afterOffload)}`);
    }
    await openRoute(devPage, "/factory/containers");

    const reverse = await browserRequest(
      devPage,
      "POST",
      `/api/factory/containers/${fixture.factory.containerId}/reverse-offload`,
      {},
    );
    expectStatus(reverse, "Factory reverse offload");
    const afterReverse = await queryOne(
      `SELECT c.status, c.actual_received_kg,
              (SELECT COUNT(*)::int FROM factory_raw_stock rs WHERE rs.container_id = c.id) AS raw_rows
       FROM factory_containers c WHERE c.id = $1`,
      [fixture.factory.containerId],
    );
    if (afterReverse.status !== "ARRIVED" || afterReverse.actual_received_kg !== null || Number(afterReverse.raw_rows) !== 0) {
      throw new Error(`Factory reverse state mismatch: ${JSON.stringify(afterReverse)}`);
    }
    await openRoute(devPage, "/factory/containers");
    return { afterOffload, afterReverse };
  });

  await runCase("Supplier Partner sale preserves stock and accounting invariants", devPage, async () => {
    await selectCompany(devPage, "PHASE7-SP");
    const before = await queryOne(
      `SELECT COALESCE(SUM(qty_remaining::numeric), 0) AS quantity
       FROM sp_stock_movements WHERE company_id = $1 AND stock_item_id = $2`,
      [fixture.companies.supplierPartner, fixture.supplierPartner.stockItemId],
    );
    const sale = await browserRequest(devPage, "POST", "/api/sp/sales", {
      saleDate: new Date().toISOString().slice(0, 10),
      customerName: "Phase 7 Browser Customer",
      paymentAccountType: "cash",
      paymentAccountId: fixture.supplierPartner.cashAccountId,
      saleLines: [{ stockItemId: fixture.supplierPartner.stockItemId, qtySold: 1, salePricePerUnit: 30 }],
    });
    expectStatus(sale, "Supplier Partner sale");
    const after = await queryOne(
      `SELECT COALESCE(SUM(qty_remaining::numeric), 0) AS quantity
       FROM sp_stock_movements WHERE company_id = $1 AND stock_item_id = $2`,
      [fixture.companies.supplierPartner, fixture.supplierPartner.stockItemId],
    );
    if (Number(after.quantity) !== Number(before.quantity) - 1) {
      throw new Error(`SP stock delta mismatch: ${before.quantity} -> ${after.quantity}`);
    }
    const voucherId = Number(sale.body?.voucherId);
    const totals = await queryOne(
      `SELECT COUNT(*)::int AS entries,
              COALESCE(SUM(debit_amount::numeric), 0) AS debit,
              COALESCE(SUM(credit_amount::numeric), 0) AS credit
       FROM voucher_entries WHERE voucher_id = $1`,
      [voucherId],
    );
    if (Number(totals.entries) !== 2 || Number(totals.debit) !== 30 || Number(totals.credit) !== 30) {
      throw new Error(`SP accounting mismatch: ${JSON.stringify(totals)}`);
    }
    await openRoute(devPage, "/sp");
    return {
      saleId: sale.body?.id,
      voucherId,
      stock: [Number(before.quantity), Number(after.quantity)],
      debit: Number(totals.debit),
      credit: Number(totals.credit),
    };
  });

  await runCase("Phone POS checkout through the mobile sale UI", devPage, async () => {
    await selectCompany(devPage, "PHASE7-ERP");
    const phonePage = await browser.newPage();
    await phonePage.setViewport(PHONE_VIEWPORT);
    try {
      const inventorySql = `SELECT quantity FROM inventory WHERE company_id = $1 AND location_id = $2 AND stock_item_id = $3`;
      const inventoryArgs = [fixture.companies.erp, fixture.erp.locationId, fixture.erp.stockItemId];
      const before = await queryOne(inventorySql, inventoryArgs);
      const lastVoucher = await queryOne(`SELECT COALESCE(MAX(id), 0) AS id FROM vouchers WHERE company_id = $1`, [
        fixture.companies.erp,
      ]);

      await openRoute(phonePage, "/pos");
      await tapTestId(phonePage, `card-pos-location-${fixture.erp.locationId}`);
      await typeTestId(phonePage, "input-mobile-product-search", "Phase 7");
      await tapTestId(phonePage, `button-mobile-select-item-${fixture.erp.stockItemId}`);
      // Clear and retype the quantity the way a cashier does; the line must stay put.
      await replaceTestIdValue(phonePage, "input-mobile-qty-0", "3");
      await waitForText(phonePage, "[data-pos-mobile-page]", "Qty 3");
      await tapTestId(phonePage, "select-mobile-payment-account");
      await pickOption(phonePage, "Phase 7 Cash");
      await assertNoHorizontalOverflow(phonePage, "POS");
      await tapTestId(phonePage, "button-mobile-checkout");

      let after;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        after = await queryOne(inventorySql, inventoryArgs);
        if (Number(after.quantity) === Number(before.quantity) - 3) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (Number(after.quantity) !== Number(before.quantity) - 3) {
        throw new Error(`Phone POS inventory delta mismatch: ${before.quantity} -> ${after.quantity}`);
      }
      const voucher = await queryOne(
        `SELECT v.id, v.voucher_type, v.total_amount,
                COALESCE(SUM(e.debit_amount::numeric), 0) AS debit,
                COALESCE(SUM(e.credit_amount::numeric), 0) AS credit
         FROM vouchers v JOIN voucher_entries e ON e.voucher_id = v.id
         WHERE v.company_id = $1 AND v.id > $2
         GROUP BY v.id ORDER BY v.id DESC LIMIT 1`,
        [fixture.companies.erp, lastVoucher.id],
      );
      if (voucher.voucher_type !== "Sales" || Number(voucher.total_amount) !== 75) {
        throw new Error(`Phone POS voucher mismatch: ${JSON.stringify(voucher)}`);
      }
      if (Number(voucher.debit) !== Number(voucher.credit)) {
        throw new Error(`Phone POS voucher is unbalanced: ${JSON.stringify(voucher)}`);
      }
      await capture(phonePage, "phone POS after checkout");
      return { before: Number(before.quantity), after: Number(after.quantity), voucherId: voucher.id };
    } finally {
      await phonePage.close().catch(() => undefined);
    }
  });

  await runCase("Desktop journal voucher through the form UI", devPage, async () => {
    await selectCompany(devPage, "PHASE7-ERP");
    const lastVoucher = await queryOne(`SELECT COALESCE(MAX(id), 0) AS id FROM vouchers WHERE company_id = $1`, [
      fixture.companies.erp,
    ]);

    await openRoute(devPage, "/vouchers");
    await tapTestId(devPage, "tab-journal");
    await typeTestId(devPage, "input-journal-account-0", "Phase 7 Cash");
    await tapTestId(devPage, "journal-account-option-0");
    await typeTestId(devPage, "input-journal-amount-0", "60");
    await tapTestId(devPage, "button-journal-add-row");
    await tapTestId(devPage, "input-journal-type-1");
    await pickOption(devPage, "CR");
    await typeTestId(devPage, "input-journal-account-1", "Phase 7 Sales");
    await tapTestId(devPage, "journal-account-option-0");
    // Switching to CR pre-fills the balancing amount; replace it explicitly.
    await replaceTestIdValue(devPage, "input-journal-amount-1", "60");
    await typeTestId(devPage, "input-journal-notes", "Wave 4 browser UI journal");
    await tapTestId(devPage, "button-save-journal-voucher");

    let voucher;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await pool.query(
        `SELECT id, voucher_type, total_amount FROM vouchers
         WHERE company_id = $1 AND id > $2 AND description = 'Wave 4 browser UI journal'`,
        [fixture.companies.erp, lastVoucher.id],
      );
      voucher = result.rows[0];
      if (voucher) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!voucher) throw new Error("Journal saved through the UI was not found");
    const entries = await pool.query(
      `SELECT ledger_account_id, debit_amount::numeric AS debit, credit_amount::numeric AS credit
       FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
      [voucher.id],
    );
    const debit = entries.rows.find((row) => Number(row.ledger_account_id) === fixture.erp.cashAccountId);
    const credit = entries.rows.find((row) => Number(row.ledger_account_id) === fixture.erp.salesAccountId);
    if (voucher.voucher_type !== "Journal" || Number(debit?.debit) !== 60 || Number(credit?.credit) !== 60) {
      throw new Error(`UI journal mismatch: ${JSON.stringify({ voucher, entries: entries.rows })}`);
    }
    return { voucherId: voucher.id, debit: Number(debit.debit), credit: Number(credit.credit) };
  });

  await runCase("Phone sidebar navigation reaches live location inventory", devPage, async () => {
    await selectCompany(devPage, "PHASE7-ERP");
    const phonePage = await browser.newPage();
    await phonePage.setViewport(PHONE_VIEWPORT);
    try {
      const stock = await queryOne(
        `SELECT quantity FROM inventory WHERE company_id = $1 AND location_id = $2 AND stock_item_id = $3`,
        [fixture.companies.erp, fixture.erp.locationId, fixture.erp.stockItemId],
      );
      await openRoute(phonePage, "/tracking");
      await tapTestId(phonePage, "button-sidebar-toggle");
      await tapTestId(phonePage, "button-section-inventory");
      await tapTestId(phonePage, "link-/inventory");
      const path = await phonePage.evaluate(() => window.location.pathname);
      if (path !== "/inventory") throw new Error(`Sidebar navigation landed on ${path}`);
      await tapTestId(phonePage, `card-location-${fixture.erp.locationId}`);
      const expected = `${Number(stock.quantity)}BL`;
      await waitForText(phonePage, "#main-content", expected);
      await assertNoHorizontalOverflow(phonePage, "Location inventory");
      await capture(phonePage, "phone location inventory");
      return { path, quantity: Number(stock.quantity) };
    } finally {
      await phonePage.close().catch(() => undefined);
    }
  });

  await runCase("Phone factory containers list shows the arrived container", devPage, async () => {
    await selectCompany(devPage, "PHASE7-FACTORY");
    const phonePage = await browser.newPage();
    await phonePage.setViewport(PHONE_VIEWPORT);
    try {
      const container = await queryOne(
        `SELECT c.status, s.name AS supplier FROM factory_containers c
         JOIN factory_suppliers s ON s.id = c.supplier_id WHERE c.id = $1`,
        [fixture.factory.containerId],
      );
      await openRoute(phonePage, "/factory/containers-hub?section=containers");
      await waitForText(phonePage, "#main-content", container.supplier);
      await tapTestId(phonePage, "button-view-list");
      await waitForText(phonePage, "#main-content", "Containers (1)");
      await assertNoHorizontalOverflow(phonePage, "Factory containers");
      await capture(phonePage, "phone factory containers");
      return container;
    } finally {
      await phonePage.close().catch(() => undefined);
    }
  });

  await runCase("POS role is blocked from accounting and foreign companies", devPage, async () => {
    const restrictedContext = await browser.createBrowserContext();
    const restrictedPage = await restrictedContext.newPage();
    await restrictedPage.setViewport({ width: 1280, height: 800 });
    try {
      await login(restrictedPage, posUsername, posPassword);
      await selectCompany(restrictedPage, "PHASE7-ERP");
      const journal = await browserRequest(restrictedPage, "POST", "/api/vouchers/journal", {
        voucherDate: new Date().toISOString().slice(0, 10),
        notes: "Phase 7 restricted attempt",
        entries: [
          {
            type: "DR",
            accountType: "ledger",
            accountId: fixture.erp.cashAccountId,
            amount: "10",
            narration: "restricted debit",
          },
          {
            type: "CR",
            accountType: "ledger",
            accountId: fixture.erp.salesAccountId,
            amount: "10",
            narration: "restricted credit",
          },
        ],
      });
      if (journal.status < 400) throw new Error(`POS role unexpectedly created a journal (${journal.status})`);

      const foreignSwitch = await browserRequest(restrictedPage, "POST", "/api/auth/set-company", {
        companyId: fixture.companies.factory,
      });
      if (foreignSwitch.status < 400) {
        throw new Error(`POS role unexpectedly switched to an unassigned company (${foreignSwitch.status})`);
      }
      await openRoute(restrictedPage, "/pos");
      await capture(restrictedPage, "POS role permissions");
      return { journalStatus: journal.status, foreignCompanyStatus: foreignSwitch.status };
    } finally {
      await restrictedContext.close();
    }
  });

  await runCase("English French Arabic runtime directions", devPage, async () => {
    await selectCompany(devPage, "PHASE7-ERP");
    const observed = [];
    for (const language of [
      { code: "en", direction: "ltr" },
      { code: "fr", direction: "ltr" },
      { code: "ar", direction: "rtl" },
    ]) {
      await openRoute(devPage, "/tracking");
      await setLanguage(devPage, language.code);
      const state = await devPage.evaluate(() => ({
        language: document.documentElement.lang,
        direction: document.documentElement.dir,
        bodyDirection: document.body.dir,
      }));
      if (
        state.language !== language.code ||
        state.direction !== language.direction ||
        state.bodyDirection !== language.direction
      ) {
        throw new Error(`${language.code} runtime state mismatch: ${JSON.stringify(state)}`);
      }
      observed.push(state);
    }
    return observed;
  });
} finally {
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (devPage && !devPage.isClosed()) await devPage.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
}

if (report.failures.length > 0) {
  console.error(JSON.stringify({ status: "phase7-browser-e2e-failed", failures: report.failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ status: "phase7-browser-e2e-passed", cases: report.cases.length }, null, 2));
