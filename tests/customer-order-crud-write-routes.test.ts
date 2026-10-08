/**
 * Behavioural coverage for the customer-order CRUD write routes.
 *
 * All seven were guard-only. A customer order is the invoice: it holds the
 * bales sold, the proforma they are priced against, and the totals the customer
 * is billed from.
 *
 * The two that touch stock and money directly:
 *
 *   - **`DELETE` releases the bales.** It is a soft delete — the order, its
 *     lines and its bale links survive so it can be restored — but every bale
 *     goes back to `IN_STOCK` so it can be re-sold. A finalized invoice is
 *     refused outright, because releasing bales that have already been billed
 *     would put sold stock back on the shelf.
 *   - **`link-proforma` re-prices the order.** Linking wipes the expected lines
 *     and backfills them from the new proforma, so a stale line surviving a
 *     re-link would compare scans against a proforma that no longer applies.
 *     It refuses a customer mismatch, an inactive proforma, and any order that
 *     is not LOADING.
 *
 * The status guards are the point of the rest: only a DRAFT order may have its
 * date changed, because the date drives which accounting period the invoice
 * lands in.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "ordcrud";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let customerId: number;
let otherCustomerId: number;
let seq = 0;

async function orderRow(id: number) {
  const result = await pool.query<{
    status: string;
    is_hidden: boolean | null;
    deleted_at: string | null;
    proforma_id_used: number | null;
    order_date: string | null;
    container_number: string | null;
    container_notes: string | null;
  }>(
    `SELECT status, is_hidden, deleted_at, proforma_id_used, order_date, container_number, container_notes
     FROM customer_orders WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

async function createOrder(status = "DRAFT", customer = customerId): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status)
     VALUES ($1, $2, '2026-06-01', $3) RETURNING id`,
    [ctx.companyId, customer, status]
  );
  return result.rows[0].id;
}

/** A proforma with one line, optionally for a different customer. */
async function createProforma(customer = customerId, isActive = true): Promise<number> {
  seq += 1;
  const proforma = await pool.query<{ id: number }>(
    `INSERT INTO customer_proformas (company_id, customer_id, name, is_active)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [ctx.companyId, customer, `${TEST_PREFIX} proforma ${seq}`, isActive]
  );
  await pool.query(
    `INSERT INTO customer_proforma_lines (proforma_id, article_code, product_name, quantity, price_per_bale)
     VALUES ($1, $2, $3, 5, '12.00')`,
    [proforma.rows[0].id, `${TEST_PREFIX}-ART-${seq}`, `${TEST_PREFIX} product ${seq}`]
  );
  return proforma.rows[0].id;
}

async function expectedLineCount(orderId: number): Promise<number> {
  const result = await pool.query(`SELECT id FROM customer_order_expected_lines WHERE order_id = $1`, [orderId]);
  return result.rowCount ?? 0;
}

/** A bale attached to an order and reserved against it. */
async function attachReservedBale(orderId: number): Promise<number> {
  seq += 1;
  const bale = await pool.query<{ id: number }>(
    `INSERT INTO factory_bales
       (company_id, bale_code, reference_number, weight_kg, cost_per_kg, total_cost, status)
     VALUES ($1, $2, $2, '30.000', '1.50', '45.00', 'RESERVED_FOR_ORDER') RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-B${seq}`]
  );
  await pool.query(
    `INSERT INTO customer_order_bales (order_id, bale_id, bale_reference, location_id, weight, price_used)
     VALUES ($1, $2, $3, $4, '30.000', '10.00')`,
    [orderId, bale.rows[0].id, `${TEST_PREFIX}-B${seq}`, ctx.locationId]
  );
  return bale.rows[0].id;
}

async function baleStatus(id: number): Promise<string> {
  const result = await pool.query<{ status: string }>(`SELECT status FROM factory_bales WHERE id = $1`, [id]);
  return result.rows[0].status;
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
    [ctx.companyId, `${TEST_PREFIX}-C1`, `${TEST_PREFIX} Customer One`]
  );
  customerId = customer.rows[0].id;

  const other = await pool.query<{ id: number }>(
    `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, $3) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-C2`, `${TEST_PREFIX} Customer Two`]
  );
  otherCustomerId = other.rows[0].id;
}, 120000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("POST /api/factory/customer-orders", () => {
  it("creates the order as DRAFT regardless of the status sent", async () => {
    const response = await agent
      .post("/api/factory/customer-orders")
      .send({ customerId, orderDate: "2026-06-01", status: "FINALIZED" });

    expect(response.status).toBe(200);
    // Status is forced. A client that could open an order straight into
    // FINALIZED would skip every guard that keys off DRAFT.
    expect((await orderRow(response.body.id))?.status).toBe("DRAFT");
  });

  it("rejects an order with no customer", async () => {
    const response = await agent.post("/api/factory/customer-orders").send({ orderDate: "2026-06-01" });
    expect(response.status).toBe(400);
  });
});

describe("PATCH /api/factory/customer-orders/:id/hidden", () => {
  it("hides and unhides the order", async () => {
    const orderId = await createOrder();

    expect((await agent.patch(`/api/factory/customer-orders/${orderId}/hidden`).send({ isHidden: true })).status).toBe(
      200
    );
    expect((await orderRow(orderId))?.is_hidden).toBe(true);

    await agent.patch(`/api/factory/customer-orders/${orderId}/hidden`).send({ isHidden: false });
    expect((await orderRow(orderId))?.is_hidden).toBe(false);
  });

  it("requires a boolean rather than coercing a truthy value", async () => {
    const orderId = await createOrder();
    const response = await agent.patch(`/api/factory/customer-orders/${orderId}/hidden`).send({ isHidden: "yes" });

    expect(response.status).toBe(400);
    expect((await orderRow(orderId))?.is_hidden).not.toBe(true);
  });
});

describe("PATCH /api/factory/customer-orders/:id/date", () => {
  it("changes the date of a DRAFT order", async () => {
    const orderId = await createOrder("DRAFT");

    const response = await agent
      .patch(`/api/factory/customer-orders/${orderId}/date`)
      .send({ orderDate: "2026-07-15" });

    expect(response.status).toBe(200);
    const stored = (await orderRow(orderId))?.order_date;
    expect(new Date(stored as unknown as string).toISOString().slice(0, 10)).toBe("2026-07-15");
  });

  it("refuses to move the date once the order has left DRAFT", async () => {
    const orderId = await createOrder("FINALIZED");

    const response = await agent
      .patch(`/api/factory/customer-orders/${orderId}/date`)
      .send({ orderDate: "2026-07-15" });

    // The order date decides which accounting period the invoice lands in, so
    // it is frozen the moment the invoice is real.
    expect(response.status).toBe(400);
    const stored = (await orderRow(orderId))?.order_date;
    expect(new Date(stored as unknown as string).toISOString().slice(0, 10)).toBe("2026-06-01");
  });

  it("requires a date and a known order", async () => {
    const orderId = await createOrder();
    expect((await agent.patch(`/api/factory/customer-orders/${orderId}/date`).send({})).status).toBe(400);
    expect(
      (await agent.patch("/api/factory/customer-orders/999999/date").send({ orderDate: "2026-07-15" })).status
    ).toBe(404);
  });
});

describe("PATCH /api/factory/customer-orders/:id/link-proforma", () => {
  it("links a proforma and backfills the expected lines", async () => {
    const orderId = await createOrder("LOADING");
    const proformaId = await createProforma();

    const response = await agent.patch(`/api/factory/customer-orders/${orderId}/link-proforma`).send({ proformaId });

    expect(response.status).toBe(200);
    expect(response.body.linked.linesBackfilled).toBe(1);
    expect((await orderRow(orderId))?.proforma_id_used).toBe(proformaId);
    expect(await expectedLineCount(orderId)).toBe(1);
  });

  it("replaces the expected lines when a different proforma is linked", async () => {
    const orderId = await createOrder("LOADING");
    const first = await createProforma();
    const second = await createProforma();

    await agent.patch(`/api/factory/customer-orders/${orderId}/link-proforma`).send({ proformaId: first });
    await agent.patch(`/api/factory/customer-orders/${orderId}/link-proforma`).send({ proformaId: second });

    // A line surviving from the old proforma would have scans compared against
    // quantities that no longer apply.
    expect((await orderRow(orderId))?.proforma_id_used).toBe(second);
    expect(await expectedLineCount(orderId)).toBe(1);
  });

  it("unlinks on a null proforma, clearing the expected lines", async () => {
    const orderId = await createOrder("LOADING");
    const proformaId = await createProforma();
    await agent.patch(`/api/factory/customer-orders/${orderId}/link-proforma`).send({ proformaId });

    const response = await agent
      .patch(`/api/factory/customer-orders/${orderId}/link-proforma`)
      .send({ proformaId: null });

    expect(response.status).toBe(200);
    expect((await orderRow(orderId))?.proforma_id_used).toBeNull();
    expect(await expectedLineCount(orderId)).toBe(0);
  });

  it("refuses a proforma belonging to a different customer", async () => {
    const orderId = await createOrder("LOADING", customerId);
    const proformaId = await createProforma(otherCustomerId);

    const response = await agent.patch(`/api/factory/customer-orders/${orderId}/link-proforma`).send({ proformaId });

    // Pricing the order against another customer's agreement is the failure
    // this guard exists for.
    expect(response.status).toBe(400);
    expect(String(response.body.message)).toContain("Customer mismatch");
    expect((await orderRow(orderId))?.proforma_id_used).toBeNull();
    expect(await expectedLineCount(orderId)).toBe(0);
  });

  it("refuses an inactive proforma", async () => {
    const orderId = await createOrder("LOADING");
    const proformaId = await createProforma(customerId, false);

    const response = await agent.patch(`/api/factory/customer-orders/${orderId}/link-proforma`).send({ proformaId });

    expect(response.status).toBe(400);
    expect((await orderRow(orderId))?.proforma_id_used).toBeNull();
  });

  it("refuses to link to an order that is not LOADING", async () => {
    const orderId = await createOrder("DRAFT");
    const proformaId = await createProforma();

    const response = await agent.patch(`/api/factory/customer-orders/${orderId}/link-proforma`).send({ proformaId });

    expect(response.status).toBe(400);
    expect((await orderRow(orderId))?.proforma_id_used).toBeNull();
  });

  it("returns 404 for an unknown order or proforma", async () => {
    const orderId = await createOrder("LOADING");
    expect(
      (await agent.patch("/api/factory/customer-orders/999999/link-proforma").send({ proformaId: 1 })).status
    ).toBe(404);
    expect(
      (await agent.patch(`/api/factory/customer-orders/${orderId}/link-proforma`).send({ proformaId: 999999 })).status
    ).toBe(404);
  });
});

describe("PATCH /api/factory/customer-orders/:id/loading-note", () => {
  it("stores the note", async () => {
    const orderId = await createOrder("LOADING");

    const response = await agent
      .patch(`/api/factory/customer-orders/${orderId}/loading-note`)
      .send({ note: "bay 3, morning shift" });

    expect(response.status).toBe(200);
    expect((await orderRow(orderId))?.container_notes).toBe("bay 3, morning shift");
  });

  it("returns 404 for an order in another company", async () => {
    const response = await agent.patch("/api/factory/customer-orders/999999/loading-note").send({ note: "x" });

    expect(response.status).toBe(404);
  });
});

describe("POST /api/factory/customer-orders/:id/assign-container", () => {
  it("records the container details on the order", async () => {
    const orderId = await createOrder("LOADING");

    const response = await agent
      .post(`/api/factory/customer-orders/${orderId}/assign-container`)
      .send({ containerNumber: "MSKU7654321", shippingCompany: "Maersk", destination: "Tripoli", bookingInfo: "Quotation $2,450 / BK123" });

    expect(response.status).toBe(200);
    expect((await orderRow(orderId))?.container_number).toBe("MSKU7654321");
    const detail = await agent.get(`/api/factory/customer-orders/${orderId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.bookingInfo).toBe("Quotation $2,450 / BK123");
    const update = await agent.post(`/api/factory/customer-orders/${orderId}/assign-container`).send({ containerNotes: "Updated after booking" });
    expect(update.status).toBe(200);
    expect((await agent.get(`/api/factory/customer-orders/${orderId}`)).body.bookingInfo).toBe("Quotation $2,450 / BK123");
  });

  it("returns 404 for an order in another company", async () => {
    const response = await agent
      .post("/api/factory/customer-orders/999999/assign-container")
      .send({ containerNumber: "X" });

    expect(response.status).toBe(404);
  });
});

