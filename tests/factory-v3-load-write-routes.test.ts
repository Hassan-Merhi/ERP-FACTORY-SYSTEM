/**
 * Behavioural coverage for the v3 stock-allocation load write routes.
 *
 * All six were guard-only, and they are the highest-risk cluster left on that
 * list: finalizing a load writes `status = 'SOLD'` onto every bale in it, which
 * is the point where stock leaves inventory for good.
 *
 * The whole cluster is one state machine, and every transition guard is load
 * bearing:
 *
 *     expected_to_load --start--> loading --finalize--> finalized
 *                    \                  \
 *                     `------cancel------`--> cancelled
 *
 * Bales may only be scanned while a load is `loading`, may not be removed once
 * it is `finalized`, and a finalized load may not be cancelled. Each of those
 * is the only thing standing between a corrected load and stock that has
 * already been sold.
 *
 * The assertion that matters most is on finalize: a bale removed from the load
 * must NOT be marked SOLD. Removal is soft — `removed_at` is stamped and the
 * row stays — so finalize has to filter on it. If it ever stopped, every bale
 * scanned by mistake and then removed would be written out of stock anyway,
 * silently, with the load looking perfectly normal.
 *
 * Wave 17 B (owner decision 1): finalize also invoices the load (a FINALIZED
 * customer order with the bales at their proforma price, the customer's SALE
 * row) in the same transaction, so the bales here sit on a location and their
 * articles are on the proforma; re-finalizing is idempotent (it used to be
 * refused with 400). The invoice itself is covered by
 * wave17b-inventory-factory.test.ts.
 *
 * The scan endpoint's two 409 warnings are covered from both sides, because
 * `bypass` is what turns a refusal into a write: a bale reserved for another
 * order, or already sitting in another active load, is refused once and
 * accepted on the confirming scan.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "v3load";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let customerId: number;
let proformaId: number;
let seq = 0;

async function createBale(status = "IN_STOCK"): Promise<{ id: number; reference: string }> {
  seq += 1;
  const reference = `${TEST_PREFIX}-REF-${seq}`;
  const article = `${TEST_PREFIX}-ART-${seq}`;
  const result = await pool.query<{ id: number }>(
    `INSERT INTO factory_bales
       (company_id, bale_code, reference_number, article_code, product_name, weight_kg, cost_per_kg, total_cost, status,
        erp_location_id)
     VALUES ($1, $2, $2, $3, $4, '25.000', '2.00', '50.00', $5, $6) RETURNING id`,
    [ctx.companyId, reference, article, `${TEST_PREFIX} product`, status, ctx.locationId]
  );
  // The invoice prices each bale from the proforma (wave 17 B).
  await pool.query(
    `INSERT INTO customer_proforma_lines (proforma_id, article_code, product_name, quantity, price_per_bale)
     VALUES ($1, $2, $3, 10, '80.00')`,
    [proformaId, article, `${TEST_PREFIX} product`]
  );
  return { id: result.rows[0].id, reference };
}

async function baleStatus(id: number): Promise<string> {
  const result = await pool.query<{ status: string }>(`SELECT status FROM factory_bales WHERE id = $1`, [id]);
  return result.rows[0].status;
}

async function loadStatus(id: number): Promise<string> {
  const result = await pool.query<{ status: string }>(`SELECT status FROM factory_v3_loads WHERE id = $1`, [id]);
  return result.rows[0].status;
}

/** A load in `expected_to_load`. */
async function createLoad(): Promise<number> {
  seq += 1;
  const response = await agent.post("/api/factory/v3/loads").send({
    proformaId,
    loadName: `${TEST_PREFIX} load ${seq}`,
    expectedLoadDate: "2026-07-01",
  });
  if (response.status !== 201) throw new Error(`Seed load failed: ${response.status} ${response.text}`);
  return response.body.id;
}

/** A load already advanced to `loading`, ready to take scans. */
async function createLoadingLoad(): Promise<number> {
  const id = await createLoad();
  const started = await agent.patch(`/api/factory/v3/loads/${id}/start`);
  if (started.status !== 200) throw new Error(`Start failed: ${started.status} ${started.text}`);
  return id;
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

  const proforma = await pool.query<{ id: number }>(
    `INSERT INTO customer_proformas (company_id, customer_id, name) VALUES ($1, $2, $3) RETURNING id`,
    [ctx.companyId, customerId, `${TEST_PREFIX} proforma`]
  );
  proformaId = proforma.rows[0].id;
}, 120000);

