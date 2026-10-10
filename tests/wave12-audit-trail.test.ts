/**
 * Wave 12 (B) — audit trail and destructive routes (owner decisions 2–4).
 *
 *   - audit_log is append-only: UPDATE, DELETE and TRUNCATE are refused; the
 *     retention job alone may delete, and only non-financial rows.
 *   - A voucher edit is audited inside its transaction: when the audit insert
 *     fails, the edit rolls back. Delete audits keep every line (> 100).
 *   - Company delete: Owner only, refused (409) with history, allowed and
 *     audited for an empty company; the company's audit rows survive.
 *   - Permanent delete of an orphaned POS sale, an employee or a customer is
 *     refused while posted lines name it.
 *   - Salary advance, rental auto-transfer and employee balance sync are
 *     atomic with their transaction.
 *
 * One file with several describes (the CI backend job is near its limit).
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import { ensureAuditLogAppendOnlyGuard } from "../server/services/audit/auditLogAppendOnlyGuard";
import { pruneRemoteSupportAuditRows } from "../server/services/remoteSupportAuditRetention";
import { syncEmployeeBalancesFromEntries } from "../server/routes/helpers/employeeHelpers";
import { maybeRunAutoTransfer } from "../server/routes/rental/shared/auto-transfer";
import { KNOWN_SECURITY_PERMISSIONS } from "../server/services/security/namedPermissionService";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "w12baudit";
let ctx: TestContext;
let agent: ReturnType<typeof request.agent>;
const extraCompanyIds: number[] = [];
const deletedCompanyIds: number[] = [];
let ownerUserId: string | null = null;

async function one<T>(text: string, params: unknown[] = []): Promise<T | undefined> {
  const result = await pool.query(text, params);
  return result.rows[0] as T | undefined;
}

async function count(text: string, params: unknown[] = []): Promise<number> {
  const row = await one<{ n: string }>(text, params);
  return Number(row?.n ?? 0);
}

/** A balanced Journal with `pairs` Dr/Cr pairs of 1.00 on the fixture's cash and sales accounts. */
async function insertJournal(number: string, pairs = 1, companyId = ctx.companyId): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const voucher = await client.query<{ id: number }>(
      `INSERT INTO vouchers (company_id, location_id, voucher_number, voucher_type, voucher_date, description,
                             total_amount, currency)
       VALUES ($1, $2, $3, 'Journal', CURRENT_DATE, 'wave 12 audit', $4, 'USD') RETURNING id`,
      [companyId, ctx.locationId, number, String(pairs)]
    );
    const id = voucher.rows[0].id;
    for (let index = 0; index < pairs; index += 1) {
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
         VALUES ($1, $2, '1.00', '0', $4), ($1, $3, '0', '1.00', $4)`,
        [id, ctx.cashAccountId, ctx.salesAccountId, `line ${index}`]
      );
    }
    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function createCompany(suffix: string): Promise<number> {
  const row = await one<{ id: number }>(
    `INSERT INTO companies (code, name, company_type, active, base_currency)
     VALUES ($1, $2, 'erp', true, 'USD') RETURNING id`,
    [`W12B${suffix}`.slice(0, 10), `${PREFIX}_${suffix}`]
  );
  extraCompanyIds.push(row!.id);
  return row!.id;
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  await ensureAuditLogAppendOnlyGuard(pool);
  agent = request.agent(ctx.app);
  const login = await agent
    .post("/api/auth/login")
    .send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
  expect(login.status).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
}, 120_000);

afterAll(async () => {
  const ids = [ctx.companyId, ...extraCompanyIds];
  await pool.query(`DROP TRIGGER IF EXISTS w12b_reject_audit ON audit_log`).catch(() => undefined);
  await pool.query(`DROP FUNCTION IF EXISTS w12b_reject_audit_fn()`).catch(() => undefined);
  await pool
    .query(`DELETE FROM inter_company_transfers WHERE from_company_id = ANY($1) OR to_company_id = ANY($1)`, [ids])
    .catch(() => undefined);
  await pool.query(`DELETE FROM rental_auto_transfer_configs WHERE company_id = ANY($1)`, [ids]).catch(() => undefined);
  await pool.query(`DELETE FROM salary_advances WHERE company_id = ANY($1)`, [ids]).catch(() => undefined);
  await deleteAuditLogRowsForTests(pool, "company_id = ANY($1::int[])", [[...ids, ...deletedCompanyIds]]);
  await cleanupTestData(PREFIX);
  if (ownerUserId) {
    await pool.query(`DELETE FROM user_security_permissions WHERE user_id = $1`, [ownerUserId]).catch(() => undefined);
    await pool.query(`DELETE FROM user_company_roles WHERE user_id = $1`, [ownerUserId]).catch(() => undefined);
    await pool.query(`DELETE FROM users WHERE id = $1`, [ownerUserId]).catch(() => undefined);
  }
  closeTestServer();
}, 120_000);

describe("audit_log is append-only", () => {
  it("refuses UPDATE, DELETE and TRUNCATE of audit rows", async () => {
    const row = await one<{ id: number }>(
      `INSERT INTO audit_log (user_id, username, company_id, action, table_name, record_identifier)
       VALUES ('w12b', 'w12b', $1, 'update', 'vouchers', 'w12b-append-only') RETURNING id`,
      [ctx.companyId]
    );
    await expect(pool.query(`UPDATE audit_log SET username = 'x' WHERE id = $1`, [row!.id])).rejects.toThrow(
      /AUDIT_LOG_APPEND_ONLY/
    );
    await expect(pool.query(`DELETE FROM audit_log WHERE id = $1`, [row!.id])).rejects.toThrow(/AUDIT_LOG_APPEND_ONLY/);

    // TRUNCATE inside a transaction that is rolled back whatever happens.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '5s'");
      await expect(client.query("TRUNCATE audit_log")).rejects.toThrow(/AUDIT_LOG_APPEND_ONLY|lock timeout/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect(await count(`SELECT COUNT(*) AS n FROM audit_log WHERE id = $1`, [row!.id])).toBe(1);
  });

  it("lets the retention job prune only non-financial rows", async () => {
    const insertOld = async (tableName: string, action: string) =>
      (await one<{ id: number }>(
        `INSERT INTO audit_log (user_id, username, company_id, action, table_name, record_identifier, created_at)
         VALUES ('w12b', 'w12b', $1, $2, $3, 'w12b-retention', now() - interval '400 days') RETURNING id`,
        [ctx.companyId, action, tableName]
      ))!.id;
    const remoteSupport = await insertOld("remote_support_sessions", "remote_support_view");
    const financialTagged = await insertOld("vouchers", "remote_support_view");
    const factoryTagged = await insertOld("factory_containers", "remote_support_view");

    // Even with the retention setting, a financial row cannot be deleted.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.audit_log_maintenance', 'retention', true)");
      await expect(client.query(`DELETE FROM audit_log WHERE id = $1`, [financialTagged])).rejects.toThrow(
        /AUDIT_LOG_APPEND_ONLY/
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }

    await pruneRemoteSupportAuditRows();

    expect(await count(`SELECT COUNT(*) AS n FROM audit_log WHERE id = $1`, [remoteSupport])).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM audit_log WHERE id = $1`, [financialTagged])).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM audit_log WHERE id = $1`, [factoryTagged])).toBe(1);
  });
});

describe("voucher edits and deletes are audited in their transaction", () => {
  it("rolls an edit back when its audit write fails, and keeps the full snapshot when it succeeds", async () => {
    const voucherId = await insertJournal(`${PREFIX}-EDIT`);
    await pool.query(`
      CREATE OR REPLACE FUNCTION w12b_reject_audit_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'w12b injected audit failure'; END; $$`);
    await pool.query(`
      CREATE TRIGGER w12b_reject_audit BEFORE INSERT ON audit_log FOR EACH ROW
      WHEN (NEW.company_id = ${ctx.companyId} AND NEW.table_name = 'vouchers')
      EXECUTE FUNCTION w12b_reject_audit_fn()`);
    try {
      const refused = await agent.patch(`/api/vouchers/${voucherId}`).send({ description: "edited" });
      expect(refused.status).toBeGreaterThanOrEqual(400);
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS w12b_reject_audit ON audit_log`);
    }
    expect(
      (await one<{ description: string }>(`SELECT description FROM vouchers WHERE id = $1`, [voucherId]))!.description
    ).toBe("wave 12 audit");

    const edited = await agent.patch(`/api/vouchers/${voucherId}`).send({ description: "edited" });
    expect(edited.status).toBe(200);
    const audit = await one<{ changes: Record<string, { old?: unknown; new?: unknown }> }>(
      `SELECT changes FROM audit_log WHERE company_id = $1 AND table_name = 'vouchers' AND record_id = $2
        AND action = 'update' ORDER BY id DESC LIMIT 1`,
      [ctx.companyId, voucherId]
    );
    expect(audit!.changes.description).toEqual({ old: "wave 12 audit", new: "edited" });
    expect((audit!.changes.entryRows.old as unknown[]).length).toBe(2);
    expect((audit!.changes.entryRows.new as unknown[]).length).toBe(2);
    expect((audit!.changes.voucher.new as { description: string }).description).toBe("edited");
  }, 60_000);

  it("keeps every line of a voucher with more than 100 lines in its delete audit", async () => {
    const voucherId = await insertJournal(`${PREFIX}-BIG`, 60);
    const deleted = await agent.delete(`/api/vouchers/${voucherId}`);
    expect(deleted.status).toBe(200);
    const audit = await one<{ changes: Record<string, { old?: unknown[] }> }>(
      `SELECT changes FROM audit_log WHERE company_id = $1 AND table_name = 'vouchers' AND record_id = $2
        AND action = 'delete' ORDER BY id DESC LIMIT 1`,
      [ctx.companyId, voucherId]
    );
    expect(audit!.changes.entryRows.old).toHaveLength(120);
    expect(audit!.changes.entries.old).toHaveLength(120);
  }, 60_000);
});

