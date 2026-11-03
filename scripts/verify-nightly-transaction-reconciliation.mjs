#!/usr/bin/env node
/**
 * Nightly reconciliation after the actual Phase 7 transactional browser tests.
 * Runs ONLY against a short-lived local postgres fixture populated by
 * prepare-phase7-browser-e2e-fixture.mjs. Never target a live company.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;
const output = path.resolve("artifacts/nightly-transactions");
const fixtureDir = path.resolve("artifacts/phase7-browser-e2e");
const requiredCases = [
  "ERP POS sale updates inventory",
  "ERP stock transfer updates both locations",
  "ERP journal voucher stays balanced",
  "Factory offload and reverse round trip",
  "Supplier Partner sale preserves stock and accounting invariants",
  "Phone POS checkout through the mobile sale UI",
  "Desktop journal voucher through the form UI",
];
const audit = { status: "failed", environment: "disposable-local-only", checks: [], finishedAt: null };
let pool;

function assertIsolated() {
  assert.equal(process.env.NODE_ENV, "test", "NODE_ENV must be test");
  assert.equal(process.env.ERP_E2E_DISPOSABLE_DB, "1", "Disposable DB must be opted in");
  assert.equal(process.env.TRAINING_SANDBOX_VERIFIED, "1", "Training sandbox must be verified");
  const url = new URL(process.env.DATABASE_URL || "");
  assert.equal(url.protocol, "postgresql:");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname), "Non-local database refused");
  assert.equal(url.pathname, "/heliumdb", "Only the dedicated fixture DB is allowed");
}
function money(value) {
  const number = Number(value);
  assert.ok(Number.isFinite(number), "Non-finite money");
  return Math.round(number * 100);
}
function quantity(value) {
  const number = Number(value);
  assert.ok(Number.isFinite(number), "Non-finite quantity");
  return number;
}
function sameQuantity(actual, expected, label) {
  assert.ok(Math.abs(quantity(actual) - expected) <= 0.000001, label + ": expected " + expected + ", got " + actual);
}
async function check(name, run) {
  try {
    const evidence = await run();
    audit.checks.push({ name, status: "passed", evidence });
    console.log("PASS " + name);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    audit.checks.push({ name, status: "failed", error: message });
    console.error("FAIL " + name + ": " + message);
  }
}
async function rows(sql, params = []) {
  return (await pool.query(sql, params)).rows;
}
async function one(sql, params = []) {
  const result = await rows(sql, params);
  assert.equal(result.length, 1, "Expected exactly one row");
  return result[0];
}

await fs.mkdir(output, { recursive: true });
try {
  assertIsolated();
  const fixture = JSON.parse(await fs.readFile(path.join(fixtureDir, "fixture.json"), "utf8"));
  const browserReport = JSON.parse(await fs.readFile(path.join(fixtureDir, "report.json"), "utf8"));
  assert.equal(fixture.status, "phase7-browser-fixture-ready");
  const companyIds = [fixture.companies.erp, fixture.companies.factory, fixture.companies.supplierPartner];
  assert.ok(companyIds.every((id) => Number.isInteger(id) && id > 0));
  assert.equal(new Set(companyIds).size, 3, "Fake companies must be distinct");
  pool = new Pool({ connectionString: process.env.DATABASE_URL });

  await check("Real transactions executed and reported", async () => {
    const cases = new Map(browserReport.cases.map((test) => [test.name, test]));
    assert.equal(browserReport.failures.length, 0, "Browser suite reported failures");
    for (const name of requiredCases) assert.equal(cases.get(name)?.status, "passed", "Required case missing or failed: " + name);
    return { executed: requiredCases, totalCases: browserReport.cases.length };
  });

  await check("Every recorded accounting entry balances by voucher", async () => {
    const vouchers = await rows(
      "SELECT v.id, v.company_id, v.voucher_type, " +
        "COUNT(e.id)::int AS entries, " +
        "COALESCE(SUM(e.debit_amount::numeric),0) AS debit, " +
        "COALESCE(SUM(e.credit_amount::numeric),0) AS credit " +
      "FROM vouchers v LEFT JOIN voucher_entries e ON e.voucher_id = v.id " +
      "WHERE v.company_id = ANY($1::int[]) " +
      "GROUP BY v.id, v.company_id, v.voucher_type ORDER BY v.id",
      [companyIds],
    );
    const posted = vouchers.filter((v) => Number(v.entries) > 0);
    assert.ok(posted.length >= 5, "Expected at least five posted example vouchers");
    for (const v of posted) {
      assert.ok(money(v.debit) > 0, "Voucher has no debit: " + v.id);
      assert.equal(money(v.debit), money(v.credit), "Unbalanced voucher: " + v.id);
    }
    return { vouchersWithEntries: posted.length, totalVouchers: vouchers.length, allBalanced: true };
  });

  await check("ERP location stock and inventory valuation", async () => {
    const inv = await rows(
      "SELECT location_id, quantity, average_rate, total_value FROM inventory " +
      "WHERE company_id = $1 AND stock_item_id = $2 ORDER BY location_id",
      [fixture.companies.erp, fixture.erp.stockItemId],
    );
    assert.equal(inv.length, 2, "Expected two fixture locations");
    const main = inv.find((v) => Number(v.location_id) === fixture.erp.locationId);
    const branch = inv.find((v) => Number(v.location_id) === fixture.erp.location2Id);
    assert.ok(main && branch, "Fixture inventory locations missing");
    // Opening 100 + 50; fake POS sells 4, mobile POS sells 3; transfer 7 internally.
    sameQuantity(main.quantity, 86, "Main warehouse stock");
    sameQuantity(branch.quantity, 57, "Branch warehouse stock");
    sameQuantity(inv.reduce((sum, v) => sum + quantity(v.quantity), 0), 143, "ERP stock conservation");
    for (const v of inv) {
      assert.ok(quantity(v.quantity) >= 0, "Negative stock in test location");
      assert.ok(Math.abs(quantity(v.total_value) - quantity(v.quantity) * quantity(v.average_rate)) < 0.02,
        "Inventory quantity/rate/value discrepancy at location " + v.location_id);
    }
    assert.equal(money(inv.reduce((sum, v) => sum + quantity(v.total_value), 0)), 143000,
      "Two POS sales should reduce inventory valuation by $70; transfer must preserve value");
    return { mainQuantity: quantity(main.quantity), branchQuantity: quantity(branch.quantity), totalQuantity: 143, totalValueUsd: 1430 };
  });

  await check("ERP cash and sales postings reconcile to fake transactions", async () => {
    const account = async (id) => one(
      "SELECT COALESCE(SUM(e.debit_amount::numeric),0) AS debit, " +
      "COALESCE(SUM(e.credit_amount::numeric),0) AS credit " +
      "FROM voucher_entries e JOIN vouchers v ON v.id = e.voucher_id " +
      "WHERE v.company_id = $1 AND e.ledger_account_id = $2",
      [fixture.companies.erp, id],
    );
    const cash = await account(fixture.erp.cashAccountId);
    const journalCreditAccount = await account(fixture.erp.salesAccountId);
    const posVouchers = await rows(
      "SELECT id, total_amount FROM vouchers " +
        "WHERE company_id = $1 AND voucher_type = 'Sales' AND deleted_at IS NULL ORDER BY id",
      [fixture.companies.erp],
    );
    // These two POS sales post $100 + $75 through the application's configured
    // POS revenue ledger, NOT through the fixture's journal-credit test account.
    // The API journal and the UI journal each credit that fixture account:
    // $125 + $60 = $185. All four transactions debit the fake cash account.
    assert.equal(posVouchers.length, 2, "Expected two real posted ERP POS sales");
    const posGrossCents = posVouchers.reduce((total, v) => total + money(v.total_amount), 0);
    const journalCreditCents = money(journalCreditAccount.credit) - money(journalCreditAccount.debit);
    const cashNetCents = money(cash.debit) - money(cash.credit);
    assert.equal(posGrossCents, 17500, "ERP posted POS sales total discrepancy");
    assert.equal(journalCreditCents, 18500, "ERP fake journal-credit ledger discrepancy");
    assert.equal(cashNetCents, 36000, "ERP fake cash account discrepancy");
    assert.equal(cashNetCents, posGrossCents + journalCreditCents, "ERP cash must reconcile to both POS sales and journal credits");
    return { cashNetUsd: 360, posSalesGrossUsd: 175, journalCreditNetUsd: 185, postedSales: posVouchers.length };
  });

  await check("Supplier Partner sale reconciles stock and payable", async () => {
    const stock = await one(
      "SELECT COALESCE(SUM(qty_remaining::numeric),0) AS quantity " +
      "FROM sp_stock_movements WHERE company_id = $1 AND stock_item_id = $2",
      [fixture.companies.supplierPartner, fixture.supplierPartner.stockItemId],
    );
    sameQuantity(stock.quantity, 4, "SP stock remaining after one-unit sale");
    const amount = await one(
      "SELECT COALESCE(SUM(e.credit_amount::numeric - e.debit_amount::numeric),0) AS net " +
      "FROM voucher_entries e JOIN vouchers v ON v.id = e.voucher_id " +
      "WHERE v.company_id = $1 AND e.ledger_account_id = $2",
      [fixture.companies.supplierPartner, fixture.supplierPartner.payableAccountId],
    );
    assert.equal(money(amount.net), 3000, "SP payable must match fake $30 sale");
    return { remainingQuantity: 4, payableUsd: 30 };
  });

  await check("Factory offload reversal restores container and raw stock", async () => {
    const container = await one(
      "SELECT status, actual_received_kg FROM factory_containers WHERE id = $1 AND company_id = $2",
      [fixture.factory.containerId, fixture.companies.factory],
    );
    assert.equal(container.status, "ARRIVED");
    assert.equal(container.actual_received_kg, null);
    const raw = await one(
      "SELECT COUNT(*)::int AS count FROM factory_raw_stock WHERE container_id = $1",
      [fixture.factory.containerId],
    );
    assert.equal(raw.count, 0, "Factory raw stock persisted after reverse offload");
    return { status: container.status, activeRawStockRows: 0 };
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  audit.checks.push({ name: "Isolation and fixture prerequisites", status: "failed", error: message });
  console.error("FAIL " + message);
} finally {
  if (pool) await pool.end();
  audit.finishedAt = new Date().toISOString();
  audit.status = audit.checks.length > 0 && audit.checks.every((c) => c.status === "passed") ? "passed" : "failed";
  await fs.writeFile(path.join(output, "reconciliation.json"), JSON.stringify(audit, null, 2) + "\n", "utf8");
  if (process.env.GITHUB_STEP_SUMMARY) {
    const summary = [
      "## Nightly fake-company transaction reconciliation",
      "",
      "Result: **" + audit.status.toUpperCase() + "**",
      "",
      "| Check | Result |",
      "| --- | --- |",
      ...audit.checks.map((c) => "| " + c.name + " | " + c.status.toUpperCase() + " |"),
      "",
      "Only disposable local database data was inspected.",
    ].join("\n");
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
  }
}
if (audit.status !== "passed") process.exitCode = 1;
