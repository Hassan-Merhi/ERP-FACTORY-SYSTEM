#!/usr/bin/env node

import bcrypt from "bcryptjs";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL || "";
const username = process.env.ERP_SMOKE_USERNAME || "";
const password = process.env.ERP_SMOKE_PASSWORD || "";

function fail(message) {
  console.error(`Phase 9 browser fixture failed: ${message}`);
  process.exit(1);
}

if (process.env.NODE_ENV !== "test") fail("NODE_ENV must be test");
if (!databaseUrl) fail("DATABASE_URL is required");
if (!username || !password) fail("ERP_SMOKE_USERNAME and ERP_SMOKE_PASSWORD are required");

let database;
try {
  database = new URL(databaseUrl);
} catch {
  fail("DATABASE_URL is invalid");
}

if (!new Set(["localhost", "127.0.0.1", "::1"]).has(database.hostname)) {
  fail(`refusing to seed a non-local database host (${database.hostname})`);
}

const pool = new Pool({ connectionString: databaseUrl });
const client = await pool.connect();

const companyFixtures = [
  { code: "PHASE9-ERP", name: "UX Verification ERP", companyType: "erp" },
  { code: "PHASE9-FACTORY", name: "UX Verification Factory", companyType: "factory" },
  { code: "PHASE9-PROPERTIES", name: "UX Verification Properties", companyType: "properties" },
  { code: "PHASE9-SP", name: "UX Verification Supplier Partner", companyType: "supplier_partner" },
];

try {
  const passwordHash = await bcrypt.hash(password, 10);
  await client.query("BEGIN");

  const companyIds = {};
  for (const fixture of companyFixtures) {
    const companyResult = await client.query(
      `INSERT INTO companies (code, name, company_type, base_currency, active)
       VALUES ($1, $2, $3, 'USD', true)
       ON CONFLICT (code) DO UPDATE
         SET name = EXCLUDED.name, company_type = EXCLUDED.company_type,
             base_currency = EXCLUDED.base_currency, active = true
       RETURNING id`,
      [fixture.code, fixture.name, fixture.companyType],
    );
    const companyId = companyResult.rows[0]?.id;
    if (!companyId) throw new Error(`fixture company was not returned for ${fixture.code}`);
    companyIds[fixture.code] = companyId;
  }

  const userResult = await client.query(
    `INSERT INTO users (username, password, active)
     VALUES ($1, $2, true)
     ON CONFLICT (username) DO UPDATE
       SET password = EXCLUDED.password, active = true
     RETURNING id`,
    [username, passwordHash],
  );
  const userId = userResult.rows[0]?.id;
  if (!userId) throw new Error("fixture user was not returned");

  await client.query("DELETE FROM user_company_roles WHERE user_id = $1", [userId]);
  for (const companyId of Object.values(companyIds)) {
    await client.query(
      `INSERT INTO user_company_roles (user_id, company_id, role)
       VALUES ($1, $2, 'Developer')`,
      [userId, companyId],
    );
  }

  await client.query("COMMIT");
  console.log(
    JSON.stringify({
      status: "phase9-browser-fixture-ready",
      companyIds,
      databaseHost: database.hostname,
    }),
  );
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  fail(error instanceof Error ? error.message : String(error));
} finally {
  client.release();
  await pool.end();
}
