/**
 * Company isolation enforced by the database (row-level security), attacked in SQL.
 *
 * These tables carry a policy that shows a session only the rows of the company
 * it has declared. The test suite normally connects as a superuser, which
 * PostgreSQL exempts from every policy, so a missing or broken policy would
 * never show up in any other test. Here each table is read and written through
 * an ordinary, unprivileged role created inside the transaction (and rolled
 * back with it), with rows of two companies in place:
 *
 *   - with no company declared, the role sees nothing (the policy fails closed);
 *   - with one declared, it sees that company's rows and not the other's;
 *   - it cannot hand its row to the other company, nor delete the other's row.
 */
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import { expectRefused, seedRow, withRollback } from "./helpers/dbGuardHarness";

const POLICY_VIOLATION = "42501";
const PROBE_ROLE = "guard_rls_probe";

/** Tables whose rows are written by triggers for other tables; a session may read and add, never rewrite. */
const READ_AND_APPEND_ONLY = new Set(["factory_row_history"]);

const ISOLATED_TABLES = [
  "accounting_cash_bank_matches",
  "accounting_cash_bank_statement_lines",
  "accounting_cash_bank_statements",
  "accounting_fiscal_review_policy",
  "accounting_fiscal_review_signoffs",
  "accounting_fiscal_reviewed_closures",
  "accounting_fx_realizations",
  "accounting_open_item_matches",
  "accounting_rental_expense_links",
  "accounting_unified_release_reviews",
  "accounting_unified_rollout_policy",
  "bank_accounts",
  "cost_center_allocations",
  "cost_center_auto_failures",
  "cost_center_auto_rules",
  "cost_center_historical_batch_items",
  "cost_center_historical_batches",
  "cost_center_monthly_budgets",
  "cost_center_source_overrides",
  "cost_centers",
  "customers",
  "factory_row_history",
  "fixed_assets",
  "inventory",
  "ledger_accounts",
  "stock_groups",
  "stock_items",
  "stock_transfer_order_approval_batch_items",
  "stock_transfer_order_approval_batch_revisions",
  "stock_transfer_order_approval_batches",
  "stock_transfer_order_approval_deliveries",
  "stock_transfer_order_approval_events",
  "stock_transfer_order_approval_settings",
  "stock_transfer_order_approval_workbooks",
  "stock_transfer_order_destination_recipients",
  "voucher_entries",
  "vouchers",
];

/**
 * Switches the transaction to an unprivileged role that owns nothing. Triggers
 * are switched off first (only a superuser may), so that a refusal seen
 * afterwards can only have come from a policy.
 */
async function becomeOrdinaryRole(client: PoolClient, table: string): Promise<void> {
  await client.query(`CREATE ROLE ${PROBE_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${table}" TO ${PROBE_ROLE}`);
  await client.query("SET LOCAL session_replication_role = replica");
  await client.query(`SET LOCAL ROLE ${PROBE_ROLE}`);
}

async function declareCompany(client: PoolClient, companyId: unknown): Promise<void> {
  await client.query("SELECT set_config('app.current_company_id', $1, true)", [
    companyId === null ? "" : String(companyId),
  ]);
}

async function visibleCompanies(client: PoolClient, table: string, companies: unknown[]): Promise<number[]> {
  const { rows } = await client.query(
    `SELECT DISTINCT company_id FROM "${table}" WHERE company_id = ANY($1::int[]) ORDER BY company_id`,
    [companies]
  );
  return rows.map((row) => Number(row.company_id));
}

/**
 * Check constraints describe what a valid business row looks like, which is
 * not under test here and would need a hand-built row for every table. They are
 * dropped for the length of the transaction so a placeholder row can stand in.
 */
async function dropCheckConstraints(client: PoolClient, table: string): Promise<void> {
  // The table itself and the parents its foreign keys point at, which get placeholder rows too.
  const { rows } = await client.query(
    `SELECT c.conrelid::regclass::text AS table_name, c.conname
       FROM pg_constraint c
      WHERE c.contype = 'c'
        AND c.conrelid IN (
          SELECT $1::regclass
          UNION
          SELECT f.confrelid FROM pg_constraint f WHERE f.contype = 'f' AND f.conrelid = $1::regclass
        )`,
    [table]
  );
  for (const row of rows) {
    await client.query(`ALTER TABLE ${row.table_name} DROP CONSTRAINT "${row.conname}"`);
  }
}

