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

async function setRole(role: string): Promise<void> {
  await pool.query(`UPDATE user_company_roles SET role = $1 WHERE user_id = $2 AND company_id = $3`, [
    role,
    ctx.userId,
    ctx.companyId,
  ]);
  const response = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  expect(response.status).toBe(200);
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
      .send({ color: "#B0E0E6", priority: 1, enabled: true });

    expect(create.status).toBe(200);
    expect(create.body).toMatchObject({
      orderId,
      color: "#B0E0E6",
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
      .send({ color: "#614051", priority: 3, enabled: true });

    expect(update.status).toBe(200);
    expect(update.body).toMatchObject({
      orderId,
      color: "#614051",
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
      (row: { orderId: number; color: string }) => row.orderId === orderId && row.color === "#614051"
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
      .send({ color: "#9400D3", priority: 10 });
    expect(firstCreate.status).toBe(200);

    const duplicateColor = await agent
      .put(`/api/factory/customer-orders/${second}/loading-list/priority-scan-config`)
      .send({ color: "#9400d3", priority: 11 });
    expect(duplicateColor.status).toBe(409);
    expect(String(duplicateColor.body.message)).toContain("color");

    // A taken priority is a queue position, not a conflict: the loading is
    // inserted there and the rest shift down, keeping priorities 1..n.
    const queued = await agent
      .put(`/api/factory/customer-orders/${second}/loading-list/priority-scan-config`)
      .send({ color: "#FFD700", priority: 10 });
    expect(queued.status).toBe(200);
    const before = await activeQueue();
    expect(before.slice(-2)).toEqual([first, second]);

    const moved = await agent
      .put(`/api/factory/customer-orders/${second}/loading-list/priority-scan-config`)
      .send({ color: "#FFD700", priority: 1 });
    expect(moved.status).toBe(200);
    expect(moved.body.priority).toBe(1);
    expect(await activeQueue()).toEqual([second, ...before.filter((id) => id !== second)]);

    const disableFirst = await agent
      .put(`/api/factory/customer-orders/${first}/loading-list/priority-scan-config`)
      .send({ color: "#9400D3", priority: 10, enabled: false });
    expect(disableFirst.status).toBe(200);

    const reuse = await agent
      .put(`/api/factory/customer-orders/${second}/loading-list/priority-scan-config`)
      .send({ color: "#9400D3", priority: 10, enabled: true });
    expect(reuse.status).toBe(200);
  });

  it("automatically releases active color and priority locks after a loading leaves LOADING", async () => {
    const completed = await createLoading();
    const nextLoading = await createLoading();

    expect(
      (
        await agent
          .put(`/api/factory/customer-orders/${completed}/loading-list/priority-scan-config`)
          .send({ color: "#B0E0E6", priority: 40, enabled: true })
      ).status
    ).toBe(200);

    await pool.query(`UPDATE customer_orders SET status = 'PENDING_VERIFICATION' WHERE id = $1`, [completed]);

    const reuse = await agent
      .put(`/api/factory/customer-orders/${nextLoading}/loading-list/priority-scan-config`)
      .send({ color: "#B0E0E6", priority: 40, enabled: true });

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
      .send({ color: "#808000", priority: 20, enabled: true });
    expect(draftResponse.status).toBe(409);

    const noProformaResponse = await agent
      .put(`/api/factory/customer-orders/${noProforma}/loading-list/priority-scan-config`)
      .send({ color: "#808000", priority: 20, enabled: true });
    expect(noProformaResponse.status).toBe(409);
    expect(String(noProformaResponse.body.message)).toContain("proforma");
  });

  it("lets non-admin users choose colors but reserves queue positions for Admin, Developer and Owner", async () => {
    const adminLoading = await createLoading();
    const memberLoading = await createLoading();

    const adminConfig = await agent
      .put(`/api/factory/customer-orders/${adminLoading}/loading-list/priority-scan-config`)
      .send({ color: "#6A5ACD", priority: 1, enabled: true });
    expect(adminConfig.status).toBe(200);

    const beforeMember = await agent.get("/api/factory/customer-orders/loading-list/priority-scan-configs");
    expect(beforeMember.status).toBe(200);
    const activeCount = beforeMember.body.filter((row: { enabled: boolean }) => row.enabled).length;

    // Non-admin roles only reach factory writes through an admin override, so
    // grant one while this user is still Admin before dropping to Manager.
    const override = await agent
      .post("/api/factory/admin-verify")
      .send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
    expect(override.status).toBe(200);

    await setRole("Manager");
    try {
      const colorOnly = await agent
        .put(`/api/factory/customer-orders/${memberLoading}/loading-list/priority-scan-config`)
        .send({ color: "#7FFF00", enabled: true });

      expect(colorOnly.status).toBe(200);
      expect(colorOnly.body.color).toBe("#7FFF00");
      expect(colorOnly.body.priority).toBe(activeCount + 1);

      const blockedPriority = await agent
        .put(`/api/factory/customer-orders/${memberLoading}/loading-list/priority-scan-config`)
        .send({ color: "#B22222", priority: 1, enabled: true });

      expect(blockedPriority.status).toBe(403);
      expect(blockedPriority.body.code).toBe("PRIORITY_POSITION_ADMIN_ONLY");

      const colorEdit = await agent
        .put(`/api/factory/customer-orders/${memberLoading}/loading-list/priority-scan-config`)
        .send({ color: "#B22222", enabled: true });

      expect(colorEdit.status).toBe(200);
      expect(colorEdit.body.color).toBe("#B22222");
      expect(colorEdit.body.priority).toBe(activeCount + 1);

      const blockedRemoval = await agent.delete(
        `/api/factory/customer-orders/${memberLoading}/loading-list/priority-scan-config`
      );
      expect(blockedRemoval.status).toBe(403);
      expect(blockedRemoval.body.code).toBe("PRIORITY_POSITION_ADMIN_ONLY");

      await setRole("Owner");
      const ownerPriority = await agent
        .put(`/api/factory/customer-orders/${memberLoading}/loading-list/priority-scan-config`)
        .send({ color: "#B22222", priority: 1, enabled: true });
      expect(ownerPriority.status).toBe(200);
      expect(ownerPriority.body.priority).toBe(1);

      const ownerRemoval = await agent.delete(
        `/api/factory/customer-orders/${memberLoading}/loading-list/priority-scan-config`
      );
      expect(ownerRemoval.status).toBe(200);
      expect(ownerRemoval.body.cleared).toBe(true);
    } finally {
      await setRole("Admin");
    }
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
      .send({ color: "#F7E7CE", priority: 999, enabled: true });
    expect(priority.status).toBe(200);

    const referenceNumber = `${PREFIX}-HIST-BALE`;
    const bale = await pool.query<{ id: number }>(
      `INSERT INTO factory_bales
         (company_id, bale_code, reference_number, article_code, product_name, erp_location_id,
          weight_kg, cost_per_kg, total_cost, status)
       VALUES ($1, $2, $2, $3, $4, $5, '40.000', '1.00', '40.00', 'IN_STOCK')
       RETURNING id`,
      [ctx.companyId, referenceNumber, articleCode, `${PREFIX} Shared History Product`, ctx.locationId]
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

    const history = await agent.get("/api/factory/customer-orders/loading-list/priority-scan-route?view=today-history");
    expect(history.status).toBe(200);
    expect(history.body.businessDate).toBe(today);
    expect(history.body.serverNow).toBeTruthy();
    expect(history.body.scans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          referenceNumber,
          orderId,
          color: "#F7E7CE",
          scannedBy: `${PREFIX}_testuser`,
        }),
        expect.objectContaining({
          referenceNumber: `${PREFIX}-OTHER-USER`,
          scannedBy: "another-user",
        }),
      ])
    );
    expect(
      history.body.scans.some((row: { referenceNumber: string }) => row.referenceNumber === `${PREFIX}-YESTERDAY`)
    ).toBe(false);
  });

  it("answers an unchanged poll without re-sending the history", async () => {
    const url = "/api/factory/customer-orders/loading-list/priority-scan-route?view=today-history";
    const full = await agent.get(url);
    expect(full.status).toBe(200);
    expect(full.body.signature).toMatch(/^\d{4}-\d{2}-\d{2}:\d+:\d+$/);
    expect(Array.isArray(full.body.scans)).toBe(true);

    const unchanged = await agent.get(`${url}&known=${encodeURIComponent(full.body.signature)}`);
    expect(unchanged.status).toBe(200);
    expect(unchanged.body).toMatchObject({ unchanged: true, signature: full.body.signature });
    expect(unchanged.body.scans).toBeUndefined();
    expect(unchanged.body.serverNow).toBeTruthy();

    const stale = await agent.get(`${url}&known=${encodeURIComponent("1999-01-01:0:0")}`);
    expect(stale.body.unchanged).toBeUndefined();
    expect(stale.body.scans).toEqual(full.body.scans);
  });

  it("marks an unmatched Priority Scan bale in Daily Scan using its production date", async () => {
    const history = await agent.get("/api/factory/customer-orders/loading-list/priority-scan-route?view=today-history");
    expect(history.status).toBe(200);
    const today = String(history.body.businessDate);

    const loading = await createLoading();
    const priority = await agent
      .put(`/api/factory/customer-orders/${loading}/loading-list/priority-scan-config`)
      .send({ color: "#FFB6C1", priority: 9999, enabled: true });
    expect(priority.status).toBe(200);

    const referenceNumber = `${PREFIX.toUpperCase()}-UNMATCHED-DAILY`;
    await pool.query(
      `INSERT INTO factory_bales
         (company_id, bale_code, reference_number, article_code, product_name, erp_location_id,
          stock_entry_date, weight_kg, cost_per_kg, total_cost, status)
       VALUES ($1, $2, $2, $3, $4, $5, $6, '42.000', '1.00', '42.00', 'IN_STOCK')`,
      [
        ctx.companyId,
        referenceNumber,
        `${PREFIX}-NOT-ON-PROFORMA`,
        `${PREFIX} Unmatched Product`,
        ctx.locationId,
        today,
      ]
    );

    const route = await agent.get(
      `/api/factory/customer-orders/loading-list/priority-scan-route?code=${encodeURIComponent(referenceNumber)}`
    );
    expect(route.status).toBe(409);
    expect(route.body.code).toBe("PRIORITY_SCAN_NOT_REQUIRED");

    const daily = await agent.post("/api/factory/daily-bale-scans").send({ referenceNumber });
    expect(daily.status).toBe(201);
    expect(daily.body.reference_number).toBe(referenceNumber);
    expect(daily.body.scan_date).toBe(today);

    const saved = await pool.query<{ scan_date: string }>(
      `SELECT scan_date::text AS scan_date
       FROM factory_daily_bale_scans
       WHERE company_id = $1 AND reference_number = $2`,
      [String(ctx.companyId), referenceNumber]
    );
    expect(saved.rows[0]?.scan_date).toBe(today);
  });

  it("clears a configuration idempotently", async () => {
    const orderId = await createLoading();
    await agent
      .put(`/api/factory/customer-orders/${orderId}/loading-list/priority-scan-config`)
      .send({ color: "#DAA520", priority: 30, enabled: true });

    const first = await agent.delete(`/api/factory/customer-orders/${orderId}/loading-list/priority-scan-config`);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ success: true, cleared: true });

    const second = await agent.delete(`/api/factory/customer-orders/${orderId}/loading-list/priority-scan-config`);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ success: true, cleared: false });
  });
});
