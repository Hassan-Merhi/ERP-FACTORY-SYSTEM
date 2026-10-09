/**
 * POST /api/factory/supplier-payments
 *
 *   - The supplier and the paid-from account must belong to the active
 *     company. Neither was checked, so a payment could debit another tenant's
 *     supplier or credit another tenant's bank/cash account.
 *   - The payment amount is stored at four places and the voucher takes it at
 *     cents half up: 1.0050 posts 1.01 (the float 1.00499... posted 1.00).
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "fsuppay";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let supplierId: number;
let foreignCompanyId: number;
let foreignSupplierId: number;
let foreignAccountId: number;
let seq = 0;

function pay(body: Record<string, unknown>) {
  seq += 1;
  return agent
    .post("/api/factory/supplier-payments")
    .set("X-Idempotency-Key", `${TEST_PREFIX}-${seq}-${Date.now()}`)
    .send({ date: "2026-09-01", currencyCode: "USD", fxRateToUsd: "1", ...body });
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  await pool.query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [ctx.companyId]);
  agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

  const supplier = await pool.query<{ id: number }>(
    `INSERT INTO factory_suppliers (company_id, name) VALUES ($1, $2) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX} supplier`]
  );
  supplierId = supplier.rows[0].id;

  const company = await pool.query<{ id: number }>(
    `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1, $2, 'factory', 'USD') RETURNING id`,
    [`${TEST_PREFIX.toUpperCase()}F`, `${TEST_PREFIX}_Foreign`]
  );
  foreignCompanyId = company.rows[0].id;
  const foreignSupplier = await pool.query<{ id: number }>(
    `INSERT INTO factory_suppliers (company_id, name) VALUES ($1, $2) RETURNING id`,
    [foreignCompanyId, `${TEST_PREFIX} foreign supplier`]
  );
  foreignSupplierId = foreignSupplier.rows[0].id;
  const foreignAccount = await pool.query<{ id: number }>(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, opening_balance, opening_balance_side)
     VALUES ($1, $2, 'Foreign cash', 'Cash', 'Cash', '0', 'Dr') RETURNING id`,
    [foreignCompanyId, `${TEST_PREFIX.toUpperCase()}-CASH`]
  );
  foreignAccountId = foreignAccount.rows[0].id;
}, 120000);

afterAll(async () => {
  await pool.query(`DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`, [
    ctx.companyId,
  ]);
  await pool.query(`DELETE FROM factory_supplier_payments WHERE company_id = ANY($1::int[])`, [
    [ctx.companyId, foreignCompanyId],
  ]);
  await pool.query(`DELETE FROM factory_suppliers WHERE company_id = ANY($1::int[])`, [
    [ctx.companyId, foreignCompanyId],
  ]);
  await pool.query(`DELETE FROM ledger_accounts WHERE company_id = $1`, [foreignCompanyId]);
  await pool.query(`DELETE FROM companies WHERE id = $1`, [foreignCompanyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("factory supplier payment", () => {
  it("refuses another company's supplier", async () => {
    const response = await pay({ supplierId: foreignSupplierId, amount: "5.00", amountUsd: "5.00" });
    expect(response.status).toBe(404);
  });

  it("refuses another company's paid-from account", async () => {
    const response = await pay({
      supplierId,
      amount: "5.00",
      amountUsd: "5.00",
      paidFromAccountId: foreignAccountId,
    });
    expect(response.status).toBe(404);
  });

  it("posts a four-place amount at cents, half up", async () => {
    const response = await pay({ supplierId, amount: "1.0050", amountUsd: "1.0050" });
    expect(response.status).toBeLessThan(300);
    const voucher = await pool.query<{ total_amount: string; debit: string; credit: string }>(
      `SELECT v.total_amount, SUM(e.debit_amount)::text AS debit, SUM(e.credit_amount)::text AS credit
         FROM vouchers v JOIN voucher_entries e ON e.voucher_id = v.id
        WHERE v.company_id = $1 AND v.voucher_number LIKE 'FACTORY-PAY-%'
        GROUP BY v.id ORDER BY v.id DESC LIMIT 1`,
      [ctx.companyId]
    );
    expect(voucher.rows[0]).toEqual({ total_amount: "1.01", debit: "1.01", credit: "1.01" });
  });
});
