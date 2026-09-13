/**
 * Concurrency coverage for POST /api/factory/customer-orders/:id/finalize.
 *
 * Finalizing a loading is the moment the factory sale becomes money: it consumes
 * an invoice number, writes the customer's SALE receivable row, flips every
 * scanned bale to SOLD, and posts a voucher per order charge. None of that may
 * happen twice for one loading, so two simultaneous finalizations have to leave
 * exactly one invoice and one receivable behind.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "ordfin";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let customerId: number;
let orderId: number;

async function saleBalanceRows() {
  const { rows } = await pool.query(
    `SELECT id, debit_amount, reference_id
     FROM customer_balances
     WHERE company_id = $1
       AND reference_type = 'INVOICE'
       AND reference_id = $2
       AND transaction_type = 'SALE'
     ORDER BY id`,
    [ctx.companyId, orderId]
  );
  return rows;
}

async function resetOrder(): Promise<void> {
  await pool.query(`DELETE FROM customer_balances WHERE company_id = $1 AND reference_id = $2`, [
    ctx.companyId,
    orderId,
  ]);
  await pool.query(`DELETE FROM customer_order_lines WHERE order_id = $1`, [orderId]);
  await pool.query(
    `UPDATE customer_orders SET status = 'VERIFIED', invoice_number = NULL, finalized_at = NULL WHERE id = $1`,
    [orderId]
  );
  await pool.query(
    `UPDATE factory_bales SET status = 'RESERVED_FOR_ORDER'
     WHERE company_id = $1 AND bale_code = $2`,
    [ctx.companyId, `${TEST_PREFIX}-BALE`]
  );
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);

  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status} ${login.text}`);

  const company = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  if (company.status !== 200) throw new Error(`Set company failed: ${company.status} ${company.text}`);

  const customer = await pool.query<{ id: number }>(
    `INSERT INTO customers (company_id, code, legal_name)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-CUSTOMER`, `${TEST_PREFIX} Customer`]
  );
  customerId = customer.rows[0].id;

  const order = await pool.query<{ id: number }>(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status, location_id)
     VALUES ($1, $2, '2026-08-24', 'VERIFIED', $3)
     RETURNING id`,
    [ctx.companyId, customerId, ctx.locationId]
  );
  orderId = order.rows[0].id;

  const bale = await pool.query<{ id: number }>(
    `INSERT INTO factory_bales
       (company_id, bale_code, reference_number, article_code, product_name,
        weight_kg, cost_per_kg, total_cost, status)
     VALUES ($1, $2, $2, 'FIN-A', 'Finalize product', '30.000', '1.50', '45.00', 'RESERVED_FOR_ORDER')
     RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-BALE`]
  );

  await pool.query(
    `INSERT INTO customer_order_bales
       (order_id, bale_id, bale_reference, location_id, weight, article_code, price_used)
     VALUES ($1, $2, $3, $4, '30.000', 'FIN-A', '10.00')`,
    [orderId, bale.rows[0].id, `${TEST_PREFIX}-BALE`, ctx.locationId]
  );
}, 120000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("customer order finalization concurrency", () => {
  it("books one invoice and one receivable when two finalizations race", async () => {
    await resetOrder();

    const responses = await Promise.all([
      agent.post(`/api/factory/customer-orders/${orderId}/finalize`).send({}),
      agent.post(`/api/factory/customer-orders/${orderId}/finalize`).send({}),
    ]);

    const ok = responses.filter((response) => response.status === 200);
    const rejected = responses.filter((response) => response.status === 400);
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].body.message).toMatch(/Only DRAFT or VERIFIED orders can be finalized/);

    // Exactly one receivable row for the invoice, at the order's grand total.
    const balances = await saleBalanceRows();
    expect(balances).toHaveLength(1);

    const order = await pool.query<{ status: string; invoice_number: string; grand_total: string }>(
      `SELECT status, invoice_number, grand_total FROM customer_orders WHERE id = $1`,
      [orderId]
    );
    expect(order.rows[0].status).toBe("FINALIZED");
    expect(order.rows[0].invoice_number).toMatch(/^INV-\d{6}$/);
    expect(Number(balances[0].debit_amount)).toBeCloseTo(Number(order.rows[0].grand_total), 2);
    expect(ok[0].body.invoiceNumber).toBe(order.rows[0].invoice_number);
  }, 60000);

  it("rejects a retry after finalization without booking a second receivable", async () => {
    const retry = await agent.post(`/api/factory/customer-orders/${orderId}/finalize`).send({});
    expect(retry.status).toBe(400);

    expect(await saleBalanceRows()).toHaveLength(1);

    const invoiceRows = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM factory_daybook_entries
       WHERE company_id = $1 AND reference_table = 'customer_orders' AND reference_id = $2 AND tx_type = 'INVOICE'`,
      [ctx.companyId, orderId]
    );
    expect(invoiceRows.rows[0].count).toBe(1);
  }, 60000);
});
