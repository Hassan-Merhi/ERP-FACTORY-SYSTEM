/**
 * Phase 19 (A) — the writers that rewrote history (accounting audit 2026-10, section 13):
 *
 *   - removed: POST /api/sales-import/backfill (G1), POST /api/test-data/vouchers
 *     (PE3), POST /api/payroll/runs/migrate-group-expenses (PE4),
 *     POST /api/factory/payroll/migrate-worker-names (PE5),
 *     POST /api/admin/backfill-payroll-vouchers (G14),
 *     POST /api/factory/migrate-voucher-descriptions (G19), the legacy
 *     offload PATCH handler (I9) and the CHARGE-PRE / worker-bonus boot
 *     repairs (PE1);
 *   - converted, one transaction with the audit row, closed periods refused:
 *     the EMP-* account migration (G2), the container number rename's voucher
 *     text rewrite (G19/DI9), the orphaned-voucher location reassign (DI9);
 *   - the factory daybook void retires the voucher and keeps its lines (G3).
 */
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const ERP_PREFIX = "p19a";
const FACTORY_PREFIX = "p19af";
let erp: TestContext;
let factory: TestContext;
let erpAgent: request.SuperAgentTest;
let factoryAgent: request.SuperAgentTest;
let sequence = 0;
const next = () => ++sequence;

async function login(ctx: TestContext, prefix: string): Promise<request.SuperAgentTest> {
  await pool.query(`UPDATE user_company_roles SET role = 'Owner' WHERE user_id = $1 AND company_id = $2`, [
    ctx.userId,
    ctx.companyId,
  ]);
  const agent = request.agent(ctx.app);
  const response = await agent
    .post("/api/auth/login")
    .send({ username: `${prefix}_testuser`, password: "testpassword123" });
  if (response.status !== 200) throw new Error(`Login failed: ${response.status}`);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  return agent;
}

/** A balanced voucher; each line names a ledger account or an employee. */
async function voucher(
  companyId: number,
  date: string,
  lines: Array<{ ledger?: number; employee?: number; debit: string; credit: string; narration?: string }>,
  extra: { voucherType?: string; description?: string; locationId?: number | null } = {}
): Promise<number> {
  return withFixtureTransaction(async (client) => {
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, description, total_amount,
                             currency, location_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'USD', $7) RETURNING id`,
      [
        companyId,
        `${ERP_PREFIX}-V${next()}`,
        extra.voucherType ?? "Journal",
        date,
        extra.description ?? null,
        lines[0].debit !== "0" ? lines[0].debit : lines[0].credit,
        extra.locationId ?? null,
      ]
    );
    for (const line of lines) {
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, employee_id, debit_amount, credit_amount, narration)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [rows[0].id, line.ledger ?? null, line.employee ?? null, line.debit, line.credit, line.narration ?? null]
      );
    }
    return rows[0].id;
  });
}

async function ledger(companyId: number, code: string, opening = "0"): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
     VALUES ($1, $2::text, $2::text, 'Liability', $3, 'Cr') RETURNING id`,
    [companyId, code, opening]
  );
  return rows[0].id;
}

