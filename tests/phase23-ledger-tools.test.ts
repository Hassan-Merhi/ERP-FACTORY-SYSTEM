/**
 * Phase 23 (chart of accounts and general ledger model) — the tools and reports:
 *   - C1: a new company gets the chart of accounts template (groups, every
 *     registry account under its class, everyday accounts), audited;
 *   - G6: the opening journal (Owner preview / plan hash / apply) moves every
 *     master opening into one journal against OPENING_BALANCE_EQUITY (P&L
 *     openings to RETAINED_EARNINGS), balance-neutral, and locks the openings;
 *   - G12: the fiscal close requires RETAINED_EARNINGS, refuses unknown-type
 *     balances and an unbalanced trial balance; the Owner reopens and the
 *     closure stays in its history;
 *   - G7: legacy orphan / deleted / cross-company / no-target lines moved to
 *     SUSPENSE by a reclassification journal, each line once;
 *   - G5: account reclassification journal (Owner), the old migration 410;
 *   - G18: the period general ledger ties to the engine;
 *   - C9: party rows presented under the control accounts; payroll workers
 *     without a legacy account post to the pooled expense accounts;
 *   - phase 22 leftover: bulk delete and payroll undo retire their vouchers.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import { loadBalanceRows } from "../server/services/accounting/balances/ledgerBalanceEngine";
import { buildTrialBalance } from "../server/services/accounting/integrity/trialBalance";
import { ensureLedgerIntegrityGuard } from "../server/services/accounting/ledgerIntegrityGuard";
import { ensureLedgerModelSchema } from "../server/services/accounting/ledgerModelSchema";
import { ensureOpeningBalanceLock } from "../server/services/accounting/openingBalanceLock";
import { ensureSystemAccounts } from "../server/services/accounting/systemAccounts";
import { TEMPLATE_GROUPS } from "../server/services/accounting/chartOfAccountsTemplate";
import { rebuildPayrollGenVoucher } from "../server/routes/payroll/_payrollAccountingHelper";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "ph23tools";
let ctx: TestContext;
let agent: ReturnType<typeof request.agent>;
let templateCompanyId = 0;
let otherCompanyId = 0;
let sequence = 0;

const errorOf = async (work: () => Promise<unknown>): Promise<string | null> => {
  try {
    await work();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

async function setRole(companyId: number, role: string) {
  const updated = await pool.query(`UPDATE user_company_roles SET role = $3 WHERE user_id = $1 AND company_id = $2`, [
    ctx.userId,
    companyId,
    role,
  ]);
  if (!updated.rowCount) {
    await pool.query(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, $3)`, [
      ctx.userId,
      companyId,
      role,
    ]);
  }
  await agent.post("/api/auth/set-company").send({ companyId });
}

async function account(code: string, type: string, extra: Record<string, unknown> = {}): Promise<number> {
  const fields: Record<string, unknown> = {
    company_id: ctx.companyId,
    code: `${PREFIX}-${code}`,
    name: `${PREFIX} ${code}`,
    account_type: type,
    ...extra,
  };
  const keys = Object.keys(fields);
  const { rows } = await pool.query(
    `INSERT INTO ledger_accounts (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
    Object.values(fields)
  );
  return rows[0].id;
}

/** A balanced USD journal: Dr `debitTarget` / Cr cash. */
function journal(
  debitTarget: Record<string, number | null>,
  amount: string,
  date: string,
  options: { companyId?: number; creditAccountId?: number; legacy?: boolean; number?: string } = {}
) {
  sequence += 1;
  const companyId = options.companyId ?? ctx.companyId;
  return withFixtureTransaction(
    async (client) => {
      const { rows } = await client.query(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency)
         VALUES ($1, $2, 'Journal', $3, $4, 'USD') RETURNING id`,
        [companyId, options.number ?? `${PREFIX}-J${sequence}`, date, amount]
      );
      const keys = Object.keys(debitTarget);
      await client.query(
        `INSERT INTO voucher_entries (voucher_id${keys.map((key) => `, ${key}`).join("")}, debit_amount, credit_amount)
         VALUES ($1${keys.map((_, i) => `, $${i + 3}`).join("")}, $2, 0)`,
        [rows[0].id, amount, ...Object.values(debitTarget)]
      );
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, 0, $3)`,
        [rows[0].id, options.creditAccountId ?? ctx.cashAccountId, amount]
      );
      return rows[0].id as number;
    },
    { legacyUnbalanced: options.legacy }
  );
}