describe("company delete", () => {
  let ownerAgent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    const owner = await one<{ id: string }>(
      `INSERT INTO users (username, password) SELECT $1, password FROM users WHERE id = $2 RETURNING id`,
      [`${PREFIX}_owner`, ctx.userId]
    );
    ownerUserId = owner!.id;
    await pool.query(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, 'Owner')`, [
      ownerUserId,
      ctx.companyId,
    ]);
    for (const permission of KNOWN_SECURITY_PERMISSIONS) {
      await pool.query(
        `INSERT INTO user_security_permissions (user_id, company_id, permission, granted_by) VALUES ($1, $2, $3, $1)`,
        [ownerUserId, ctx.companyId, permission]
      );
    }
    ownerAgent = request.agent(ctx.app);
    expect(
      (await ownerAgent.post("/api/auth/login").send({ username: `${PREFIX}_owner`, password: "testpassword123" }))
        .status
    ).toBe(200);
    expect((await ownerAgent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
  }, 60_000);

  it("is refused for an Admin, and with 409 for a company that has vouchers", async () => {
    const companyId = await createCompany("HIST");
    await pool.query(
      `INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, 'Owner'), ($3, $2, 'Admin')`,
      [ownerUserId, companyId, ctx.userId]
    );
    await pool.query(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency, optional)
       VALUES ($1, $2, 'Journal', CURRENT_DATE, '0', 'USD', true)`,
      [companyId, `${PREFIX}-HIST`]
    );

    expect((await agent.delete(`/api/companies/${companyId}`)).status).toBe(403);
    const refused = await ownerAgent.delete(`/api/companies/${companyId}`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("COMPANY_HAS_HISTORY");
    expect(refused.body.blockers).toContain("vouchers");
    expect(await count(`SELECT COUNT(*) AS n FROM companies WHERE id = $1`, [companyId])).toBe(1);
  }, 60_000);

  it("deletes an empty company in one audited transaction and keeps its audit rows", async () => {
    const companyId = await createCompany("EMPTY");
    await pool.query(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, 'Owner')`, [
      ownerUserId,
      companyId,
    ]);
    await pool.query(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance) VALUES ($1, $2, 'Cash', 'Cash', '0')`,
      [companyId, `${PREFIX}-EC`]
    );
    await pool.query(
      `INSERT INTO audit_log (user_id, username, company_id, action, table_name, record_identifier)
       VALUES ('w12b', 'w12b', $1, 'create', 'ledger_accounts', 'w12b-before-delete')`,
      [companyId]
    );

    const deleted = await ownerAgent.delete(`/api/companies/${companyId}`);
    expect(deleted.status).toBe(200);
    deletedCompanyIds.push(companyId);
    expect(await count(`SELECT COUNT(*) AS n FROM companies WHERE id = $1`, [companyId])).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM ledger_accounts WHERE company_id = $1`, [companyId])).toBe(0);
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM audit_log WHERE company_id = $1 AND table_name = 'companies' AND action = 'delete'`,
        [companyId]
      )
    ).toBe(1);
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM audit_log WHERE company_id = $1 AND record_identifier = 'w12b-before-delete'`,
        [companyId]
      )
    ).toBe(1);
  }, 60_000);
});

describe("permanent delete from Deleted Items", () => {
  it("refuses a posted orphaned POS sale and deletes an empty one with an audit row", async () => {
    const orphanLocation = await one<{ id: number }>(
      `INSERT INTO locations (company_id, code, name, deleted_at) VALUES ($1, $2, $3, now()) RETURNING id`,
      [ctx.companyId, `${PREFIX}-ORPH`, `${PREFIX}_Orphan`]
    );
    const posted = await insertJournal(`${PREFIX}-POSP`);
    await pool.query(`UPDATE vouchers SET location_id = $2, voucher_type = 'Sales' WHERE id = $1`, [
      posted,
      orphanLocation!.id,
    ]);
    const refused = await agent.delete(`/api/deleted-items/orphanedPosSale/${posted}/permanent`);
    expect(refused.status).toBe(409);
    expect(await count(`SELECT COUNT(*) AS n FROM voucher_entries WHERE voucher_id = $1`, [posted])).toBe(2);

    const empty = await one<{ id: number }>(
      `INSERT INTO vouchers (company_id, location_id, voucher_number, voucher_type, voucher_date, total_amount, currency)
       VALUES ($1, $2, $3, 'Sales', CURRENT_DATE, '0', 'USD') RETURNING id`,
      [ctx.companyId, orphanLocation!.id, `${PREFIX}-POSE`]
    );
    const removed = await agent.delete(`/api/deleted-items/orphanedPosSale/${empty!.id}/permanent`);
    expect(removed.status).toBe(200);
    expect(await count(`SELECT COUNT(*) AS n FROM vouchers WHERE id = $1`, [empty!.id])).toBe(0);
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM audit_log WHERE table_name = 'vouchers' AND record_id = $1 AND action = 'delete'`,
        [empty!.id]
      )
    ).toBe(1);
  }, 60_000);

  it("refuses an employee or customer named on a voucher line and deletes them otherwise, audited", async () => {
    const named = await one<{ id: number }>(
      `INSERT INTO employees (company_id, code, first_name, last_name, join_date) VALUES ($1, $2, 'Named', 'Emp', '2026-01-01') RETURNING id`,
      [ctx.companyId, `${PREFIX}-E1`]
    );
    const free = await one<{ id: number }>(
      `INSERT INTO employees (company_id, code, first_name, last_name, join_date) VALUES ($1, $2, 'Free', 'Emp', '2026-01-01') RETURNING id`,
      [ctx.companyId, `${PREFIX}-E2`]
    );
    const namedCustomer = await one<{ id: number }>(
      `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Named Customer') RETURNING id`,
      [ctx.companyId, `${PREFIX}-C1`]
    );
    const freeCustomer = await one<{ id: number }>(
      `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Free Customer') RETURNING id`,
      [ctx.companyId, `${PREFIX}-C2`]
    );
    const voucherId = await insertJournal(`${PREFIX}-PARTY`);
    const lines = await pool.query<{ id: number }>(`SELECT id FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`, [
      voucherId,
    ]);
    await pool.query(`UPDATE voucher_entries SET ledger_account_id = NULL, employee_id = $2 WHERE id = $1`, [
      lines.rows[0].id,
      named!.id,
    ]);
    await pool.query(`UPDATE voucher_entries SET ledger_account_id = NULL, customer_id = $2 WHERE id = $1`, [
      lines.rows[1].id,
      namedCustomer!.id,
    ]);
    await pool.query(`UPDATE employees SET deleted_at = now() WHERE id = ANY($1)`, [[named!.id, free!.id]]);
    await pool.query(`UPDATE customers SET deleted_at = now() WHERE id = ANY($1)`, [
      [namedCustomer!.id, freeCustomer!.id],
    ]);

    expect((await agent.delete(`/api/deleted-items/employee/${named!.id}/permanent`)).status).toBe(409);
    expect((await agent.delete(`/api/deleted-items/customer/${namedCustomer!.id}/permanent`)).status).toBe(409);
    expect(await one(`SELECT employee_id FROM voucher_entries WHERE id = $1`, [lines.rows[0].id])).toEqual({
      employee_id: named!.id,
    });
    expect(await one(`SELECT customer_id FROM voucher_entries WHERE id = $1`, [lines.rows[1].id])).toEqual({
      customer_id: namedCustomer!.id,
    });

    expect((await agent.delete(`/api/deleted-items/employee/${free!.id}/permanent`)).status).toBe(200);
    expect((await agent.delete(`/api/deleted-items/customer/${freeCustomer!.id}/permanent`)).status).toBe(200);
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM audit_log WHERE company_id = $1 AND action = 'delete'
           AND ((table_name = 'employees' AND record_id = $2) OR (table_name = 'customers' AND record_id = $3))`,
        [ctx.companyId, free!.id, freeCustomer!.id]
      )
    ).toBe(2);
  }, 60_000);
});

describe("atomic writers", () => {
  it("writes a salary advance's voucher, lines and advance together or not at all", async () => {
    const employee = await one<{ id: number }>(
      `INSERT INTO employees (company_id, code, first_name, last_name, join_date) VALUES ($1, $2, 'Advance', 'Emp', '2026-01-01') RETURNING id`,
      [ctx.companyId, `${PREFIX}-SA`]
    );
    const vouchersBefore = await count(
      `SELECT COUNT(*) AS n FROM vouchers WHERE company_id = $1 AND voucher_number LIKE 'SA-%'`,
      [ctx.companyId]
    );
    // A cash account that does not exist: the second line fails after the voucher was inserted.
    const failed = await agent
      .post("/api/salary-advances")
      .send({ employeeId: employee!.id, amount: "25.00", advanceDate: "2026-10-01", cashAccountId: 2147480001 });
    expect(failed.status).toBe(400);
    expect(
      await count(`SELECT COUNT(*) AS n FROM vouchers WHERE company_id = $1 AND voucher_number LIKE 'SA-%'`, [
        ctx.companyId,
      ])
    ).toBe(vouchersBefore);
    expect(await count(`SELECT COUNT(*) AS n FROM salary_advances WHERE employee_id = $1`, [employee!.id])).toBe(0);

    const created = await agent
      .post("/api/salary-advances")
      .send({ employeeId: employee!.id, amount: "25.00", advanceDate: "2026-10-01", cashAccountId: ctx.cashAccountId });
    expect(created.status).toBe(201);
    expect(created.body.voucherId).toBeTruthy();
    expect(
      await count(`SELECT COUNT(*) AS n FROM voucher_entries WHERE voucher_id = $1`, [created.body.voucherId])
    ).toBe(2);
    expect(
      await count(`SELECT COUNT(*) AS n FROM audit_log WHERE table_name = 'salary_advances' AND record_id = $1`, [
        created.body.id,
      ])
    ).toBe(1);
  }, 60_000);

  it("writes both companies' rental auto-transfer vouchers and the link together or not at all", async () => {
    const destCompanyId = await createCompany("DEST");
    const destCash = await one<{ id: number }>(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance) VALUES ($1, $2, 'Dest Cash', 'Cash', '0') RETURNING id`,
      [destCompanyId, `${PREFIX}-DC`]
    );
    // The destination account belongs to the source company: the ledger guard
    // refuses the destination line after the source voucher was written.
    await pool.query(
      `INSERT INTO rental_auto_transfer_configs (company_id, module, dest_company_id, dest_ledger_account_id, enabled)
       VALUES ($1, 'PROPERTIES', $2, $3, true)`,
      [ctx.companyId, destCompanyId, ctx.salesAccountId]
    );
    const outBefore = await count(
      `SELECT COUNT(*) AS n FROM vouchers WHERE company_id = $1 AND voucher_number LIKE 'TR-OUT-%'`,
      [ctx.companyId]
    );
    await maybeRunAutoTransfer(ctx.companyId, "PROPERTIES", ctx.cashAccountId, "40.00", "2026-10-01", "W12B/1");
    expect(
      await count(`SELECT COUNT(*) AS n FROM vouchers WHERE company_id = $1 AND voucher_number LIKE 'TR-OUT-%'`, [
        ctx.companyId,
      ])
    ).toBe(outBefore);
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM ledger_accounts WHERE company_id = ANY($1) AND code = 'TRANSFER-CLEARING'`,
        [[ctx.companyId, destCompanyId]]
      )
    ).toBe(0);

    await pool.query(`UPDATE rental_auto_transfer_configs SET dest_ledger_account_id = $2 WHERE company_id = $1`, [
      ctx.companyId,
      destCash!.id,
    ]);
    await maybeRunAutoTransfer(ctx.companyId, "PROPERTIES", ctx.cashAccountId, "40.00", "2026-10-01", "W12B/1");
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM inter_company_transfers WHERE from_company_id = $1 AND to_company_id = $2`,
        [ctx.companyId, destCompanyId]
      )
    ).toBe(1);
    expect(
      await count(`SELECT COUNT(*) AS n FROM vouchers WHERE company_id = $1 AND voucher_number LIKE 'TR-IN-%'`, [
        destCompanyId,
      ])
    ).toBe(1);
  }, 60_000);

  it("moves employee balances on the caller's transaction, so a rollback undoes them", async () => {
    const employee = await one<{ id: number }>(
      `INSERT INTO employees (company_id, code, first_name, last_name, join_date) VALUES ($1, $2, 'Sync', 'Emp', '2026-01-01') RETURNING id`,
      [ctx.companyId, `${PREFIX}-SYNC`]
    );
    const entries = [{ ledgerAccountId: null, employeeId: employee!.id, debitAmount: "0", creditAmount: "12.50" }];
    await expect(
      db.transaction(async (tx) => {
        await syncEmployeeBalancesFromEntries(entries, ctx.companyId, false, tx);
        throw new Error("w12b rollback");
      })
    ).rejects.toThrow("w12b rollback");
    expect(await one(`SELECT current_balance FROM employees WHERE id = $1`, [employee!.id])).toEqual({
      current_balance: "0.00",
    });

    await db.transaction((tx) => syncEmployeeBalancesFromEntries(entries, ctx.companyId, false, tx));
    expect(await one(`SELECT current_balance FROM employees WHERE id = $1`, [employee!.id])).toEqual({
      current_balance: "12.50",
    });
  }, 60_000);
});
