#!/usr/bin/env node
/**
 * Seeds the disposable company the business journeys run in.
 *
 * Its own company, so the journeys can close a fiscal period without touching
 * the other browser suites' data. Refuses any database but a local heliumdb,
 * like the Phase 7 fixture it sits beside.
 */
import fs from "node:fs/promises";
import path from "node:path";

import bcrypt from "bcryptjs";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL || "";
const username = process.env.ERP_JOURNEYS_USERNAME || "";
const password = process.env.ERP_JOURNEYS_PASSWORD || "";
const outputDir = path.resolve("artifacts/business-journeys");

function fail(message) {
  console.error(`Business journeys fixture failed: ${message}`);
  process.exit(1);
}

if (process.env.NODE_ENV !== "test") fail("NODE_ENV must be test");
if (process.env.ERP_E2E_DISPOSABLE_DB !== "1") fail("ERP_E2E_DISPOSABLE_DB must explicitly allow disposable seeding");
if (!username || !password) fail("ERP_JOURNEYS_USERNAME and ERP_JOURNEYS_PASSWORD are required");
let database;
try {
  database = new URL(databaseUrl);
} catch {
  fail("DATABASE_URL is missing or invalid");
}
if (!new Set(["localhost", "127.0.0.1", "::1"]).has(database.hostname)) fail("refusing a non-local database host");
if (database.pathname !== "/heliumdb") fail("refusing anything except the dedicated heliumdb test database");

const pool = new pg.Pool({ connectionString: databaseUrl });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const company = await client.query(
    `INSERT INTO companies (code, name, company_type, base_currency, active)
     VALUES ('E2E-JOURNEYS', 'Business Journeys', 'erp', 'USD', true) RETURNING id`
  );
  const companyId = Number(company.rows[0].id);

  const user = await client.query(`INSERT INTO users (username, password, active) VALUES ($1, $2, true) RETURNING id`, [
    username,
    await bcrypt.hash(password, 12),
  ]);
  await client.query(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, 'Admin')`, [
    user.rows[0].id,
    companyId,
  ]);

  const location = await client.query(
    `INSERT INTO locations (company_id, code, name, active) VALUES ($1, 'BJ-MAIN', 'Journeys Main', true) RETURNING id`,
    [companyId]
  );
  const locationId = Number(location.rows[0].id);
  const group = await client.query(
    `INSERT INTO stock_groups (company_id, code, name, active) VALUES ($1, 'BJ-GROUP', 'Journeys Stock', true) RETURNING id`,
    [companyId]
  );
  const item = await client.query(
    `INSERT INTO stock_items (company_id, code, name, stock_group_id, uom, selling_price, active)
     VALUES ($1, 'BJ-ITEM', 'Journeys Item', $2, 'PCS', '40.00', true) RETURNING id`,
    [companyId, group.rows[0].id]
  );
  const stockItemId = Number(item.rows[0].id);
  await client.query(
    `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value)
     VALUES ($1, $2, $3, '100.000', '10.00', '1000.00')`,
    [companyId, locationId, stockItemId]
  );

  const accounts = await client.query(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, opening_balance, opening_balance_side)
     VALUES ($1, 'BJ-CASH', 'Journeys Cash', 'Cash', 'Cash', '0', 'Dr'),
            ($1, 'BJ-SALES', 'Journeys Sales', 'Income', 'Sales', '0', 'Cr'),
            ($1, 'BJ-RENT', 'Journeys Rent', 'Expense', 'Indirect Expense', '0', 'Dr'),
            ($1, 'BJ-RETAINED', 'Journeys Retained Earnings', 'Equity', 'Retained Earnings', '0', 'Cr')
     RETURNING id, code`,
    [companyId]
  );
  const accountId = (code) => Number(accounts.rows.find((row) => row.code === code).id);
  await client.query("COMMIT");

  const fixture = {
    status: "business-journeys-fixture-ready",
    companyId,
    companyCode: "E2E-JOURNEYS",
    locationId,
    stockItemId,
    cashAccountId: accountId("BJ-CASH"),
    salesAccountId: accountId("BJ-SALES"),
    rentAccountId: accountId("BJ-RENT"),
    retainedEarningsAccountId: accountId("BJ-RETAINED"),
  };
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, "fixture.json"), `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(JSON.stringify({ status: fixture.status }));
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  fail(error instanceof Error ? error.message : String(error));
} finally {
  client.release();
  await pool.end();
}
