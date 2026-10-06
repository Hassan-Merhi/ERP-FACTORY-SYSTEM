/**
 * POST /api/credit-sales-import/import posts a credit sale from an imported
 * sheet.
 *
 *   - Each line is stored at cents and the voucher total is the sum of the
 *     stored lines: two lines of 1.3 at 0.35 are 0.46 each and 0.92 in all.
 *     The float total (0.9099999999999999) disagreed with its own lines.
 *   - A quantity or rate that does not parse is refused before anything is
 *     written; it used to be written as NaN.
 *   - A location of another company is refused.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "csimport";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let customerId: number;
let foreignCompanyId: number;
let foreignLocationId: number;

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

  const customer = await pool.query<{ id: number }>(
    `INSERT INTO customers (company_id, code, legal_name, active) VALUES ($1, $2, $3, true) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}CUST`, `${TEST_PREFIX} Customer`]
  );
  customerId = customer.rows[0].id;

  const company = await pool.query<{ id: number }>(
    `INSERT INTO companies (code, name, company_type, active, base_currency)
     VALUES ($1, $2, 'erp', true, 'USD') RETURNING id`,
    [`${TEST_PREFIX.toUpperCase()}X`, `${TEST_PREFIX}_ForeignCompany`]
  );
  foreignCompanyId = company.rows[0].id;
  const location = await pool.query<{ id: number }>(
    `INSERT INTO locations (company_id, code, name, active) VALUES ($1, $2, $3, true) RETURNING id`,
    [foreignCompanyId, `${TEST_PREFIX.toUpperCase()}-FL`, `${TEST_PREFIX} Foreign Location`]
  );
  foreignLocationId = location.rows[0].id;
}, 120000);

afterAll(async () => {
  await pool.query(`DELETE FROM locations WHERE id = $1`, [foreignLocationId]);
  await pool.query(`DELETE FROM companies WHERE id = $1`, [foreignCompanyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

function importSale(body: Record<string, unknown>) {
  return agent.post("/api/credit-sales-import/import").send({
    locationId: ctx.locationId,
    saleDate: "2026-09-10",
    customerId,
    ...body,
  });
}

describe("POST /api/credit-sales-import/import", () => {
  it("totals the voucher as the sum of its cent-rounded lines", async () => {
    const response = await importSale({
      items: [
        { barcode: `${TEST_PREFIX}-ITEM1`, quantity: 1.3, rate: 0.35 },
        { barcode: `${TEST_PREFIX}-ITEM2`, quantity: 1.3, rate: 0.35 },
      ],
    });

    expect(response.status).toBe(200);
    expect(response.body.totalSales).toBe("0.92");
    const voucherId = response.body.voucher.id;
    const lines = await pool.query<{ total_sales: string }>(
      `SELECT total_sales FROM sales_items WHERE voucher_id = $1 ORDER BY id`,
      [voucherId]
    );
    expect(lines.rows.map((row) => row.total_sales)).toEqual(["0.46", "0.46"]);
    const voucher = await pool.query<{ total_amount: string }>(`SELECT total_amount FROM vouchers WHERE id = $1`, [
      voucherId,
    ]);
    expect(Number(voucher.rows[0].total_amount)).toBe(0.92);
    const entries = await pool.query<{ debit_amount: string; credit_amount: string }>(
      `SELECT debit_amount, credit_amount FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
      [voucherId]
    );
    expect(entries.rows.map((row) => [Number(row.debit_amount), Number(row.credit_amount)])).toEqual([
      [0.92, 0],
      [0, 0.92],
    ]);
  });

  it("refuses a quantity that does not parse", async () => {
    const response = await importSale({ items: [{ barcode: `${TEST_PREFIX}-ITEM1`, quantity: "abc", rate: 1 }] });
    expect(response.status).toBe(400);
    expect(response.body.message).toBe("Invalid amount");
  });

  it("refuses another company's location", async () => {
    const response = await importSale({
      locationId: foreignLocationId,
      items: [{ barcode: `${TEST_PREFIX}-ITEM1`, quantity: 1, rate: 1 }],
    });
    expect(response.status).toBe(400);
    expect(response.body.message).toBe("Location not found");
  });
});
