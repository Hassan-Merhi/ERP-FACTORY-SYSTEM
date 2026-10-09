/**
 * Behavioural coverage for the customer-order charge write routes.
 *
 * All four were guard-only. Each of them mutates `customer_order_charges` and
 * then re-derives the order's stored totals, and those totals are what the
 * customer is invoiced from.
 *
 * The invariant is arithmetic and exact, so it is worth asserting rather than
 * approximating:
 *
 *     grand_total = subtotal_bales + freight_amount + other_charges_total
 *
 * with charges bucketed into freight or other by `charge_type`. Every one of
 * these endpoints calls `recalculateOrderTotals` after its write, so a charge
 * that lands in the wrong bucket, or a recalculation that is skipped on one
 * path, leaves the order's grand total disagreeing with the charges attached to
 * it — and both numbers still look plausible on their own.
 *
 * These orders carry no bales, so `subtotal_bales` is zero throughout and the
 * grand total is exactly the charges. That keeps the assertion on the part
 * these routes are responsible for.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "ordchg";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let customerId: number;
let orderSeq = 0;

interface OrderTotals {
  subtotal_bales: string;
  freight_amount: string;
  other_charges_total: string;
  grand_total: string;
}

async function orderTotals(orderId: number): Promise<OrderTotals> {
  const result = await pool.query<OrderTotals>(
    `SELECT subtotal_bales, freight_amount, other_charges_total, grand_total
     FROM customer_orders WHERE id = $1`,
    [orderId]
  );
  return result.rows[0];
}

/** grand_total must always equal the three components it is built from. */
async function expectTotalsConsistent(orderId: number) {
  const totals = await orderTotals(orderId);
  const sum = Number(totals.subtotal_bales) + Number(totals.freight_amount) + Number(totals.other_charges_total);
  expect(Number(totals.grand_total)).toBeCloseTo(sum, 2);
  return totals;
}

async function createOrder(): Promise<number> {
  orderSeq += 1;
  const result = await pool.query<{ id: number }>(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status)
     VALUES ($1, $2, '2026-05-01', 'DRAFT') RETURNING id`,
    [ctx.companyId, customerId]
  );
  return result.rows[0].id;
}

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
    `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, $3) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-CUST`, `${TEST_PREFIX} Customer`]
  );
  customerId = customer.rows[0].id;
}, 120000);

afterAll(async () => {
  await pool.query(
    `DELETE FROM customer_order_charges WHERE order_id IN (SELECT id FROM customer_orders WHERE company_id = $1)`,
    [ctx.companyId]
  );
  await pool.query(`DELETE FROM customer_orders WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM customers WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("POST /api/factory/customer-orders/:id/charges", () => {
  it("adds a freight charge into the freight bucket and into the grand total", async () => {
    const orderId = await createOrder();

    const response = await agent
      .post(`/api/factory/customer-orders/${orderId}/charges`)
      .send({ name: "Freight", amount: "125.50", chargeType: "FREIGHT" });

    expect(response.status).toBe(200);
    const totals = await expectTotalsConsistent(orderId);
    expect(Number(totals.freight_amount)).toBeCloseTo(125.5, 2);
    expect(Number(totals.other_charges_total)).toBeCloseTo(0, 2);
    expect(Number(totals.grand_total)).toBeCloseTo(125.5, 2);
  });

  it("keeps freight and other charges in separate buckets", async () => {
    const orderId = await createOrder();

    await agent
      .post(`/api/factory/customer-orders/${orderId}/charges`)
      .send({ name: "Freight", amount: "100.00", chargeType: "FREIGHT" });
    await agent
      .post(`/api/factory/customer-orders/${orderId}/charges`)
      .send({ name: "Handling", amount: "40.00", chargeType: "OTHER" });

    const totals = await expectTotalsConsistent(orderId);
    // The invoice shows these separately, so a charge landing in the wrong
    // bucket is wrong on the document even though the total still adds up.
    expect(Number(totals.freight_amount)).toBeCloseTo(100, 2);
    expect(Number(totals.other_charges_total)).toBeCloseTo(40, 2);
    expect(Number(totals.grand_total)).toBeCloseTo(140, 2);
  });

  it("defaults an unspecified charge type to OTHER", async () => {
    const orderId = await createOrder();

    await agent.post(`/api/factory/customer-orders/${orderId}/charges`).send({ name: "Misc", amount: "15.00" });

    const totals = await expectTotalsConsistent(orderId);
    expect(Number(totals.other_charges_total)).toBeCloseTo(15, 2);
    expect(Number(totals.freight_amount)).toBeCloseTo(0, 2);
  });

  it("rejects a charge with no name or no amount", async () => {
    const orderId = await createOrder();

    expect((await agent.post(`/api/factory/customer-orders/${orderId}/charges`).send({ amount: "10" })).status).toBe(
      400
    );
    expect((await agent.post(`/api/factory/customer-orders/${orderId}/charges`).send({ name: "x" })).status).toBe(400);

    const totals = await orderTotals(orderId);
    expect(Number(totals.grand_total)).toBeCloseTo(0, 2);
  });

  it("returns 404 for an order in another company", async () => {
    const response = await agent
      .post("/api/factory/customer-orders/999999/charges")
      .send({ name: "Freight", amount: "10", chargeType: "FREIGHT" });

    expect(response.status).toBe(404);
  });
});

