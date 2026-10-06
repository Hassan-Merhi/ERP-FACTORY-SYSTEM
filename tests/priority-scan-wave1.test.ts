import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { ensurePriorityScanSchema } from "../server/startup/priorityScanSchema";
import { closeTestServer, cleanupTestData, seedTestData, type TestContext } from "./setup";

const PREFIX = "priorityscanw1";
let ctx: TestContext;
let agent: request.SuperAgentTest;
let customerId: number;
let proformaId: number;

async function createLoading(options: { status?: string; withProforma?: boolean } = {}): Promise<number> {
  const status = options.status ?? "LOADING";
  const withProforma = options.withProforma ?? true;
  const result = await pool.query<{ id: number }>(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status, proforma_id_used)
     VALUES ($1, $2, '2026-10-03', $3, $4) RETURNING id`,
    [ctx.companyId, customerId, status, withProforma ? proformaId : null]
  );
  return result.rows[0].id;
}

beforeAll(async () => {
  await ensurePriorityScanSchema(pool);
  ctx = await seedTestData(PREFIX);
  agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login").send({
    username: `${PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

  const customer = await pool.query<{ id: number }>(
    `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, $3) RETURNING id`,
    [ctx.companyId, `${PREFIX}-C1`, `${PREFIX} Customer`]
  );
  customerId = customer.rows[0].id;

  const proforma = await pool.query<{ id: number }>(
    `INSERT INTO customer_proformas (company_id, customer_id, name, is_active)
     VALUES ($1, $2, $3, TRUE) RETURNING id`,
    [ctx.companyId, customerId, `${PREFIX} Proforma`]
  );
  proformaId = proforma.rows[0].id;
});