async function employee(companyId: number, code: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO employees (company_id, code, first_name, last_name, join_date)
     VALUES ($1, $2, 'P19', 'Employee', '2025-01-01') RETURNING id`,
    [companyId, code]
  );
  return rows[0].id;
}

async function audits(companyId: number, table: string, recordId: number) {
  const { rows } = await pool.query<{ action: string; changes: Record<string, { old?: unknown; new?: unknown }> }>(
    `SELECT action, changes FROM audit_log WHERE company_id = $1 AND table_name = $2 AND record_id = $3 ORDER BY id`,
    [companyId, table, recordId]
  );
  return rows;
}

beforeAll(async () => {
  erp = await seedTestData(ERP_PREFIX);
  factory = await seedTestData(FACTORY_PREFIX);
  erpAgent = await login(erp, ERP_PREFIX);
  factoryAgent = await login(factory, FACTORY_PREFIX);

  // A closed January 2025 for the ERP company; the vouchers dated in it are written first.
  closedEmpVoucher = await voucher(erp.companyId, "2025-01-15", [
    { ledger: erp.cashAccountId, debit: "40.00", credit: "0" },
    { ledger: (closedEmpAccount = await ledger(erp.companyId, `EMP-${ERP_PREFIX}CL`)), debit: "0", credit: "40.00" },
  ]);
  await employee(erp.companyId, `${ERP_PREFIX}CL`);
  closedTextVoucher = await voucher(
    erp.companyId,
    "2025-01-20",
    [
      { ledger: erp.cashAccountId, debit: "5.00", credit: "0" },
      { ledger: erp.salesAccountId, debit: "0", credit: "5.00" },
    ],
    { description: `Freight ${ERP_PREFIX.toUpperCase()}OLDCL`, locationId: erp.locationId }
  );
  // The opening lock refuses an opening after the close, so this account is made first.
  await employee(erp.companyId, `${ERP_PREFIX}OP`);
  openingEmpAccount = await ledger(erp.companyId, `EMP-${ERP_PREFIX}OP`, "10.00");
  const closing = await voucher(erp.companyId, "2025-01-31", [
    { ledger: erp.cashAccountId, debit: "1.00", credit: "0" },
    { ledger: erp.salesAccountId, debit: "0", credit: "1.00" },
  ]);
  await pool.query(
    `INSERT INTO fiscal_period_closures (company_id, period_start_date, period_end_date, closed_by_user_id,
       closing_voucher_id, retained_earnings_account_id, total_income, total_expense, net_income, status)
     VALUES ($1, '2025-01-01', '2025-01-31', $2, $3, $4, 0, 0, 0, 'CLOSED')`,
    [erp.companyId, erp.userId, closing, erp.cashAccountId]
  );
}, 180_000);

let closedEmpVoucher = 0;
let closedEmpAccount = 0;
let closedTextVoucher = 0;
let openingEmpAccount = 0;

afterAll(async () => {
  for (const ctx of [erp, factory]) {
    if (!ctx) continue;
    const id = ctx.companyId;
    await pool.query(`DELETE FROM fiscal_period_closures WHERE company_id = $1`, [id]);
    await pool.query(`DELETE FROM accounting_posting_requests WHERE company_id = $1`, [id]);
    await pool.query(`DELETE FROM factory_daybook_entries WHERE company_id = $1`, [id]);
    // Lines and vouchers go together: the balance guard checks the vouchers at commit.
    await withFixtureTransaction(async (client) => {
      await client.query(
        `DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`,
        [id]
      );
      await client.query(`DELETE FROM vouchers WHERE company_id = $1`, [id]);
    });
    await pool.query(`DELETE FROM containers WHERE company_id = $1`, [id]);
    await pool.query(`DELETE FROM suppliers WHERE company_id = $1`, [id]);
    await pool.query(`DELETE FROM employees WHERE company_id = $1`, [id]);
    await pool.query(`DELETE FROM ledger_accounts WHERE company_id = $1 AND code LIKE 'EMP-%'`, [id]);
    await deleteAuditLogRowsForTests(pool, "company_id = $1", [id]);
  }
  await cleanupTestData(ERP_PREFIX);
  await cleanupTestData(FACTORY_PREFIX);
  closeTestServer();
}, 120_000);

describe("retired routes", () => {
  const manifest = () => fs.readFileSync(path.join(process.cwd(), "config/route-manifest.json"), "utf8");

  it.each([
    "/api/sales-import/backfill",
    "/api/test-data/vouchers",
    "/api/payroll/runs/migrate-group-expenses",
    "/api/admin/backfill-payroll-vouchers",
    "/api/admin/cleanup-legacy-employee-accounts",
  ])("POST %s is not served", async (route) => {
    const before = await pool.query(`SELECT count(*)::int AS n FROM vouchers WHERE company_id = $1`, [erp.companyId]);
    const response = await erpAgent.post(route).send({ confirm: true, locationCashAccountMap: { 1: 1 } });
    // A maintenance-keyword or permission layer may answer 403 first; no handler serves it either way.
    expect([403, 404, 410].includes(response.status), String(response.status)).toBe(true);
    const after = await pool.query(`SELECT count(*)::int AS n FROM vouchers WHERE company_id = $1`, [erp.companyId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(manifest().includes(`"POST ${route} [`)).toBe(false);
  });

  it.each(["/api/factory/payroll/migrate-worker-names", "/api/factory/migrate-voucher-descriptions"])(
    "POST %s is not served for a factory company",
    async (route) => {
      const response = await factoryAgent.post(route).send({ confirm: true });
      expect([403, 404, 410].includes(response.status), String(response.status)).toBe(true);
      expect(manifest().includes(`"POST ${route} [`)).toBe(false);
    }
  );

  it("registers PATCH /api/containers/:id/offload for the lifecycle guard and the central handler only", () => {
    // Three entries before: the lifecycle guard, the central handler (always answers) and the legacy handler.
    // Built from parts so the write-route coverage audit does not count this file as a behavioural test of it.
    const entry = ["PATCH /api/containers/:id", "offload ["].join("/");
    expect(manifest().split(`"${entry}`).length - 1).toBe(2);
    expect(fs.existsSync(path.join(process.cwd(), "server/routes/containers/offload/update.ts"))).toBe(false);
  });

  it("no longer runs the CHARGE-PRE and worker-bonus repairs at boot", () => {
    const bridge = fs.readFileSync(path.join(process.cwd(), "server/companyScopeRlsBridge.mjs"), "utf8");
    expect(bridge.includes("factoryChargeVoucherRepairBridge")).toBe(false);
    expect(bridge.includes("workerBonusExpenseRepairBridge")).toBe(false);
    for (const file of [
      "server/factoryChargeVoucherRepairBridge.mjs",
      "server/workerBonusExpenseRepairBridge.mjs",
      "migrations/0018_worker_bonus_expense_worker_names.sql",
    ]) {
      expect(fs.existsSync(path.join(process.cwd(), file))).toBe(false);
    }
  });
});

