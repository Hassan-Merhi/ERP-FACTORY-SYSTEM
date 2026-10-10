/**
 * Wave 18 (A) — scheduler and rental posting (owner decisions of 2026-10-10).
 *
 * 1. Scheduled posters run per company in tenant scope and skip (never force)
 *    a posting dated in a closed period.
 * 2. The legacy prepaid shop rent recognition left the daily job: an Owner
 *    preview (plan hash) / apply (confirm + hash, one transaction, closed
 *    periods refused, audited) tool.
 * 3. GET {rental}/units only reads; "post due accruals now" (Admin/Owner)
 *    posts due scheduled payments and accruals on the business date, audited.
 */
import fs from "node:fs";
import path from "node:path";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { getCompanyBusinessDate } from "../server/lib/dateUtils";
import { runInCompanyPostingScope } from "../server/services/accounting/scheduledPostingScope";
import {
  runRecurringJournal,
  upsertRecurringJournalFromVoucher,
} from "../server/services/accounting/recurringJournalService";
import { runWithDatabaseMaintenanceScope } from "../server/services/security/databaseScopeRuntimeContext";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "w18arent";
const USERNAME = `${TEST_PREFIX}_testuser`;
let ctx: TestContext;
let agent: request.SuperAgentTest;
const unitIds: number[] = [];
const contractIds: number[] = [];

const asScheduler = <T>(work: () => Promise<T>) => runWithDatabaseMaintenanceScope("scheduler:wave18a-test", work);

const iso = (date: Date) => date.toISOString().slice(0, 10);
const today = getCompanyBusinessDate(null);
const firstOfMonth = (monthsBack: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - monthsBack);
  return iso(d);
};
const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
};
const lastMonth1 = firstOfMonth(1);
const closureDate = addDays(lastMonth1, -20);

async function journal(number: string, date: string, debitAccount: number, creditAccount: number, amount: string) {
  return withFixtureTransaction(async (client) => {
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency, source_module)
       VALUES ($1, $2, 'Journal', $3, $4, 'USD', 'ERP') RETURNING id`,
      [ctx.companyId, number, date, amount]
    );
    await client.query(
      `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount)
       VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
      [rows[0].id, debitAccount, amount, creditAccount]
    );
    return rows[0].id;
  });
}

let closures = 0;
async function closeBooksThrough(date: string) {
  closures += 1;
  const closing = await journal(
    `${TEST_PREFIX}-CLOSE-${closures}`,
    date,
    ctx.cashAccountId,
    ctx.salesAccountId,
    "1.00"
  );
  await pool.query(
    `INSERT INTO fiscal_period_closures (company_id, period_start_date, period_end_date, closed_by_user_id,
       closing_voucher_id, retained_earnings_account_id, total_income, total_expense, net_income, status)
     VALUES ($1, $2, $2, $3, $4, $5, 0, 0, 0, 'CLOSED')`,
    [ctx.companyId, date, ctx.userId, closing, ctx.cashAccountId]
  );
}
const reopenBooks = () => pool.query(`DELETE FROM fiscal_period_closures WHERE company_id = $1`, [ctx.companyId]);

async function shopContract(unitNumber: string, startDate: string, rent: string) {
  const { rows: unit } = await pool.query<{ id: number }>(
    `INSERT INTO property_units (company_id, module, unit_type, unit_number, location_group, active)
     VALUES ($1, 'ERP', 'SHOP', $2, 'W18', true) RETURNING id`,
    [ctx.companyId, unitNumber]
  );
  const { rows: contract } = await pool.query<{ id: number }>(
    `INSERT INTO property_contracts (company_id, module, unit_id, tenant_name, rental_amount, start_date, status, currency)
     VALUES ($1, 'ERP', $2, 'W18 Landlord', $3, $4, 'ACTIVE', 'USD') RETURNING id`,
    [ctx.companyId, unit[0].id, rent, startDate]
  );
  unitIds.push(unit[0].id);
  contractIds.push(contract[0].id);
  return { unitId: unit[0].id, contractId: contract[0].id };
}

const vouchersLike = async (pattern: string) =>
  (
    await pool.query<{ id: number; voucher_number: string; voucher_date: string; total_amount: string }>(
      `SELECT id, voucher_number, voucher_date::text AS voucher_date, total_amount::text AS total_amount
         FROM vouchers WHERE company_id = $1 AND voucher_number LIKE $2 AND deleted_at IS NULL ORDER BY id`,
      [ctx.companyId, pattern]
    )
  ).rows;

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  await pool.query(`UPDATE user_company_roles SET role = 'Owner' WHERE user_id = $1 AND company_id = $2`, [
    ctx.userId,
    ctx.companyId,
  ]);
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({ username: USERNAME, password: "testpassword123" });
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
}, 120_000);