afterAll(async () => {
  await pool.query(
    `DELETE FROM factory_v3_load_bales WHERE load_id IN (SELECT id FROM factory_v3_loads WHERE company_id = $1)`,
    [ctx.companyId]
  );
  await pool.query(`DELETE FROM customer_balances WHERE company_id = $1`, [ctx.companyId]);
  for (const table of ["customer_order_bales", "customer_order_lines"]) {
    await pool.query(`DELETE FROM ${table} WHERE order_id IN (SELECT id FROM customer_orders WHERE company_id = $1)`, [
      ctx.companyId,
    ]);
  }
  await pool.query(`DELETE FROM customer_orders WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM customer_invoice_sequences WHERE company_id = $1`, [ctx.companyId]);
  await deleteAuditLogRowsForTests(pool, "company_id = $1", [ctx.companyId]);
  await pool.query(`DELETE FROM factory_v3_loads WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM customer_proformas WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM customers WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("POST /api/factory/v3/loads", () => {
  it("opens a load in expected_to_load", async () => {
    const id = await createLoad();
    expect(await loadStatus(id)).toBe("expected_to_load");
  });

  it("requires a proforma, a name and an expected date", async () => {
    for (const body of [
      { loadName: "x", expectedLoadDate: "2026-07-01" },
      { proformaId, expectedLoadDate: "2026-07-01" },
      { proformaId, loadName: "x" },
    ]) {
      expect((await agent.post("/api/factory/v3/loads").send(body)).status).toBe(400);
    }
  });
});

describe("PATCH /api/factory/v3/loads/:id/start", () => {
  it("moves expected_to_load to loading", async () => {
    const id = await createLoad();
    const response = await agent.patch(`/api/factory/v3/loads/${id}/start`);

    expect(response.status).toBe(200);
    expect(await loadStatus(id)).toBe("loading");
  });

  it("refuses to start a load that is already loading", async () => {
    const id = await createLoadingLoad();
    const response = await agent.patch(`/api/factory/v3/loads/${id}/start`);

    expect(response.status).toBe(400);
    expect(await loadStatus(id)).toBe("loading");
  });

  it("returns 404 for a load in another company", async () => {
    expect((await agent.patch("/api/factory/v3/loads/999999/start")).status).toBe(404);
  });
});

describe("POST /api/factory/v3/loads/:id/bales", () => {
  it("scans a bale in by its reference number", async () => {
    const loadId = await createLoadingLoad();
    const bale = await createBale();

    const response = await agent.post(`/api/factory/v3/loads/${loadId}/bales`).send({ scanCode: bale.reference });

    expect(response.status).toBe(201);
    expect(response.body.baleId).toBe(bale.id);
    // Scanning allocates, it does not sell — the bale stays in stock until the
    // load is finalized.
    expect(await baleStatus(bale.id)).toBe("IN_STOCK");
  });

  it("refuses to scan into a load that has not started", async () => {
    const loadId = await createLoad();
    const bale = await createBale();

    const response = await agent.post(`/api/factory/v3/loads/${loadId}/bales`).send({ scanCode: bale.reference });

    expect(response.status).toBe(400);
    const rows = await pool.query(`SELECT id FROM factory_v3_load_bales WHERE load_id = $1`, [loadId]);
    expect(rows.rowCount).toBe(0);
  });

  it("refuses the same bale twice in one load", async () => {
    const loadId = await createLoadingLoad();
    const bale = await createBale();

    expect((await agent.post(`/api/factory/v3/loads/${loadId}/bales`).send({ scanCode: bale.reference })).status).toBe(
      201
    );
    const second = await agent.post(`/api/factory/v3/loads/${loadId}/bales`).send({ scanCode: bale.reference });

    // Counting one physical bale twice overstates the load and, at finalize,
    // would try to sell it twice.
    expect(second.status).toBe(400);
    const rows = await pool.query(`SELECT id FROM factory_v3_load_bales WHERE load_id = $1 AND removed_at IS NULL`, [
      loadId,
    ]);
    expect(rows.rowCount).toBe(1);
  });

  it("refuses a bale that is already SOLD", async () => {
    const loadId = await createLoadingLoad();
    const bale = await createBale("SOLD");

    const response = await agent.post(`/api/factory/v3/loads/${loadId}/bales`).send({ scanCode: bale.reference });

    expect(response.status).toBe(400);
    expect(await baleStatus(bale.id)).toBe("SOLD");
  });

  it("warns once on a bale reserved for another order, then accepts the confirming scan", async () => {
    const loadId = await createLoadingLoad();
    const bale = await createBale("RESERVED_FOR_ORDER");

    const warned = await agent.post(`/api/factory/v3/loads/${loadId}/bales`).send({ scanCode: bale.reference });
    expect(warned.status).toBe(409);
    expect(warned.body.code).toBe("RESERVED_WARNING");
    // The warning must not have written anything — that is what makes it a
    // confirmation rather than a notification.
    expect((await pool.query(`SELECT id FROM factory_v3_load_bales WHERE load_id = $1`, [loadId])).rowCount).toBe(0);

    const confirmed = await agent
      .post(`/api/factory/v3/loads/${loadId}/bales`)
      .send({ scanCode: bale.reference, bypass: true });
    expect(confirmed.status).toBe(201);
  });

  it("warns once when the bale sits in another active load, then accepts the confirming scan", async () => {
    const firstLoad = await createLoadingLoad();
    const secondLoad = await createLoadingLoad();
    const bale = await createBale();

    expect(
      (await agent.post(`/api/factory/v3/loads/${firstLoad}/bales`).send({ scanCode: bale.reference })).status
    ).toBe(201);

    const warned = await agent.post(`/api/factory/v3/loads/${secondLoad}/bales`).send({ scanCode: bale.reference });
    expect(warned.status).toBe(409);
    expect(warned.body.code).toBe("OTHER_V3_LOAD_WARNING");

    const confirmed = await agent
      .post(`/api/factory/v3/loads/${secondLoad}/bales`)
      .send({ scanCode: bale.reference, bypass: true });
    expect(confirmed.status).toBe(201);
  });

  it("returns 404 for a scan code that matches nothing", async () => {
    const loadId = await createLoadingLoad();
    const response = await agent.post(`/api/factory/v3/loads/${loadId}/bales`).send({ scanCode: "no-such-bale" });

    expect(response.status).toBe(404);
  });

  it("requires a scan code", async () => {
    const loadId = await createLoadingLoad();
    expect((await agent.post(`/api/factory/v3/loads/${loadId}/bales`).send({})).status).toBe(400);
  });
});

describe("DELETE /api/factory/v3/loads/:id/bales/:baleId", () => {
  it("soft-removes the scan, keeping the row and stamping removed_at", async () => {
    const loadId = await createLoadingLoad();
    const bale = await createBale();
    const scanned = await agent.post(`/api/factory/v3/loads/${loadId}/bales`).send({ scanCode: bale.reference });

    const response = await agent.delete(`/api/factory/v3/loads/${loadId}/bales/${scanned.body.id}`);
    expect(response.status).toBe(200);

    // The row survives so the load keeps its audit trail of what was scanned
    // and taken back off.
    const row = await pool.query<{ removed_at: string | null }>(
      `SELECT removed_at FROM factory_v3_load_bales WHERE id = $1`,
      [scanned.body.id]
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].removed_at).not.toBeNull();
  });

  it("lets a removed bale be scanned back into the same load", async () => {
    const loadId = await createLoadingLoad();
    const bale = await createBale();
    const scanned = await agent.post(`/api/factory/v3/loads/${loadId}/bales`).send({ scanCode: bale.reference });
    await agent.delete(`/api/factory/v3/loads/${loadId}/bales/${scanned.body.id}`);

    // The duplicate guard only looks at non-removed rows, so correcting a
    // mistaken removal must not be blocked by the earlier scan.
    const rescan = await agent.post(`/api/factory/v3/loads/${loadId}/bales`).send({ scanCode: bale.reference });
    expect(rescan.status).toBe(201);
  });
});

describe("POST /api/factory/v3/loads/:id/finalize", () => {
  it("marks every scanned bale SOLD and closes the load", async () => {
    const loadId = await createLoadingLoad();
    const first = await createBale();
    const second = await createBale();
    await agent.post(`/api/factory/v3/loads/${loadId}/bales`).send({ scanCode: first.reference });
    await agent.post(`/api/factory/v3/loads/${loadId}/bales`).send({ scanCode: second.reference });

    const response = await agent.post(`/api/factory/v3/loads/${loadId}/finalize`);
    expect(response.status).toBe(200);

    expect(await loadStatus(loadId)).toBe("finalized");
    expect(await baleStatus(first.id)).toBe("SOLD");
    expect(await baleStatus(second.id)).toBe("SOLD");
  });

  it("does not sell a bale that was removed from the load", async () => {
    const loadId = await createLoadingLoad();
    const kept = await createBale();
    const removed = await createBale();
    await agent.post(`/api/factory/v3/loads/${loadId}/bales`).send({ scanCode: kept.reference });
    const removedScan = await agent.post(`/api/factory/v3/loads/${loadId}/bales`).send({ scanCode: removed.reference });
    await agent.delete(`/api/factory/v3/loads/${loadId}/bales/${removedScan.body.id}`);

    expect((await agent.post(`/api/factory/v3/loads/${loadId}/finalize`)).status).toBe(200);

    expect(await baleStatus(kept.id)).toBe("SOLD");
    // Removal is soft, so finalize has to filter on removed_at. If it ever
    // stopped, every bale scanned by mistake and taken back off would still be
    // written out of stock, with the load looking entirely normal.
    expect(await baleStatus(removed.id)).toBe("IN_STOCK");
  });

  it("refuses to finalize a load that has not started", async () => {
    const loadId = await createLoad();
    const response = await agent.post(`/api/factory/v3/loads/${loadId}/finalize`);

    expect(response.status).toBe(400);
    expect(await loadStatus(loadId)).toBe("expected_to_load");
  });

  it("re-finalizing is idempotent: the same invoice, no second one", async () => {
    const loadId = await createLoadingLoad();
    const bale = await createBale();
    await agent.post(`/api/factory/v3/loads/${loadId}/bales`).send({ scanCode: bale.reference });
    const first = await agent.post(`/api/factory/v3/loads/${loadId}/finalize`);
    expect(first.status).toBe(200);

    const second = await agent.post(`/api/factory/v3/loads/${loadId}/finalize`);
    expect(second.status).toBe(200);
    expect(second.body.alreadyFinalized).toBe(true);
    expect(second.body.invoice.orderId).toBe(first.body.invoice.orderId);
    const orders = await pool.query(`SELECT COUNT(*)::int AS n FROM customer_order_bales WHERE bale_id = $1`, [
      bale.id,
    ]);
    expect(orders.rows[0].n).toBe(1);
  });

  it("refuses to remove a bale from a finalized load", async () => {
    const loadId = await createLoadingLoad();
    const bale = await createBale();
    const scanned = await agent.post(`/api/factory/v3/loads/${loadId}/bales`).send({ scanCode: bale.reference });
    await agent.post(`/api/factory/v3/loads/${loadId}/finalize`);

    const response = await agent.delete(`/api/factory/v3/loads/${loadId}/bales/${scanned.body.id}`);

    // The bale is already SOLD; un-scanning it here would leave the load and
    // the stock ledger disagreeing about what shipped.
    expect(response.status).toBe(400);
    expect(await baleStatus(bale.id)).toBe("SOLD");
  });
});

describe("PATCH /api/factory/v3/loads/:id/cancel", () => {
  it("cancels a load that has not been finalized, leaving its bales in stock", async () => {
    const loadId = await createLoadingLoad();
    const bale = await createBale();
    await agent.post(`/api/factory/v3/loads/${loadId}/bales`).send({ scanCode: bale.reference });

    const response = await agent.patch(`/api/factory/v3/loads/${loadId}/cancel`);

    expect(response.status).toBe(200);
    expect(await loadStatus(loadId)).toBe("cancelled");
    // Cancelling is the opposite of finalizing: nothing may leave stock.
    expect(await baleStatus(bale.id)).toBe("IN_STOCK");
  });

  it("refuses to cancel a finalized load", async () => {
    const loadId = await createLoadingLoad();
    const bale = await createBale();
    await agent.post(`/api/factory/v3/loads/${loadId}/bales`).send({ scanCode: bale.reference });
    await agent.post(`/api/factory/v3/loads/${loadId}/finalize`);

    const response = await agent.patch(`/api/factory/v3/loads/${loadId}/cancel`);

    // The bales are sold. Cancelling now would suggest they are still available.
    expect(response.status).toBe(400);
    expect(await loadStatus(loadId)).toBe("finalized");
    expect(await baleStatus(bale.id)).toBe("SOLD");
  });
});