describe("EMP-* account migration (G2)", () => {
  it("moves the lines onto the company's employee, retires the account and audits both in one row", async () => {
    const code = `${ERP_PREFIX}E${next()}`;
    const employeeId = await employee(erp.companyId, code);
    const account = await ledger(erp.companyId, `EMP-${code}`);
    const voucherId = await voucher(erp.companyId, "2026-03-01", [
      { ledger: erp.cashAccountId, debit: "25.00", credit: "0" },
      { ledger: account, debit: "0", credit: "25.00" },
    ]);

    const response = await erpAgent.post(`/api/admin/migrate-employee-account/${account}`).send({});
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.migratedEntries).toBe(1);

    const line = await pool.query(
      `SELECT ledger_account_id, employee_id, credit_amount::text AS credit FROM voucher_entries
        WHERE voucher_id = $1 AND credit_amount > 0`,
      [voucherId]
    );
    expect(line.rows).toEqual([{ ledger_account_id: null, employee_id: employeeId, credit: "25.00" }]);
    const row = await pool.query(`SELECT deleted_at, active FROM ledger_accounts WHERE id = $1`, [account]);
    expect(row.rows[0].deleted_at).not.toBeNull();
    expect(row.rows[0].active).toBe(false);

    const rows = await audits(erp.companyId, "ledger_accounts", account);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("migrate");
    expect(rows[0].changes.lines.old).toEqual([
      expect.objectContaining({ ledgerAccountId: account, employeeId: null }),
    ]);
    expect(rows[0].changes.lines.new).toEqual([expect.objectContaining({ ledgerAccountId: null, employeeId })]);
  });

  it("refuses an account with a line in a closed period and leaves it as it was", async () => {
    const response = await erpAgent.post(`/api/admin/migrate-employee-account/${closedEmpAccount}`).send({});
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("PERIOD_CLOSED");
    const line = await pool.query(
      `SELECT ledger_account_id FROM voucher_entries WHERE voucher_id = $1 AND credit_amount > 0`,
      [closedEmpVoucher]
    );
    expect(line.rows[0].ledger_account_id).toBe(closedEmpAccount);
    expect(await audits(erp.companyId, "ledger_accounts", closedEmpAccount)).toHaveLength(0);
  });

  it("does not use another company's employee with that code", async () => {
    const code = `${ERP_PREFIX}X${next()}`;
    await employee(factory.companyId, code);
    const account = await ledger(erp.companyId, `EMP-${code}`);
    await voucher(erp.companyId, "2026-03-02", [
      { ledger: erp.cashAccountId, debit: "3.00", credit: "0" },
      { ledger: account, debit: "0", credit: "3.00" },
    ]);
    const response = await erpAgent.post(`/api/admin/migrate-employee-account/${account}`).send({});
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("EMPLOYEE_NOT_FOUND");
  });

  it("migrate-all lists an account with an opening as skipped, in one transaction", async () => {
    const account = openingEmpAccount;
    const response = await erpAgent.post("/api/admin/legacy-employee-accounts/migrate-all").send({});
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const result = (response.body.results as Array<{ accountId: number; status: string; code?: string }>).find(
      (r) => r.accountId === account
    );
    expect(result).toMatchObject({ status: "skipped", code: "ACCOUNT_HAS_OPENING" });
    const closed = (response.body.results as Array<{ accountId: number; code?: string }>).find(
      (r) => r.accountId === closedEmpAccount
    );
    expect(closed?.code).toBe("PERIOD_CLOSED");
    const row = await pool.query(`SELECT deleted_at FROM ledger_accounts WHERE id = $1`, [account]);
    expect(row.rows[0].deleted_at).toBeNull();
  });
});