afterAll(async () => {
  const id = ctx.companyId;
  await reopenBooks();
  await pool.query(`DELETE FROM recurring_journals WHERE company_id = $1`, [id]);
  if (contractIds.length) {
    await pool.query(`DELETE FROM property_payments WHERE contract_id = ANY($1::int[])`, [contractIds]);
    await pool.query(`DELETE FROM property_monthly_ledger WHERE contract_id = ANY($1::int[])`, [contractIds]);
    await pool.query(`DELETE FROM property_contracts WHERE id = ANY($1::int[])`, [contractIds]);
    await pool.query(`DELETE FROM property_units WHERE id = ANY($1::int[])`, [unitIds]);
  }
  await pool.query(`DELETE FROM factory_daybook_entries WHERE company_id = $1`, [id]);
  await pool.query(`DELETE FROM accounting_posting_requests WHERE company_id = $1`, [id]);
  await pool.query(`DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`, [
    id,
  ]);
  await pool.query(`DELETE FROM vouchers WHERE company_id = $1`, [id]);
  await deleteAuditLogRowsForTests(pool, "company_id = $1", [id]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 120_000);

describe("scheduled posters run in tenant scope and skip closed periods", () => {
  it("posts each company outside the maintenance scope", async () => {
    const scope = await asScheduler(() =>
      runInCompanyPostingScope(ctx.companyId, async () => {
        const client = await pool.connect();
        try {
          const { rows } = await client.query<{ maintenance: string | null; company: string | null }>(
            `SELECT current_setting('app.company_scope_maintenance', true) AS maintenance,
                    current_setting('app.current_company_id', true) AS company`
          );
          return rows[0];
        } finally {
          client.release();
        }
      })
    );
    expect(scope.maintenance).not.toBe("on");
    expect(scope.company).toBe(String(ctx.companyId));
  });

  it("skips a recurring journal dated in a closed period and posts it once the period is open", async () => {
    const source = await journal(
      `${TEST_PREFIX}-RJ-SRC`,
      addDays(closureDate, -40),
      ctx.cashAccountId,
      ctx.salesAccountId,
      "25.00"
    );
    const recurring = await asScheduler(() =>
      upsertRecurringJournalFromVoucher({ companyId: ctx.companyId, sourceVoucherId: source, userId: ctx.userId })
    );
    await pool.query(`UPDATE recurring_journals SET next_run_date = $2 WHERE id = $1`, [recurring.id, closureDate]);
    await closeBooksThrough(closureDate);
    const due = { ...recurring, nextRunDate: closureDate };

    const skipped = await asScheduler(() => runRecurringJournal(due));
    expect(skipped.posted).toBe(false);
    expect(skipped.skipped).toMatchObject({ reference: `recurring-journal:${recurring.id}`, reason: "PERIOD_CLOSED" });
    expect(await vouchersLike(`RJ-${recurring.id}-%`)).toEqual([]);
    const { rows: held } = await pool.query(
      `SELECT next_run_date::text AS next_run_date, last_error FROM recurring_journals WHERE id = $1`,
      [recurring.id]
    );
    expect(held[0].next_run_date).toBe(closureDate);
    expect(held[0].last_error).toMatch(/^PERIOD_CLOSED/);

    await reopenBooks();
    const posted = await asScheduler(() => runRecurringJournal(due));
    expect(posted.posted).toBe(true);
    const rj = await vouchersLike(`RJ-${recurring.id}-%`);
    expect(rj).toHaveLength(1);
    expect(rj[0]).toMatchObject({ voucher_date: closureDate, total_amount: "25.00" });
    const { rows: audit } = await pool.query(
      `SELECT changes FROM audit_log WHERE company_id = $1 AND table_name = 'recurring_journals' AND record_id = $2`,
      [ctx.companyId, recurring.id]
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].changes.nextRunDate.old).toBe(closureDate);
  });

  it("no longer runs the legacy prepaid recognition from the daily rental job", () => {
    const source = fs.readFileSync(path.resolve("server/services/scheduler/scheduled-jobs.ts"), "utf8");
    expect(source).not.toContain("repairLegacyFullyPrepaidRentRecognition");
    expect(source).not.toContain("legacyPrepaidRecognitionRepair");
    expect(source).toContain("postDueRentalForCompany");
  });
});

describe("legacy prepaid shop rent recognition (Owner preview/apply)", () => {
  const BASE = "/api/erp/rental/admin/legacy-prepaid-recognition";
  let rowId: number;
  let paymentId: number;
  const paymentDate = addDays(lastMonth1, -10);

  beforeAll(async () => {
    const { rows: expense } = await pool.query<{ id: number }>(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
       VALUES ($1, 'W18-SHOP-RENT', 'Rent Expense - ERP Shops', 'Indirect Expense', 0, 'Dr') RETURNING id`,
      [ctx.companyId]
    );
    const { unitId, contractId } = await shopContract("W18-P1", lastMonth1, "300.00");
    const paid = await journal(`${TEST_PREFIX}-PAY-1`, paymentDate, expense[0].id, ctx.cashAccountId, "300.00");
    const [year, month] = lastMonth1.split("-").map(Number);
    const { rows: row } = await pool.query<{ id: number }>(
      `INSERT INTO property_monthly_ledger (company_id, module, contract_id, unit_id, year, month, expected_amount, paid_amount)
       VALUES ($1, 'ERP', $2, $3, $4, $5, '300.00', '300.00') RETURNING id`,
      [ctx.companyId, contractId, unitId, year, month]
    );
    rowId = row[0].id;
    const { rows: payment } = await pool.query<{ id: number }>(
      `INSERT INTO property_payments (company_id, module, contract_id, unit_id, amount, payment_date, for_year, for_month,
         posting_status, payment_group_id, voucher_id, ledger_row_id)
       VALUES ($1, 'ERP', $2, $3, '300.00', $4, $5, $6, 'POSTED', 'PG-W18-PREPAID', $7, $8) RETURNING id`,
      [ctx.companyId, contractId, unitId, paymentDate, year, month, paid, rowId]
    );
    paymentId = payment[0].id;
  });

  it("previews read-only, refuses a closed period, a missing or stale hash, and applies once, audited", async () => {
    const preview = await agent.get(`${BASE}/plan`);
    expect(preview.status).toBe(200);
    expect(preview.body.blockers).toEqual([]);
    expect(preview.body.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.body.rows).toEqual([
      expect.objectContaining({
        ledgerRowId: rowId,
        dueDate: lastMonth1,
        expected: "300.00",
        reclassifications: [
          expect.objectContaining({
            voucherNumber: `LEGACY-PREPAID-RECLASS-${ctx.companyId}-${rowId}-${paymentId}`,
            voucherDate: paymentDate,
            amount: "300.00",
          }),
        ],
        recognition: expect.objectContaining({ voucherNumber: `LEGACY-PREPAID-REC-${ctx.companyId}-${rowId}` }),
      }),
    ]);
    expect(await vouchersLike("LEGACY-PREPAID-%")).toEqual([]);

    expect((await agent.post(`${BASE}/apply`).send({ planHash: preview.body.planHash })).status).toBe(400);
    expect((await agent.post(`${BASE}/apply`).send({ confirm: true })).status).toBe(400);
    const stale = await agent.post(`${BASE}/apply`).send({ confirm: true, planHash: "0".repeat(64) });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("PLAN_CHANGED");

    // A closure covering the original payment date: the month is not applied.
    await closeBooksThrough(paymentDate);
    const closed = await agent.get(`${BASE}/plan`);
    expect(closed.body.rows).toEqual([]);
    expect(closed.body.skipped).toEqual([{ ledgerRowId: rowId, reason: "PERIOD_CLOSED", dates: [paymentDate] }]);
    expect(closed.body.blockers).toEqual(["NOTHING_TO_APPLY"]);
    const refused = await agent.post(`${BASE}/apply`).send({ confirm: true, planHash: closed.body.planHash });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("NOTHING_TO_APPLY");
    expect(await vouchersLike("LEGACY-PREPAID-%")).toEqual([]);
    await reopenBooks();

    const applied = await agent.post(`${BASE}/apply`).send({ confirm: true, planHash: preview.body.planHash });
    expect(applied.status).toBe(200);
    const posted = await vouchersLike("LEGACY-PREPAID-%");
    expect(posted.map((v) => [v.voucher_number, v.voucher_date, v.total_amount])).toEqual([
      [`LEGACY-PREPAID-RECLASS-${ctx.companyId}-${rowId}-${paymentId}`, paymentDate, "300.00"],
      [`LEGACY-PREPAID-REC-${ctx.companyId}-${rowId}`, lastMonth1, "300.00"],
    ]);
    const { rows: ledger } = await pool.query(
      `SELECT accrual_voucher_id, used_prepaid_account FROM property_monthly_ledger WHERE id = $1`,
      [rowId]
    );
    expect(ledger[0]).toEqual({ accrual_voucher_id: posted[1].id, used_prepaid_account: true });
    const { rows: audit } = await pool.query(
      `SELECT username, changes FROM audit_log
        WHERE company_id = $1 AND record_identifier = 'rental-legacy-prepaid-recognition:ERP'`,
      [ctx.companyId]
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].username).toBe(USERNAME);
    expect(audit[0].changes.entryRows.old).toEqual([
      { id: rowId, accrualVoucherId: null, usedPrepaidAccount: false, usedAdvanceAccount: false },
    ]);

    const again = await agent.get(`${BASE}/plan`);
    expect(again.body.blockers).toEqual(["NOTHING_TO_APPLY"]);
  });
});

describe("rental units GET only reads; post due accruals now posts and audits", () => {
  let contractId: number;
  let unitId: number;

  beforeAll(async () => {
    ({ contractId, unitId } = await shopContract("W18-S1", firstOfMonth(3), "500.00"));
  });

  it("GET /units posts nothing and creates no monthly rows", async () => {
    const before = await pool.query(`SELECT count(*)::int AS n FROM vouchers WHERE company_id = $1`, [ctx.companyId]);
    const res = await agent.get("/api/erp/rental/units?unitType=SHOP");
    expect(res.status).toBe(200);
    const after = await pool.query(`SELECT count(*)::int AS n FROM vouchers WHERE company_id = $1`, [ctx.companyId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const rows = await pool.query(`SELECT count(*)::int AS n FROM property_monthly_ledger WHERE contract_id = $1`, [
      contractId,
    ]);
    expect(rows.rows[0].n).toBe(0);
  });

  it("is Admin/Owner only, posts on the business date, audits, and skips a closed-period scheduled payment", async () => {
    await closeBooksThrough(closureDate);
    const scheduledDate = addDays(closureDate, -1);
    const [year, month] = scheduledDate.split("-").map(Number);
    await pool.query(
      `INSERT INTO property_payments (company_id, module, contract_id, unit_id, amount, payment_date, for_year, for_month,
         posting_status, payment_group_id, cash_account_id)
       VALUES ($1, 'ERP', $2, $3, '500.00', $4, $5, $6, 'SCHEDULED', 'PG-W18-CLOSED', $7)`,
      [ctx.companyId, contractId, unitId, scheduledDate, year, month, ctx.cashAccountId]
    );

    const res = await agent.post("/api/erp/rental/accruals/post-due");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      companyId: ctx.companyId,
      module: "ERP",
      asOfDate: today,
      closedThrough: closureDate,
    });
    expect(res.body.accrued).toBeGreaterThan(0);
    expect(res.body.skipped).toEqual([
      expect.objectContaining({
        reference: "rental-scheduled-payment:PG-W18-CLOSED",
        date: scheduledDate,
        reason: "PERIOD_CLOSED",
      }),
    ]);
    const { rows: scheduled } = await pool.query(
      `SELECT posting_status FROM property_payments WHERE payment_group_id = 'PG-W18-CLOSED'`
    );
    expect(scheduled[0].posting_status).toBe("SCHEDULED");

    const accruals = await vouchersLike("ACCR-RENT-%");
    expect(accruals.length).toBeGreaterThan(0);
    for (const voucher of accruals) expect(voucher.voucher_date).toBe(today);
    const { rows: audit } = await pool.query(
      `SELECT username, changes FROM audit_log WHERE company_id = $1 AND table_name = 'vouchers' AND record_id = $2`,
      [ctx.companyId, accruals[0].id]
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].username).toBe(USERNAME);
    expect(audit[0].changes.trigger.new).toBe("manual");
    await reopenBooks();

    // Once the period is open the same action posts the scheduled payment, audited in its transaction.
    const reopened = await agent.post("/api/erp/rental/accruals/post-due");
    expect(reopened.status).toBe(200);
    expect(reopened.body).toMatchObject({ scheduledPaymentsPosted: 1, scheduledPaymentsFailed: 0, skipped: [] });
    const { rows: paymentAudit } = await pool.query(
      `SELECT username, changes FROM audit_log
        WHERE company_id = $1 AND record_identifier = 'rental-scheduled-payment:PG-W18-CLOSED'`,
      [ctx.companyId]
    );
    expect(paymentAudit).toHaveLength(1);
    expect(paymentAudit[0].username).toBe(USERNAME);
    expect(paymentAudit[0].changes.payments.new[0].postingStatus).toBe("POSTED");

    await pool.query(`UPDATE user_company_roles SET role = 'Normal User' WHERE user_id = $1 AND company_id = $2`, [
      ctx.userId,
      ctx.companyId,
    ]);
    try {
      await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
      expect((await agent.post("/api/erp/rental/accruals/post-due")).status).toBe(403);
    } finally {
      await pool.query(`UPDATE user_company_roles SET role = 'Owner' WHERE user_id = $1 AND company_id = $2`, [
        ctx.userId,
        ctx.companyId,
      ]);
      await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
    }
  });
});
