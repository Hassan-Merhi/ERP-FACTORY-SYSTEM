/**
 * Migration 0016 actually isolates tenants — proven by running it.
 *
 * The migration is executed against a scratch database as an ordinary
 * non-superuser role. A superuser bypasses RLS entirely, so using one for the
 * assertions below would make the most important tests pass vacuously.
 */
import { Client } from "pg";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATION_SQL = readFileSync(
  path.join(process.cwd(), "migrations", "0016_company_scope_rls_readiness.sql"),
  "utf8"
);

const SCRATCH_DATABASE = "rls_migration_probe";
const PROBE_ROLE = "rls_migration_probe_role";
const PROBE_PASSWORD = "rls_migration_probe_password";

const HOME_COMPANY = 7;
const OTHER_COMPANY = 8;

/**
 * The scratch database on the same server, with everything else unchanged.
 *
 * The role goes in the URL rather than in the client options: node-postgres
 * applies the connection string after the option object, so a `user` option
 * beside a connection string that names postgres connects as postgres — which
 * would have made every assertion below pass as a superuser bypassing RLS.
 */
function scratchConnectionString(database: string, as?: { user: string; password: string }): string {
  const base = process.env.DATABASE_URL ?? "";
  const url = new URL(base);
  url.pathname = `/${database}`;
  if (as) {
    url.username = as.user;
    url.password = as.password;
  }
  return url.toString();
}

function sslFor(connectionString: string): false | { rejectUnauthorized: boolean } {
  const localSocket = process.env.PGSSLMODE === "disable" || connectionString.includes("host=%2Ftmp");
  return localSocket ? false : { rejectUnauthorized: false };
}

async function connect(connectionString: string): Promise<Client> {
  const client = new Client({ connectionString, ssl: sslFor(connectionString) });
  await client.connect();
  return client;
}

/**
 * The subset of the real schema the migration names: enough columns for the
 * policies to compile and for a row to belong to a company. Building this by
 * hand rather than importing the production schema keeps the test about the
 * policy predicates rather than about unrelated columns.
 */
const SCRATCH_SCHEMA = `
  CREATE TABLE vouchers (id serial PRIMARY KEY, company_id integer NOT NULL, voucher_number text);
  CREATE TABLE customers (id serial PRIMARY KEY, company_id integer NOT NULL, name text);
  CREATE TABLE ledger_accounts (id serial PRIMARY KEY, company_id integer NOT NULL, name text);
  CREATE TABLE bank_accounts (id serial PRIMARY KEY, company_id integer NOT NULL, name text);
  CREATE TABLE fixed_assets (id serial PRIMARY KEY, company_id integer NOT NULL, name text);
  CREATE TABLE stock_groups (id serial PRIMARY KEY, company_id integer NOT NULL, name text);
  CREATE TABLE stock_items (id serial PRIMARY KEY, company_id integer NOT NULL, name text);
  CREATE TABLE inventory (id serial PRIMARY KEY, company_id integer NOT NULL, quantity numeric);
  CREATE TABLE voucher_entries (id serial PRIMARY KEY, voucher_id integer NOT NULL REFERENCES vouchers(id), amount numeric);
`;

let admin: Client | null = null;
let probe: Client | null = null;
let available = false;

/** Every direct-company table the migration protects. */
const SCOPED_TABLES = [
  "vouchers",
  "customers",
  "ledger_accounts",
  "bank_accounts",
  "fixed_assets",
  "stock_groups",
  "stock_items",
  "inventory",
];

async function scopeTo(value: string | null, authorizedCompanyIds = ""): Promise<void> {
  await probe!.query(
    `SELECT
       set_config('app.company_scope_maintenance', 'off', false),
       set_config('app.current_company_id', $1, false),
       set_config('app.authorized_company_ids', $2, false)`,
    [value ?? "", authorizedCompanyIds]
  );
}