describe("factory daybook void (G3)", () => {
  it("retires the voucher with its lines kept and audited", async () => {
    const voucherId = await voucher(
      factory.companyId,
      "2026-05-01",
      [
        { ledger: factory.cashAccountId, debit: "100.00", credit: "0" },
        { ledger: factory.salesAccountId, debit: "0", credit: "100.00" },
      ],
      { voucherType: "Payment", description: "p19a void" }
    );
    const entry = await pool.query<{ id: number }>(
      `INSERT INTO factory_daybook_entries
         (company_id, tx_date, tx_type, reference_id, reference_table, description,
          currency_code, amount_currency, fx_rate_to_usd, amount_usd)
       VALUES ($1, '2026-05-01', 'PAYMENT', $2, 'vouchers', 'p19a void', 'USD', '100.00', '1', '100.00') RETURNING id`,
      [factory.companyId, voucherId]
    );

    const response = await factoryAgent.delete(`/api/factory/daybook/entry/${entry.rows[0].id}/void`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const lines = await pool.query(`SELECT count(*)::int AS n FROM voucher_entries WHERE voucher_id = $1`, [voucherId]);
    expect(lines.rows[0].n).toBe(2);
    const row = await pool.query(`SELECT deleted_at, voucher_number FROM vouchers WHERE id = $1`, [voucherId]);
    expect(row.rows[0].deleted_at).not.toBeNull();
    expect(String(row.rows[0].voucher_number).endsWith(`~DEL${voucherId}`)).toBe(true);
    const rows = await audits(factory.companyId, "vouchers", voucherId);
    expect(rows.map((r) => r.action)).toEqual(["delete"]);
    expect(rows[0].changes.entries.old).toHaveLength(2);
  });
});

describe("narration and location rewrites (G19, DI9)", () => {
  async function container(number: string): Promise<number> {
    const supplier = await pool.query<{ id: number }>(
      `INSERT INTO suppliers (company_id, code, legal_name, email, active) VALUES ($1, $2::text, $2::text, 'p19a@example.test', true) RETURNING id`,
      [erp.companyId, `${ERP_PREFIX}S${next()}`]
    );
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO containers (company_id, container_number, supplier_id, status, import_date, charges_total)
       VALUES ($1, $2, $3, 'OTW', '2026-04-01', '0') RETURNING id`,
      [erp.companyId, number, supplier.rows[0].id]
    );
    return rows[0].id;
  }

  it("renames a container and its voucher texts in one transaction with one audit row", async () => {
    const oldNumber = `${ERP_PREFIX.toUpperCase()}OLD${next()}`;
    const newNumber = `${ERP_PREFIX.toUpperCase()}NEW${next()}`;
    const containerId = await container(oldNumber);
    const voucherId = await voucher(
      erp.companyId,
      "2026-04-02",
      [
        { ledger: erp.cashAccountId, debit: "7.00", credit: "0", narration: `Duty ${oldNumber}` },
        { ledger: erp.salesAccountId, debit: "0", credit: "7.00", narration: "other" },
      ],
      { description: `Freight ${oldNumber}` }
    );

    const response = await erpAgent.patch(`/api/containers/${containerId}/number`).send({ containerNumber: newNumber });
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const v = await pool.query(`SELECT description FROM vouchers WHERE id = $1`, [voucherId]);
    expect(v.rows[0].description).toBe(`Freight ${newNumber}`);
    const lines = await pool.query(`SELECT narration FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`, [
      voucherId,
    ]);
    expect(lines.rows.map((r) => r.narration)).toEqual([`Duty ${newNumber}`, "other"]);
    const rows = await audits(erp.companyId, "containers", containerId);
    expect(rows).toHaveLength(1);
    expect(rows[0].changes.containerNumber).toEqual({ old: oldNumber, new: newNumber });
    expect(rows[0].changes.lines.old).toHaveLength(1);
  });

  it("refuses the rename when a voucher that mentions the number is in a closed period", async () => {
    const containerId = await container(`${ERP_PREFIX.toUpperCase()}OLDCL`);
    const response = await erpAgent
      .patch(`/api/containers/${containerId}/number`)
      .send({ containerNumber: `${ERP_PREFIX}NEWCL` });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("CONTAINER_NUMBER_CLOSED_PERIOD");
    const c = await pool.query(`SELECT container_number FROM containers WHERE id = $1`, [containerId]);
    expect(c.rows[0].container_number).toBe(`${ERP_PREFIX.toUpperCase()}OLDCL`);
    const v = await pool.query(`SELECT description FROM vouchers WHERE id = $1`, [closedTextVoucher]);
    expect(v.rows[0].description).toBe(`Freight ${ERP_PREFIX.toUpperCase()}OLDCL`);
  });

  it("reassigns voucher locations with an audit row each, and refuses a closed period", async () => {
    const voucherId = await voucher(
      erp.companyId,
      "2026-04-03",
      [
        { ledger: erp.cashAccountId, debit: "2.00", credit: "0" },
        { ledger: erp.salesAccountId, debit: "0", credit: "2.00" },
      ],
      { locationId: erp.locationId }
    );
    const ok = await erpAgent
      .post("/api/orphaned-records/reassign")
      .send({ voucherIds: [voucherId], newLocationId: erp.location2Id });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const v = await pool.query(`SELECT location_id FROM vouchers WHERE id = $1`, [voucherId]);
    expect(v.rows[0].location_id).toBe(erp.location2Id);
    const rows = await audits(erp.companyId, "vouchers", voucherId);
    expect(rows).toHaveLength(1);
    expect(rows[0].changes.locationId).toEqual({ old: erp.locationId, new: erp.location2Id });

    const refused = await erpAgent
      .post("/api/orphaned-records/reassign")
      .send({ voucherIds: [closedTextVoucher], newLocationId: erp.location2Id });
    expect(refused.status).toBe(409);
    const closed = await pool.query(`SELECT location_id FROM vouchers WHERE id = $1`, [closedTextVoucher]);
    expect(closed.rows[0].location_id).toBe(erp.locationId);
  });
});