describe("DELETE /api/factory/customer-orders/:id", () => {
  it("soft-deletes the order and releases its bales back to stock", async () => {
    const orderId = await createOrder("LOADING");
    const baleId = await attachReservedBale(orderId);

    const response = await agent.delete(`/api/factory/customer-orders/${orderId}`);
    expect(response.status).toBe(200);

    const row = await orderRow(orderId);
    // The order survives so it can be restored from Deleted Items, but the
    // bales are freed — leaving them reserved would strand sellable stock
    // against an invoice nobody can see.
    expect(row).not.toBeNull();
    expect(row?.deleted_at).not.toBeNull();
    expect(await baleStatus(baleId)).toBe("IN_STOCK");

    const links = await pool.query(`SELECT id FROM customer_order_bales WHERE order_id = $1`, [orderId]);
    expect(links.rowCount).toBe(1);
  });

  it("refuses to delete a finalized invoice, leaving its bales alone", async () => {
    const orderId = await createOrder("FINALIZED");
    const baleId = await attachReservedBale(orderId);

    const response = await agent.delete(`/api/factory/customer-orders/${orderId}`);

    // Releasing bales that have already been billed would put sold stock back
    // on the shelf.
    expect(response.status).not.toBe(200);
    expect((await orderRow(orderId))?.deleted_at).toBeNull();
    expect(await baleStatus(baleId)).toBe("RESERVED_FOR_ORDER");
  });

  it("does not delete an already-deleted order twice", async () => {
    const orderId = await createOrder("DRAFT");
    expect((await agent.delete(`/api/factory/customer-orders/${orderId}`)).status).toBe(200);

    const second = await agent.delete(`/api/factory/customer-orders/${orderId}`);

    // The lookup excludes soft-deleted rows, so the second call finds nothing.
    expect(second.status).not.toBe(200);
  });
});
