/**
 * Wave 9 (ledger safety) — destructive admin routes that rewrite or delete
 * accounting history.
 *
 *   - POST /api/admin/reset-company-data, company-data-reset and
 *     undo-company-reset are Owner-only, act on the session's company only,
 *     run in one transaction and write an audit_log row. Undo restores only the
 *     vouchers the last soft reset deleted.
 *   - DELETE /api/deleted-items/voucher/:id/permanent is Admin/Owner-only, runs
 *     in one transaction, is audited, and refuses a fiscal-period closing
 *     voucher instead of deleting the closure row.
 *   - POST /api/deleted-items/voucher/:id/restore is Admin/Owner-only and audited.
 *   - Deleting one side of an inter-company transfer soft-deletes the other
 *     company's voucher (lines kept) and audits it under that company.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX_A = "w9histA";
const PREFIX_B = "w9histB";

let a: TestContext;
let b: TestContext;
let agent: request.SuperAgentTest;
let seq = 0;

async function setRole(role: string): Promise<void> {
  await db.update(schema.userCompanyRoles).set({ role }).where(eq(schema.userCompanyRoles.userId, a.userId));
  const res = await agent.post("/api/auth/set-company").send({ companyId: a.companyId });
  expect(res.status, res.text).toBe(200);
}

async function journal(
  ctx: TestContext,
  voucherType = "Journal",
  options: { deleted?: boolean; date?: string } = {}
): Promise<number> {
  seq += 1;
  const voucher = await pool.query<{ id: number }>(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, deleted_at)
     VALUES ($1, $2, $3, $4, '40.00', $5) RETURNING id`,
    [
      ctx.companyId,
      `W9H-${ctx.companyId}-${seq}`,
      voucherType,
      options.date ?? "2026-05-10",
      options.deleted ? new Date() : null,
    ]
  );
  const id = voucher.rows[0].id;
  await pool.query(
    `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount)
     VALUES ($1, $2, '40.00', '0'), ($1, $3, '0', '40.00')`,
    [id, ctx.cashAccountId, ctx.salesAccountId]
  );
  return id;
}

async function count(sqlText: string, params: unknown[]): Promise<number> {
  const result = await pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${sqlText}`, params);
  return result.rows[0].n;
}

async function auditRows(companyId: number, tableName: string, extra = "", params: unknown[] = []) {
  const result = await pool.query<{
    id: number;
    action: string;
    record_id: number | null;
    record_identifier: string | null;
    changes: Record<string, { old?: unknown; new?: unknown }>;
  }>(
    `SELECT id, action, record_id, record_identifier, changes FROM audit_log
     WHERE company_id = $1 AND table_name = $2 ${extra} ORDER BY id`,
    [companyId, tableName, ...params]
  );
  return result.rows;
}

beforeAll(async () => {
  a = await seedTestData(PREFIX_A);
  b = await seedTestData(PREFIX_B);
  agent = request.agent(a.app) as request.SuperAgentTest;
  const login = await agent
    .post("/api/auth/login")
    .send({ username: `${PREFIX_A}_testuser`, password: "testpassword123" });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status} ${login.text}`);
  const selected = await agent.post("/api/auth/set-company").send({ companyId: a.companyId });
  if (selected.status !== 200) throw new Error(`set-company failed: ${selected.status} ${selected.text}`);
}, 120_000);

afterAll(async () => {
  for (const ctx of [a, b]) {
    if (!ctx) continue;
    await pool
      .query(`DELETE FROM inter_company_transfers WHERE from_company_id = $1 OR to_company_id = $1`, [ctx.companyId])
      .catch(() => undefined);
  }
  if (a) await cleanupTestData(PREFIX_A);
  if (b) await cleanupTestData(PREFIX_B);
  closeTestServer();
}, 120_000);

describe("POST /api/admin/reset-company-data", () => {
  it("is refused for an Admin (Owner-only) and leaves the vouchers in place", async () => {
    await setRole("Admin");
    const id = await journal(a);
    const response = await agent.post("/api/admin/reset-company-data").send({ companyId: a.companyId });
    expect(response.status, response.text).toBe(403);
    expect(await count(`vouchers WHERE id = $1`, [id])).toBe(1);
  });

  it("is refused for another company's id even for the Owner", async () => {
    await setRole("Owner");
    const foreign = await journal(b);
    const response = await agent.post("/api/admin/reset-company-data").send({ companyId: b.companyId });
    expect(response.status, response.text).toBe(403);
    expect(await count(`vouchers WHERE id = $1`, [foreign])).toBe(1);
  });

  it("deletes the company's Payment/Receipt/Journal vouchers, their lines and posting identities, and audits it", async () => {
    await setRole("Owner");
    const journalId = await journal(a, "Journal");
    const paymentId = await journal(a, "Payment");
    const salesId = await journal(a, "Sales");
    // An engine-posted voucher: its posting identity restricts the voucher delete.
    await pool.query(
      `INSERT INTO accounting_posting_requests (company_id, idempotency_key, source_type, source_id, request_fingerprint, voucher_id)
       VALUES ($1, $2, 'w9-test', $3, $4, $5)`,
      [a.companyId, `w9-reset-${paymentId}`, String(paymentId), "f".repeat(64), paymentId]
    );

    const response = await agent.post("/api/admin/reset-company-data").send({});
    expect(response.status, response.text).toBe(200);

    expect(await count(`vouchers WHERE id = ANY($1::int[])`, [[journalId, paymentId]])).toBe(0);
    expect(await count(`voucher_entries WHERE voucher_id = ANY($1::int[])`, [[journalId, paymentId]])).toBe(0);
    expect(await count(`accounting_posting_requests WHERE voucher_id = $1`, [paymentId])).toBe(0);
    expect(await count(`vouchers WHERE id = $1`, [salesId])).toBe(1);

    const audits = await auditRows(a.companyId, "company_data_reset", `AND record_identifier = 'reset-company-data'`);
    expect(audits).toHaveLength(1);
    const pages = audits[0].changes.vouchers.old as Array<Array<{ id: number }>>;
    const ids = pages.flat().map((row) => row.id);
    expect(ids).toEqual(expect.arrayContaining([journalId, paymentId]));
    expect(ids).not.toContain(salesId);
  });

  it("refuses (409) a reset that would delete a fiscal-period closing voucher", async () => {
    await setRole("Owner");
    const first = await journal(a, "Journal");
    const closing = await journal(a, "Journal");
    await pool.query(
      `INSERT INTO fiscal_period_closures (company_id, period_start_date, period_end_date, closed_by_user_id,
         closing_voucher_id, retained_earnings_account_id, total_income, total_expense, net_income, status)
       VALUES ($1, '2020-01-01', '2020-12-31', $2, $3, $4, '0', '0', '0', 'REOPENED')`,
      [a.companyId, a.userId, closing, a.salesAccountId]
    );
    try {
      const response = await agent.post("/api/admin/reset-company-data").send({ companyId: a.companyId });
      expect(response.status, response.text).toBe(409);
      expect(await count(`vouchers WHERE id = ANY($1::int[])`, [[first, closing]])).toBe(2);
    } finally {
      await pool.query(`DELETE FROM fiscal_period_closures WHERE closing_voucher_id = $1`, [closing]);
    }
  });

  it("rolls the whole reset back when one voucher cannot be deleted", async () => {
    await setRole("Owner");
    const first = await journal(a, "Journal");
    const linked = await journal(a, "Payment");
    const other = await journal(b, "Receipt");
    // inter_company_transfers restricts deleting the voucher it links.
    const [transfer] = await db
      .insert(schema.interCompanyTransfers)
      .values({
        transferType: "Cash",
        fromCompanyId: a.companyId,
        toCompanyId: b.companyId,
        transferDate: "2026-05-10",
        amount: "40.00",
        fromLedgerAccountId: a.cashAccountId,
        toLedgerAccountId: b.cashAccountId,
        fromVoucherId: linked,
        toVoucherId: other,
      })
      .returning();
    try {
      const response = await agent.post("/api/admin/reset-company-data").send({ companyId: a.companyId });
      expect(response.status, response.text).toBeGreaterThanOrEqual(400);
      expect(await count(`vouchers WHERE id = ANY($1::int[])`, [[first, linked]])).toBe(2);
      expect(await count(`voucher_entries WHERE voucher_id = ANY($1::int[])`, [[first, linked]])).toBe(4);
      expect(
        await auditRows(a.companyId, "company_data_reset", `AND record_identifier = 'reset-company-data'`)
      ).toHaveLength(1);
    } finally {
      await db.delete(schema.interCompanyTransfers).where(eq(schema.interCompanyTransfers.id, transfer.id));
    }
  });
});

describe("company-data-reset and undo-company-reset", () => {
  it("records the zeroed opening balances and undo restores only that reset's vouchers", async () => {
    await setRole("Owner");
    // Clear what earlier cases left behind so this reset owns a known set.
    await pool.query(
      `DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`,
      [a.companyId]
    );
    await pool.query(`DELETE FROM vouchers WHERE company_id = $1`, [a.companyId]);

    const earlierDeleted = await journal(a, "Journal", { deleted: true });
    const live = await journal(a, "Payment");
    await pool.query(
      `UPDATE ledger_accounts SET opening_balance = '125.00', opening_balance_side = 'Dr' WHERE id = $1`,
      [a.cashAccountId]
    );

    const refused = await agent
      .post("/api/admin/company-data-reset")
      .send({ companyId: b.companyId, accountIds: [], clearStockOpeningBalances: false });
    expect(refused.status, refused.text).toBe(403);

    const reset = await agent
      .post("/api/admin/company-data-reset")
      .send({ companyId: a.companyId, accountIds: [a.cashAccountId], clearStockOpeningBalances: false });
    expect(reset.status, reset.text).toBe(200);
    expect(reset.body.results.vouchersDeleted).toBe(1);

    const opening = await pool.query(`SELECT opening_balance FROM ledger_accounts WHERE id = $1`, [a.cashAccountId]);
    expect(Number(opening.rows[0].opening_balance)).toBe(0);

    const [audit] = await auditRows(a.companyId, "company_data_reset", `AND record_identifier = 'company-data-reset'`);
    const balances = (audit.changes.openingBalances.old as Array<Array<Record<string, unknown>>>).flat();
    expect(balances).toEqual([
      expect.objectContaining({ id: a.cashAccountId, openingBalance: "125.00", openingBalanceSide: "Dr" }),
    ]);

    // Undo matches the reset's own deleted_at: the voucher deleted before the
    // reset stays deleted.
    const undo = await agent.post("/api/admin/undo-company-reset").send({ companyId: a.companyId });
    expect(undo.status, undo.text).toBe(200);
    expect(undo.body.vouchersRestored).toBe(1);
    const rows = await pool.query<{ id: number; deleted_at: Date | null }>(
      `SELECT id, deleted_at FROM vouchers WHERE id = ANY($1::int[])`,
      [[earlierDeleted, live]]
    );
    const byId = new Map(rows.rows.map((row) => [row.id, row.deleted_at]));
    expect(byId.get(live)).toBeNull();
    expect(byId.get(earlierDeleted)).not.toBeNull();

    const undoAudit = await auditRows(a.companyId, "company_data_reset", `AND action = 'restore'`);
    expect(undoAudit).toHaveLength(1);
    expect(undoAudit[0].record_id).toBe(audit.id);

    // The same reset cannot be undone twice.
    const again = await agent.post("/api/admin/undo-company-reset").send({ companyId: a.companyId });
    expect(again.status, again.text).toBe(404);
  });

  it("is Owner-only", async () => {
    await setRole("Admin");
    const reset = await agent
      .post("/api/admin/company-data-reset")
      .send({ companyId: a.companyId, accountIds: [], clearStockOpeningBalances: false });
    expect(reset.status).toBe(403);
    const undo = await agent.post("/api/admin/undo-company-reset").send({ companyId: a.companyId });
    expect(undo.status).toBe(403);
  });
});

describe("deleted items: vouchers", () => {
  it("refuses to permanently delete a fiscal-period closing voucher and keeps the closure row", async () => {
    await setRole("Admin");
    const closing = await journal(a, "Journal", { deleted: true });
    await pool.query(
      `INSERT INTO fiscal_period_closures (company_id, period_start_date, period_end_date, closed_by_user_id,
         closing_voucher_id, retained_earnings_account_id, total_income, total_expense, net_income, status)
       VALUES ($1, '2019-01-01', '2019-12-31', $2, $3, $4, '0', '0', '0', 'REOPENED')`,
      [a.companyId, a.userId, closing, a.salesAccountId]
    );
    try {
      const response = await agent.delete(`/api/deleted-items/voucher/${closing}/permanent`);
      expect(response.status, response.text).toBe(409);
      expect(await count(`fiscal_period_closures WHERE closing_voucher_id = $1`, [closing])).toBe(1);
      expect(await count(`vouchers WHERE id = $1`, [closing])).toBe(1);
    } finally {
      await pool.query(`DELETE FROM fiscal_period_closures WHERE closing_voucher_id = $1`, [closing]);
    }
  });

  it("permanently deletes a voucher for an Admin, atomically and audited with its lines", async () => {
    await setRole("Admin");
    const id = await journal(a, "Journal", { deleted: true });
    const response = await agent.delete(`/api/deleted-items/voucher/${id}/permanent`);
    expect(response.status, response.text).toBe(200);
    expect(await count(`vouchers WHERE id = $1`, [id])).toBe(0);
    const audits = await auditRows(a.companyId, "vouchers", `AND record_id = $3 AND action = 'delete'`, [id]);
    expect(audits).toHaveLength(1);
    expect(audits[0].changes.entries.old).toHaveLength(2);
    expect(audits[0].changes.voucher.old).toMatchObject({ id });
  });

  it("refuses permanent delete and restore of a voucher for a Manager", async () => {
    await setRole("Manager");
    const id = await journal(a, "Journal", { deleted: true });
    const permanent = await agent.delete(`/api/deleted-items/voucher/${id}/permanent`);
    expect(permanent.status, permanent.text).toBe(403);
    const restore = await agent.post(`/api/deleted-items/voucher/${id}/restore`);
    expect(restore.status, restore.text).toBe(403);
    const row = await pool.query(`SELECT deleted_at FROM vouchers WHERE id = $1`, [id]);
    expect(row.rows[0].deleted_at).not.toBeNull();
  });

  it("restores a voucher for an Admin and audits the restore", async () => {
    await setRole("Admin");
    const id = await journal(a, "Journal", { deleted: true });
    const response = await agent.post(`/api/deleted-items/voucher/${id}/restore`);
    expect(response.status, response.text).toBe(200);
    const row = await pool.query(`SELECT deleted_at FROM vouchers WHERE id = $1`, [id]);
    expect(row.rows[0].deleted_at).toBeNull();
    const audits = await auditRows(a.companyId, "vouchers", `AND record_id = $3 AND action = 'restore'`, [id]);
    expect(audits).toHaveLength(1);
  });
});

describe("inter-company voucher delete", () => {
  it.each([
    ["Contra", "Contra"],
    ["Payment", "Receipt"],
    ["Journal", "Journal"],
  ])(
    "soft-deletes the %s counterpart voucher, keeps its lines and audits it under its company",
    async (fromType, toType) => {
      await setRole("Admin");
      // Each pair reaches a different DELETE /api/vouchers/:id handler: Payment/Receipt
      // and Journal the central lifecycle routes, Contra voucher-entries/delete.ts.
      const fromVoucherId = await journal(a, fromType);
      const toVoucherId = await journal(b, toType);
      await db.insert(schema.interCompanyTransfers).values({
        transferType: "Cash",
        fromCompanyId: a.companyId,
        toCompanyId: b.companyId,
        transferDate: "2026-05-10",
        amount: "40.00",
        fromLedgerAccountId: a.cashAccountId,
        toLedgerAccountId: b.cashAccountId,
        fromVoucherId,
        toVoucherId,
      });

      const response = await agent.delete(`/api/vouchers/${fromVoucherId}`);
      expect(response.status, response.text).toBe(200);

      const counterpart = await pool.query(`SELECT deleted_at FROM vouchers WHERE id = $1`, [toVoucherId]);
      expect(counterpart.rows).toHaveLength(1);
      expect(counterpart.rows[0].deleted_at).not.toBeNull();
      expect(await count(`voucher_entries WHERE voucher_id = $1`, [toVoucherId])).toBe(2);

      const audits = await auditRows(b.companyId, "vouchers", `AND record_id = $3 AND action = 'delete'`, [
        toVoucherId,
      ]);
      expect(audits).toHaveLength(1);
      expect(audits[0].changes.interCompanyCounterpartOf.old).toMatchObject({ voucherId: fromVoucherId });
    }
  );

  it("bulk delete also soft-deletes the counterpart voucher", async () => {
    await setRole("Admin");
    const fromVoucherId = await journal(a, "Payment");
    const toVoucherId = await journal(b, "Receipt");
    await db.insert(schema.interCompanyTransfers).values({
      transferType: "Cash",
      fromCompanyId: a.companyId,
      toCompanyId: b.companyId,
      transferDate: "2026-05-10",
      amount: "40.00",
      fromLedgerAccountId: a.cashAccountId,
      toLedgerAccountId: b.cashAccountId,
      fromVoucherId,
      toVoucherId,
    });

    const response = await agent.post(`/api/vouchers/bulk-delete`).send({ voucherIds: [fromVoucherId] });
    expect(response.status, response.text).toBe(200);
    expect(response.body.deletedCount).toBe(1);

    const counterpart = await pool.query(`SELECT deleted_at FROM vouchers WHERE id = $1`, [toVoucherId]);
    expect(counterpart.rows[0].deleted_at).not.toBeNull();
    expect(await count(`voucher_entries WHERE voucher_id = $1`, [toVoucherId])).toBe(2);
    expect(
      await auditRows(b.companyId, "vouchers", `AND record_id = $3 AND action = 'delete'`, [toVoucherId])
    ).toHaveLength(1);
  });
});
