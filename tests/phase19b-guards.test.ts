/**
 * Phase 19 (B) — guards, deletes, rental routes and the account tree
 * (docs/accounting-audit-2026-10.md, section 13 and the wave log).
 *
 * DI2/PE11  the maintenance scope no longer bypasses the closed-period guard or
 *           the opening lock; boot steps still run with closed periods.
 * DI4       the opening lock covers deleting a master after a close.
 * D5, D1    new vouchers need two lines and a header total equal to their line
 *           total (stock transfers exempt); history vouchers balance after a
 *           line edit.
 * C5, C6    the account tree guard; bulk-assign-parent; reserved codes and
 *           system accounts.
 * PE6, PE7  factory supplier permanent delete and fixed-asset delete.
 * PE2       rental GET detail and export read only; accrue / post-scheduled /
 *           run-monthly Admin/Owner on the business date with the real actor;
 *           the recorded rental payment rate.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import { companyBusinessDate } from "../server/services/accounting/companyBusinessDate";
import { ensureClosedPeriodGuard } from "../server/services/accounting/closedPeriodGuard";
import { runAccountingIntegrityDiagnostic } from "../server/services/accounting/integrity/accountingIntegrityDiagnostic";
import {
  ensureLedgerIntegrityGuard,
  LEDGER_ACCOUNT_PARENT_FK,
  LEDGER_INTEGRITY_GUARD_VERSION,
} from "../server/services/accounting/ledgerIntegrityGuard";
import {
  ensureOpeningBalanceLock,
  installedOpeningBalanceLockVersion,
  OPENING_BALANCE_LOCK_VERSION,
} from "../server/services/accounting/openingBalanceLock";
import {
  ensureRequiredSystemAccountsForAllCompanies,
  ensureSystemAccounts,
} from "../server/services/accounting/systemAccounts";
import {
  ensureVoucherBalanceGuard,
  installedVoucherBalanceGuardVersion,
  VOUCHER_BALANCE_GUARD_VERSION,
} from "../server/services/accounting/voucherBalanceGuard";
import {
  assertSalesCostTargetsInOpenPeriods,
  disableMaintenanceScope,
  enableRunCompanyScope,
} from "../server/services/inventory/historicalSalesCostRepairLoaders";
import { runWithDatabaseMaintenanceScope } from "../server/services/security/databaseScopeRuntimeContext";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "p19bguard";
const USERNAME = `${PREFIX}_testuser`;
let ctx: TestContext;
let agent: request.SuperAgentTest;
let otherCompanyId: number;
let sequence = 0;
const nextNumber = () => `${PREFIX}-${++sequence}`;
const unitIds: number[] = [];
const contractIds: number[] = [];
const repairRunIds: number[] = [];
let today: string;

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

async function setRole(role: string) {
  await pool.query(`UPDATE user_company_roles SET role = $1 WHERE user_id = $2 AND company_id = $3`, [
    role,
    ctx.userId,
    ctx.companyId,
  ]);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
}

/** A balanced two-line journal, total = line total. */
async function journal(date: string, amount = "10.00", type = "Journal"): Promise<number> {
  return withFixtureTransaction(async (client) => {
    const id = (
      await client.query(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, optional)
         VALUES ($1, $2, $3, $4, $5, false) RETURNING id`,
        [ctx.companyId, nextNumber(), type, date, amount]
      )
    ).rows[0].id as number;
    await client.query(
      `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount)
       VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
      [id, ctx.cashAccountId, amount, ctx.salesAccountId]
    );
    return id;
  });
}

let closureDate: string;
async function closeBooks() {
  const closing = await journal(closureDate, "1.00");
  await pool.query(
    `INSERT INTO fiscal_period_closures (company_id, period_start_date, period_end_date, closed_by_user_id,
       closing_voucher_id, retained_earnings_account_id, total_income, total_expense, net_income, status)
     VALUES ($1, $2, $2, $3, $4, $5, 0, 0, 0, 'CLOSED')`,
    [ctx.companyId, closureDate, ctx.userId, closing, ctx.cashAccountId]
  );
}
const reopenBooks = () => pool.query(`DELETE FROM fiscal_period_closures WHERE company_id = $1`, [ctx.companyId]);

