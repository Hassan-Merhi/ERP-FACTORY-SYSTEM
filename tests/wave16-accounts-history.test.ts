/**
 * Wave 16 (B) — accounts with history, audit inside the transaction, one line
 * target (docs/accounting-audit-2026-10.md, wave log).
 *
 *   - Account rules: an account with posted lines changes its opening only by
 *     an Admin or Owner (audited in the transaction), never changes type
 *     category, never moves company (ledger accounts, banks, factory suppliers).
 *   - Factory suppliers and fixed assets are under the opening-balance lock.
 *   - transfer-account is Admin/Owner, one transaction, audited in it.
 *   - Central voucher handlers write their audit in the posting transaction:
 *     a failed audit rolls the voucher back.
 *   - The database refuses a new line with no target or several (a ledger line
 *     with its customer tag is the one pair allowed); existing lines are exempt.
 *   - The ledger account delete guard reads a sideless opening on the engine's side.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const auditControl = vi.hoisted(() => ({ fail: false }));

vi.mock("../server/services/audit/auditService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/services/audit/auditService")>();
  return {
    ...actual,
    writeAuditEvent: async (...args: Parameters<typeof actual.writeAuditEvent>) => {
      if (auditControl.fail) throw new Error("audit store unavailable (test)");
      return actual.writeAuditEvent(...args);
    },
  };
});

import { pool } from "../server/db";
import {
  ACCOUNT_COMPANY_CHANGE_CODE,
  ACCOUNT_OPENING_CHANGE_FORBIDDEN_CODE,
  ACCOUNT_TYPE_CATEGORY_CHANGE_CODE,
  AccountHistoryError,
  assertAccountChangeAllowed,
} from "../server/services/accounting/accountHistoryPolicy";
import { ensureClosedPeriodGuard } from "../server/services/accounting/closedPeriodGuard";
import {
  ensureLedgerIntegrityGuard,
  LEDGER_INTEGRITY_GUARD_VERSION,
} from "../server/services/accounting/ledgerIntegrityGuard";
import {
  ensureOpeningBalanceLock,
  OPENING_BALANCE_LOCK_TABLES,
  OPENING_BALANCE_LOCK_VERSION,
  installedOpeningBalanceLockVersion,
  openingBalanceLockTriggerName,
} from "../server/services/accounting/openingBalanceLock";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "wave16accts";
let ctx: TestContext;
let agent: request.SuperAgentTest;
let otherCompanyId: number;
let sequence = 0;
const nextNumber = () => `${PREFIX}-${++sequence}`;

type Target = Partial<
  Record<
    | "ledger_account_id"
    | "bank_account_id"
    | "fixed_asset_id"
    | "supplier_id"
    | "employee_id"
    | "factory_supplier_id"
    | "customer_id",
    number
  >
>;

/** A balanced two-line journal: `target` debited, the seed cash account credited. */
async function postAgainst(target: Target, amount = "10.00", date = "2026-10-02"): Promise<number> {
  return withFixtureTransaction(async (client) => {
    const id = (
      await client.query(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, optional)
         VALUES ($1, $2, 'Journal', $3, $4, false) RETURNING id`,
        [ctx.companyId, nextNumber(), date, amount]
      )
    ).rows[0].id as number;
    const columns = Object.keys(target);
    await client.query(
      `INSERT INTO voucher_entries (voucher_id, ${columns.join(", ")}, debit_amount, credit_amount)
       VALUES ($1, ${columns.map((_, index) => `$${index + 2}`).join(", ")}, $${columns.length + 2}, 0)`,
      [id, ...Object.values(target), amount]
    );
    await client.query(
      `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, 0, $3)`,
      [id, ctx.cashAccountId, amount]
    );
    return id;
  });
}

async function ledgerAccount(code: string, accountType: string, opening = "0", side: string | null = "Dr") {
  return (
    await pool.query(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
       VALUES ($1, $2::varchar, $2::text, $3, $4, $5) RETURNING id`,
      [ctx.companyId, `${PREFIX}_${code}`, accountType, opening, side]
    )
  ).rows[0].id as number;
}