async function enableMaintenanceScope(): Promise<void> {
  await probe!.query(
    `SELECT
       set_config('app.company_scope_maintenance', 'on', false),
       set_config('app.current_company_id', '', false),
       set_config('app.authorized_company_ids', '', false)`
  );
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;

  const server = await connect(process.env.DATABASE_URL);
  try {
    await server.query(`DROP DATABASE IF EXISTS ${SCRATCH_DATABASE}`);
    await server.query(`CREATE DATABASE ${SCRATCH_DATABASE}`);
    await server.query(`DROP ROLE IF EXISTS ${PROBE_ROLE}`);
    await server.query(`CREATE ROLE ${PROBE_ROLE} LOGIN PASSWORD '${PROBE_PASSWORD}'`);
  } finally {
    await server.end();
  }

  const scratchUrl = scratchConnectionString(SCRATCH_DATABASE);
  admin = await connect(scratchUrl);
  await admin.query(SCRATCH_SCHEMA);
  await admin.query(MIGRATION_SQL);

  await admin.query(`INSERT INTO vouchers (id, company_id, voucher_number) VALUES
    (1, ${HOME_COMPANY}, 'HOME-1'), (2, ${OTHER_COMPANY}, 'OTHER-1')`);
  await admin.query(`INSERT INTO voucher_entries (id, voucher_id, amount) VALUES
    (1, 1, '100'), (2, 2, '250')`);
  for (const table of SCOPED_TABLES) {
    if (table === "vouchers") continue;
    const column = table === "inventory" ? "quantity" : "name";
    const values = table === "inventory" ? ["5", "9"] : ["'home'", "'other'"];
    await admin.query(
      `INSERT INTO ${table} (company_id, ${column}) VALUES (${HOME_COMPANY}, ${values[0]}), (${OTHER_COMPANY}, ${values[1]})`
    );
  }

  await admin.query(`GRANT USAGE ON SCHEMA public TO ${PROBE_ROLE}`);
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${PROBE_ROLE}`);
  await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${PROBE_ROLE}`);

  probe = await connect(scratchConnectionString(SCRATCH_DATABASE, { user: PROBE_ROLE, password: PROBE_PASSWORD }));
  const who = await probe.query("SELECT usesuper FROM pg_user WHERE usename = current_user");
  expect(who.rows[0]?.usesuper, "the probe role must not bypass RLS").toBe(false);

  available = true;
}, 60_000);

afterAll(async () => {
  await probe?.end().catch(() => {});
  await admin?.end().catch(() => {});
  if (!process.env.DATABASE_URL) return;

  const server = await connect(process.env.DATABASE_URL).catch(() => null);
  if (!server) return;
  try {
    await server.query(`DROP DATABASE IF EXISTS ${SCRATCH_DATABASE}`).catch(() => {});
    await server.query(`DROP ROLE IF EXISTS ${PROBE_ROLE}`).catch(() => {});
  } finally {
    await server.end().catch(() => {});
  }
}, 60_000);