describe("PATCH /api/factory/customer-orders/:id/charges/:chargeId", () => {
  it("re-derives the totals from the new amount", async () => {
    const orderId = await createOrder();
    const created = await agent
      .post(`/api/factory/customer-orders/${orderId}/charges`)
      .send({ name: "Freight", amount: "100.00", chargeType: "FREIGHT" });
    expect(created.status).toBe(200);

    const chargeId = (
      await pool.query<{ id: number }>(`SELECT id FROM customer_order_charges WHERE order_id = $1`, [orderId])
    ).rows[0].id;

    const response = await agent
      .patch(`/api/factory/customer-orders/${orderId}/charges/${chargeId}`)
      .send({ name: "Freight", amount: "60.00", chargeType: "FREIGHT" });
    expect(response.status).toBe(200);

    const totals = await expectTotalsConsistent(orderId);
    // A recalculation skipped on the edit path would leave 100 here while the
    // charge row says 60 — the invoice and its lines would disagree.
    expect(Number(totals.freight_amount)).toBeCloseTo(60, 2);
    expect(Number(totals.grand_total)).toBeCloseTo(60, 2);
  });

  it("ignores a charge type in the body, leaving the charge in its original bucket", async () => {
    const orderId = await createOrder();
    await agent
      .post(`/api/factory/customer-orders/${orderId}/charges`)
      .send({ name: "Freight", amount: "70.00", chargeType: "FREIGHT" });
    const chargeId = (
      await pool.query<{ id: number }>(`SELECT id FROM customer_order_charges WHERE order_id = $1`, [orderId])
    ).rows[0].id;

    const response = await agent
      .patch(`/api/factory/customer-orders/${orderId}/charges/${chargeId}`)
      .send({ name: "Freight", amount: "70.00", chargeType: "OTHER" });
    expect(response.status).toBe(200);

    // The edit path accepts only name, amount and ledgerAccountId — charge type
    // is fixed at creation, because moving it would need the linked voucher
    // re-posted. Re-bucketing is delete-and-recreate. Pinned so that a later
    // change to accept chargeType has to deal with the voucher deliberately
    // rather than by widening the allow-list.
    const totals = await expectTotalsConsistent(orderId);
    expect(Number(totals.freight_amount)).toBeCloseTo(70, 2);
    expect(Number(totals.other_charges_total)).toBeCloseTo(0, 2);
  });

  it("refuses an edit that names no updatable field", async () => {
    const orderId = await createOrder();
    await agent
      .post(`/api/factory/customer-orders/${orderId}/charges`)
      .send({ name: "Freight", amount: "20.00", chargeType: "FREIGHT" });
    const chargeId = (
      await pool.query<{ id: number }>(`SELECT id FROM customer_order_charges WHERE order_id = $1`, [orderId])
    ).rows[0].id;

    const response = await agent
      .patch(`/api/factory/customer-orders/${orderId}/charges/${chargeId}`)
      .send({ chargeType: "OTHER" });

    expect(response.status).toBe(400);
    expect(Number((await orderTotals(orderId)).freight_amount)).toBeCloseTo(20, 2);
  });
});