afterAll(async () => {
  if (ctx?.companyId) {
    await pool.query(`DELETE FROM factory_priority_scan_history WHERE company_id = $1`, [ctx.companyId]);
    await pool.query(`DELETE FROM customer_order_priority_scan_configs WHERE company_id = $1`, [ctx.companyId]);
  }
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60000);

describe("Priority Scan Wave 1 configuration foundation", () => {
  it("creates, reads, and updates a loading priority without moving an already-scanned bale", async () => {
    const orderId = await createLoading();
    const bale = await pool.query<{ id: number }>(
      `INSERT INTO factory_bales
         (company_id, bale_code, reference_number, weight_kg, cost_per_kg, total_cost, status)
       VALUES ($1, $2, $2, '40.000', '1.00', '40.00', 'RESERVED_FOR_ORDER')
       RETURNING id`,
      [ctx.companyId, `${PREFIX}-B-W1`]
    );
    await pool.query(
      `INSERT INTO customer_order_bales
         (order_id, bale_id, bale_reference, location_id, weight, article_code, bale_name, price_used, scanned_by)
       VALUES ($1, $2, $3, $4, '40.000', 'CCR', 'CCR - 40KG', '10.00', $5)`,
      [orderId, bale.rows[0].id, `${PREFIX}-B-W1`, ctx.locationId, `${PREFIX}_testuser`]
    );

    const create = await agent
      .put(`/api/factory/customer-orders/${orderId}/loading-list/priority-scan-config`)
      .send({ color: "Blue", priority: 1, enabled: true });

    expect(create.status).toBe(200);
    expect(create.body).toMatchObject({
      orderId,
      color: "Blue",
      priority: 1,
      enabled: true,
      createdBy: ctx.userId,
      createdByName: `${PREFIX}_testuser`,
      updatedBy: ctx.userId,
      updatedByName: `${PREFIX}_testuser`,
    });

    const beforeOrder = await pool.query(
      `SELECT status, proforma_id_used, total_qty_bales FROM customer_orders WHERE id = $1`,
      [orderId]
    );

    // Priorities are queue positions (Wave 2): asking for #3 while this is the
    // only active loading keeps it at #1.
    const update = await agent
      .put(`/api/factory/customer-orders/${orderId}/loading-list/priority-scan-config`)
      .send({ color: "Navy", priority: 3, enabled: true });

    expect(update.status).toBe(200);
    expect(update.body).toMatchObject({
      orderId,
      color: "Navy",
      priority: 1,
      enabled: true,
      createdBy: create.body.createdBy,
      createdByName: create.body.createdByName,
      updatedBy: ctx.userId,
      updatedByName: `${PREFIX}_testuser`,
    });

    const afterOrder = await pool.query(
      `SELECT status, proforma_id_used, total_qty_bales FROM customer_orders WHERE id = $1`,
      [orderId]
    );
    expect(afterOrder.rows[0]).toEqual(beforeOrder.rows[0]);

    const baleLink = await pool.query<{ order_id: number }>(
      `SELECT order_id FROM customer_order_bales WHERE bale_id = $1`,
      [bale.rows[0].id]
    );
    expect(baleLink.rows[0]?.order_id).toBe(orderId);

    const list = await agent.get("/api/factory/customer-orders/loading-list/priority-scan-configs");
    expect(list.status).toBe(200);
    const listed = list.body.some(
      (row: { orderId: number; color: string }) => row.orderId === orderId && row.color === "Navy"
    );
    expect(listed).toBe(true);
  });

  it("prevents duplicate active colors, queues priorities and frees colors when disabled", async () => {
    const activeQueue = async (): Promise<number[]> =>
      (
        await pool.query<{ order_id: number }>(
          `SELECT order_id FROM customer_order_priority_scan_configs
            WHERE company_id = $1 AND enabled ORDER BY priority`,
          [ctx.companyId]
        )
      ).rows.map((row) => row.order_id);

    const first = await createLoading();
    const second = await createLoading();

    const firstCreate = await agent
      .put(`/api/factory/customer-orders/${first}/loading-list/priority-scan-config`)
      .send({ color: "Purple", priority: 10 });
    expect(firstCreate.status).toBe(200);

    const duplicateColor = await agent
      .put(`/api/factory/customer-orders/${second}/loading-list/priority-scan-config`)
      .send({ color: " purple ", priority: 11 });
    expect(duplicateColor.status).toBe(409);
    expect(String(duplicateColor.body.message)).toContain("color");

    // A taken priority is a queue position, not a conflict: the loading is
    // inserted there and the rest shift down, keeping priorities 1..n.
    const queued = await agent
      .put(`/api/factory/customer-orders/${second}/loading-list/priority-scan-config`)
      .send({ color: "Gold", priority: 10 });
    expect(queued.status).toBe(200);
    const before = await activeQueue();
    expect(before.slice(-2)).toEqual([first, second]);

    const moved = await agent
      .put(`/api/factory/customer-orders/${second}/loading-list/priority-scan-config`)
      .send({ color: "Gold", priority: 1 });
    expect(moved.status).toBe(200);
    expect(moved.body.priority).toBe(1);
    expect(await activeQueue()).toEqual([second, ...before.filter((id) => id !== second)]);

    const disableFirst = await agent
      .put(`/api/factory/customer-orders/${first}/loading-list/priority-scan-config`)
      .send({ color: "Purple", priority: 10, enabled: false });
    expect(disableFirst.status).toBe(200);

    const reuse = await agent
      .put(`/api/factory/customer-orders/${second}/loading-list/priority-scan-config`)
      .send({ color: "Purple", priority: 10, enabled: true });
    expect(reuse.status).toBe(200);
  });

  it("automatically releases active color and priority locks after a loading leaves LOADING", async () => {
    const completed = await createLoading();
    const nextLoading = await createLoading();

    expect(
      (
        await agent
          .put(`/api/factory/customer-orders/${completed}/loading-list/priority-scan-config`)
          .send({ color: "Blue", priority: 40, enabled: true })
      ).status
    ).toBe(200);

    await pool.query(`UPDATE customer_orders SET status = 'PENDING_VERIFICATION' WHERE id = $1`, [completed]);

    const reuse = await agent
      .put(`/api/factory/customer-orders/${nextLoading}/loading-list/priority-scan-config`)
      .send({ color: "Blue", priority: 40, enabled: true });

    expect(reuse.status).toBe(200);

    const stale = await pool.query<{ enabled: boolean }>(
      `SELECT enabled FROM customer_order_priority_scan_configs WHERE company_id = $1 AND order_id = $2`,
      [ctx.companyId, completed]
    );
    expect(stale.rows[0]?.enabled).toBe(false);
  });

  it("requires a real pending loading with a linked proforma before activation", async () => {
    const draft = await createLoading({ status: "DRAFT" });
    const noProforma = await createLoading({ withProforma: false });

    const draftResponse = await agent
      .put(`/api/factory/customer-orders/${draft}/loading-list/priority-scan-config`)
      .send({ color: "Green", priority: 20, enabled: true });
    expect(draftResponse.status).toBe(409);

    const noProformaResponse = await agent
      .put(`/api/factory/customer-orders/${noProforma}/loading-list/priority-scan-config`)
      .send({ color: "Green", priority: 20, enabled: true });
    expect(noProformaResponse.status).toBe(409);
    expect(String(noProformaResponse.body.message)).toContain("proforma");
  });

  it("persists Priority Scans in one company-wide today list and excludes older days", async () => {
    const initialHistory = await agent.get(
      "/api/factory/customer-orders/loading-list/priority-scan-route?view=today-history"
    );
    expect(initialHistory.status).toBe(200);
    const today = String(initialHistory.body.businessDate);
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const yesterdayDate = new Date(`${today}T12:00:00Z`);
    yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
    const yesterday = yesterdayDate.toISOString().slice(0, 10);

    const sharedProforma = await pool.query<{ id: number }>(
      `INSERT INTO customer_proformas (company_id, customer_id, name, is_active)
       VALUES ($1, $2, $3, TRUE) RETURNING id`,
      [ctx.companyId, customerId, `${PREFIX} Shared History Proforma`]
    );
    const sharedProformaId = sharedProforma.rows[0].id;
    const articleCode = `${PREFIX}-HIST-A`;
    await pool.query(
      `INSERT INTO customer_proforma_lines (proforma_id, article_code, product_name, quantity, price_per_bale)
       VALUES ($1, $2, $3, 2, '10.00')`,
      [sharedProformaId, articleCode, `${PREFIX} Shared History Product`]
    );

    const loading = await pool.query<{ id: number }>(
      `INSERT INTO customer_orders (company_id, customer_id, order_date, status, proforma_id_used)
       VALUES ($1, $2, $3, 'LOADING', $4) RETURNING id`,
      [ctx.companyId, customerId, today, sharedProformaId]
    );
    const orderId = loading.rows[0].id;

    const priority = await agent
      .put(`/api/factory/customer-orders/${orderId}/loading-list/priority-scan-config`)
      .send({ color: "Lime", priority: 999, enabled: true });
    expect(priority.status).toBe(200);

    const referenceNumber = `${PREFIX}-HIST-BALE`;
    const bale = await pool.query<{ id: number }>(
      `INSERT INTO factory_bales
         (company_id, bale_code, reference_number, article_code, product_name, erp_location_id,
          weight_kg, cost_per_kg, total_cost, status)
       VALUES ($1, $2, $2, $3, $4, $5, '40.000', '1.00', '40.00', 'IN_STOCK')
       RETURNING id`,
      [
        ctx.companyId,
        referenceNumber,
        articleCode,
        `${PREFIX} Shared History Product`,
        ctx.locationId,
      ]
    );

    const scan = await agent.post(`/api/factory/customer-orders/${orderId}/bales`).send({
      scanCode: referenceNumber,
      locationId: ctx.locationId,
      priorityScan: true,
    });
    expect(scan.status).toBe(200);

    await pool.query(
      `INSERT INTO factory_priority_scan_history
         (company_id, order_id, bale_id, reference_number, product_name, article_code,
          priority, color, business_date, scanned_by, scanned_at)
       VALUES
         ($1, $2, $3, $4, 'Shared by another user', $5, 1, 'Lime', $6, 'another-user', now()),
         ($1, $2, $3, $7, 'Previous day', $5, 1, 'Lime', $8, 'another-user', now() - interval '1 day')`,
      [
        ctx.companyId,
        orderId,
        bale.rows[0].id,
        `${PREFIX}-OTHER-USER`,
        articleCode,
        today,
        `${PREFIX}-YESTERDAY`,
        yesterday,
      ]
    );

    const history = await agent.get(
      "/api/factory/customer-orders/loading-list/priority-scan-route?view=today-history"
    );
    expect(history.status).toBe(200);
    expect(history.body.businessDate).toBe(today);
    expect(history.body.serverNow).toBeTruthy();
    expect(history.body.scans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          referenceNumber,
          orderId,
          color: "Lime",
          scannedBy: `${PREFIX}_testuser`,
        }),
        expect.objectContaining({
          referenceNumber: `${PREFIX}-OTHER-USER`,
          scannedBy: "another-user",
        }),
      ])
    );
    expect(
      history.body.scans.some(
        (row: { referenceNumber: string }) => row.referenceNumber === `${PREFIX}-YESTERDAY`
      )
    ).toBe(false);
  });

  it("clears a configuration idempotently", async () => {
    const orderId = await createLoading();
    await agent
      .put(`/api/factory/customer-orders/${orderId}/loading-list/priority-scan-config`)
      .send({ color: "Orange", priority: 30, enabled: true });

    const first = await agent.delete(`/api/factory/customer-orders/${orderId}/loading-list/priority-scan-config`);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ success: true, cleared: true });

    const second = await agent.delete(`/api/factory/customer-orders/${orderId}/loading-list/priority-scan-config`);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ success: true, cleared: false });
  });
});
