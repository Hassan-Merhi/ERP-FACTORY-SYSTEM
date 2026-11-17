/**
 * PostgreSQL concurrency coverage for loading finalization.
 *
 * The finalize route locks the source LOADING order before calculating and
 * creating a carried-over proforma. This test sends both requests at the same
 * time and verifies that the second transaction cannot create a duplicate
 * after the first transaction finalizes the source order.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "custload";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let customerId: number;
let proformaId: number;
let collidingProformaId: number;
let orderId: number;

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

  const proforma = await pool.query<{ id: number }>(
    `INSERT INTO customer_proformas (company_id, customer_id, name, is_active)
     VALUES ($1, $2, $3, true)
     RETURNING id`,
    [ctx.companyId, customerId, `${TEST_PREFIX} Proforma`]
  );
  proformaId = proforma.rows[0].id;

  const collidingProforma = await pool.query<{ id: number }>(
    `INSERT INTO customer_proformas (company_id, customer_id, name, is_active)
     VALUES ($1, $2, $3, false)
     RETURNING id`,
    [ctx.companyId, customerId, `${TEST_PREFIX} Proforma - 2 Remaining - Carried Over`]
  );
  collidingProformaId = collidingProforma.rows[0].id;

  await pool.query(
    `INSERT INTO customer_proforma_lines
       (proforma_id, article_code, product_name, quantity, price_per_bale)
     VALUES ($1, 'PARTIAL-A', 'Partial product', 3, '10.00')`,
    [proformaId]
  );

  const order = await pool.query<{ id: number }>(
    `INSERT INTO customer_orders
       (company_id, customer_id, order_date, proforma_id_used, status, location_id)
     VALUES ($1, $2, '2026-08-24', $3, 'LOADING', $4)
     RETURNING id`,
    [ctx.companyId, customerId, proformaId, ctx.locationId]
  );
  orderId = order.rows[0].id;

  const bale = await pool.query<{ id: number }>(
    `INSERT INTO factory_bales
       (company_id, bale_code, reference_number, article_code, product_name,
        weight_kg, cost_per_kg, total_cost, status)
     VALUES ($1, $2, $2, 'PARTIAL-A', 'Partial product', '30.000', '1.50', '45.00', 'RESERVED_FOR_ORDER')
     RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-BALE`]
  );

  await pool.query(
    `INSERT INTO customer_order_bales
       (order_id, bale_id, bale_reference, location_id, weight, article_code, price_used)
     VALUES ($1, $2, $3, $4, '30.000', 'PARTIAL-A', '10.00')`,
    [orderId, bale.rows[0].id, `${TEST_PREFIX}-BALE`, ctx.locationId]
  );
}, 120000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("customer loading finalization concurrency", () => {
  it("creates exactly one carried-over proforma when two finalizations race", async () => {
    const responses = await Promise.all([
      agent.post(`/api/factory/customer-orders/${orderId}/finalize-loading`).send({ createCarryoverProforma: true }),
      agent.post(`/api/factory/customer-orders/${orderId}/finalize-loading`).send({ createCarryoverProforma: true }),
    ]);

    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 400)).toHaveLength(1);

    const order = await pool.query<{ status: string; loading_finalized_at: Date | null }>(
      `SELECT status, loading_finalized_at
       FROM customer_orders
       WHERE id = $1 AND company_id = $2`,
      [orderId, ctx.companyId]
    );
    expect(order.rows).toEqual([{ status: "VERIFIED", loading_finalized_at: expect.anything() }]);

    const carriedOverProformas = await pool.query<{ id: number; name: string; status: string }>(
      `SELECT id, name, status
       FROM customer_proformas
       WHERE company_id = $1
          AND customer_id = $2
          AND id <> $3
          AND id <> $4
          AND name = $5
         AND deleted_at IS NULL`,
      [
        ctx.companyId,
        customerId,
        proformaId,
        collidingProformaId,
        `${TEST_PREFIX} Proforma - 2 Remaining - Carried Over`,
      ]
    );
    expect(carriedOverProformas.rows).toEqual([
      {
        id: expect.any(Number),
        name: `${TEST_PREFIX} Proforma - 2 Remaining - Carried Over`,
        status: "ACTIVE",
      },
    ]);

    const carriedOverLines = await pool.query<{
      article_code: string;
      quantity: number;
      price_per_bale: string;
    }>(
      `SELECT article_code, quantity::float8 AS quantity, price_per_bale
       FROM customer_proforma_lines
       WHERE proforma_id = $1`,
      [carriedOverProformas.rows[0].id]
    );
    expect(carriedOverLines.rows).toEqual([{ article_code: "PARTIAL-A", quantity: 2, price_per_bale: "10.00" }]);

    const reservations = await pool.query<{
      proforma_id: number;
      article_code: string;
      reserved_qty: number;
    }>(
      `SELECT proforma_id, article_code, reserved_qty
       FROM proforma_stock_reservations
       WHERE company_id = $1
         AND proforma_id IN ($2, $3)
       ORDER BY proforma_id`,
      [ctx.companyId, proformaId, carriedOverProformas.rows[0].id]
    );
    expect(reservations.rows).toEqual([
      {
        proforma_id: carriedOverProformas.rows[0].id,
        article_code: "PARTIAL-A",
        reserved_qty: 2,
      },
    ]);

    const sourceProforma = await pool.query<{ is_active: boolean; status: string }>(
      `SELECT is_active, status
       FROM customer_proformas
       WHERE id = $1 AND company_id = $2`,
      [proformaId, ctx.companyId]
    );
    expect(sourceProforma.rows).toEqual([{ is_active: false, status: "PARTIALLY_DISPATCHED" }]);

    const pendingLoadings = await pool.query<{ id: number }>(
      `SELECT id
       FROM customer_orders
       WHERE company_id = $1
         AND proforma_id_used = $2
         AND id <> $3
         AND status = 'LOADING'
         AND deleted_at IS NULL`,
      [ctx.companyId, proformaId, orderId]
    );
    expect(pendingLoadings.rows).toEqual([]);
  });

  it("rejects a retry after finalization without creating more records", async () => {
    const beforeDaybook = await pool.query<{ tx_type: string; reference_id: number }>(
      `SELECT tx_type, reference_id
       FROM factory_daybook_entries
       WHERE company_id = $1
         AND reference_table = 'customer_orders'
         AND reference_id = $2
         AND tx_type IN ('LOADING_SUBMITTED', 'ORDER_VERIFIED')`,
      [ctx.companyId, orderId]
    );
    const beforeCarryovers = await pool.query<{ id: number }>(
      `SELECT id
       FROM customer_proformas
       WHERE company_id = $1
          AND customer_id = $2
          AND id <> $3
          AND name = $4
         AND deleted_at IS NULL`,
      [ctx.companyId, customerId, proformaId, `${TEST_PREFIX} Proforma - 2 Remaining - Carried Over`]
    );

    const retry = await agent
      .post(`/api/factory/customer-orders/${orderId}/finalize-loading`)
      .send({ createCarryoverProforma: true });

    expect(retry.status).toBe(400);
    expect(retry.body).toEqual({ message: "Only LOADING orders can be finalized for loading" });

    const order = await pool.query<{ status: string; loading_finalized_at: Date | null }>(
      `SELECT status, loading_finalized_at
       FROM customer_orders
       WHERE id = $1 AND company_id = $2`,
      [orderId, ctx.companyId]
    );
    expect(order.rows).toEqual([{ status: "VERIFIED", loading_finalized_at: expect.anything() }]);

    const afterCarryovers = await pool.query<{ id: number }>(
      `SELECT id
       FROM customer_proformas
       WHERE company_id = $1
          AND customer_id = $2
          AND id <> $3
          AND name = $4
         AND deleted_at IS NULL`,
      [ctx.companyId, customerId, proformaId, `${TEST_PREFIX} Proforma - 2 Remaining - Carried Over`]
    );
    const afterDaybook = await pool.query<{ tx_type: string; reference_id: number }>(
      `SELECT tx_type, reference_id
       FROM factory_daybook_entries
       WHERE company_id = $1
         AND reference_table = 'customer_orders'
         AND reference_id = $2
         AND tx_type IN ('LOADING_SUBMITTED', 'ORDER_VERIFIED')`,
      [ctx.companyId, orderId]
    );

    expect(afterCarryovers.rows).toEqual(beforeCarryovers.rows);
    expect(afterDaybook.rows).toEqual(beforeDaybook.rows);
  });

  it("rejects carry-over while another active loading uses the source proforma", async () => {
    const multiProforma = await pool.query<{ id: number }>(
      `INSERT INTO customer_proformas (company_id, customer_id, name, is_active)
       VALUES ($1, $2, $3, true)
       RETURNING id`,
      [ctx.companyId, customerId, `${TEST_PREFIX} Multi Loading Proforma`]
    );
    const multiProformaId = multiProforma.rows[0].id;
    await pool.query(
      `INSERT INTO customer_proforma_lines
         (proforma_id, article_code, product_name, quantity, price_per_bale)
       VALUES ($1, 'MULTI-A', 'Multi product', 3, '15.00')`,
      [multiProformaId]
    );
    const orders = await pool.query<{ id: number }>(
      `INSERT INTO customer_orders
         (company_id, customer_id, order_date, proforma_id_used, status, location_id)
       VALUES
         ($1, $2, '2026-08-24', $3, 'LOADING', $4),
         ($1, $2, '2026-08-24', $3, 'LOADING', $4)
       RETURNING id`,
      [ctx.companyId, customerId, multiProformaId, ctx.locationId]
    );
    const sourceOrderId = orders.rows[0].id;
    const otherOrderId = orders.rows[1].id;
    const bale = await pool.query<{ id: number }>(
      `INSERT INTO factory_bales
         (company_id, bale_code, reference_number, article_code, product_name,
          weight_kg, cost_per_kg, total_cost, status)
       VALUES ($1, $2, $2, 'MULTI-A', 'Multi product', '30.000', '1.50', '45.00', 'RESERVED_FOR_ORDER')
       RETURNING id`,
      [ctx.companyId, `${TEST_PREFIX}-MULTI-BALE`]
    );
    await pool.query(
      `INSERT INTO customer_order_bales
         (order_id, bale_id, bale_reference, location_id, weight, article_code, price_used)
       VALUES ($1, $2, $3, $4, '30.000', 'MULTI-A', '15.00')`,
      [sourceOrderId, bale.rows[0].id, `${TEST_PREFIX}-MULTI-BALE`, ctx.locationId]
    );

    const response = await agent
      .post(`/api/factory/customer-orders/${sourceOrderId}/finalize-loading`)
      .send({ createCarryoverProforma: true });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      message: `Cannot move remaining while loading #${otherOrderId} still uses this proforma`,
    });

    const unchangedOrders = await pool.query<{ id: number; status: string }>(
      `SELECT id, status
       FROM customer_orders
       WHERE id IN ($1, $2)
       ORDER BY id`,
      [sourceOrderId, otherOrderId]
    );
    expect(unchangedOrders.rows).toEqual([
      { id: sourceOrderId, status: "LOADING" },
      { id: otherOrderId, status: "LOADING" },
    ]);

    const unchangedProforma = await pool.query<{ is_active: boolean; status: string }>(
      `SELECT is_active, status
       FROM customer_proformas
       WHERE id = $1`,
      [multiProformaId]
    );
    expect(unchangedProforma.rows).toEqual([{ is_active: true, status: "ACTIVE" }]);

    const carryovers = await pool.query<{ id: number }>(
      `SELECT id
       FROM customer_proformas
       WHERE company_id = $1
         AND customer_id = $2
         AND name = $3
         AND id <> $4`,
      [ctx.companyId, customerId, `${TEST_PREFIX} Multi Loading Proforma - 2 Remaining - Carried Over`, multiProformaId]
    );
    expect(carryovers.rows).toEqual([]);
  });
});
