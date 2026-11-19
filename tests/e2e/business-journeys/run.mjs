#!/usr/bin/env node
/**
 * Business journeys: whole cycles a company runs, end to end.
 *
 * The Phase 7 browser suite checks single operations. These journeys chain
 * them the way an accountant does, through a real browser session against the
 * running server, and check what each step left behind in three places: the
 * API's own reports, the screens, and the database.
 *
 *   1. Closing the books: an expense is posted last month, the month is closed
 *      against retained earnings, a back-dated entry is refused, the period is
 *      reopened with a reason and the same entry is accepted.
 *   2. Order to cash: a customer buys on credit, stock goes down, the customer
 *      owes the invoice, a receipt settles it, and repeating either request
 *      (a double click, a retried network call) changes nothing.
 *   3. The books still balance: after both journeys, the trial balance is
 *      balanced, every live voucher balances on its own and no stock is
 *      negative.
 *
 * Run by .github/workflows/business-journeys.yml after prepare.mjs.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import pg from "pg";
import puppeteer from "puppeteer";

const baseUrl = `http://127.0.0.1:${process.env.PORT || 5000}`;
const username = process.env.ERP_JOURNEYS_USERNAME || "";
const password = process.env.ERP_JOURNEYS_PASSWORD || "";
const timeoutMs = Number(process.env.ERP_E2E_TIMEOUT_MS || 45_000);
const outputDir = path.resolve("artifacts/business-journeys");
const fixture = JSON.parse(await fs.readFile(path.join(outputDir, "fixture.json"), "utf8"));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const report = { baseUrl, startedAt: new Date().toISOString(), fixture, steps: [], failures: [] };

// ── Dates ──────────────────────────────────────────────────────────────────
const today = new Date();
const isoDate = (date) => date.toISOString().slice(0, 10);
const lastMonthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
const lastMonthEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
const lastMonthMid = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 15));

// ── Browser and assertion helpers ──────────────────────────────────────────
async function request(page, method, url, body) {
  return page.evaluate(
    async ({ m, u, b }) => {
      const response = await fetch(u, {
        method: m,
        credentials: "include",
        cache: "no-store",
        headers: b === undefined ? undefined : { "content-type": "application/json" },
        body: b === undefined ? undefined : JSON.stringify(b),
      });
      const text = await response.text();
      let parsed = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        // keep the raw body for the report
      }
      return { status: response.status, body: parsed };
    },
    { m: method, u: url, b: body }
  );
}

function check(condition, message, detail) {
  if (!condition) throw new Error(`${message}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
}

function ok(result, label) {
  check(result.status >= 200 && result.status < 300, `${label} returned ${result.status}`, result.body);
  return result.body;
}

async function one(text, values = []) {
  const { rows } = await pool.query(text, values);
  check(rows.length === 1, `expected one row for ${text}`, rows);
  return rows[0];
}

const money = (value) => Math.round(Number(value) * 100) / 100;

async function settle(page) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function login(page) {
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await page.waitForSelector('[data-testid="input-username"]', { visible: true, timeout: timeoutMs });
  await page.type('[data-testid="input-username"]', username);
  await page.type('[data-testid="input-password"]', password);
  await page.click('[data-testid="button-login"]');
  await page.waitForFunction(() => window.location.pathname !== "/login", { timeout: timeoutMs });
  await settle(page);
  // First sign-in asks for a language; pick English if it does.
  if (await page.$('[data-testid="language-onboarding-dialog"]')) {
    await page.click('[data-testid="language-onboarding-en"]');
    await page.waitForSelector('[data-testid="language-onboarding-continue"]', { visible: true, timeout: timeoutMs });
    await page.click('[data-testid="language-onboarding-continue"]');
    await settle(page);
  }
}

async function selectCompany(page) {
  const result = await request(page, "POST", "/api/auth/set-company", { companyId: fixture.companyId });
  ok(result, "company switch");
  await page.evaluate((id) => window.localStorage.setItem("selectedCompanyId", String(id)), fixture.companyId);
}

/** Opens a screen and checks the application shell rendered it, not a login page or a crash overlay. */
async function openScreen(page, route, expectedText) {
  const response = await page.goto(`${baseUrl}${route}`, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  check(response && response.status() < 400, `${route} returned HTTP ${response?.status()}`);
  await page.waitForFunction(() => Boolean(document.getElementById("main-content")), { timeout: timeoutMs });
  if (expectedText) {
    await page.waitForFunction((text) => document.body.innerText.includes(text), { timeout: timeoutMs }, expectedText);
  }
  await settle(page);
  const state = await page.evaluate(() => ({
    path: window.location.pathname,
    recovery: Boolean(document.getElementById("stale-asset-recovery")),
  }));
  check(!state.recovery && !state.path.startsWith("/login"), `${route} did not render`, state);
}

async function step(page, name, fn) {
  const startedAt = new Date().toISOString();
  try {
    const evidence = await fn();
    report.steps.push({ name, status: "passed", startedAt, evidence });
    console.log(`PASS ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    const screenshot = path.join(outputDir, `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`);
    await page.screenshot({ path: screenshot, fullPage: true }).catch(() => undefined);
    report.steps.push({ name, status: "failed", startedAt, error: message, screenshot });
    report.failures.push({ name, error: message });
    console.error(`FAIL ${name}: ${message}`);
  }
}

const journal = (date, debitAccountId, creditAccountId, amount, notes) => ({
  voucherDate: date,
  notes,
  entries: [
    { type: "DR", accountType: "ledger", accountId: debitAccountId, amount: String(amount), narration: notes },
    { type: "CR", accountType: "ledger", accountId: creditAccountId, amount: String(amount), narration: notes },
  ],
});

async function voucherCount() {
  const row = await one(`SELECT count(*)::int AS n FROM vouchers WHERE company_id = $1 AND deleted_at IS NULL`, [
    fixture.companyId,
  ]);
  return row.n;
}

async function stockOnHand() {
  const row = await one(
    `SELECT quantity FROM inventory WHERE company_id = $1 AND location_id = $2 AND stock_item_id = $3`,
    [fixture.companyId, fixture.locationId, fixture.stockItemId]
  );
  return Number(row.quantity);
}

// ── Journeys ───────────────────────────────────────────────────────────────
await fs.mkdir(outputDir, { recursive: true });
const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
const state = {};

try {
  await step(page, "sign in and open the journeys company", async () => {
    await login(page);
    await selectCompany(page);
    const me = ok(await request(page, "GET", "/api/auth/me"), "auth/me");
    return { username: me?.username };
  });

  // 1. Closing the books
  await step(page, "an expense posted last month shows in the trial balance", async () => {
    const posted = ok(
      await request(
        page,
        "POST",
        "/api/vouchers/journal",
        journal(isoDate(lastMonthMid), fixture.rentAccountId, fixture.cashAccountId, 300, "Journeys rent")
      ),
      "rent journal"
    );
    state.rentVoucherId = Number(posted?.voucher?.id ?? posted?.voucherId ?? posted?.id);
    check(Number.isInteger(state.rentVoucherId), "the journal response named no voucher", posted);
    const trial = ok(
      await request(page, "GET", `/api/accounting/trial-balance?asOf=${isoDate(lastMonthEnd)}`),
      "trial balance"
    );
    check(trial.balanced === true, "the trial balance is not balanced", trial);
    return { voucherId: state.rentVoucherId };
  });

  await step(page, "closing last month moves the expense into retained earnings", async () => {
    const closed = ok(
      await request(page, "POST", "/api/fiscal-period/close", {
        periodStartDate: isoDate(lastMonthStart),
        periodEndDate: isoDate(lastMonthEnd),
        retainedEarningsAccountId: fixture.retainedEarningsAccountId,
      }),
      "fiscal close"
    );
    check(money(closed.totalExpense) === 300 && money(closed.netIncome) === -300, "close totals are wrong", closed);
    const closure = await one(
      `SELECT id, status, closing_voucher_id FROM fiscal_period_closures WHERE company_id = $1 ORDER BY id DESC LIMIT 1`,
      [fixture.companyId]
    );
    state.closureId = Number(closure.id);
    state.closingVoucherId = Number(closure.closing_voucher_id);
    // After the closing entry, the expense account carries nothing at the period end.
    const rent = await one(
      `SELECT COALESCE(SUM(ve.debit_amount - ve.credit_amount), 0) AS balance
         FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
        WHERE ve.ledger_account_id = $1 AND v.deleted_at IS NULL AND NOT v.optional AND v.voucher_date <= $2`,
      [fixture.rentAccountId, isoDate(lastMonthEnd)]
    );
    check(money(rent.balance) === 0, "the expense account still has a balance after the close", rent);
    return { closureId: state.closureId, status: closure.status };
  });

  await step(page, "an entry dated inside the closed month is refused and nothing is written", async () => {
    const before = await voucherCount();
    const refused = await request(
      page,
      "POST",
      "/api/vouchers/journal",
      journal(isoDate(lastMonthMid), fixture.rentAccountId, fixture.cashAccountId, 25, "Journeys late rent")
    );
    check(
      refused.status >= 400 && refused.status < 500,
      `a back-dated journal returned ${refused.status}`,
      refused.body
    );
    check(
      JSON.stringify(refused.body).includes("closed"),
      "the refusal does not say the period is closed",
      refused.body
    );
    check((await voucherCount()) === before, "a refused journal still wrote a voucher");
    return { status: refused.status };
  });

  await step(page, "reopening needs a reason, then the back-dated entry is accepted", async () => {
    const noReason = await request(page, "POST", `/api/fiscal-period/${state.closureId}/reopen`, {});
    check(noReason.status === 400, `reopening without a reason returned ${noReason.status}`, noReason.body);
    ok(
      await request(page, "POST", `/api/fiscal-period/${state.closureId}/reopen`, {
        reason: "Late invoice from the landlord",
      }),
      "reopen"
    );
    ok(
      await request(
        page,
        "POST",
        "/api/vouchers/journal",
        journal(isoDate(lastMonthMid), fixture.rentAccountId, fixture.cashAccountId, 25, "Journeys late rent")
      ),
      "back-dated journal after reopening"
    );
    // Reopening removes the closure and soft-deletes its closing entry.
    const closed = await one(
      `SELECT count(*)::int AS n FROM fiscal_period_closures WHERE company_id = $1 AND status = 'CLOSED'`,
      [fixture.companyId]
    );
    check(closed.n === 0, "a closed period is still recorded after reopening", closed);
    const closing = await one(`SELECT deleted_at FROM vouchers WHERE id = $1`, [state.closingVoucherId]);
    check(closing.deleted_at !== null, "the closing entry is still live after reopening", closing);
    return { closedPeriods: closed.n };
  });

  // 2. Order to cash
  await step(page, "a new customer buys on credit and stock goes down", async () => {
    const customer = ok(
      await request(page, "POST", "/api/customers", { companyId: fixture.companyId, legalName: "Journeys Customer" }),
      "create customer"
    );
    state.customerId = Number(customer?.id);
    check(Number.isInteger(state.customerId), "the customer response named no id", customer);
    // A credit sale posts to the customer's receivable account, which creating the customer opened.
    const receivable = await one(`SELECT ledger_account_id FROM customers WHERE id = $1`, [state.customerId]);
    state.receivableAccountId = Number(receivable.ledger_account_id);
    check(state.receivableAccountId > 0, "the new customer has no receivable account", receivable);
    state.stockBefore = await stockOnHand();
    state.saleRequest = {
      locationId: fixture.locationId,
      isCreditSale: true,
      paymentAccountId: state.receivableAccountId,
      items: [{ stockItemId: fixture.stockItemId, quantity: 3, rate: 40 }],
      voucherDate: isoDate(today),
      clientSaleId: randomUUID(),
      notes: "Journeys credit sale",
    };
    const sale = ok(await request(page, "POST", "/api/pos/sales", state.saleRequest), "credit sale");
    state.saleVoucherId = Number(sale?.voucher?.id ?? sale?.voucherId ?? sale?.id);
    check((await stockOnHand()) === state.stockBefore - 3, "stock did not go down by 3");
    const balance = ok(await request(page, "GET", `/api/customers/${state.customerId}/balance`), "customer balance");
    check(money(balance.balance) === 120, "the customer does not owe 120", balance);
    // The customers screen lists them while they owe something.
    await openScreen(page, "/customers", "Journeys Customer");
    return { customerId: state.customerId, voucherId: state.saleVoucherId, owes: money(balance.balance) };
  });

  await step(page, "sending the same sale again does not sell twice", async () => {
    const vouchersBefore = await voucherCount();
    const repeat = ok(await request(page, "POST", "/api/pos/sales", state.saleRequest), "repeated credit sale");
    const repeatId = Number(repeat?.voucher?.id ?? repeat?.voucherId ?? repeat?.id);
    check(repeatId === state.saleVoucherId, "the repeat created a different voucher", {
      first: state.saleVoucherId,
      repeat: repeatId,
    });
    check((await voucherCount()) === vouchersBefore, "the repeat wrote another voucher");
    check((await stockOnHand()) === state.stockBefore - 3, "the repeat moved stock again");
    return { voucherId: repeatId };
  });

  await step(page, "a receipt settles the invoice, once, however often it is sent", async () => {
    const receipt = {
      voucherType: "Receipt",
      voucherDate: isoDate(today),
      paymentAccountType: "ledger",
      paymentAccountId: fixture.cashAccountId,
      entries: [{ accountType: "customer", accountId: state.customerId, amount: "120" }],
      notes: "Journeys receipt",
      currency: "USD",
      clientRequestId: randomUUID(),
    };
    const first = ok(await request(page, "POST", "/api/vouchers/payment-receipt", receipt), "receipt");
    const vouchersAfterFirst = await voucherCount();
    const second = await request(page, "POST", "/api/vouchers/payment-receipt", receipt);
    check(second.status < 300, `the repeated receipt returned ${second.status}`, second.body);
    check((await voucherCount()) === vouchersAfterFirst, "the repeated receipt wrote another voucher");
    const balance = ok(await request(page, "GET", `/api/customers/${state.customerId}/balance`), "customer balance");
    check(money(balance.balance) === 0, "the customer still owes after paying", balance);
    const statement = ok(
      await request(page, "GET", `/api/customers/${state.customerId}/statement`),
      "customer statement"
    );
    // Settled customers drop out of the default list; asking for zero balances brings them back.
    await openScreen(page, "/customers", "No customers found");
    await page.click('[data-testid="button-toggle-hide-zero"]');
    await page.waitForFunction(() => document.body.innerText.includes("Journeys Customer"), { timeout: timeoutMs });
    return {
      receipt: first?.voucher?.id ?? first?.id,
      statementRows: Array.isArray(statement) ? statement.length : undefined,
    };
  });

  // 3. The books still balance
  await step(page, "after every journey the books balance and no stock is negative", async () => {
    const trial = ok(await request(page, "GET", "/api/accounting/trial-balance"), "trial balance");
    check(trial.balanced === true, "the trial balance is not balanced", trial);
    const unbalanced = await pool.query(
      `SELECT v.id, v.voucher_number, SUM(ve.debit_amount) AS debit, SUM(ve.credit_amount) AS credit
         FROM vouchers v JOIN voucher_entries ve ON ve.voucher_id = v.id
        WHERE v.company_id = $1 AND v.deleted_at IS NULL AND NOT v.optional
        GROUP BY v.id, v.voucher_number
       HAVING round(SUM(ve.debit_amount), 2) <> round(SUM(ve.credit_amount), 2)`,
      [fixture.companyId]
    );
    check(unbalanced.rows.length === 0, "some vouchers do not balance", unbalanced.rows);
    const negative = await pool.query(
      `SELECT stock_item_id, location_id, quantity FROM inventory WHERE company_id = $1 AND quantity < 0`,
      [fixture.companyId]
    );
    check(negative.rows.length === 0, "some stock is negative", negative.rows);
    await openScreen(page, "/vouchers");
    return { vouchers: await voucherCount() };
  });
} finally {
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
  await pool.end();
}

if (report.failures.length > 0) {
  console.error(`${report.failures.length} business journey step(s) failed`);
  process.exit(1);
}
console.log(`All ${report.steps.length} business journey steps passed`);