async function setRole(role: string) {
  await pool.query(`UPDATE user_company_roles SET role = $1 WHERE user_id = $2 AND company_id = $3`, [
    role,
    ctx.userId,
    ctx.companyId,
  ]);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
}

async function auditRows(tableName: string, recordId: number) {
  return (
    await pool.query(
      `SELECT action, changes FROM audit_log WHERE company_id = $1 AND table_name = $2 AND record_id = $3 ORDER BY id`,
      [ctx.companyId, tableName, recordId]
    )
  ).rows as Array<{ action: string; changes: Record<string, { old?: unknown; new?: unknown }> }>;
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  // Factory supplier routes need a factory company.
  await pool.query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [ctx.companyId]);
  expect(await ensureLedgerIntegrityGuard(pool)).toBe(true);
  await ensureClosedPeriodGuard(pool);
  expect(await ensureOpeningBalanceLock(pool)).toBe(true);
  otherCompanyId = (
    await pool.query(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
      `W16B${Date.now().toString(36).slice(-5).toUpperCase()}`,
    ])
  ).rows[0].id;
  agent = request.agent(ctx.app);
  expect(
    (await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" })).status
  ).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
}, 120000);

afterAll(async () => {
  auditControl.fail = false;
  // The rest of the suite writes masters freely: remove the opening lock this file installed.
  for (const table of OPENING_BALANCE_LOCK_TABLES) {
    await pool.query(`DROP TRIGGER IF EXISTS ${openingBalanceLockTriggerName(table)} ON ${table}`);
  }
  await withFixtureTransaction(async (client) => {
    await client.query(`SET LOCAL app.closed_period_override = 'on'`);
    await client.query(`SET LOCAL app.ledger_integrity_bypass = 'on'`);
    await client.query(`DELETE FROM fiscal_period_closures WHERE company_id = $1`, [ctx.companyId]);
    await client.query(
      `DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`,
      [ctx.companyId]
    );
    await client.query(`DELETE FROM vouchers WHERE company_id = $1 AND voucher_number LIKE $2`, [
      ctx.companyId,
      `${PREFIX}%`,
    ]);
    await client.query(`DELETE FROM bank_accounts WHERE company_id = ANY($1::int[])`, [
      [ctx.companyId, otherCompanyId],
    ]);
    await client.query(`DELETE FROM fixed_assets WHERE company_id = $1`, [ctx.companyId]);
    await client.query(`DELETE FROM factory_suppliers WHERE company_id = $1`, [ctx.companyId]);
    await client.query(`DELETE FROM customers WHERE company_id = $1`, [ctx.companyId]);
    await client.query(`DELETE FROM suppliers WHERE company_id = $1`, [ctx.companyId]);
    await client.query(`DELETE FROM employees WHERE company_id = $1`, [ctx.companyId]);
  });
  await deleteAuditLogRowsForTests(pool, "company_id = ANY($1::int[])", [[ctx.companyId, otherCompanyId]]);
  await withFixtureTransaction(async (client) => {
    await client.query(`SET LOCAL session_replication_role = replica`);
    await client.query(`DELETE FROM companies WHERE id = $1`, [otherCompanyId]);
  });
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 120000);

describe("account change rules (policy)", () => {
  const lines = (live: number, any = live) => ({ live, any });
  const code = (run: () => unknown) => {
    try {
      run();
      return null;
    } catch (error) {
      return error instanceof AccountHistoryError ? error.code : String(error);
    }
  };
  const opening = (before: string, after: string, side = "Dr") => ({
    before: { amount: before, side },
    after: { amount: after, side },
    defaultSide: "Dr" as const,
  });

  it("restricts opening changes on accounts with lines to Admin, Owner and Developer", () => {
    expect(
      code(() => assertAccountChangeAllowed({ role: "Manager", lines: lines(1), opening: opening("1", "2") }))
    ).toBe(ACCOUNT_OPENING_CHANGE_FORBIDDEN_CODE);
    for (const role of ["Admin", "Owner", "Developer"]) {
      expect(code(() => assertAccountChangeAllowed({ role, lines: lines(1), opening: opening("1", "2") }))).toBeNull();
    }
    // No lines: anyone who may edit the account; an unchanged opening (100 vs 100.00) is no change.
    expect(
      code(() => assertAccountChangeAllowed({ role: "POS", lines: lines(0), opening: opening("1", "2") }))
    ).toBeNull();
    expect(
      code(() => assertAccountChangeAllowed({ role: "POS", lines: lines(3), opening: opening("100", "100.00") }))
    ).toBeNull();
    // The side counts once the amount is not zero; a missing side reads as the default.
    expect(
      code(() =>
        assertAccountChangeAllowed({
          role: "Manager",
          lines: lines(1),
          opening: { before: { amount: "5", side: null }, after: { amount: "5", side: "Cr" }, defaultSide: "Dr" },
        })
      )
    ).toBe(ACCOUNT_OPENING_CHANGE_FORBIDDEN_CODE);
  });

  it("refuses a type change across category once a live line exists, allows a same-category change", () => {
    const type = (before: string, after: string) => ({
      before: { accountType: before, subType: null },
      after: { accountType: after, subType: null },
    });
    expect(
      code(() => assertAccountChangeAllowed({ role: "Admin", lines: lines(1), type: type("Expense", "Asset") }))
    ).toBe(ACCOUNT_TYPE_CATEGORY_CHANGE_CODE);
    expect(
      code(() => assertAccountChangeAllowed({ role: "Admin", lines: lines(1), type: type("Income", "Liability") }))
    ).toBe(ACCOUNT_TYPE_CATEGORY_CHANGE_CODE);
    expect(
      code(() =>
        assertAccountChangeAllowed({ role: "Admin", lines: lines(1), type: type("Expense", "Direct Expense") })
      )
    ).toBeNull();
    // Only deleted-voucher lines: not live history for the type rule.
    expect(
      code(() => assertAccountChangeAllowed({ role: "Admin", lines: lines(0, 2), type: type("Expense", "Asset") }))
    ).toBeNull();
  });

  it("refuses a company change once any line exists", () => {
    expect(
      code(() => assertAccountChangeAllowed({ role: "Admin", lines: lines(0, 1), company: { before: 1, after: 2 } }))
    ).toBe(ACCOUNT_COMPANY_CHANGE_CODE);
    expect(
      code(() => assertAccountChangeAllowed({ role: "Admin", lines: lines(0, 0), company: { before: 1, after: 2 } }))
    ).toBeNull();
  });
});

describe("ledger account edits", () => {
  let expenseId: number;

  beforeAll(async () => {
    expenseId = await ledgerAccount("EXP", "Expense", "50.00", "Dr");
    await postAgainst({ ledger_account_id: expenseId });
  });

  it("refuses an opening change by a Manager, accepts and audits it for an Admin", async () => {
    await setRole("Manager");
    const refused = await agent
      .put(`/api/ledger-accounts/${expenseId}`)
      .send({ openingBalance: "60.00", openingBalanceSide: "Dr" });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe(ACCOUNT_OPENING_CHANGE_FORBIDDEN_CODE);
    await setRole("Admin");
    const accepted = await agent.put(`/api/ledger-accounts/${expenseId}`).send({
      openingBalance: "60.00",
      openingBalanceSide: "Dr",
    });
    expect(accepted.status).toBe(200);
    const audit = (await auditRows("ledger_accounts", expenseId)).at(-1);
    expect(audit?.changes.openingBalance).toEqual({ old: "50.00", new: "60.00" });
  });

  it("refuses Expense to Asset, allows Expense to Direct Expense with an audit row", async () => {
    const refused = await agent.put(`/api/ledger-accounts/${expenseId}`).send({ accountType: "Asset" });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe(ACCOUNT_TYPE_CATEGORY_CHANGE_CODE);
    const accepted = await agent.put(`/api/ledger-accounts/${expenseId}`).send({ accountType: "Direct Expense" });
    expect(accepted.status).toBe(200);
    const audit = (await auditRows("ledger_accounts", expenseId)).at(-1);
    expect(audit?.changes.accountType).toEqual({ old: "Expense", new: "Direct Expense" });
  });

  it("refuses a move to another company", async () => {
    // The admin company-scope guard refuses a body companyId other than the
    // active company first (403); the history rule (409, policy tests above)
    // stands behind it for any writer that passes one.
    const refused = await agent.put(`/api/ledger-accounts/${expenseId}`).send({ companyId: otherCompanyId });
    expect([403, 409]).toContain(refused.status);
    const row = (await pool.query(`SELECT company_id FROM ledger_accounts WHERE id = $1`, [expenseId])).rows[0];
    expect(row.company_id).toBe(ctx.companyId);
  });
});

describe("bank account edits", () => {
  let bankId: number;

  beforeAll(async () => {
    bankId = (
      await pool.query(
        `INSERT INTO bank_accounts (company_id, code, name, account_number, bank_name, opening_balance, opening_balance_side)
         VALUES ($1, $2::varchar, $2::text, '1', 'Bank', 100, 'Dr') RETURNING id`,
        [ctx.companyId, `${PREFIX}_BANK`]
      )
    ).rows[0].id;
    await postAgainst({ bank_account_id: bankId });
  });

  it("lets only Admin/Owner change the opening of a bank with lines, audited; never moves company", async () => {
    await setRole("Manager");
    const refused = await agent
      .put(`/api/bank-accounts/${bankId}`)
      .send({ openingBalance: "150", openingBalanceSide: "Dr" });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe(ACCOUNT_OPENING_CHANGE_FORBIDDEN_CODE);
    // Other fields stay editable for the same user.
    expect((await agent.put(`/api/bank-accounts/${bankId}`).send({ name: `${PREFIX} Bank renamed` })).status).toBe(200);

    await setRole("Owner");
    expect(
      (await agent.put(`/api/bank-accounts/${bankId}`).send({ openingBalance: "150", openingBalanceSide: "Dr" })).status
    ).toBe(200);
    const audit = (await auditRows("bank_accounts", bankId)).at(-1);
    expect(audit?.changes.openingBalance).toEqual({ old: "100.00", new: "150.00" });

    const moved = await agent.put(`/api/bank-accounts/${bankId}`).send({ companyId: otherCompanyId });
    expect([403, 409]).toContain(moved.status);
    expect((await pool.query(`SELECT company_id FROM bank_accounts WHERE id = $1`, [bankId])).rows[0].company_id).toBe(
      ctx.companyId
    );
    await setRole("Admin");
  });
});

describe("factory suppliers", () => {
  let supplierId: number;

  beforeAll(async () => {
    const created = await agent
      .post("/api/factory/suppliers")
      .send({ name: `${PREFIX} Supplier`, openingBalance: "25" });
    expect(created.status).toBe(200);
    supplierId = created.body.id;
    expect((await auditRows("factory_suppliers", supplierId)).map((row) => row.action)).toEqual(["create"]);
    await postAgainst({ factory_supplier_id: supplierId });
  });

  it("writes only the supplier's editable fields, under the history rules, audited", async () => {
    // A column outside the edit schema is not written (the raw body used to be).
    const edit = await agent
      .patch(`/api/factory/suppliers/${supplierId}`)
      .send({ phone: "123", currentRawMaterialCostPerKgUsd: "9.99" });
    expect(edit.status).toBe(200);
    const row = (
      await pool.query(`SELECT phone, current_raw_material_cost_per_kg_usd FROM factory_suppliers WHERE id = $1`, [
        supplierId,
      ])
    ).rows[0];
    expect(row).toEqual({ phone: "123", current_raw_material_cost_per_kg_usd: null });

    await setRole("Manager");
    const refused = await agent
      .patch(`/api/factory/suppliers/${supplierId}/opening-balance`)
      .send({ openingBalance: "30" });
    expect(refused.status).toBe(403);
    await setRole("Admin");
    const accepted = await agent.patch(`/api/factory/suppliers/${supplierId}/opening-balance`).send({
      openingBalance: "30.10",
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.openingBalance).toBe("30.1000");
    const audit = (await auditRows("factory_suppliers", supplierId)).at(-1);
    expect(audit?.changes.openingBalance).toEqual({ old: "25.0000", new: "30.1000" });

    const moved = await agent.patch(`/api/factory/suppliers/${supplierId}`).send({ companyId: otherCompanyId });
    expect([403, 409]).toContain(moved.status);
    expect(
      (await pool.query(`SELECT company_id FROM factory_suppliers WHERE id = $1`, [supplierId])).rows[0].company_id
    ).toBe(ctx.companyId);
  });
});

describe("opening-balance lock v2", () => {
  it("installs on factory suppliers and fixed assets and refuses their opening changes after a close", async () => {
    expect(await installedOpeningBalanceLockVersion(pool)).toBe(OPENING_BALANCE_LOCK_VERSION);
    const supplier = (
      await pool.query(
        `INSERT INTO factory_suppliers (company_id, name, opening_balance) VALUES ($1, $2, 5) RETURNING id`,
        [ctx.companyId, `${PREFIX} locked supplier`]
      )
    ).rows[0].id;
    const asset = (
      await pool.query(
        `INSERT INTO fixed_assets (company_id, code, name, category, purchase_date, purchase_amount, opening_balance)
         VALUES ($1, $2::varchar, $2::text, 'Equipment', '2025-01-01', 10, 7) RETURNING id`,
        [ctx.companyId, `${PREFIX}_FA`]
      )
    ).rows[0].id;
    const closingVoucherId = await postAgainst({ ledger_account_id: ctx.salesAccountId }, "1.00", "2025-01-31");
    await pool.query(
      `INSERT INTO fiscal_period_closures (company_id, period_start_date, period_end_date, closed_by_user_id,
         closing_voucher_id, retained_earnings_account_id, total_income, total_expense, net_income, status)
       VALUES ($1, '2025-01-01', '2025-01-31', $2, $3, $4, 0, 0, 0, 'CLOSED')`,
      [ctx.companyId, ctx.userId, closingVoucherId, ctx.cashAccountId]
    );
    try {
      for (const [table, id] of [
        ["factory_suppliers", supplier],
        ["fixed_assets", asset],
      ] as const) {
        await expect(pool.query(`UPDATE ${table} SET opening_balance = 99 WHERE id = $1`, [id])).rejects.toThrow(
          /ACCOUNTING_PERIOD_CLOSED/
        );
        // Other fields stay editable.
        await pool.query(`UPDATE ${table} SET name = name || ' (renamed)' WHERE id = $1`, [id]);
      }
      const routeRefusal = await agent.patch(`/api/factory/suppliers/${supplier}/opening-balance`).send({
        openingBalance: "6",
      });
      expect(routeRefusal.status).toBe(409);
    } finally {
      await withFixtureTransaction(async (client) => {
        await client.query(`SET LOCAL app.closed_period_override = 'on'`);
        await client.query(`DELETE FROM fiscal_period_closures WHERE company_id = $1`, [ctx.companyId]);
      });
    }
  });
});

describe("transfer-account", () => {
  it("is Admin/Owner only and audits the move in its transaction", async () => {
    const from = await ledgerAccount("XFER-FROM", "Expense");
    const to = await ledgerAccount("XFER-TO", "Expense");
    const voucherId = await postAgainst({ ledger_account_id: from });
    const entryId = (
      await pool.query(`SELECT id FROM voucher_entries WHERE voucher_id = $1 AND ledger_account_id = $2`, [
        voucherId,
        from,
      ])
    ).rows[0].id;

    await setRole("Manager");
    expect(
      (await agent.post("/api/voucher-entries/transfer-account").send({ entryIds: [entryId], toAccountId: to })).status
    ).toBe(403);
    await setRole("Admin");

    auditControl.fail = true;
    try {
      const failed = await agent
        .post("/api/voucher-entries/transfer-account")
        .send({ entryIds: [entryId], toAccountId: to });
      expect(failed.status).toBe(500);
    } finally {
      auditControl.fail = false;
    }
    expect(
      (await pool.query(`SELECT ledger_account_id FROM voucher_entries WHERE id = $1`, [entryId])).rows[0]
    ).toEqual({
      ledger_account_id: from,
    });

    const moved = await agent
      .post("/api/voucher-entries/transfer-account")
      .send({ entryIds: [entryId], toAccountId: to });
    expect(moved.status).toBe(200);
    expect(
      (await pool.query(`SELECT ledger_account_id FROM voucher_entries WHERE id = $1`, [entryId])).rows[0]
    ).toEqual({
      ledger_account_id: to,
    });
    const audit = (await auditRows("voucher_entries", to)).at(-1);
    expect(audit?.changes.movedEntries.old).toEqual([expect.objectContaining({ entryId, ledgerAccountId: from })]);
  });
});

describe("voucher handlers audit in the transaction", () => {
  const journal = (clientRequestId?: string) => ({
    ...(clientRequestId ? { clientRequestId } : {}),
    voucher: { voucherNumber: nextNumber(), voucherType: "Journal", voucherDate: "2026-10-03" },
    entries: [
      { ledgerAccountId: ctx.cashAccountId, debitAmount: "12.00", creditAmount: "0" },
      { ledgerAccountId: ctx.salesAccountId, debitAmount: "0", creditAmount: "12.00" },
    ],
  });
  const vouchersNamed = async (number: string) =>
    Number(
      (
        await pool.query(`SELECT COUNT(*) FROM vouchers WHERE company_id = $1 AND voucher_number = $2`, [
          ctx.companyId,
          number,
        ])
      ).rows[0].count
    );

  it("rolls back the central and the legacy generic create when the audit fails", async () => {
    for (const body of [journal(`${PREFIX}-central-${Date.now()}`), journal()]) {
      auditControl.fail = true;
      try {
        const response = await agent.post("/api/vouchers/with-entries").send(body);
        expect(response.status).toBeGreaterThanOrEqual(400);
      } finally {
        auditControl.fail = false;
      }
      expect(await vouchersNamed(body.voucher.voucherNumber)).toBe(0);
    }
    const accepted = journal(`${PREFIX}-central-ok-${Date.now()}`);
    const response = await agent.post("/api/vouchers/with-entries").send(accepted);
    expect(response.status).toBe(200);
    expect((await auditRows("vouchers", response.body.voucher.id)).map((row) => row.action)).toContain("create");
  });
});

describe("one line target (ledger integrity guard v2)", () => {
  const insertLines = (lines: Array<Target & { debit: string; credit: string }>) =>
    withFixtureTransaction(async (client) => {
      const id = (
        await client.query(
          `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, optional)
           VALUES ($1, $2, 'Journal', '2026-10-04', 0, false) RETURNING id`,
          [ctx.companyId, nextNumber()]
        )
      ).rows[0].id as number;
      for (const { debit, credit, ...target } of lines) {
        const columns = Object.keys(target);
        await client.query(
          `INSERT INTO voucher_entries (voucher_id${columns.map((c) => `, ${c}`).join("")}, debit_amount, credit_amount)
           VALUES ($1${columns.map((_, index) => `, $${index + 2}`).join("")}, $${columns.length + 2}, $${columns.length + 3})`,
          [id, ...Object.values(target), debit, credit]
        );
      }
      return id;
    });

  it("is installed at its version", async () => {
    const version = (
      await pool.query(`SELECT obj_description(to_regprocedure('erp_voucher_entry_target_guard()'), 'pg_proc') AS v`)
    ).rows[0].v;
    expect(version).toBe(LEDGER_INTEGRITY_GUARD_VERSION);
  });

  it("refuses a new line with no owner, two accounts or two parties; allows an account line with one party tag", async () => {
    const customerId = (
      await pool.query(
        `INSERT INTO customers (company_id, code, legal_name, ledger_account_id) VALUES ($1, $2::varchar, $2::text, $3) RETURNING id`,
        [ctx.companyId, `${PREFIX}_CUST`, ctx.salesAccountId]
      )
    ).rows[0].id;
    const bankId = (
      await pool.query(
        `INSERT INTO bank_accounts (company_id, code, name, account_number, bank_name) VALUES ($1, $2::varchar, $2::text, '2', 'B') RETURNING id`,
        [ctx.companyId, `${PREFIX}_BANK2`]
      )
    ).rows[0].id;

    await expect(
      insertLines([
        { debit: "5.00", credit: "0" },
        { ledger_account_id: ctx.cashAccountId, debit: "0", credit: "5.00" },
      ])
    ).rejects.toThrow(/VOUCHER_LINE_TARGET_REQUIRED/);
    await expect(
      insertLines([
        { ledger_account_id: ctx.salesAccountId, bank_account_id: bankId, debit: "5.00", credit: "0" },
        { ledger_account_id: ctx.cashAccountId, debit: "0", credit: "5.00" },
      ])
    ).rejects.toThrow(/VOUCHER_LINE_TARGET_REQUIRED/);
    const supplierId = (
      await pool.query(
        `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2::varchar, $2::text, '') RETURNING id`,
        [ctx.companyId, `${PREFIX}_SUP`]
      )
    ).rows[0].id;
    const employeeId = (
      await pool.query(
        `INSERT INTO employees (company_id, code, first_name, last_name, join_date) VALUES ($1, $2, 'W16', 'Employee', '2026-01-01') RETURNING id`,
        [ctx.companyId, `${PREFIX}_EMP`]
      )
    ).rows[0].id;
    // Two parties and no account: no single owner.
    await expect(
      insertLines([
        { supplier_id: supplierId, employee_id: employeeId, debit: "5.00", credit: "0" },
        { ledger_account_id: ctx.cashAccountId, debit: "0", credit: "5.00" },
      ])
    ).rejects.toThrow(/VOUCHER_LINE_TARGET_REQUIRED/);
    // An account line tagged with one party belongs to the account (the engine's rule).
    for (const tag of [{ customer_id: customerId }, { supplier_id: supplierId }]) {
      await expect(
        insertLines([
          { ledger_account_id: ctx.salesAccountId, ...tag, debit: "5.00", credit: "0" },
          { ledger_account_id: ctx.cashAccountId, debit: "0", credit: "5.00" },
        ])
      ).resolves.toBeGreaterThan(0);
    }
    // A bank with its own linked ledger counts once (on the ledger).
    await pool.query(`UPDATE bank_accounts SET linked_ledger_id = $2 WHERE id = $1`, [bankId, ctx.salesAccountId]);
    await expect(
      insertLines([
        { ledger_account_id: ctx.salesAccountId, bank_account_id: bankId, debit: "5.00", credit: "0" },
        { ledger_account_id: ctx.cashAccountId, debit: "0", credit: "5.00" },
      ])
    ).resolves.toBeGreaterThan(0);
  });

  it("leaves existing lines editable while their targets do not change", async () => {
    const voucherId = await withFixtureTransaction(async (client) => {
      await client.query(`SET LOCAL app.ledger_integrity_bypass = 'on'`);
      const id = (
        await client.query(
          `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, optional)
           VALUES ($1, $2, 'Journal', '2026-10-04', 0, false) RETURNING id`,
          [ctx.companyId, nextNumber()]
        )
      ).rows[0].id as number;
      await client.query(`INSERT INTO voucher_entries (voucher_id, debit_amount, credit_amount) VALUES ($1, 3, 0)`, [
        id,
      ]);
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, 0, 3)`,
        [id, ctx.cashAccountId]
      );
      return id;
    });
    await pool.query(
      `UPDATE voucher_entries SET narration = 'legacy line, reviewed' WHERE voucher_id = $1 AND ledger_account_id IS NULL`,
      [voucherId]
    );
    // Giving it a target is a change the engine can attribute: allowed.
    await pool.query(
      `UPDATE voucher_entries SET ledger_account_id = $2 WHERE voucher_id = $1 AND ledger_account_id IS NULL`,
      [voucherId, ctx.salesAccountId]
    );
  });
});

describe("ledger account delete guard", () => {
  it("reads a sideless opening on the side of the account type", async () => {
    // A liability with a sideless 40.00 opening is Cr 40.00; a 40.00 debit empties it.
    const liability = await ledgerAccount("LIAB-SIDELESS", "Liability", "40.00", null);
    await postAgainst({ ledger_account_id: liability }, "40.00");
    await pool.query(`UPDATE ledger_accounts SET deleted_at = now() WHERE id = $1`, [liability]);

    // An expense with a sideless opening stays Dr: a credit-free account with an opening keeps its balance.
    const expense = await ledgerAccount("EXP-SIDELESS", "Expense", "40.00", null);
    await postAgainst({ ledger_account_id: expense }, "40.00");
    await expect(pool.query(`UPDATE ledger_accounts SET deleted_at = now() WHERE id = $1`, [expense])).rejects.toThrow(
      /LEDGER_ACCOUNT_HAS_BALANCE/
    );
  });
});