const closingOf = async (companyId: number, kind: string, id: number, asOf?: string) => {
  const rows = await loadBalanceRows(db, { companyId, asOf: asOf ?? null, kind: kind as never, ids: [id] });
  const row = rows[0];
  return row ? row.masterOpening.plus(row.periodDebit).minus(row.periodCredit).toFixed(2) : "0.00";
};

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  await ensureOpeningBalanceLock(pool);
  await ensureLedgerIntegrityGuard(pool);
  await ensureLedgerModelSchema(pool);
  await ensureSystemAccounts(db, ctx.companyId);
  const other = await pool.query(
    `INSERT INTO companies (code, name, base_currency) VALUES ($1::varchar, $1::text, 'USD') RETURNING id`,
    [`${PREFIX.toUpperCase()}X`]
  );
  otherCompanyId = other.rows[0].id;
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
  await setRole(ctx.companyId, "Admin");
}, 120_000);

afterAll(async () => {
  const ids = [ctx.companyId, otherCompanyId, templateCompanyId].filter(Boolean);
  await pool.query(`DELETE FROM fiscal_period_closures WHERE company_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM fiscal_period_closure_history WHERE company_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM opening_journal_applications WHERE company_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM legacy_line_repairs WHERE company_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM accounting_posting_requests WHERE company_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM factory_payrolls WHERE company_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM factory_workers WHERE company_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM erp_payroll_runs WHERE company_id = ANY($1::int[])`, [ids]);
  await withFixtureTransaction(async (client) => {
    await client.query("SET LOCAL app.closed_period_override = 'on'");
    await client.query(
      `DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = ANY($1::int[]))`,
      [ids]
    );
    await client.query(`DELETE FROM vouchers WHERE company_id = ANY($1::int[])`, [ids]);
    await client.query("SET LOCAL app.opening_journal_apply = 'on'");
    await client.query(`DELETE FROM customers WHERE company_id = ANY($1::int[])`, [ids]);
    await client.query(`DELETE FROM suppliers WHERE company_id = ANY($1::int[])`, [ids]);
    await client.query(`DELETE FROM bank_accounts WHERE company_id = ANY($1::int[])`, [ids]);
    await client.query(`UPDATE ledger_accounts SET parent_id = NULL WHERE company_id = ANY($1::int[])`, [ids]);
    await client.query(`DELETE FROM ledger_accounts WHERE company_id = ANY($1::int[]) AND company_id <> $2`, [
      ids,
      ctx.companyId,
    ]);
  });
  await pool.query(`DELETE FROM user_company_roles WHERE company_id = ANY($1::int[]) AND company_id <> $2`, [
    ids,
    ctx.companyId,
  ]);
  await deleteAuditLogRowsForTests(pool, "company_id = ANY($1::int[])", [ids]);
  await pool.query(`DELETE FROM companies WHERE id = ANY($1::int[]) AND id <> $2`, [ids, ctx.companyId]);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 120_000);

describe("C1: chart of accounts template", () => {
  it("creates a new company with groups, every registry account under its class and the everyday accounts", async () => {
    const response = await agent.post("/api/companies").send({
      code: `${PREFIX.toUpperCase()}T`,
      name: `${PREFIX} template company`,
      companyType: "erp",
      parentCompanyId: null,
    });
    expect(response.status).toBe(201);
    templateCompanyId = response.body.id;
    const { rows } = await pool.query(
      `SELECT la.code, la.sub_type, la.account_class, p.code AS parent_code
         FROM ledger_accounts la LEFT JOIN ledger_accounts p ON p.id = la.parent_id
        WHERE la.company_id = $1`,
      [templateCompanyId]
    );
    const byCode = new Map(rows.map((row) => [row.code, row]));
    for (const group of Object.values(TEMPLATE_GROUPS)) expect(byCode.get(group.code)?.sub_type).toBe("Group");
    expect(byCode.get("RETAINED_EARNINGS")?.parent_code).toBe("GRP-EQUITY");
    expect(byCode.get("ACCOUNTS_RECEIVABLE")?.parent_code).toBe("GRP-ASSETS");
    expect(byCode.get("ACCOUNTS_PAYABLE")?.parent_code).toBe("GRP-LIABILITIES");
    expect(byCode.get("RETAIL-SALES")?.parent_code).toBe("GRP-INCOME");
    expect(byCode.get("ROUNDING")?.parent_code).toBe("GRP-EXPENSES");
    expect(byCode.get("TAX_PAYABLE")?.account_class).toBe("LIABILITY");
    expect(byCode.get("CASH")?.account_class).toBe("ASSET");
    const audit = await pool.query(
      `SELECT changes FROM audit_log WHERE company_id = $1 AND table_name = 'companies' AND action = 'create'`,
      [templateCompanyId]
    );
    expect(audit.rows[0].changes.chartOfAccountsTemplate.new).toMatch(/coa-template/);
  });
});

describe("G6: the opening journal", () => {
  it("moves every master opening into one journal, balance-neutral, and locks the openings", async () => {
    const companyId = templateCompanyId;
    await setRole(companyId, "Owner");
    const ids = new Map(
      (await pool.query(`SELECT code, id FROM ledger_accounts WHERE company_id = $1`, [companyId])).rows.map((r) => [
        r.code,
        r.id,
      ])
    );
    await pool.query(`UPDATE ledger_accounts SET opening_balance = 300, opening_balance_side = 'Dr' WHERE id = $1`, [
      ids.get("CASH"),
    ]);
    await pool.query(`UPDATE ledger_accounts SET opening_balance = 40, opening_balance_side = 'Dr' WHERE id = $1`, [
      ids.get("PURCHASES"),
    ]);
    const customer = await pool.query(
      `INSERT INTO customers (company_id, code, legal_name, opening_balance, opening_balance_side)
       VALUES ($1, 'P23C', 'P23 customer', 60, 'Dr') RETURNING id`,
      [companyId]
    );
    const supplier = await pool.query(
      `INSERT INTO suppliers (company_id, code, legal_name, email, opening_balance, opening_balance_side)
       VALUES ($1, 'P23S', 'P23 supplier', 's@example.com', 100, 'Cr') RETURNING id`,
      [companyId]
    );
    const before = await buildTrialBalance(companyId, null);
    expect(before.differenceComponents.openingBalances).toBe("300.00");

    const missing = await agent.get("/api/accounting/opening-journal/plan");
    expect(missing.body.blockers).toContain("CUT_OVER_DATE_REQUIRED");
    const plan = await agent.get("/api/accounting/opening-journal/plan?cutOverDate=2026-01-01");
    expect(plan.status).toBe(200);
    expect(plan.body.blockers).toEqual([]);
    expect(plan.body.totals).toMatchObject({ debit: "400.00", credit: "400.00", openingBalanceEquity: "-300.00" });
    expect(plan.body.totals.movedToRetainedEarnings).toBe("40.00");

    expect(
      (
        await agent
          .post("/api/accounting/opening-journal/apply")
          .send({ confirm: true, planHash: "0".repeat(64), cutOverDate: "2026-01-01" })
      ).body.code
    ).toBe("PLAN_CHANGED");
    await setRole(companyId, "Admin");
    expect(
      (
        await agent
          .post("/api/accounting/opening-journal/apply")
          .send({ confirm: true, planHash: plan.body.planHash, cutOverDate: "2026-01-01" })
      ).status
    ).toBe(403);
    await setRole(companyId, "Owner");
    const apply = await agent
      .post("/api/accounting/opening-journal/apply")
      .send({ confirm: true, planHash: plan.body.planHash, cutOverDate: "2026-01-01" });
    expect(apply.status).toBe(200);
    expect(apply.body.voucherId).toBeGreaterThan(0);

    const after = await buildTrialBalance(companyId, null);
    expect(after.differenceComponents.openingBalances).toBe("0.00");
    expect(after.balanced).toBe(true);
    expect(await closingOf(companyId, "ledger", ids.get("CASH"))).toBe("300.00");
    expect(await closingOf(companyId, "customer", customer.rows[0].id)).toBe("60.00");
    expect(await closingOf(companyId, "supplier", supplier.rows[0].id)).toBe("-100.00");
    expect(await closingOf(companyId, "ledger", ids.get("PURCHASES"))).toBe("0.00");
    expect(await closingOf(companyId, "ledger", ids.get("RETAINED_EARNINGS"))).toBe("40.00");
    expect(await closingOf(companyId, "ledger", ids.get("OPENING_BALANCE_EQUITY"))).toBe("-300.00");
    const masters = await pool.query(`SELECT opening_balance::numeric AS o FROM ledger_accounts WHERE id = $1`, [
      ids.get("CASH"),
    ]);
    expect(Number(masters.rows[0].o)).toBe(0);

    expect(
      await errorOf(() => pool.query(`UPDATE ledger_accounts SET opening_balance = 5 WHERE id = $1`, [ids.get("CASH")]))
    ).toMatch(/OPENING_JOURNAL_APPLIED/);
    expect(
      await errorOf(() =>
        pool.query(
          `INSERT INTO customers (company_id, code, legal_name, opening_balance) VALUES ($1, 'P23C2', 'x', 5)`,
          [companyId]
        )
      )
    ).toMatch(/OPENING_JOURNAL_APPLIED/);
    const again = await agent.get("/api/accounting/opening-journal/plan?cutOverDate=2026-01-01");
    expect(again.body.blockers).toContain("ALREADY_APPLIED");
    expect(again.body.applied.voucherId).toBe(apply.body.voucherId);
  });
});

describe("G12: fiscal close and reopen", () => {
  it("requires RETAINED_EARNINGS, refuses unknown-type balances and an unbalanced trial balance, keeps history", async () => {
    await setRole(ctx.companyId, "Admin");
    await journal({ ledger_account_id: ctx.cashAccountId }, "100", "2026-03-10", {
      creditAccountId: ctx.salesAccountId,
    });
    const close = (body: Record<string, unknown> = {}) =>
      agent
        .post("/api/fiscal-period/close")
        .send({ periodStartDate: "2026-01-01", periodEndDate: "2026-03-31", ...body });

    const wrong = await close({ retainedEarningsAccountId: ctx.cashAccountId });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe("RETAINED_EARNINGS_NOT_SYSTEM_ACCOUNT");

    const weird = await account("WEIRD", "Weird Type");
    await journal({ ledger_account_id: weird }, "5", "2026-03-11");
    const unknown = await close();
    expect(unknown.status).toBe(409);
    expect(unknown.body.message).toMatch(/unknown type/);
    await pool.query(`UPDATE ledger_accounts SET account_type = 'Asset' WHERE id = $1`, [weird]);

    const plug = await journal({ ledger_account_id: weird }, "3", "2026-03-12", { legacy: true });
    await withFixtureTransaction(
      async (client) => {
        await client.query(`DELETE FROM voucher_entries WHERE voucher_id = $1 AND credit_amount > 0`, [plug]);
      },
      { legacyUnbalanced: true }
    );
    const unbalanced = await close();
    expect(unbalanced.status).toBe(409);
    expect(unbalanced.body.message).toMatch(/does not balance/);
    await withFixtureTransaction(
      async (client) => {
        await client.query(`UPDATE vouchers SET deleted_at = now() WHERE id = $1`, [plug]);
      },
      { legacyUnbalanced: true }
    );

    const closed = await close();
    expect(closed.status).toBe(200);
    expect(Number(closed.body.netIncome)).toBe(100);

    await setRole(ctx.companyId, "Owner");
    const reopen = await agent.post(`/api/fiscal-period/${closed.body.id}/reopen`).send({ reason: "phase 23 test" });
    expect(reopen.status).toBe(200);
    const history = await pool.query(
      `SELECT reason, reopened_by_user_id, closure FROM fiscal_period_closure_history WHERE closure_id = $1`,
      [closed.body.id]
    );
    expect(history.rows[0]).toMatchObject({ reason: "phase 23 test", reopened_by_user_id: ctx.userId });
    expect(history.rows[0].closure.closingVoucherId).toBe(closed.body.closingVoucherId);
  });
});

describe("G7: legacy line reclassification", () => {
  it("moves orphan, deleted, other-company and no-target lines to SUSPENSE by a journal, once", async () => {
    await setRole(ctx.companyId, "Owner");
    const deletedAccount = await account("DELACC", "Asset");
    await journal({ ledger_account_id: deletedAccount }, "15", "2026-04-01");
    await withFixtureTransaction(
      async (client) => {
        await client.query(`UPDATE ledger_accounts SET deleted_at = now() WHERE id = $1`, [deletedAccount]);
      },
      { legacyUnbalanced: true }
    );
    const noTarget = await journal({ narration: null } as never, "7", "2026-04-02", { legacy: true });
    const orphan = await account("ORPHAN", "Asset");
    await journal({ ledger_account_id: orphan }, "9", "2026-04-03");
    await withFixtureTransaction(async (client) => {
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(`DELETE FROM ledger_accounts WHERE id = $1`, [orphan]);
    });
    const foreign = await account("FOREIGN", "Asset", { company_id: otherCompanyId });
    await journal({ ledger_account_id: foreign }, "4", "2026-04-04", { legacy: true });

    const plan = await agent.get("/api/accounting/legacy-line-reclassification/plan");
    expect(plan.status).toBe(200);
    const kinds = plan.body.groups.map((group: { kind: string }) => group.kind).sort();
    expect(kinds).toEqual(["crossCompanyAccount", "deletedAccount", "noTarget", "orphanAccount"]);
    expect(plan.body.totals).toMatchObject({ debit: "35.00", credit: "35.00" });

    const apply = await agent
      .post("/api/accounting/legacy-line-reclassification/apply")
      .send({ confirm: true, planHash: plan.body.planHash });
    expect(apply.status).toBe(200);
    expect(apply.body.restoredPlaceholders).toEqual([orphan]);

    const suspense = await pool.query(`SELECT id FROM ledger_accounts WHERE company_id = $1 AND code = 'SUSPENSE'`, [
      ctx.companyId,
    ]);
    expect(await closingOf(ctx.companyId, "ledger", suspense.rows[0].id)).toBe("35.00");
    const unassigned = await loadBalanceRows(db, { companyId: ctx.companyId, kind: "unassigned" });
    expect(unassigned.every((row) => row.periodDebit.minus(row.periodCredit).isZero())).toBe(true);
    const missing = await loadBalanceRows(db, { companyId: ctx.companyId, kind: "missingAccount" });
    expect(missing.every((row) => row.periodDebit.minus(row.periodCredit).isZero())).toBe(true);
    const placeholder = await pool.query(`SELECT active, code FROM ledger_accounts WHERE id = $1`, [orphan]);
    expect(placeholder.rows[0]).toMatchObject({ active: false, code: `LEGACY-ORPHAN-${orphan}` });
    const original = await pool.query(`SELECT COUNT(*)::int AS n FROM voucher_entries WHERE voucher_id = $1`, [
      noTarget,
    ]);
    expect(original.rows[0].n).toBe(2);

    const replan = await agent.get("/api/accounting/legacy-line-reclassification/plan");
    expect(replan.body.blockers).toContain("NOTHING_TO_REPAIR");
    const validation = await agent
      .post("/api/accounting/legacy-line-reclassification/validate-constraints")
      .send({ confirm: true });
    expect(validation.status).toBe(200);
    expect(validation.body.results.length).toBeGreaterThanOrEqual(6);
  });
});

describe("G5: account reclassification", () => {
  it("moves a balance by a journal (Owner) and retires the line-rewriting migration", async () => {
    await setRole(ctx.companyId, "Owner");
    const source = await account("RECLSRC", "Expense");
    const destination = await account("RECLDST", "Expense");
    await journal({ ledger_account_id: source }, "25", "2026-05-05");
    const query = `sourceAccountIds=${source}&destinationAccountId=${destination}&date=2026-05-31&deactivateSources=true`;
    const plan = await agent.get(`/api/accounting/account-reclassification/plan?${query}`);
    expect(plan.status).toBe(200);
    expect(plan.body.blockers).toEqual([]);
    expect(plan.body.total).toBe("25.00");
    const apply = await agent.post("/api/accounting/account-reclassification/apply").send({
      confirm: true,
      planHash: plan.body.planHash,
      sourceAccountIds: [source],
      destinationAccountId: destination,
      date: "2026-05-31",
      deactivateSources: true,
    });
    expect(apply.status).toBe(200);
    expect(await closingOf(ctx.companyId, "ledger", source)).toBe("0.00");
    expect(await closingOf(ctx.companyId, "ledger", destination)).toBe("25.00");
    const state = await pool.query(`SELECT active FROM ledger_accounts WHERE id = $1`, [source]);
    expect(state.rows[0].active).toBe(false);

    await setRole(ctx.companyId, "Admin");
    const retired = await agent.post("/api/admin/account-migration/execute").send({});
    expect(retired.status).toBe(410);
    expect(retired.body.code).toBe("ACCOUNT_MIGRATION_RETIRED");
  });
});

describe("G18 / C9: period general ledger and control accounts", () => {
  it("ties the general ledger to the engine and presents parties under the control accounts", async () => {
    await setRole(ctx.companyId, "Admin");
    await journal({ ledger_account_id: ctx.cashAccountId }, "11", "2026-06-02", {
      creditAccountId: ctx.salesAccountId,
    });
    await journal({ ledger_account_id: ctx.cashAccountId }, "12", "2026-06-20", {
      creditAccountId: ctx.salesAccountId,
    });
    const report = await agent.get(
      `/api/accounting/general-ledger?from=2026-06-01&to=2026-06-30&kind=ledger&ids=${ctx.cashAccountId}`
    );
    expect(report.status).toBe(200);
    const cash = report.body.accounts[0];
    expect(cash.lines.length).toBeGreaterThanOrEqual(2);
    expect(cash.closing).toBe(await closingOf(ctx.companyId, "ledger", ctx.cashAccountId, "2026-06-30"));
    expect(cash.lines[cash.lines.length - 1].balance).toBe(cash.closing);
    expect(cash.opening).toBe(await closingOf(ctx.companyId, "ledger", ctx.cashAccountId, "2026-05-31"));

    const all = await agent.get("/api/accounting/general-ledger?from=2026-01-01&to=2026-12-31");
    const tb = await buildTrialBalance(ctx.companyId, "2026-12-31");
    expect(all.body.totals.closing).toBe((Number(tb.totals.closingDebit) - Number(tb.totals.closingCredit)).toFixed(2));
    expect((await agent.get("/api/accounting/general-ledger?from=2026-02-01&to=2026-01-01")).status).toBe(400);

    const customer = await pool.query(
      `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, 'P23TB', 'P23 tb customer') RETURNING id`,
      [ctx.companyId]
    );
    await journal({ customer_id: customer.rows[0].id }, "8", "2026-06-25");
    const trial = await buildTrialBalance(ctx.companyId, null);
    const row = trial.rows.find((r) => r.kind === "customer" && r.id === customer.rows[0].id);
    expect(row?.controlAccountCode).toBe("ACCOUNTS_RECEIVABLE");
    const receivable = trial.controlAccounts.find((c) => c.code === "ACCOUNTS_RECEIVABLE");
    expect(receivable?.partyCount).toBeGreaterThanOrEqual(1);
    expect(Number(receivable?.partiesClosing)).toBeGreaterThanOrEqual(8);
  });

  it("posts payroll workers without a legacy account to the pooled expense accounts", async () => {
    const worker = await pool.query(
      `INSERT INTO factory_workers (company_id, full_name) VALUES ($1, 'P23 New Worker') RETURNING id`,
      [ctx.companyId]
    );
    await pool.query(
      `INSERT INTO factory_payrolls (company_id, worker_id, period_start, period_end, net_salary, bonuses, advances)
       VALUES ($1, $2, '2026-07-01', '2026-07-31', 100, 10, 0)`,
      [ctx.companyId, worker.rows[0].id]
    );
    await rebuildPayrollGenVoucher(db, ctx.companyId, "2026-07-01", "2026-07-31");
    const lines = await pool.query(
      `SELECT la.code, ve.debit_amount::numeric AS debit
         FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
         JOIN ledger_accounts la ON la.id = ve.ledger_account_id
        WHERE v.company_id = $1 AND v.voucher_number LIKE 'PAYROLL-GEN-%' AND v.deleted_at IS NULL AND ve.debit_amount > 0`,
      [ctx.companyId]
    );
    const codes = lines.rows.map((r) => r.code);
    expect(codes).toContain("FACTORY_SALARY_EXPENSE");
    const perWorker = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ledger_accounts WHERE company_id = $1 AND name LIKE '%P23 New Worker%'`,
      [ctx.companyId]
    );
    expect(perWorker.rows[0].n).toBe(0);
  });
});

describe("Phase 22 leftover: bulk delete and payroll undo retire their vouchers", () => {
  it("renumbers ~DEL and releases the identity on bulk delete and on a payroll run undo", async () => {
    await setRole(ctx.companyId, "Admin");
    const voucherId = await journal({ ledger_account_id: ctx.cashAccountId }, "6", "2026-08-01", {
      creditAccountId: ctx.salesAccountId,
    });
    const bulk = await agent.post("/api/vouchers/bulk-delete").send({ voucherIds: [voucherId] });
    expect(bulk.status).toBe(200);
    expect(bulk.body.deletedCount).toBe(1);
    const deleted = await pool.query(`SELECT voucher_number, deleted_at FROM vouchers WHERE id = $1`, [voucherId]);
    expect(String(deleted.rows[0].voucher_number).endsWith(`~DEL${voucherId}`)).toBe(true);
    expect(deleted.rows[0].deleted_at).not.toBeNull();

    const run = await pool.query(
      `INSERT INTO erp_payroll_runs (company_id, status, date, created_at, paid_at) VALUES ($1, 'PAID', '2026-08-05', now()::text, now()::text)
       RETURNING id`,
      [ctx.companyId]
    );
    const payment = await journal({ ledger_account_id: ctx.salesAccountId }, "20", "2026-08-05", {
      number: `SAL-${run.rows[0].id}-1`,
    });
    const undo = await agent.post(`/api/payroll/runs/${run.rows[0].id}/undo`).send({});
    expect(undo.status).toBe(200);
    const retired = await pool.query(`SELECT voucher_number, original_voucher_number FROM vouchers WHERE id = $1`, [
      payment,
    ]);
    expect(retired.rows[0].voucher_number).toBe(`SAL-${run.rows[0].id}-1~DEL${payment}`);
    expect(retired.rows[0].original_voucher_number).toBe(`SAL-${run.rows[0].id}-1`);
    const state = await pool.query(`SELECT status FROM erp_payroll_runs WHERE id = $1`, [run.rows[0].id]);
    expect(state.rows[0].status).toBe("DRAFT");
  });
});
