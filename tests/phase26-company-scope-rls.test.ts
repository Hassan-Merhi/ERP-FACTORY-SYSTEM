/**
 * Phase 26 (MC-8): row-level company scope on the remaining company-owned
 * tables (migrations/20261011_026_company_scope_rls_extension.sql), probed as a
 * non-superuser role with RLS forced, the way production runs.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const roleName = "phase26_rls_probe_role";
const PREFIX = "p26rls";

describeDatabase("phase 26 company-scope RLS extension", () => {
  let admin: Client;
  let parent: number;
  let child: number;
  let stranger: number;

  async function id(text: string, params: unknown[]): Promise<number> {
    const result = await admin.query(text, params);
    return Number(result.rows[0].id);
  }

  /** Runs `query` as the probe role with the given tenant scope; returns the rows. */
  async function asTenant(companyId: number, query: string, params: unknown[] = []) {
    await admin.query("BEGIN");
    try {
      await admin.query(`SET LOCAL ROLE ${roleName}`);
      await admin.query(
        `SELECT set_config('app.company_scope_maintenance', 'off', true),
                set_config('app.current_company_id', $1, true),
                set_config('app.authorized_company_ids', '', true)`,
        [String(companyId)]
      );
      const result = await admin.query(query, params);
      return result.rows;
    } finally {
      await admin.query("ROLLBACK");
    }
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    // The fixture connection writes every company's rows (maintenance scope), so the
    // suite also runs when connected as a non-superuser role (RLS enforced); each
    // probe below turns it off for its own transaction.
    await admin.query("SELECT set_config('app.company_scope_maintenance', 'on', false)");
    for (const file of ["0016_company_scope_rls_readiness.sql", "20261011_026_company_scope_rls_extension.sql"]) {
      await admin.query(await readFile(path.join(process.cwd(), "migrations", file), "utf8"));
    }
    await admin.query(`DROP OWNED BY ${roleName}`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${roleName}`);
    await admin.query(`CREATE ROLE ${roleName} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${roleName}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${roleName}`);

    const company = (suffix: string, parentId: number | null) =>
      id(`INSERT INTO companies (code, name, parent_company_id) VALUES ($1, $2, $3) RETURNING id`, [
        `${PREFIX}${suffix}${Date.now() % 100000}`.toUpperCase(),
        `${PREFIX} ${suffix}`,
        parentId,
      ]);
    parent = await company("p", null);
    child = await company("c", parent);
    stranger = await company("s", null);
    for (const companyId of [parent, child, stranger]) {
      await admin.query(
        `INSERT INTO employees (company_id, code, first_name, last_name, join_date) VALUES ($1, $2, 'E', $3, '2026-01-01')`,
        [companyId, `${PREFIX}-E-${companyId}`, String(companyId)]
      );
      await admin.query(`INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, $3, 'x@y.z')`, [
        companyId,
        `${PREFIX}-S-${companyId}`,
        `${PREFIX} supplier ${companyId}`,
      ]);
    }
    const cashParent = await id(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'c', 'Cash') RETURNING id`,
      [parent, `${PREFIX}-CP`]
    );
    const cashChild = await id(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'c', 'Cash') RETURNING id`,
      [child, `${PREFIX}-CC`]
    );
    await admin.query(
      `INSERT INTO inter_company_transfers (transfer_type, from_company_id, to_company_id, transfer_date, amount,
         from_ledger_account_id, to_ledger_account_id) VALUES ('Cash', $1, $2, '2026-01-02', 1, $3, $4)`,
      [parent, child, cashParent, cashChild]
    );
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    const ids = [parent, child, stranger].filter(Boolean);
    await admin.query(`DELETE FROM inter_company_transfers WHERE from_company_id = ANY($1)`, [ids]);
    await admin.query(`DELETE FROM employees WHERE company_id = ANY($1)`, [ids]);
    await admin.query(`DELETE FROM suppliers WHERE company_id = ANY($1)`, [ids]);
    await admin.query(`DELETE FROM ledger_accounts WHERE company_id = ANY($1)`, [ids]);
    await admin.query(`UPDATE companies SET parent_company_id = NULL WHERE id = ANY($1)`, [ids]);
    await admin.query(`DELETE FROM companies WHERE id = ANY($1)`, [ids]);
    await admin.query(`DROP OWNED BY ${roleName}`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${roleName}`).catch(() => {});
    await admin.end();
  }, 60_000);

  it("forces RLS with a company-scope policy on every phase 26 table present", async () => {
    const { rows } = await admin.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              EXISTS (SELECT 1 FROM pg_policies p WHERE p.tablename = c.relname
                       AND p.policyname = c.relname || '_company_scope_policy') AS policy
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
      [
        [
          "employees",
          "factory_suppliers",
          "customer_balances",
          "fiscal_period_closures",
          "suppliers",
          "inter_company_transfers",
          "factory_containers",
          "factory_supplier_payments",
        ],
      ]
    );
    expect(rows.length).toBe(8);
    for (const row of rows)
      expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true, policy: true });
  });

  it("shows a company only its own employees", async () => {
    const rows = await asTenant(parent, `SELECT company_id FROM employees WHERE code LIKE $1`, [`${PREFIX}-E-%`]);
    expect(rows.map((row) => row.company_id)).toEqual([parent]);
  });

  it("shows suppliers of the company, its parent or subsidiaries, never a stranger's", async () => {
    const fromChild = await asTenant(child, `SELECT company_id FROM suppliers WHERE code LIKE $1 ORDER BY code`, [
      `${PREFIX}-S-%`,
    ]);
    const companies = fromChild.map((row) => row.company_id);
    expect(companies).toContain(child);
    expect(companies).toContain(parent);
    expect(companies).not.toContain(stranger);
    const fromStranger = await asTenant(stranger, `SELECT company_id FROM suppliers WHERE code LIKE $1`, [
      `${PREFIX}-S-%`,
    ]);
    expect(fromStranger.map((row) => row.company_id)).toEqual([stranger]);
  });

  it("shows a transfer link to either of its companies only", async () => {
    const query = `SELECT id FROM inter_company_transfers WHERE from_company_id = $1`;
    expect(await asTenant(parent, query, [parent])).toHaveLength(1);
    expect(await asTenant(child, query, [parent])).toHaveLength(1);
    expect(await asTenant(stranger, query, [parent])).toHaveLength(0);
  });

  it("fails closed without a tenant identity", async () => {
    await admin.query("BEGIN");
    try {
      await admin.query(`SET LOCAL ROLE ${roleName}`);
      await admin.query(
        `SELECT set_config('app.current_company_id', '', true), set_config('app.company_scope_maintenance', 'off', true)`
      );
      await expect(admin.query(`SELECT 1 FROM employees LIMIT 1`)).rejects.toThrow(
        /app.current_company_id is required/
      );
    } finally {
      await admin.query("ROLLBACK");
    }
  });
});
