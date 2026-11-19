/**
 * Wave 16 (A), owner decision of 2026-10-09 — the Properties deferred rent
 * reclassification no longer runs at boot or on a PROPERTIES request; it is an
 * Owner preview (read-only, plan hash) / apply (confirm + hash, one
 * transaction, current company, closed period refused, audited) tool.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { getCompanyBusinessDate } from "../server/lib/dateUtils";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "w16rent";
const BASE = "/api/properties/rental/admin/deferred-rent-reclassification";
let ctx: TestContext;
let agent: request.SuperAgentTest;
let deferredId: number;
let incomeId: number;

async function account(code: string, name: string, accountType: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, $4, 0, 'Cr') RETURNING id`,
    [ctx.companyId, code, name, accountType]
  );
  return rows[0].id;
}

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

const reclassVouchers = async () =>
  (
    await pool.query(
      `SELECT id, voucher_number, voucher_date::text AS voucher_date FROM vouchers
        WHERE company_id = $1 AND voucher_number LIKE 'RENT-DEF-RECLASS-%' AND deleted_at IS NULL`,
      [ctx.companyId]
    )
  ).rows;

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  await pool.query(`UPDATE companies SET company_type = 'properties' WHERE id = $1`, [ctx.companyId]);
  await pool.query(`UPDATE user_company_roles SET role = 'Owner' WHERE user_id = $1 AND company_id = $2`, [
    ctx.userId,
    ctx.companyId,
  ]);
  deferredId = await account("DEF-RENT-REV", "Deferred Rent Revenue", "Liability");
  incomeId = await account("RENT-INC", "Rental Income - Properties", "Income");
  await journal(`${TEST_PREFIX}-RCPT-1`, "2026-01-10", ctx.cashAccountId, deferredId, "150.00");
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
}, 120_000);

afterAll(async () => {
  const id = ctx.companyId;
  await pool.query(`DELETE FROM fiscal_period_closures WHERE company_id = $1`, [id]);
  await pool.query(`DELETE FROM accounting_posting_requests WHERE company_id = $1`, [id]);
  await pool.query(`DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`, [
    id,
  ]);
  await pool.query(`DELETE FROM vouchers WHERE company_id = $1`, [id]);
  await deleteAuditLogRowsForTests(pool, "company_id = $1", [id]);
  await pool.query(`UPDATE companies SET company_type = 'erp' WHERE id = $1`, [id]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 120_000);

describe("deferred rent reclassification (Owner preview/apply)", () => {
  it("does not run when the routes register or on a PROPERTIES request", async () => {
    await agent.get("/api/properties/rental/units");
    expect(await reclassVouchers()).toEqual([]);
    const { rows } = await pool.query(`SELECT active, is_hidden FROM ledger_accounts WHERE id = $1`, [deferredId]);
    expect(rows[0]).toEqual({ active: true, is_hidden: false });
  });

  it("previews the journal read-only, refuses a closed date, a missing or stale hash, and a non-Owner", async () => {
    const preview = await agent.get(`${BASE}/plan`);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      deferredAccount: { id: deferredId },
      incomeAccount: { id: incomeId },
      deferredClosing: "-150.00",
      blockers: [],
      hideAccount: { before: { active: true, isHidden: false }, after: { active: false, isHidden: true } },
    });
    expect(preview.body.journal.lines).toEqual([
      expect.objectContaining({ ledgerAccountId: deferredId, debit: "150.00", credit: "0.00" }),
      expect.objectContaining({ ledgerAccountId: incomeId, debit: "0.00", credit: "150.00" }),
    ]);
    expect(preview.body.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await reclassVouchers()).toEqual([]);

    expect((await agent.post(`${BASE}/apply`).send({ confirm: true })).status).toBe(400);
    expect((await agent.post(`${BASE}/apply`).send({ planHash: preview.body.planHash })).status).toBe(400);
    const stale = await agent.post(`${BASE}/apply`).send({ confirm: true, planHash: "0".repeat(64) });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("PLAN_CHANGED");

    // A closure covering the business date refuses the apply.
    const today = getCompanyBusinessDate(null);
    const closing = await journal(`${TEST_PREFIX}-CLOSE`, today, ctx.cashAccountId, ctx.salesAccountId, "1.00");
    await pool.query(
      `INSERT INTO fiscal_period_closures (company_id, period_start_date, period_end_date, closed_by_user_id,
         closing_voucher_id, retained_earnings_account_id, total_income, total_expense, net_income, status)
       VALUES ($1, $2, $2, $3, $4, $5, 0, 0, 0, 'CLOSED')`,
      [ctx.companyId, today, ctx.userId, closing, ctx.cashAccountId]
    );
    const closedPlan = await agent.get(`${BASE}/plan`);
    expect(closedPlan.body.blockers).toContain("PERIOD_CLOSED");
    const refused = await agent.post(`${BASE}/apply`).send({ confirm: true, planHash: closedPlan.body.planHash });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("PERIOD_CLOSED");
    await pool.query(`DELETE FROM fiscal_period_closures WHERE company_id = $1`, [ctx.companyId]);
    expect(await reclassVouchers()).toEqual([]);

    await pool.query(`UPDATE user_company_roles SET role = 'Admin' WHERE user_id = $1 AND company_id = $2`, [
      ctx.userId,
      ctx.companyId,
    ]);
    try {
      await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
      expect((await agent.get(`${BASE}/plan`)).status).toBe(403);
    } finally {
      await pool.query(`UPDATE user_company_roles SET role = 'Owner' WHERE user_id = $1 AND company_id = $2`, [
        ctx.userId,
        ctx.companyId,
      ]);
      await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
    }
  });

  it("applies the reviewed plan once: posts the journal, hides the account, audits before and after", async () => {
    const preview = await agent.get(`${BASE}/plan`);
    const applied = await agent.post(`${BASE}/apply`).send({ confirm: true, planHash: preview.body.planHash });
    expect(applied.status).toBe(200);
    expect(applied.body.voucherId).toEqual(expect.any(Number));

    const posted = await reclassVouchers();
    expect(posted).toHaveLength(1);
    expect(posted[0].voucher_date).toBe(preview.body.voucherDate);
    const { rows: lines } = await pool.query(
      `SELECT ledger_account_id, debit_amount::text AS debit, credit_amount::text AS credit
         FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
      [posted[0].id]
    );
    expect(lines.map((line) => [line.ledger_account_id, Number(line.debit), Number(line.credit)])).toEqual([
      [deferredId, 150, 0],
      [incomeId, 0, 150],
    ]);
    const { rows: flags } = await pool.query(`SELECT active, is_hidden FROM ledger_accounts WHERE id = $1`, [
      deferredId,
    ]);
    expect(flags[0]).toEqual({ active: false, is_hidden: true });

    const { rows: audits } = await pool.query(
      `SELECT changes FROM audit_log WHERE company_id = $1 AND record_identifier = 'properties-deferred-rent-reclassification'`,
      [ctx.companyId]
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].changes).toMatchObject({
      deferredAccount: {
        old: { id: deferredId, active: true, isHidden: false },
        new: { active: false, isHidden: true },
      },
      deferredClosing: { old: "-150.00", new: "0.00" },
    });

    const after = await agent.get(`${BASE}/plan`);
    expect(after.body.deferredClosing).toBe("0.00");
    expect(after.body.blockers).toEqual(["NOTHING_TO_APPLY"]);
    const again = await agent.post(`${BASE}/apply`).send({ confirm: true, planHash: after.body.planHash });
    expect(again.status).toBe(400);
    expect(await reclassVouchers()).toHaveLength(1);
  });

  it("refuses a company that is not a Properties company", async () => {
    await pool.query(`UPDATE companies SET company_type = 'erp' WHERE id = $1`, [ctx.companyId]);
    try {
      const preview = await agent.get(`${BASE}/plan`);
      expect(preview.body.blockers).toContain("NOT_PROPERTIES_COMPANY");
    } finally {
      await pool.query(`UPDATE companies SET company_type = 'properties' WHERE id = $1`, [ctx.companyId]);
    }
  });
});