async function ledger(code: string, accountType: string, options: { companyId?: number; parentId?: number } = {}) {
  return (
    await pool.query(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type, parent_id)
       VALUES ($1, $2::varchar, $2::text, $3, $4) RETURNING id`,
      [options.companyId ?? ctx.companyId, `${PREFIX}-${code}`, accountType, options.parentId ?? null]
    )
  ).rows[0].id as number;
}

const auditRows = async (tableName: string, recordId: number) =>
  (
    await pool.query(
      `SELECT action, username, changes FROM audit_log WHERE table_name = $1 AND record_id = $2 ORDER BY id`,
      [tableName, recordId]
    )
  ).rows as Array<{ action: string; username: string; changes: Record<string, { old?: unknown; new?: unknown }> }>;

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  await ensureClosedPeriodGuard(pool);
  await ensureOpeningBalanceLock(pool);
  expect(await ensureLedgerIntegrityGuard(pool)).toBe(true);
  await ensureVoucherBalanceGuard(pool);
  otherCompanyId = (
    await pool.query(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
      `P19B${Date.now().toString(36).slice(-5).toUpperCase()}`,
    ])
  ).rows[0].id as number;
  today = await companyBusinessDate(ctx.companyId);
  closureDate = addDays(today, -60);
  agent = request.agent(ctx.app);
  expect((await agent.post("/api/auth/login").send({ username: USERNAME, password: "testpassword123" })).status).toBe(
    200
  );
  await setRole("Owner");
}, 120000);

afterAll(async () => {
  await reopenBooks();
  const ids = [ctx.companyId, otherCompanyId];
  if (repairRunIds.length) {
    await pool.query(`DELETE FROM historical_sales_cost_repair_rows WHERE run_id = ANY($1::int[])`, [repairRunIds]);
    await pool.query(`DELETE FROM historical_sales_cost_repair_runs WHERE id = ANY($1::int[])`, [repairRunIds]);
  }
  if (contractIds.length) {
    await pool.query(`DELETE FROM property_payments WHERE contract_id = ANY($1::int[])`, [contractIds]);
    await pool.query(`DELETE FROM property_monthly_ledger WHERE contract_id = ANY($1::int[])`, [contractIds]);
    await pool.query(`DELETE FROM property_contracts WHERE id = ANY($1::int[])`, [contractIds]);
    await pool.query(`DELETE FROM property_units WHERE id = ANY($1::int[])`, [unitIds]);
  }
  await pool.query(`DELETE FROM exchange_rates WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_daybook_entries WHERE company_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM accounting_posting_requests WHERE company_id = ANY($1::int[])`, [ids]);
  await withFixtureTransaction(async (client) => {
    await client.query(`SET LOCAL app.closed_period_override = 'on'`);
    await client.query(`SET LOCAL app.ledger_integrity_bypass = 'on'`);
    await client.query(
      `DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = ANY($1::int[]))`,
      [ids]
    );
    await client.query(`DELETE FROM vouchers WHERE company_id = ANY($1::int[])`, [ids]);
    await client.query(`DELETE FROM factory_supplier_payments WHERE company_id = $1`, [ctx.companyId]);
    await client.query(`DELETE FROM factory_suppliers WHERE company_id = $1`, [ctx.companyId]);
    await client.query(`DELETE FROM fixed_assets WHERE company_id = $1`, [ctx.companyId]);
    await client.query(`DELETE FROM customers WHERE company_id = $1 AND code LIKE $2`, [ctx.companyId, `${PREFIX}%`]);
    await client.query(`UPDATE ledger_accounts SET parent_id = NULL WHERE company_id = ANY($1::int[])`, [ids]);
    await client.query(`DELETE FROM ledger_accounts WHERE company_id = $1 AND code LIKE $2`, [
      ctx.companyId,
      `${PREFIX}-%`,
    ]);
    await client.query(`DELETE FROM ledger_accounts WHERE company_id = $1`, [otherCompanyId]);
  });
  await deleteAuditLogRowsForTests(pool, "company_id = ANY($1::int[])", [ids]);
  await withFixtureTransaction(async (client) => {
    await client.query(`SET LOCAL session_replication_role = replica`);
    await client.query(`DELETE FROM companies WHERE id = $1`, [otherCompanyId]);
  });
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 120000);

describe("DI2, PE11: maintenance scope no longer bypasses the closed-period guard and the opening lock", () => {
  it("refuses a closed-period voucher and opening in the maintenance scope; only the override passes", async () => {
    await closeBooks();
    try {
      const inMaintenance = <T>(work: (client: import("pg").PoolClient) => Promise<T>) =>
        runWithDatabaseMaintenanceScope("phase19b-test", async () => {
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            const result = await work(client);
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            throw error;
          } finally {
            client.release();
          }
        });
      await expect(
        inMaintenance((client) =>
          client.query(
            `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
             VALUES ($1, $2, 'Stock Transfer', $3, 0)`,
            [ctx.companyId, nextNumber(), closureDate]
          )
        )
      ).rejects.toThrow(/ACCOUNTING_PERIOD_CLOSED/);
      await expect(
        inMaintenance((client) =>
          client.query(`UPDATE ledger_accounts SET opening_balance = 5, opening_balance_side = 'Dr' WHERE id = $1`, [
            ctx.cashAccountId,
          ])
        )
      ).rejects.toThrow(/ACCOUNTING_PERIOD_CLOSED/);
      // The fiscal reopen's audited override still passes.
      await expect(
        inMaintenance(async (client) => {
          await client.query(`SET LOCAL app.closed_period_override = 'on'`);
          return client.query(
            `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
             VALUES ($1, $2, 'Stock Transfer', $3, 0)`,
            [ctx.companyId, nextNumber(), closureDate]
          );
        })
      ).resolves.toBeDefined();
    } finally {
      await reopenBooks();
    }
  });

  it("boot still starts with closed periods: guards install and system accounts provision", async () => {
    await closeBooks();
    try {
      await ensureClosedPeriodGuard(pool);
      await ensureOpeningBalanceLock(pool);
      expect(await installedOpeningBalanceLockVersion(pool)).toBe(OPENING_BALANCE_LOCK_VERSION);
      expect(await ensureLedgerIntegrityGuard(pool)).toBe(true);
      await ensureVoucherBalanceGuard(pool);
      expect(await installedVoucherBalanceGuardVersion(pool)).toBe(VOUCHER_BALANCE_GUARD_VERSION);
      // A missing registry account is created in the closed company (no voucher line, no opening).
      await withFixtureTransaction(async (client) => {
        await client.query(`SET LOCAL app.ledger_integrity_bypass = 'on'`);
        await client.query(`DELETE FROM ledger_accounts WHERE company_id = $1 AND code = 'RETAINED_EARNINGS'`, [
          ctx.companyId,
        ]);
      });
      await expect(ensureRequiredSystemAccountsForAllCompanies()).resolves.toBeUndefined();
      const { rows } = await pool.query(
        `SELECT id FROM ledger_accounts WHERE company_id = $1 AND code = 'RETAINED_EARNINGS' AND deleted_at IS NULL`,
        [ctx.companyId]
      );
      expect(rows).toHaveLength(1);
      const diagnostic = await runAccountingIntegrityDiagnostic(ctx.companyId);
      const guards = diagnostic.checks.find((check) => check.key === "database_guards_installed");
      expect(guards?.samples ?? []).toEqual([]);
    } finally {
      await reopenBooks();
    }
  });

  it("the historical sales cost apply runs in the run's tenant scope and refuses a closed-period sale", async () => {
    const sale = await journal(closureDate, "4.00", "Sales");
    const run = (
      await pool.query(
        `INSERT INTO historical_sales_cost_repair_runs (algorithm_version, status, source_cutoff_at, requested_company_ids, created_by)
         VALUES ('test', 'ready', NOW(), ARRAY[$1]::int[], $2) RETURNING id`,
        [ctx.companyId, USERNAME]
      )
    ).rows[0].id as number;
    repairRunIds.push(run);
    await pool.query(
      `INSERT INTO historical_sales_cost_repair_rows (run_id, company_id, location_id, stock_item_id, voucher_id,
         sales_item_id, occurred_at, evidence, source_type, source_id, original_cost_price, original_total_cost,
         original_profit, proposed_cost_price, proposed_total_cost, proposed_profit, status)
       VALUES ($1, $2, $3, $4, $5, -1, $6::date, '{}'::jsonb, 'sale', 'x', 1, 1, 1, 2, 2, 0, 'ready')`,
      [run, ctx.companyId, ctx.locationId, ctx.stockItemIds[0], sale, closureDate]
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await disableMaintenanceScope(client);
      await enableRunCompanyScope(client, [ctx.companyId]);
      const scope = await client.query(
        `SELECT current_setting('app.company_scope_maintenance', true) AS m, current_setting('app.current_company_id', true) AS c`
      );
      expect(scope.rows[0]).toEqual({ m: "off", c: String(ctx.companyId) });
      await assertSalesCostTargetsInOpenPeriods(client, { kind: "run", runId: run });
      await closeBooks();
      await expect(assertSalesCostTargetsInOpenPeriods(client, { kind: "run", runId: run })).rejects.toThrow(
        /HSCR_PERIOD_CLOSED:1/
      );
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      await reopenBooks();
    }
  });
});

describe("DI4: the opening lock covers deleting a master after a close", () => {
  it("refuses a hard or soft delete of a master with an opening; an empty one goes", async () => {
    const customer = async (code: string, opening: string) =>
      (
        await pool.query(
          `INSERT INTO customers (company_id, code, legal_name, opening_balance, opening_balance_side)
           VALUES ($1, $2::varchar, $2::text, $3, 'Dr') RETURNING id`,
          [ctx.companyId, `${PREFIX}${code}`, opening]
        )
      ).rows[0].id as number;
    const withOpening = await customer("C1", "25.00");
    const empty = await customer("C2", "0");
    await closeBooks();
    try {
      await expect(pool.query(`DELETE FROM customers WHERE id = $1`, [withOpening])).rejects.toThrow(
        /ACCOUNTING_PERIOD_CLOSED/
      );
      await expect(pool.query(`UPDATE customers SET deleted_at = NOW() WHERE id = $1`, [withOpening])).rejects.toThrow(
        /ACCOUNTING_PERIOD_CLOSED/
      );
      await expect(pool.query(`DELETE FROM customers WHERE id = $1`, [empty])).resolves.toBeDefined();
    } finally {
      await reopenBooks();
    }
    await expect(
      pool.query(`UPDATE customers SET deleted_at = NOW() WHERE id = $1`, [withOpening])
    ).resolves.toBeDefined();
  });
});

describe("D5 (listed), D1: voucher shape", () => {
  const insert = (type: string, total: string, lines: Array<[number, string, string]>, currency?: string) =>
    withFixtureTransaction(async (client) => {
      const id = (
        await client.query(
          `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [ctx.companyId, nextNumber(), type, today, total, currency ?? "USD"]
        )
      ).rows[0].id as number;
      for (const [account, debit, credit] of lines) {
        await client.query(
          `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, $3, $4)`,
          [id, account, debit, credit]
        );
      }
      return id;
    });

  it("lists (not refuses) new vouchers with no line or a header total that is not the line total", async () => {
    const empty = await insert("Journal", "0", []);
    const mismatch = await insert("Journal", "99.00", [
      [ctx.cashAccountId, "10.00", "0"],
      [ctx.salesAccountId, "0", "10.00"],
    ]);
    const good = await insert("Journal", "10.00", [
      [ctx.cashAccountId, "10.00", "0"],
      [ctx.salesAccountId, "0", "10.00"],
    ]);
    // Exempt: stock transfers (no GL line by design) and a credit note's refund header.
    const transfer = await insert("Stock Transfer", "120.00", []);
    const note = await insert("Credit Note", "80.00", [
      [ctx.cashAccountId, "112.09", "0"],
      [ctx.salesAccountId, "0", "112.09"],
    ]);
    const diagnostic = await runAccountingIntegrityDiagnostic(ctx.companyId);
    const shape = diagnostic.checks.find((entry) => entry.key === "voucher_shape_new");
    const listed = new Map((shape?.samples ?? []).map((row) => [Number(row.id), row.reason]));
    expect(listed.get(empty)).toBe("too_few_lines");
    expect(listed.get(mismatch)).toBe("total_mismatch");
    for (const id of [good, transfer, note]) expect(listed.has(id)).toBe(false);
    expect(shape?.status).toBe("warn");
    await withFixtureTransaction(async (client) => {
      await client.query(`DELETE FROM voucher_entries WHERE voucher_id = ANY($1::int[])`, [[empty, mismatch]]);
      await client.query(`DELETE FROM vouchers WHERE id = ANY($1::int[])`, [[empty, mismatch]]);
    });
  });

  it("a history voucher must balance after a line edit; a narration edit stays free", async () => {
    const history = await withFixtureTransaction(async (client) => {
      await client.query(`SET LOCAL session_replication_role = replica`);
      const id = (
        await client.query(
          `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
           VALUES ($1, $2, 'Journal', $3, 0) RETURNING id`,
          [ctx.companyId, nextNumber(), today]
        )
      ).rows[0].id as number;
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, company_id)
         VALUES ($1, $2, 30, 0, $4), ($1, $3, 0, 30, $4)`,
        [id, ctx.cashAccountId, ctx.salesAccountId, ctx.companyId]
      );
      await client.query(`UPDATE vouchers SET balance_guard_exempt_history = true WHERE id = $1`, [id]);
      return id;
    });
    await expect(
      withFixtureTransaction((client) =>
        client.query(`UPDATE voucher_entries SET debit_amount = 25 WHERE voucher_id = $1 AND debit_amount > 0`, [
          history,
        ])
      )
    ).rejects.toThrow(/does not balance/);
    await expect(
      withFixtureTransaction(async (client) => {
        await client.query(`UPDATE voucher_entries SET debit_amount = 25 WHERE voucher_id = $1 AND debit_amount > 0`, [
          history,
        ]);
        await client.query(
          `UPDATE voucher_entries SET credit_amount = 25 WHERE voucher_id = $1 AND credit_amount > 0`,
          [history]
        );
      })
    ).resolves.toBeUndefined();
    await expect(
      pool.query(`UPDATE voucher_entries SET narration = 'edited' WHERE voucher_id = $1`, [history])
    ).resolves.toBeDefined();
  });
});

describe("C5: the account tree", () => {
  it("has the parent foreign key and refuses self, other-company, deleted, cross-class parents and cycles", async () => {
    const fk = await pool.query(`SELECT convalidated FROM pg_constraint WHERE conname = $1`, [
      LEDGER_ACCOUNT_PARENT_FK,
    ]);
    expect(fk.rows).toHaveLength(1);
    const assets = await ledger("ASSETS", "Asset");
    const child = await ledger("CASH2", "Asset", { parentId: assets });
    const grandchild = await ledger("PETTY", "Bank", { parentId: child });
    const expense = await ledger("EXP", "Expense");
    const foreign = await ledger("FOREIGN", "Asset", { companyId: otherCompanyId });
    const deleted = await ledger("DELETED", "Asset");
    await pool.query(`UPDATE ledger_accounts SET deleted_at = NOW() WHERE id = $1`, [deleted]);

    const setParent = (id: number, parentId: number) =>
      pool.query(`UPDATE ledger_accounts SET parent_id = $2 WHERE id = $1`, [id, parentId]);
    await expect(setParent(assets, assets)).rejects.toThrow(/LEDGER_ACCOUNT_PARENT_INVALID.*own parent/);
    await expect(setParent(assets, grandchild)).rejects.toThrow(/LEDGER_ACCOUNT_PARENT_INVALID.*sub-accounts/);
    await expect(setParent(child, foreign)).rejects.toThrow(/LEDGER_ACCOUNT_PARENT_INVALID.*this company/);
    await expect(setParent(child, deleted)).rejects.toThrow(/LEDGER_ACCOUNT_PARENT_INVALID.*deleted/);
    await expect(setParent(child, expense)).rejects.toThrow(/LEDGER_ACCOUNT_PARENT_INVALID.*asset/);
    // Retyping a child to another class under its parent, or deleting a parent with live children.
    await expect(
      pool.query(`UPDATE ledger_accounts SET account_type = 'Expense' WHERE id = $1`, [child])
    ).rejects.toThrow(/LEDGER_ACCOUNT_PARENT_INVALID/);
    await expect(pool.query(`UPDATE ledger_accounts SET deleted_at = NOW() WHERE id = $1`, [assets])).rejects.toThrow(
      /sub-accounts: move them first/
    );
  });

  it("leaves existing bad links alone (boot reinstalls the guard) and lists them in the diagnostic", async () => {
    const income = await ledger("INC", "Income");
    const bad = await ledger("BADCHILD", "Asset");
    await withFixtureTransaction(async (client) => {
      await client.query(`SET LOCAL app.ledger_integrity_bypass = 'on'`);
      await client.query(`UPDATE ledger_accounts SET parent_id = $2 WHERE id = $1`, [bad, income]);
    });
    await pool.query(`COMMENT ON FUNCTION erp_voucher_entry_target_guard() IS 'reinstall'`);
    expect(await ensureLedgerIntegrityGuard(pool)).toBe(true);
    const version = await pool.query(
      `SELECT obj_description(to_regprocedure('erp_voucher_entry_target_guard()'), 'pg_proc') AS v`
    );
    expect(version.rows[0].v).toBe(LEDGER_INTEGRITY_GUARD_VERSION);
    // An unrelated edit of the bad row still works (only changed links are checked).
    await expect(
      pool.query(`UPDATE ledger_accounts SET name = name || ' ' WHERE id = $1`, [bad])
    ).resolves.toBeDefined();
    const diagnostic = await runAccountingIntegrityDiagnostic(ctx.companyId);
    const check = diagnostic.checks.find((entry) => entry.key === "ledger_account_parent_invalid");
    expect(check?.status).toBe("warn");
    expect(check?.samples).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: bad, reason: "parent_other_class" })])
    );
  });

  it("bulk-assign-parent is Admin/Owner, one transaction, audited, and refused whole on a bad link", async () => {
    const parent = await ledger("BULKP", "Expense");
    const a = await ledger("BULKA", "Expense");
    const b = await ledger("BULKB", "Expense");
    const wrong = await ledger("BULKW", "Income");
    await setRole("Manager");
    expect(
      (await agent.patch("/api/ledger-accounts/bulk-assign-parent").send({ accountIds: [a], parentId: parent })).status
    ).toBe(403);
    await setRole("Owner");
    const refused = await agent
      .patch("/api/ledger-accounts/bulk-assign-parent")
      .send({ accountIds: [a, wrong], parentId: parent });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("LEDGER_ACCOUNT_PARENT_INVALID");
    const after = await pool.query(`SELECT parent_id FROM ledger_accounts WHERE id = $1`, [a]);
    expect(after.rows[0].parent_id).toBeNull();
    const ok = await agent
      .patch("/api/ledger-accounts/bulk-assign-parent")
      .send({ accountIds: [a, b], parentId: parent });
    expect(ok.status).toBe(200);
    expect(ok.body.map((row: { parentId: number }) => row.parentId)).toEqual([parent, parent]);
    const audit = await auditRows("ledger_accounts", a);
    expect(audit.at(-1)?.changes.parentId).toEqual({ old: null, new: parent });
  });
});

describe("C6: reserved codes and system accounts", () => {
  it("refuses a reserved code on create, a rename and a delete of a system account; delete is Admin/Owner", async () => {
    await db.transaction((tx) => ensureSystemAccounts(tx, ctx.companyId, ["RETAINED_EARNINGS"]));
    const created = await agent.post("/api/ledger-accounts").send({
      companyId: ctx.companyId,
      code: "RETAINED_EARNINGS",
      name: `${PREFIX} fake RE`,
      accountType: "Equity",
    });
    expect(created.body).toMatchObject({ code: "SYSTEM_ACCOUNT_CODE_RESERVED" });
    expect(created.status).toBe(409);
    expect(created.body.code).toBe("SYSTEM_ACCOUNT_CODE_RESERVED");
    const { rows } = await pool.query(
      `SELECT id, name FROM ledger_accounts WHERE company_id = $1 AND code = 'RETAINED_EARNINGS' AND deleted_at IS NULL`,
      [ctx.companyId]
    );
    expect(rows).toHaveLength(1);
    const renamed = await agent.put(`/api/ledger-accounts/${rows[0].id}`).send({ name: `${PREFIX} renamed` });
    expect(renamed.body).toMatchObject({ code: "SYSTEM_ACCOUNT_RENAME_REFUSED" });
    expect(renamed.status).toBe(409);
    expect(renamed.body.code).toBe("SYSTEM_ACCOUNT_RENAME_REFUSED");
    // The global delete policy (canDelete) keeps account deletes to Admins.
    await setRole("Admin");
    const deleted = await agent.delete(`/api/ledger-accounts/${rows[0].id}`);
    expect(deleted.body).toMatchObject({ code: "SYSTEM_ACCOUNT_DELETE_REFUSED" });
    expect(deleted.status).toBe(409);
    expect(deleted.body.code).toBe("SYSTEM_ACCOUNT_DELETE_REFUSED");

    const plain = await ledger("PLAIN", "Expense");
    await setRole("Manager");
    expect((await agent.delete(`/api/ledger-accounts/${plain}`)).status).toBe(403);
    await setRole("Admin");
    expect((await agent.delete(`/api/ledger-accounts/${plain}`)).status).toBe(200);
    await setRole("Owner");
  });
});

describe("PE7: fixed-asset delete", () => {
  const asset = async (code: string, opening = "0") =>
    (
      await pool.query(
        `INSERT INTO fixed_assets (company_id, code, name, category, purchase_date, purchase_amount, opening_balance)
         VALUES ($1, $2::varchar, $2::text, 'Equipment', '2026-01-01', 100, $3) RETURNING id`,
        [ctx.companyId, `${PREFIX}-${code}-${Date.now()}`, opening]
      )
    ).rows[0].id as number;

  it("is Admin/Owner, refused with an opening or lines, else a soft delete audited in the transaction", async () => {
    const empty = await asset("FA1");
    const withOpening = await asset("FA2", "50.00");
    const withLines = await asset("FA3");
    await withFixtureTransaction(async (client) => {
      const id = (
        await client.query(
          `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
           VALUES ($1, $2, 'Journal', $3, 7) RETURNING id`,
          [ctx.companyId, nextNumber(), today]
        )
      ).rows[0].id as number;
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, fixed_asset_id, debit_amount, credit_amount) VALUES ($1, $2, 7, 0)`,
        [id, withLines]
      );
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, 0, 7)`,
        [id, ctx.cashAccountId]
      );
    });
    await setRole("Manager");
    expect((await agent.delete(`/api/fixed-assets/${empty}`)).status).toBe(403);
    await setRole("Owner");
    const opening = await agent.delete(`/api/fixed-assets/${withOpening}`);
    expect(opening.status).toBe(409);
    expect(opening.body.code).toBe("FIXED_ASSET_HAS_OPENING");
    const lines = await agent.delete(`/api/fixed-assets/${withLines}`);
    expect(lines.status).toBe(409);
    expect(lines.body.code).toBe("FIXED_ASSET_HAS_ENTRIES");
    expect((await agent.delete(`/api/fixed-assets/${empty}`)).status).toBe(200);
    const row = await pool.query(`SELECT deleted_at, active FROM fixed_assets WHERE id = $1`, [empty]);
    expect(row.rows[0].deleted_at).not.toBeNull();
    expect(row.rows[0].active).toBe(false);
    expect((await auditRows("fixed_assets", empty)).map((entry) => entry.action)).toEqual(["delete"]);
    const list = await agent.get("/api/fixed-assets");
    expect(list.body.map((entry: { id: number }) => entry.id)).not.toContain(empty);
    expect((await agent.delete(`/api/fixed-assets/${empty}`)).status).toBe(404);
  });
});

describe("PE6: factory supplier permanent delete", () => {
  const supplier = async (name: string) =>
    (
      await pool.query(
        `INSERT INTO factory_suppliers (company_id, name, is_active) VALUES ($1, $2, true) RETURNING id`,
        [ctx.companyId, `${PREFIX} ${name}`]
      )
    ).rows[0].id as number;

  // Factory routes need a factory company: the seed company is one for this test.
  beforeAll(async () => {
    await pool.query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [ctx.companyId]);
  });
  afterAll(async () => {
    await pool.query(`UPDATE companies SET company_type = 'erp' WHERE id = $1`, [ctx.companyId]);
  });

  it("is Admin/Owner, refused with history (nothing removed), else one transaction with its audit", async () => {
    const empty = await supplier("empty");
    const withLines = await supplier("lines");
    await withFixtureTransaction(async (client) => {
      const id = (
        await client.query(
          `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
           VALUES ($1, $2, 'Journal', $3, 9) RETURNING id`,
          [ctx.companyId, nextNumber(), today]
        )
      ).rows[0].id as number;
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, factory_supplier_id, debit_amount, credit_amount) VALUES ($1, $2, 9, 0)`,
        [id, withLines]
      );
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, 0, 9)`,
        [id, ctx.cashAccountId]
      );
    });
    await setRole("Manager");
    expect((await agent.delete(`/api/factory/suppliers/${empty}/permanent`)).status).toBe(403);
    await setRole("Owner");
    const refused = await agent.delete(`/api/factory/suppliers/${withLines}/permanent`);
    expect(refused.body).toMatchObject({ code: "FACTORY_SUPPLIER_HAS_HISTORY" });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "FACTORY_SUPPLIER_HAS_HISTORY", history: { voucherLines: 1 } });
    expect((await pool.query(`SELECT 1 FROM factory_suppliers WHERE id = $1`, [withLines])).rows).toHaveLength(1);
    expect((await agent.delete(`/api/factory/suppliers/${empty}/permanent`)).status).toBe(200);
    expect((await pool.query(`SELECT 1 FROM factory_suppliers WHERE id = $1`, [empty])).rows).toHaveLength(0);
    const audit = await auditRows("factory_suppliers", empty);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "delete", username: USERNAME });
  });
});

describe("PE2: rental reads, roles, business date, actor and rate", () => {
  let contractId: number;
  let unitId: number;
  const firstOfMonth = (monthsBack: number) => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - monthsBack);
    return d.toISOString().slice(0, 10);
  };

  beforeAll(async () => {
    const unit = await pool.query<{ id: number }>(
      `INSERT INTO property_units (company_id, module, unit_type, unit_number, location_group, active)
       VALUES ($1, 'ERP', 'SHOP', 'P19B-S1', 'P19B', true) RETURNING id`,
      [ctx.companyId]
    );
    unitId = unit.rows[0].id;
    const contract = await pool.query<{ id: number }>(
      `INSERT INTO property_contracts (company_id, module, unit_id, tenant_name, rental_amount, start_date, status, currency)
       VALUES ($1, 'ERP', $2, 'P19B Landlord', '300.00', $3, 'ACTIVE', 'USD') RETURNING id`,
      [ctx.companyId, unitId, firstOfMonth(2)]
    );
    contractId = contract.rows[0].id;
    unitIds.push(unitId);
    contractIds.push(contractId);
  });

  const monthlyRows = async () =>
    (await pool.query(`SELECT count(*)::int AS n FROM property_monthly_ledger WHERE contract_id = $1`, [contractId]))
      .rows[0].n as number;

  it("GET detail and the statement export write no monthly row (missing months computed in memory)", async () => {
    const detail = await agent.get(`/api/erp/rental/units/${unitId}/detail`);
    expect(detail.status).toBe(200);
    expect(detail.body.ledger.length).toBeGreaterThan(0);
    expect(detail.body.ledger.every((row: { virtual?: boolean }) => row.virtual === true)).toBe(true);
    expect(await monthlyRows()).toBe(0);
    const exported = await agent.get(`/api/erp/rental/units/${unitId}/statement/export`);
    expect(exported.status).toBe(200);
    expect(await monthlyRows()).toBe(0);
  });

  it("accrue, post-scheduled and run-monthly are Admin/Owner", async () => {
    await setRole("Manager");
    try {
      for (const path of ["accrue", "payments/post-scheduled", "run-monthly"]) {
        expect((await agent.post(`/api/erp/rental/${path}`)).status).toBe(403);
      }
    } finally {
      await setRole("Owner");
    }
    expect(await monthlyRows()).toBe(0);
  });

  it("accrue posts on the company's business date, audited with the signed-in user; a closed date is refused", async () => {
    const accrued = await agent.post("/api/erp/rental/accrue").set("X-Client-Date", "2020-01-01");
    expect(accrued.status).toBe(200);
    expect(accrued.body.asOf).toBe(today);
    expect(accrued.body.accrued).toBeGreaterThan(0);
    const { rows: accruals } = await pool.query(
      `SELECT id, voucher_date::text AS voucher_date FROM vouchers
        WHERE company_id = $1 AND voucher_number LIKE 'ACCR-RENT-%' AND deleted_at IS NULL`,
      [ctx.companyId]
    );
    expect(accruals.length).toBeGreaterThan(0);
    for (const voucher of accruals) expect(voucher.voucher_date).toBe(today);
    const audit = await auditRows("vouchers", accruals[0].id);
    expect(audit[0]).toMatchObject({ username: USERNAME });
    expect(audit[0].changes.trigger.new).toBe("route");

    const savedClosure = closureDate;
    closureDate = today;
    try {
      await closeBooks();
      const closed = await agent.post("/api/erp/rental/accrue");
      expect(closed.status).toBe(409);
      expect(closed.body.code).toBe("PERIOD_CLOSED");
    } finally {
      await reopenBooks();
      closureDate = savedClosure;
    }
  });

  it("posts a scheduled payment as of the business date with the real actor", async () => {
    const [year, month] = today.split("-").map(Number);
    await pool.query(
      `INSERT INTO property_payments (company_id, module, contract_id, unit_id, amount, payment_date, for_year, for_month,
         posting_status, payment_group_id, cash_account_id, currency, exchange_rate)
       VALUES ($1, 'ERP', $2, $3, '300.00', $4, $5, $6, 'SCHEDULED', 'PG-P19B-1', $7, 'USD', '1')`,
      [ctx.companyId, contractId, unitId, today, year, month, ctx.cashAccountId]
    );
    const res = await agent.post("/api/erp/rental/payments/post-scheduled").set("X-Client-Date", "2020-01-01");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ posted: 1, failed: 0, asOf: today });
    const { rows } = await pool.query(
      `SELECT username, changes FROM audit_log WHERE company_id = $1 AND record_identifier = 'rental-scheduled-payment:PG-P19B-1'`,
      [ctx.companyId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].username).toBe(USERNAME);
  });

  it("a non-USD payment posts at the recorded dated rate, never the client's, and is refused without one", async () => {
    const payment = (body: Record<string, unknown>) =>
      agent.post("/api/erp/rental/payments").send({
        contractId,
        cashAccountId: ctx.cashAccountId,
        amount: "6000",
        paymentDate: today,
        currency: "XOF",
        ...body,
      });
    const refused = await payment({ exchangeRate: "1" });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "RENTAL_RATE_REQUIRED", currency: "XOF", date: today });
    expect(
      (await pool.query(`SELECT 1 FROM property_payments WHERE contract_id = $1 AND currency = 'XOF'`, [contractId]))
        .rows
    ).toHaveLength(0);

    await pool.query(
      `INSERT INTO exchange_rates (company_id, from_currency, to_currency, rate, effective_date)
       VALUES ($1, 'USD', 'XOF', 600, $2)`,
      [ctx.companyId, addDays(today, -3)]
    );
    const posted = await payment({ exchangeRate: "1" });
    expect(posted.status).toBe(200);
    const { rows } = await pool.query(
      `SELECT exchange_rate::text AS rate, voucher_id FROM property_payments WHERE contract_id = $1 AND currency = 'XOF'`,
      [contractId]
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(Number(rows[0].rate)).toBe(600);
    const lines = await pool.query(
      `SELECT SUM(debit_amount)::numeric(20,2)::text AS base FROM voucher_entries WHERE voucher_id = $1`,
      [rows[0].voucher_id]
    );
    expect(lines.rows[0].base).toBe("10.00");
  });
});