/** With no company declared the policy must give nothing away: no rows, or a refusal to answer at all. */
async function expectClosed(client: PoolClient, table: string, companies: unknown[]): Promise<void> {
  await client.query("SAVEPOINT guard_closed");
  try {
    expect(await visibleCompanies(client, table, companies)).toEqual([]);
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT guard_closed");
    expect((error as Error).message).toContain("app.current_company_id is required for tenant data access");
    return;
  }
  await client.query("RELEASE SAVEPOINT guard_closed");
}

async function twoCompaniesWithRows(client: PoolClient, table: string) {
  await dropCheckConstraints(client, table);
  const mine = Number((await seedRow(client, "companies")).id);
  const theirs = Number((await seedRow(client, "companies")).id);
  await seedRow(client, table, { company_id: mine });
  await seedRow(client, table, { company_id: theirs });
  return { mine, theirs, both: [mine, theirs].sort((a, b) => a - b) };
}

describe("the set of company-isolated tables", () => {
  it("is exactly the tables this suite probes, each with its policy forced on the table owner too", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query(
        `SELECT c.relname AS table_name, c.relforcerowsecurity AS forced,
                (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
                (SELECT bool_and(p.polpermissive) FROM pg_policy p WHERE p.polrelid = c.oid) AS permissive
           FROM pg_class c
          WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relrowsecurity
          ORDER BY c.relname`
      );

      expect(rows.map((row) => row.table_name)).toEqual(ISOLATED_TABLES);
      for (const row of rows) {
        expect(row.forced, `${row.table_name} must force its policy on the owner`).toBe(true);
        // Policies combine with OR: a second one could quietly widen access, so the count is pinned.
        expect(row.policies, row.table_name).toBe(READ_AND_APPEND_ONLY.has(row.table_name) ? 2 : 1);
      }
    });
  });

  it("is protected by a role check that the test connection would otherwise bypass", async () => {
    await withRollback(async (client) => {
      const { mine, both } = await twoCompaniesWithRows(client, "customers");
      await declareCompany(client, mine);

      // As the superuser the suite connects with, the policy does not apply at all.
      expect(await visibleCompanies(client, "customers", both)).toEqual(both);

      await becomeOrdinaryRole(client, "customers");
      expect(await visibleCompanies(client, "customers", both)).toEqual([mine]);

      // And it is the policy doing that: with it switched off, the same role sees both companies.
      await client.query("RESET ROLE");
      await client.query("ALTER TABLE customers DISABLE ROW LEVEL SECURITY");
      await client.query(`SET LOCAL ROLE ${PROBE_ROLE}`);
      expect(await visibleCompanies(client, "customers", both)).toEqual(both);
    });
  });
});

describe.each(ISOLATED_TABLES)("company isolation on %s", (table) => {
  it("shows nothing until a company is declared, then only that company's rows", async () => {
    await withRollback(async (client) => {
      const { mine, theirs, both } = await twoCompaniesWithRows(client, table);
      await becomeOrdinaryRole(client, table);

      await expectClosed(client, table, both);
      await declareCompany(client, null);
      await expectClosed(client, table, both);

      await declareCompany(client, mine);
      expect(await visibleCompanies(client, table, both)).toEqual([mine]);
      await declareCompany(client, theirs);
      expect(await visibleCompanies(client, table, both)).toEqual([theirs]);
    });
  });

  it("cannot touch another company's rows, or hand its own to another company", async () => {
    await withRollback(async (client) => {
      const { mine, theirs, both } = await twoCompaniesWithRows(client, table);
      await becomeOrdinaryRole(client, table);
      await declareCompany(client, mine);

      const removed = await client.query(`DELETE FROM "${table}" WHERE company_id = $1`, [theirs]);
      expect(removed.rowCount).toBe(0);
      const taken = await client.query(`UPDATE "${table}" SET company_id = $1 WHERE company_id = $2`, [mine, theirs]);
      expect(taken.rowCount).toBe(0);

      if (READ_AND_APPEND_ONLY.has(table)) {
        // No update or delete policy exists, so even its own rows cannot be rewritten.
        const rewritten = await client.query(`UPDATE "${table}" SET company_id = $1 WHERE company_id = $2`, [
          theirs,
          mine,
        ]);
        expect(rewritten.rowCount).toBe(0);
        const purged = await client.query(`DELETE FROM "${table}" WHERE company_id = $1`, [mine]);
        expect(purged.rowCount).toBe(0);
      } else {
        await expectRefused(client, `UPDATE "${table}" SET company_id = $1 WHERE company_id = $2`, [theirs, mine], {
          code: POLICY_VIOLATION,
          message: "row-level security policy",
        });
      }

      // Nothing moved: the other company's row is still there when that company looks.
      await declareCompany(client, theirs);
      expect(await visibleCompanies(client, table, both)).toEqual([theirs]);
    });
  });
});
