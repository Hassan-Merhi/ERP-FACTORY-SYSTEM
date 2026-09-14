import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "spreconclose";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let payableAccountId: number;
let prepaidAccountId: number;
let cashAccountId: number;
let supplierId: number;
const voucherIds: number[] = [];
const migrationRunIds: string[] = [];

type Surface = {
  key: string;
  databaseValue: number;
  reportValue: number;
  pass: boolean;
  basis: string;
  evidenceStatus?: string;
  detail?: string;
};

type Report = {
  status: string;
  mismatchCount: number;
  unavailableCount: number;
  surfaces: Surface[];
};

function surface(report: Report, key: string): Surface {
  const found = report.surfaces.find((entry) => entry.key === key);
  expect(found, `surface ${key} missing`).toBeTruthy();
  return found!;
}

async function reconciliation(): Promise<Report> {
  const response = await agent.get("/api/sp/reconciliation/full");
  expect(response.status, response.text.slice(0, 500)).toBe(200);
  return response.body as Report;
}

async function createAccount(code: string, name: string, accountType: string, subType?: string) {
  const [account] = await db
    .insert(schema.ledgerAccounts)
    .values({
      companyId: ctx.companyId,
      code,
      name,
      accountType,
      subType: subType ?? null,
      openingBalance: "0",
      openingBalanceSide: accountType === "Asset" || accountType === "Cash" ? "Dr" : "Cr",
    })
    .returning();
  return account;
}