describe("company scope RLS migration 0016", () => {
  it("fails closed when no tenant or maintenance scope is present", async () => {
    expect(available).toBe(true);
    await scopeTo(null);

    for (const table of SCOPED_TABLES) {
      await expect(probe!.query(`SELECT count(*)::int AS total FROM ${table}`)).rejects.toMatchObject({
        code: "22023",
      });
    }
  });

  it("allows all-company access only after explicit maintenance assertion", async () => {
    expect(available).toBe(true);
    await enableMaintenanceScope();

    for (const table of SCOPED_TABLES) {
      const { rows } = await probe!.query(`SELECT count(*)::int AS total FROM ${table}`);
      expect(rows[0].total, `${table} must be visible to explicit maintenance scope`).toBe(2);
    }
  });

  it("hides another company's rows when a company is stated", async () => {
    expect(available).toBe(true);
    await scopeTo(String(HOME_COMPANY));

    for (const table of SCOPED_TABLES) {
      const { rows } = await probe!.query(`SELECT company_id FROM ${table}`);
      expect(
        rows.map((row) => row.company_id),
        `${table} leaked another company's rows`
      ).toEqual([HOME_COMPANY]);
    }
  });

  it("refuses to write a row into another company", async () => {
    expect(available).toBe(true);
    await scopeTo(String(HOME_COMPANY));

    await expect(
      probe!.query(`INSERT INTO customers (company_id, name) VALUES (${OTHER_COMPANY}, 'smuggled')`)
    ).rejects.toThrow(/row-level security/i);

    await expect(
      probe!.query(`UPDATE customers SET company_id = ${OTHER_COMPANY} WHERE company_id = ${HOME_COMPANY}`)
    ).rejects.toThrow(/row-level security/i);
  });

  it("accepts a write that stays inside the stated company", async () => {
    expect(available).toBe(true);
    await scopeTo(String(HOME_COMPANY));

    await probe!.query(`INSERT INTO customers (company_id, name) VALUES (${HOME_COMPANY}, 'legitimate')`);
    const { rows } = await probe!.query(`SELECT count(*)::int AS total FROM customers`);
    expect(rows[0].total).toBe(2);

    await probe!.query(`DELETE FROM customers WHERE name = 'legitimate'`);
  });

  it("supports an explicit secondary company list for intentional intercompany work", async () => {
    expect(available).toBe(true);
    await scopeTo(String(HOME_COMPANY), String(OTHER_COMPANY));
    const { rows } = await probe!.query("SELECT company_id FROM vouchers ORDER BY company_id");
    expect(rows.map((row) => row.company_id)).toEqual([HOME_COMPANY, OTHER_COMPANY]);
  });

  it("fails closed on malformed tenant assertions", async () => {
    expect(available).toBe(true);
    await scopeTo("not-a-number");
    await expect(probe!.query("SELECT count(*) FROM vouchers")).rejects.toThrow(/invalid input syntax/i);

    for (const value of ["0", "-1"]) {
      await scopeTo(value);
      await expect(probe!.query("SELECT count(*) FROM vouchers")).rejects.toMatchObject({ code: "22023" });
    }

    await scopeTo(String(HOME_COMPANY), "8,bad");
    await expect(probe!.query("SELECT erp_authorized_company_ids()")).rejects.toMatchObject({ code: "22023" });
  });

  it("scopes voucher entries through their parent voucher", async () => {
    expect(available).toBe(true);
    await scopeTo(String(HOME_COMPANY));

    const { rows } = await probe!.query("SELECT voucher_id FROM voucher_entries");
    expect(rows.map((row) => row.voucher_id)).toEqual([1]);

    // The company-sync trigger reads the parent voucher under RLS, so another
    // company's voucher is invisible and the insert fails before the policy
    // check runs (#1727). Either way the cross-tenant write is refused.
    await expect(
      probe!.query("INSERT INTO voucher_entries (voucher_id, amount) VALUES (2, '999')")
    ).rejects.toMatchObject({ code: "23503", message: expect.stringMatching(/requires a visible parent voucher/) });
  });

  it("can be applied twice without stacking duplicate policies", async () => {
    expect(available).toBe(true);
    await admin!.query(MIGRATION_SQL);

    const { rows } = await admin!.query(
      `SELECT tablename, count(*)::int AS policies FROM pg_policies
       WHERE schemaname = 'public' AND policyname LIKE '%_company_scope_policy'
       GROUP BY tablename ORDER BY tablename`
    );

    expect(rows).toHaveLength(SCOPED_TABLES.length + 1);
    for (const row of rows) {
      expect(row.policies, `${row.tablename} has ${row.policies} scope policies`).toBe(1);
    }

    await scopeTo(String(HOME_COMPANY));
    const { rows: after } = await probe!.query("SELECT company_id FROM vouchers");
    expect(after.map((row) => row.company_id)).toEqual([HOME_COMPANY]);
  });
});
