/**
 * Behavioural coverage for the shipping-container row write routes.
 *
 * All six were guard-only. A row tracks one customer invoice through shipping,
 * and `DELETE` is the one that touches stock: if the linked order is still
 * `LOADING`, removing the row has to put its bales back into stock and return
 * the order to `DRAFT`, because a loading order is deducted from stock
 * availability.
 *
 * What is pinned:
 *
 *   - **One row per invoice.** The endpoint checks for an existing row and the
 *     table carries a unique index; a second row would double-count the invoice
 *     on the shipping board.
 *   - **Deleting a LOADING row returns the bales.** Legacy orders mark their
 *     bales `RESERVED_FOR_ORDER`; those go back to `IN_STOCK`, and the order
 *     drops to `DRAFT`. Skipping either leaves stock permanently reserved
 *     against an invoice that is no longer being shipped.
 *   - **Deleting a non-LOADING row leaves the order alone.** The restore is
 *     conditional, and running it on a finalized order would un-sell its bales.
 *   - **`done` and `restore` are exact inverses.** `restore` has to clear
 *     `doneAt`, `doneBy` and `whatsappSentAt` as well as the flag, or a
 *     re-opened row still looks notified.
 *   - **`sync-order` writes to the order, not the row**, and only within the
 *     session's company.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "shiprow";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let customerId: number;
let seq = 0;

interface RowRecord {
  id: number;
  is_done: boolean | null;
  done_at: string | null;
  done_by: string | null;
  whatsapp_sent_at: string | null;
  note: string | null;
  anything: string | null;
}

async function rowRecord(id: number): Promise<RowRecord | null> {
  const result = await pool.query<RowRecord>(
    `SELECT id, is_done, done_at, done_by, whatsapp_sent_at, note, anything
     FROM factory_shipping_container_rows WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

async function orderRecord(id: number) {
  const result = await pool.query<{ status: string; container_number: string | null; destination: string | null }>(
    `SELECT status, container_number, destination FROM customer_orders WHERE id = $1`,
    [id]
  );
  return result.rows[0];
}

async function createOrder(status = "DRAFT", proformaIdUsed: number | null = null): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status, proforma_id_used)
     VALUES ($1, $2, '2026-06-01', $3, $4) RETURNING id`,
    [ctx.companyId, customerId, status, proformaIdUsed]
  );
  return result.rows[0].id;
}

/** A bale reserved against an order, as a legacy loading order leaves it. */
async function createReservedBale(orderId: number): Promise<number> {
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

async function createRow(orderId: number): Promise<number> {
  const response = await agent
    .post("/api/factory/shipping-container-rows")
    .send({ customerOrderId: orderId, orderDate: "2026-06-01" });
  if (response.status !== 201) throw new Error(`Seed row failed: ${response.status} ${response.text}`);
  return response.body.id;
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
  await pool.query(`DELETE FROM factory_shipping_container_rows WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(
    `DELETE FROM customer_order_bales WHERE order_id IN (SELECT id FROM customer_orders WHERE company_id = $1)`,
    [ctx.companyId]
  );
  await pool.query(`DELETE FROM customer_orders WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(
    `DELETE FROM customer_proforma_lines WHERE proforma_id IN
       (SELECT id FROM customer_proformas WHERE company_id = $1)`,
    [ctx.companyId]
  );
  await pool.query(`DELETE FROM customer_proformas WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM customers WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("POST /api/factory/shipping-container-rows", () => {
  it("creates one row for the invoice", async () => {
    const orderId = await createOrder();
    const rowId = await createRow(orderId);

    expect(await rowRecord(rowId)).not.toBeNull();
  });

  it("refuses a second row for the same invoice", async () => {
    const orderId = await createOrder();
    await createRow(orderId);

    const duplicate = await agent
      .post("/api/factory/shipping-container-rows")
      .send({ customerOrderId: orderId, orderDate: "2026-06-01" });

    // Two rows would double-count the invoice on the shipping board.
    expect(duplicate.status).toBe(409);
    const rows = await pool.query(`SELECT id FROM factory_shipping_container_rows WHERE customer_order_id = $1`, [
      orderId,
    ]);
    expect(rows.rowCount).toBe(1);
  });

  it("returns 404 for an invoice in another company", async () => {
    const response = await agent
      .post("/api/factory/shipping-container-rows")
      .send({ customerOrderId: 999999, orderDate: "2026-06-01" });

    expect(response.status).toBe(404);
  });

  it("requires an invoice and an order date", async () => {
    const orderId = await createOrder();
    expect((await agent.post("/api/factory/shipping-container-rows").send({ orderDate: "2026-06-01" })).status).toBe(
      400
    );
    expect((await agent.post("/api/factory/shipping-container-rows").send({ customerOrderId: orderId })).status).toBe(
      400
    );
  });
});

describe("PATCH /api/factory/shipping-container-rows/:id", () => {
  it("updates only the fields sent, including the free-text Anything column", async () => {
    const rowId = await createRow(await createOrder());

    const response = await agent
      .patch(`/api/factory/shipping-container-rows/${rowId}`)
      .send({ note: "at port", anything: "Call broker after customs / ref 88-A" });

    expect(response.status).toBe(200);
    const row = await rowRecord(rowId);
    expect(row?.note).toBe("at port");
    expect(row?.anything).toBe("Call broker after customs / ref 88-A");

    const list = await agent.get("/api/factory/shipping-container-rows?isDone=false&pageSize=500");
    expect(list.status).toBe(200);
    expect(list.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: rowId,
          anything: "Call broker after customs / ref 88-A",
        }),
      ])
    );
  });

  it("returns 404 for a row in another company", async () => {
    expect((await agent.patch("/api/factory/shipping-container-rows/999999").send({ note: "x" })).status).toBe(404);
  });
});

describe("PATCH /api/factory/shipping-container-rows/:id/sync-order", () => {
  it("writes the shipping fields onto the linked order", async () => {
    const orderId = await createOrder();
    const rowId = await createRow(orderId);

    const response = await agent
      .patch(`/api/factory/shipping-container-rows/${rowId}/sync-order`)
      .send({ containerNumber: "MSKU1234567", destination: "Beirut" });

    expect(response.status).toBe(200);
    // These live on the order, not the row — the shipping board edits them
    // through the row, but the invoice is where they are read from.
    const order = await orderRecord(orderId);
    expect(order.container_number).toBe("MSKU1234567");
    expect(order.destination).toBe("Beirut");
  });

  it("returns 404 for a row in another company", async () => {
    const response = await agent
      .patch("/api/factory/shipping-container-rows/999999/sync-order")
      .send({ destination: "x" });

    expect(response.status).toBe(404);
  });
});

describe("POST /api/factory/shipping-container-rows/:id/done and /api/factory/shipping-container-rows/:id/restore", () => {
  it("marks the row done with a timestamp and a user", async () => {
    const rowId = await createRow(await createOrder());

    const response = await agent.post(`/api/factory/shipping-container-rows/${rowId}/done`).send({});

    expect(response.status).toBe(200);
    const row = await rowRecord(rowId);
    expect(row?.is_done).toBe(true);
    expect(row?.done_at).not.toBeNull();
    expect(row?.done_by).toBeTruthy();
    expect(row?.whatsapp_sent_at).toBeNull();
  });

  it("stamps the WhatsApp time only when asked", async () => {
    const rowId = await createRow(await createOrder());

    await agent.post(`/api/factory/shipping-container-rows/${rowId}/done`).send({ markWhatsappSent: true });

    expect((await rowRecord(rowId))?.whatsapp_sent_at).not.toBeNull();
  });

  it("restores the row to exactly its pre-done state", async () => {
    const rowId = await createRow(await createOrder());
    await agent.post(`/api/factory/shipping-container-rows/${rowId}/done`).send({ markWhatsappSent: true });

    const response = await agent.post(`/api/factory/shipping-container-rows/${rowId}/restore`).send({});

    expect(response.status).toBe(200);
    const row = await rowRecord(rowId);
    // All four have to clear. A re-opened row that still carried
    // whatsappSentAt would be skipped by the next notification run.
    expect(row?.is_done).toBe(false);
    expect(row?.done_at).toBeNull();
    expect(row?.done_by).toBeNull();
    expect(row?.whatsapp_sent_at).toBeNull();
  });
});

describe("DELETE /api/factory/shipping-container-rows/:id", () => {
  it("returns a loading order's bales to stock and drops it back to DRAFT", async () => {
    const orderId = await createOrder("LOADING");
    const baleId = await createReservedBale(orderId);
    const rowId = await createRow(orderId);

    const response = await agent.delete(`/api/factory/shipping-container-rows/${rowId}`);
    expect(response.status).toBe(200);

    // Without this the bale stays RESERVED_FOR_ORDER forever, held against an
    // invoice that is no longer being shipped, and the order keeps being
    // deducted from stock availability.
    expect(await baleStatus(baleId)).toBe("IN_STOCK");
    expect((await orderRecord(orderId)).status).toBe("DRAFT");
    expect(await rowRecord(rowId)).toBeNull();
  });

  it("leaves a non-loading order untouched", async () => {
    const orderId = await createOrder("FINALIZED");
    const baleId = await createReservedBale(orderId);
    const rowId = await createRow(orderId);

    expect((await agent.delete(`/api/factory/shipping-container-rows/${rowId}`)).status).toBe(200);

    // The restore is conditional on LOADING for a reason: running it on a
    // finalized order would un-reserve bales that have already shipped.
    expect(await baleStatus(baleId)).toBe("RESERVED_FOR_ORDER");
    expect((await orderRecord(orderId)).status).toBe("FINALIZED");
  });

  it("does not touch bales of a V5 order, which are already in stock", async () => {
    const proforma = await pool.query<{ id: number }>(
      `INSERT INTO customer_proformas (company_id, customer_id, name) VALUES ($1, $2, $3) RETURNING id`,
      [ctx.companyId, customerId, `${TEST_PREFIX} proforma`]
    );
    const orderId = await createOrder("LOADING", proforma.rows[0].id);
    const baleId = await createReservedBale(orderId);
    const rowId = await createRow(orderId);

    expect((await agent.delete(`/api/factory/shipping-container-rows/${rowId}`)).status).toBe(200);

    // A proforma-linked order keeps its bales IN_STOCK throughout, so the
    // legacy un-reserve is skipped; the order still returns to DRAFT.
    expect(await baleStatus(baleId)).toBe("RESERVED_FOR_ORDER");
    expect((await orderRecord(orderId)).status).toBe("DRAFT");

    await pool.query(`DELETE FROM customer_proformas WHERE id = $1`, [proforma.rows[0].id]);
  });

  it("returns 404 for a row in another company", async () => {
    expect((await agent.delete("/api/factory/shipping-container-rows/999999")).status).toBe(404);
  });
});

describe("POST /api/factory/shipping-container-rows/sync", () => {
  /** Rows the sync would have to create: active orders with no row yet. */
  async function rowCount(): Promise<number> {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM factory_shipping_container_rows WHERE company_id = $1`,
      [ctx.companyId]
    );
    return Number(result.rows[0].count);
  }

  it("opens a row for every active order that has none, and is idempotent", async () => {
    const loading = await createOrder("LOADING");
    const verified = await createOrder("VERIFIED");

    const first = await agent.post("/api/factory/shipping-container-rows/sync").send({});
    expect(first.status).toBe(200);
    const afterFirst = await rowCount();

    // The board calls this on every page load. A second pass must find nothing
    // left to do — otherwise each visit doubles the board.
    const second = await agent.post("/api/factory/shipping-container-rows/sync").send({});
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(0);
    expect(await rowCount()).toBe(afterFirst);

    for (const orderId of [loading, verified]) {
      const rows = await pool.query(
        `SELECT id FROM factory_shipping_container_rows WHERE company_id = $1 AND customer_order_id = $2`,
        [ctx.companyId, orderId]
      );
      expect(rows.rowCount).toBe(1);
    }
  });

  it("ignores orders that are not being shipped", async () => {
    const draft = await createOrder("DRAFT");
    const deleted = await createOrder("LOADING");
    await pool.query(`UPDATE customer_orders SET deleted_at = now() WHERE id = $1`, [deleted]);

    await agent.post("/api/factory/shipping-container-rows/sync").send({});

    // A DRAFT order has not started loading and a soft-deleted one is gone;
    // either on the board is a container nobody is shipping.
    for (const orderId of [draft, deleted]) {
      const rows = await pool.query(
        `SELECT id FROM factory_shipping_container_rows WHERE company_id = $1 AND customer_order_id = $2`,
        [ctx.companyId, orderId]
      );
      expect(rows.rowCount).toBe(0);
    }
  });
});