async function insertVoucher(voucherType: string, totalAmount: string, suffix: string): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO vouchers
      (company_id, location_id, voucher_number, voucher_type, voucher_date, total_amount, currency, optional)
     VALUES ($1, $2, $3, $4, DATE '2026-09-01', $5, 'USD', false)
     RETURNING id`,
    [ctx.companyId, ctx.locationId, `${TEST_PREFIX}-${suffix}-${Date.now()}`, voucherType, totalAmount]
  );
  const id = result.rows[0].id;
  voucherIds.push(id);
  return id;
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  await pool.query(`UPDATE companies SET company_type = 'supplier_partner' WHERE id = $1`, [ctx.companyId]);

  await createAccount("SP-OTW-CLOSE", "Closeout Goods OTW", "Asset", "sp_goods_otw");
  await createAccount("SP-OTWC-CLOSE", "Closeout OTW Clearing", "Liability", "sp_otw_clearing");
  const payable = await createAccount("SP-PAY-CLOSE", "Closeout Payable", "Liability", "sp_payable");
  payableAccountId = payable.id;
  await createAccount("SP-STK-CLOSE", "Closeout Stock", "Asset", "sp_stock");
  await createAccount("SP-COST-CLOSE", "Closeout Cost Clearing", "Liability", "sp_cost_clearing");
  await createAccount("SP-OPEN-CLOSE", "Closeout Opening", "Equity", "sp_opnbal");
  await createAccount("SP-PEXP-CLOSE", "Closeout Prepaid Expenses", "Asset", "sp_prepaid_expenses");
  const prepaid = await createAccount("SP-PRE-CLOSE", "Closeout Prepaid", "Asset", "sp_prepaid");
  prepaidAccountId = prepaid.id;
  const cash = await createAccount("CASH-CLOSE", "Closeout Cash", "Cash");
  cashAccountId = cash.id;

  const supplier = await pool.query<{ id: number }>(
    `INSERT INTO suppliers (company_id, code, legal_name, email, active)
     VALUES ($1, $2, $3, $4, true)
     RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-SUP`, `${TEST_PREFIX} Supplier`, `${TEST_PREFIX}@example.test`]
  );
  supplierId = supplier.rows[0].id;

  agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  expect(login.status).toBe(200);
  const selected = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  expect(selected.status).toBe(200);
}, 120000);

afterAll(async () => {
  if (migrationRunIds.length) {
    await pool.query(`DELETE FROM sp_migration_rehearsal_runs WHERE id = ANY($1::uuid[])`, [migrationRunIds]);
  }
  await pool.query(`DELETE FROM sp_prepaid_charges WHERE company_id = $1`, [ctx.companyId]);
  if (voucherIds.length) {
    await pool.query(`DELETE FROM sales_items WHERE voucher_id = ANY($1::int[])`, [voucherIds]);
    await pool.query(`DELETE FROM voucher_entries WHERE voucher_id = ANY($1::int[])`, [voucherIds]);
    await pool.query(`DELETE FROM vouchers WHERE id = ANY($1::int[])`, [voucherIds]);
  }
  await pool.query(`DELETE FROM suppliers WHERE id = $1`, [supplierId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("SP full reconciliation closeout", () => {
  it("counts a multi-line Sales voucher header exactly once for gross profit", async () => {
    const voucherId = await insertVoucher("Sales", "100", "MULTILINE");
    await pool.query(
      `INSERT INTO sales_items
        (voucher_id, stock_item_id, quantity, selling_price, cost_price, total_sales, total_cost, profit)
       VALUES
        ($1, $2, 1, 60, 30, 60, 30, 30),
        ($1, $2, 1, 40, 20, 40, 20, 20)`,
      [voucherId, ctx.stockItemIds[0]]
    );

    const grossProfit = surface(await reconciliation(), "gross_profit");
    expect(grossProfit.databaseValue).toBeCloseTo(50, 2);
    expect(grossProfit.reportValue).toBeCloseTo(50, 2);
    expect(grossProfit.pass).toBe(true);

    await pool.query(`DELETE FROM sales_items WHERE voucher_id = $1`, [voucherId]);
    await pool.query(`DELETE FROM vouchers WHERE id = $1`, [voucherId]);
  }, 60000);

  it("reconciles the complete payable against independent counterparty entries and detects drift", async () => {
    const voucherId = await insertVoucher("Journal", "100", "PAYABLE");
    await pool.query(
      `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
       VALUES
         ($1, $2, '0', '100', 'Supplier Cash Payable'),
         ($1, $3, '100', '0', 'Cash counterparty')`,
      [voucherId, payableAccountId, cashAccountId]
    );

    const consistent = surface(await reconciliation(), "supplier_payable_control");
    expect(consistent.databaseValue).toBeCloseTo(100, 2);
    expect(consistent.reportValue).toBeCloseTo(100, 2);
    expect(consistent.pass).toBe(true);

    await pool.query(
      `UPDATE voucher_entries SET debit_amount = '90'
       WHERE voucher_id = $1 AND ledger_account_id = $2`,
      [voucherId, cashAccountId]
    );
    const broken = surface(await reconciliation(), "supplier_payable_control");
    expect(broken.databaseValue).toBeCloseTo(100, 2);
    expect(broken.reportValue).toBeCloseTo(90, 2);
    expect(broken.pass).toBe(false);

    await pool.query(`DELETE FROM voucher_entries WHERE voucher_id = $1`, [voucherId]);
    await pool.query(`DELETE FROM vouchers WHERE id = $1`, [voucherId]);
  }, 60000);

  it("reconciles supplier-tagged statement entries against their non-supplier counterparty", async () => {
    const voucherId = await insertVoucher("Journal", "75", "STATEMENT");
    await pool.query(
      `INSERT INTO voucher_entries
        (voucher_id, ledger_account_id, supplier_id, debit_amount, credit_amount, narration)
       VALUES
         ($1, $2, $3, '0', '75', 'Supplier statement line'),
         ($1, $4, NULL, '75', '0', 'Statement counterparty')`,
      [voucherId, payableAccountId, supplierId, cashAccountId]
    );

    const consistent = surface(await reconciliation(), "supplier_statement_control");
    expect(consistent.databaseValue).toBeCloseTo(75, 2);
    expect(consistent.reportValue).toBeCloseTo(75, 2);
    expect(consistent.pass).toBe(true);

    await pool.query(
      `UPDATE voucher_entries SET debit_amount = '70'
       WHERE voucher_id = $1 AND supplier_id IS NULL`,
      [voucherId]
    );
    const broken = surface(await reconciliation(), "supplier_statement_control");
    expect(broken.databaseValue).toBeCloseTo(75, 2);
    expect(broken.reportValue).toBeCloseTo(70, 2);
    expect(broken.pass).toBe(false);

    await pool.query(`DELETE FROM voucher_entries WHERE voucher_id = $1`, [voucherId]);
    await pool.query(`DELETE FROM vouchers WHERE id = $1`, [voucherId]);
  }, 60000);

  it("reconciles prepaid register amounts against posted accounting instead of itself", async () => {
    const voucherId = await insertVoucher("Journal", "200", "PREPAID");
    const prepaid = await pool.query<{ id: number }>(
      `INSERT INTO sp_prepaid_charges
        (company_id, prepaid_date, charge_type, amount_paid_usd, amount_used_usd, voucher_id)
       VALUES ($1, DATE '2026-09-01', 'freight', '200', '0', $2)
       RETURNING id`,
      [ctx.companyId, voucherId]
    );
    await pool.query(
      `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
       VALUES
         ($1, $2, '200', '0', 'Prepaid debit'),
         ($1, $3, '0', '200', 'Cash payment')`,
      [voucherId, prepaidAccountId, cashAccountId]
    );

    const consistent = surface(await reconciliation(), "prepaid_balances");
    expect(consistent.databaseValue).toBeCloseTo(200, 2);
    expect(consistent.reportValue).toBeCloseTo(200, 2);
    expect(consistent.pass).toBe(true);

    await pool.query(
      `UPDATE voucher_entries SET debit_amount = '150'
       WHERE voucher_id = $1 AND ledger_account_id = $2`,
      [voucherId, prepaidAccountId]
    );
    const broken = surface(await reconciliation(), "prepaid_balances");
    expect(broken.databaseValue).toBeCloseTo(200, 2);
    expect(broken.reportValue).toBeCloseTo(150, 2);
    expect(broken.pass).toBe(false);

    await pool.query(`DELETE FROM sp_prepaid_charges WHERE id = $1`, [prepaid.rows[0].id]);
    await pool.query(`DELETE FROM voucher_entries WHERE voucher_id = $1`, [voucherId]);
    await pool.query(`DELETE FROM vouchers WHERE id = $1`, [voucherId]);
  }, 60000);

  it("reports migration evidence as explicit N/A or failure instead of swallowing it as PASS", async () => {
    const noMigration = surface(await reconciliation(), "migration_balances");
    expect(noMigration.evidenceStatus).toBe("NOT_APPLICABLE");
    expect(noMigration.pass).toBe(true);
    expect(noMigration.detail).toContain("No non-rolled-back migration rehearsal");

    const run = await pool.query<{ id: string }>(
      `INSERT INTO sp_migration_rehearsal_runs
        (source_company_id, target_company_id, action, status, rows_created, error_message, notes)
       VALUES ($1, $1, 'closeout_test', 'failed', 0, 'forced verification failure', 'test evidence')
       RETURNING id`,
      [ctx.companyId]
    );
    migrationRunIds.push(run.rows[0].id);

    const failedMigration = surface(await reconciliation(), "migration_balances");
    expect(failedMigration.evidenceStatus).toBe("FAIL");
    expect(failedMigration.pass).toBe(false);
    expect(failedMigration.databaseValue).toBe(1);

    await pool.query(`DELETE FROM sp_migration_rehearsal_runs WHERE id = $1`, [run.rows[0].id]);
    migrationRunIds.splice(migrationRunIds.indexOf(run.rows[0].id), 1);
  }, 60000);
});