describe("DELETE /api/factory/customer-orders/:id/charges/:chargeId", () => {
  it("takes the amount back out of the totals", async () => {
    const orderId = await createOrder();
    await agent
      .post(`/api/factory/customer-orders/${orderId}/charges`)
      .send({ name: "Freight", amount: "100.00", chargeType: "FREIGHT" });
    await agent
      .post(`/api/factory/customer-orders/${orderId}/charges`)
      .send({ name: "Handling", amount: "25.00", chargeType: "OTHER" });

    const chargeId = (
      await pool.query<{ id: number }>(
        `SELECT id FROM customer_order_charges WHERE order_id = $1 AND charge_type = 'FREIGHT'`,
        [orderId]
      )
    ).rows[0].id;

    const response = await agent.delete(`/api/factory/customer-orders/${orderId}/charges/${chargeId}`);
    expect(response.status).toBe(200);

    const totals = await expectTotalsConsistent(orderId);
    expect(Number(totals.freight_amount)).toBeCloseTo(0, 2);
    // The charge that was not deleted has to survive untouched.
    expect(Number(totals.other_charges_total)).toBeCloseTo(25, 2);
    expect(Number(totals.grand_total)).toBeCloseTo(25, 2);

    const remaining = await pool.query(`SELECT id FROM customer_order_charges WHERE order_id = $1`, [orderId]);
    expect(remaining.rowCount).toBe(1);
  });

  it("returns 404 for an order that is not in this company", async () => {
    const response = await agent.delete("/api/factory/customer-orders/999999/charges/1");
    expect(response.status).toBe(404);
  });
});

describe("POST /api/factory/customer-orders/:id/charges/relink-vouchers", () => {
  it("refuses to relink an order that is not finalized, and moves no money doing so", async () => {
    const orderId = await createOrder();
    await agent
      .post(`/api/factory/customer-orders/${orderId}/charges`)
      .send({ name: "Freight", amount: "33.00", chargeType: "FREIGHT" });
    const before = await orderTotals(orderId);

    const response = await agent.post(`/api/factory/customer-orders/${orderId}/charges/relink-vouchers`).send({});

    // Relinking posts charge vouchers against the customer's ledger account, so
    // it only makes sense once the order is finalized — running it on a draft
    // would put entries in the ledger for an order that can still change.
    expect(response.status).toBe(400);
    expect(await orderTotals(orderId)).toEqual(before);
  });

  it("relinks a finalized order without altering its totals", async () => {
    const orderId = await createOrder();
    await agent
      .post(`/api/factory/customer-orders/${orderId}/charges`)
      .send({ name: "Freight", amount: "44.00", chargeType: "FREIGHT" });
    await pool.query(`UPDATE customer_orders SET status = 'FINALIZED' WHERE id = $1`, [orderId]);
    const before = await orderTotals(orderId);

    const response = await agent.post(`/api/factory/customer-orders/${orderId}/charges/relink-vouchers`).send({});

    // Repairing FK linkage between charges and their vouchers must never move
    // money — the totals are the invoice.
    expect(response.status).toBe(200);
    expect(await orderTotals(orderId)).toEqual(before);
  });

  it("returns 404 for an order in another company", async () => {
    const response = await agent.post("/api/factory/customer-orders/999999/charges/relink-vouchers").send({});
    expect(response.status).toBe(404);
  });
});

describe("PATCH charge amounts at the cents the charge stores", () => {
  async function orderWithCharge(): Promise<{ orderId: number; chargeId: number }> {
    const orderId = await createOrder();
    await agent
      .post(`/api/factory/customer-orders/${orderId}/charges`)
      .send({ name: "Freight", amount: "10.00", chargeType: "FREIGHT" });
    const chargeId = (
      await pool.query<{ id: number }>(`SELECT id FROM customer_order_charges WHERE order_id = $1`, [orderId])
    ).rows[0].id;
    return { orderId, chargeId };
  }

  it("rounds a half-cent amount half up, as the charge's voucher does", async () => {
    const { orderId, chargeId } = await orderWithCharge();

    const response = await agent
      .patch(`/api/factory/customer-orders/${orderId}/charges/${chargeId}`)
      .send({ amount: "1.005" });
    expect(response.status).toBe(200);

    // The float path wrote parseFloat("1.005").toFixed(2) = "1.00", while a
    // linked voucher's numeric(…, 2) column kept 1.01.
    const charge = await pool.query<{ amount: string }>(`SELECT amount FROM customer_order_charges WHERE id = $1`, [
      chargeId,
    ]);
    expect(charge.rows[0].amount).toBe("1.01");
    expect((await expectTotalsConsistent(orderId)).grand_total).toBe("1.01");
  });

  it("refuses an amount that is not a number instead of storing NaN", async () => {
    const { orderId, chargeId } = await orderWithCharge();

    const response = await agent
      .patch(`/api/factory/customer-orders/${orderId}/charges/${chargeId}`)
      .send({ amount: "abc" });
    expect(response.status).toBe(400);

    const charge = await pool.query<{ amount: string }>(`SELECT amount FROM customer_order_charges WHERE id = $1`, [
      chargeId,
    ]);
    expect(charge.rows[0].amount).toBe("10.00");
  });
});
