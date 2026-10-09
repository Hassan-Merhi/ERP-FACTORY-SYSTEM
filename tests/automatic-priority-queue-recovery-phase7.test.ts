/**
 * Phase 7 — queue advancement, recovery, and priority-color lifecycle.
 * Authored ONLY. Claude will run tests, compilation and CI on the one PR.
 */
import request from "supertest";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import { ensurePriorityScanSchema } from "../server/startup/priorityScanSchema";
import {
  advanceSatisfiedPriorityScanConfigs,
  PRIORITY_SCAN_LOCK_NAMESPACE,
  reactivateAutoCompletedPriorityLoadingsLockedTx,
  resolvePriorityScanArticleTarget,
} from "../server/routes/factory/customer-orders/priorityScanQueue";
import { reversePriorityAllocationForDeletedBaleTx } from "../server/routes/factory/customer-orders/priorityAutoAllocation";
import { closeTestServer, cleanupTestData, seedTestData, type TestContext } from "./setup";

const PREFIX = "autoque7";
const ARTICLE = "AUTOQUEUE-JOGGER";
const QUEUE_PATH = "/api/factory/customer-orders/loading-list/priority-scan-configs";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let customerId: number;
let proformaId: number;
let red: number;
let blue: number;
let redBales: number[] = [];
let blueBale: number;

async function loading(status = "LOADING"): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status, proforma_id_used)
     VALUES ($1, $2, CURRENT_DATE, $3, $4) RETURNING id`,
    [ctx.companyId, customerId, status, proformaId]
  );
  return result.rows[0].id;
}

async function configure(orderId: number, priority: number, color: string, enabled = true) {
  const result = await agent
    .put(`/api/factory/customer-orders/${orderId}/loading-list/priority-scan-config`)
    .send({ priority, color, enabled });
  expect(result.status).toBe(200);
  return result.body;
}

async function queue() {
  const result = await agent.get(QUEUE_PATH);
  expect(result.status).toBe(200);
  return result.body as Array<{
    id: number; orderId: number; priority: number; color: string;
    enabled: boolean; updatedByName: string | null;
  }>;
}

async function activeOrderIds(): Promise<number[]> {
  return (await queue()).filter(row => row.enabled)
    .sort((a,b) => a.priority - b.priority).map(row => row.orderId);
}

async function attachBale(orderId: number, reference: string, withScanHistory = false) {
  const { rows: bales } = await pool.query<{ id: number }>(
    `INSERT INTO factory_bales
      (company_id, bale_code, reference_number, article_code,
       product_name, erp_location_id, weight_kg, cost_per_kg, total_cost, status)
     VALUES ($1, $2, $2, $3, 'Adult Jogger Pant', $4, '40', '1', '40', 'IN_STOCK')
     RETURNING id`,
    [ctx.companyId, reference, ARTICLE, ctx.locationId]
  );
  const baleId = bales[0].id;
  await pool.query(
    `INSERT INTO customer_order_bales
      (order_id, bale_id, bale_reference, location_id, weight,
       article_code, bale_name, price_used)
     VALUES ($1, $2, $3, $4, '40', $5, 'Adult Jogger Pant', '25')`,
    [orderId, baleId, reference, ctx.locationId, ARTICLE]
  );
  if (withScanHistory) {
    await pool.query(
      `INSERT INTO factory_priority_scan_history
        (company_id, order_id, bale_id, reference_number, article_code,
         priority, color, business_date, scanned_by, allocation_source)
       VALUES ($1, $2, $3, $4, $5, 1, '#dc2626', CURRENT_DATE, 'original-user', 'manual')`,
      [ctx.companyId, orderId, baleId, reference, ARTICLE]
    );
  }
  return baleId;
}

async function reverse(baleId: number, deferQueueRecovery = false) {
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, ${ctx.companyId})`);
    return reversePriorityAllocationForDeletedBaleTx(tx, {
      companyId: ctx.companyId, baleId, actor: "Queue Recovery Supervisor",
      actorId: ctx.userId, reason: "Removed damaged Jogger bale",
      deferQueueRecovery,
    });
  });
}

beforeAll(async () => {
  await ensurePriorityScanSchema(pool);
  ctx = await seedTestData(PREFIX);
  agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login")
    .send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
  expect(login.status).toBe(200);
  expect((await agent.post("/api/auth/set-company")
    .send({ companyId: ctx.companyId })).status).toBe(200);
  await pool.query("UPDATE user_company_roles SET role = 'Admin' WHERE user_id = $1 AND company_id = $2",
    [ctx.userId, ctx.companyId]);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

  const { rows: customers } = await pool.query<{ id: number }>(
    `INSERT INTO customers (company_id, code, legal_name)
     VALUES ($1, $2, 'Queue Recovery Customer') RETURNING id`,
    [ctx.companyId, `${PREFIX}-C`]
  );
  customerId = customers[0].id;
  const { rows: proformas } = await pool.query<{ id: number }>(
    `INSERT INTO customer_proformas (company_id, customer_id, name, is_active)
     VALUES ($1, $2, 'Shared Queue Proforma', TRUE) RETURNING id`,
    [ctx.companyId, customerId]
  );
  proformaId = proformas[0].id;
  await pool.query(
    `INSERT INTO customer_proforma_lines
      (proforma_id, article_code, product_name, quantity, price_per_bale)
     VALUES ($1, $2, 'Adult Jogger Pant', 2, '25')`,
    [proformaId, ARTICLE]
  );

  red = await loading();
  blue = await loading();
  await configure(red, 1, "#dc2626");
  await configure(blue, 2, "#2563eb");
  redBales = [
    await attachBale(red, `${PREFIX}-RED-1`, true),
    await attachBale(red, `${PREFIX}-RED-2`),
  ];
  blueBale = await attachBale(blue, `${PREFIX}-BLUE-1`);
}, 120000);

afterAll(async () => {
  if (ctx?.companyId) {
    await pool.query("DELETE FROM factory_priority_auto_allocations WHERE company_id = $1", [ctx.companyId]);
    await pool.query("DELETE FROM factory_priority_scan_history WHERE company_id = $1", [ctx.companyId]);
    await pool.query("DELETE FROM customer_order_priority_scan_configs WHERE company_id = $1", [ctx.companyId]);
    await pool.query("DELETE FROM customer_order_bale_removals WHERE order_id IN (SELECT id FROM customer_orders WHERE company_id = $1)", [ctx.companyId]);
    await pool.query("DELETE FROM customer_order_bales WHERE order_id IN (SELECT id FROM customer_orders WHERE company_id = $1)", [ctx.companyId]);
    await pool.query("DELETE FROM customer_order_lines WHERE order_id IN (SELECT id FROM customer_orders WHERE company_id = $1)", [ctx.companyId]);
    await pool.query("DELETE FROM factory_bales WHERE company_id = $1", [ctx.companyId]);
  }
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 90000);

describe("Phase 7: auto-advance and front-of-queue recovery", () => {
  it("completes Red but NOT Blue even when they share the exact same proforma", async () => {
    const advanced = await advanceSatisfiedPriorityScanConfigs(ctx.companyId);
    expect(advanced.completedOrderIds).toEqual([red]);
    expect(advanced.activeOrderId).toBe(blue);
    expect(await activeOrderIds()).toEqual([blue]);
    const rows = await queue();
    expect(rows.find(row => row.orderId === red)).toMatchObject({
      enabled: false, updatedByName: "system:auto-completed",
    });
    expect(rows.find(row => row.orderId === blue)).toMatchObject({ enabled: true, priority: 1 });
  });

  it("reopens Red at #1 after an allocated bale is detached; Blue's bale never moves", async () => {
    const affected = await reverse(redBales[0]);
    expect(affected).toContain(red);
    expect(await activeOrderIds()).toEqual([red, blue]);
    const configs = await queue();
    expect(configs.find(row => row.orderId === red)).toMatchObject({ enabled: true, priority: 1 });
    expect(configs.find(row => row.orderId === blue)).toMatchObject({ enabled: true, priority: 2 });

    const { rows: blueLinks } = await pool.query<{ order_id: number }>(
      "SELECT order_id FROM customer_order_bales WHERE bale_id = $1", [blueBale]
    );
    expect(blueLinks[0]?.order_id).toBe(blue);

    const { rows: historic } = await pool.query<{
      color: string; priority: number; reversed_at: string | null
    }>(
      "SELECT color, priority, reversed_at FROM factory_priority_scan_history WHERE company_id = $1 AND bale_id = $2",
      [ctx.companyId, redBales[0]]
    );
    expect(historic[0]).toMatchObject({ color: "#dc2626", priority: 1 });
    expect(historic[0].reversed_at).toBeTruthy();

    const nextTarget = await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, ${ctx.companyId})`);
      return resolvePriorityScanArticleTarget(tx, ctx.companyId, ARTICLE);
    });
    expect(nextTarget).toMatchObject({ orderId: red, priority: 1 });
  }, 60000);

  it("keeps old RED labels unchanged if another loading reused Red's color before recovery", async () => {
    const replacement = await attachBale(red, `${PREFIX}-RED-REPLACEMENT`);
    expect(replacement).toBeGreaterThan(0);
    const completed = await advanceSatisfiedPriorityScanConfigs(ctx.companyId);
    expect(completed.completedOrderIds).toContain(red);
    const green = await loading();
    await configure(green, 2, "#dc2626"); // previously completed Red released the color

    await reverse(replacement);
    const configs = await queue();
    const redConfig = configs.find(row => row.orderId === red)!;
    const greenConfig = configs.find(row => row.orderId === green)!;
    expect(await activeOrderIds()).toEqual([red, blue, green]);
    expect(redConfig).toMatchObject({ enabled: true, priority: 1 });
    expect(redConfig.color).not.toBe("#dc2626");
    expect(greenConfig).toMatchObject({ color: "#dc2626", enabled: true, priority: 3 });

    const { rows: historic } = await pool.query<{ color: string }>(
      "SELECT color FROM factory_priority_scan_history WHERE company_id = $1 AND bale_id = $2",
      [ctx.companyId, redBales[0]]
    );
    expect(historic[0].color).toBe("#dc2626");
  }, 60000);

  it("never reactivates manually disabled or verified loadings", async () => {
    const manuallyDisabled = await loading();
    await configure(manuallyDisabled, 4, "#7c3aed");
    // The loading was completed automatically, then an operator explicitly
    // switched it OFF. The later human action must win over auto recovery.
    await pool.query(
      `UPDATE customer_order_priority_scan_configs SET enabled = FALSE,
         updated_by_name = 'system:auto-completed', updated_by = NULL
       WHERE company_id = $1 AND order_id = $2`,
      [ctx.companyId, manuallyDisabled]
    );
    await configure(manuallyDisabled, 4, "#7c3aed", false);

    const verified = await loading("VERIFIED");
    await pool.query(
      `INSERT INTO customer_order_priority_scan_configs
       (company_id, order_id, color, color_key, priority, enabled, updated_by_name)
       VALUES ($1, $2, '#eab308', '#eab308', 20, FALSE, 'system:auto-completed')`,
      [ctx.companyId, verified]
    );
    const result = await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, ${ctx.companyId})`);
      return reactivateAutoCompletedPriorityLoadingsLockedTx(
        tx, ctx.companyId, [manuallyDisabled, verified]
      );
    });
    expect(result).toHaveLength(0);
    expect((await queue()).find(row => row.orderId === manuallyDisabled))
      .toMatchObject({ enabled: false });
    expect((await queue()).find(row => row.orderId === verified))
      .toMatchObject({ enabled: false });
  });

  it("restores multiple auto-completed loadings by original queue age, not caller deletion order", async () => {
    const older = await loading();
    const newer = await loading();
    for (const [orderId, createdAt, color] of [
      [older, "2026-01-01T09:00:00Z", "#0891b2"],
      [newer, "2026-01-02T09:00:00Z", "#db2777"],
    ] as const) {
      await pool.query(
        `INSERT INTO customer_order_priority_scan_configs
          (company_id, order_id, color, color_key, priority, enabled, updated_by_name, created_at)
         VALUES ($1, $2, $3, $3, 99, FALSE, 'system:auto-completed', $4)`,
        [ctx.companyId, orderId, color, createdAt]
      );
    }

    const before = await activeOrderIds();
    const recovered = await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, ${ctx.companyId})`);
      return reactivateAutoCompletedPriorityLoadingsLockedTx(tx, ctx.companyId, [newer, older]);
    });
    expect(recovered.map(row => row.orderId)).toEqual([older, newer]);
    expect(recovered.map(row => row.priority)).toEqual([1, 2]);
    expect(await activeOrderIds()).toEqual([older, newer, ...before]);
    const after = (await queue()).filter(row => row.enabled).sort((a,b) => a.priority - b.priority);
    expect(after.map(row => row.priority)).toEqual(after.map((_, index) => index + 1));
  }, 60000);

  it("does not resurrect a loading whose own proforma requirement remains fully satisfied", async () => {
    const satisfied = await loading();
    await attachBale(satisfied, `${PREFIX}-SAT-1`);
    await attachBale(satisfied, `${PREFIX}-SAT-2`);
    await pool.query(
      `INSERT INTO customer_order_priority_scan_configs
         (company_id, order_id, color, color_key, priority, enabled, updated_by_name)
       VALUES ($1, $2, '#f59e0b', '#f59e0b', 99, FALSE, 'system:auto-completed')`,
      [ctx.companyId, satisfied]
    );
    const recovered = await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, ${ctx.companyId})`);
      return reactivateAutoCompletedPriorityLoadingsLockedTx(tx, ctx.companyId, [satisfied]);
    });
    expect(recovered).toHaveLength(0);
    expect((await queue()).find(row => row.orderId === satisfied)?.enabled).toBe(false);
  });

  it("serializes two simultaneous recovery attempts into exactly one queue reactivation", async () => {
    const pending = await loading();
    await pool.query(
      `INSERT INTO customer_order_priority_scan_configs
         (company_id, order_id, color, color_key, priority, enabled, updated_by_name)
       VALUES ($1, $2, '#f59e0b', '#f59e0b', 99, FALSE, 'system:auto-completed')`,
      [ctx.companyId, pending]
    );
    const attempt = () => db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, ${ctx.companyId})`);
      return reactivateAutoCompletedPriorityLoadingsLockedTx(tx, ctx.companyId, [pending]);
    });
    const [first, second] = await Promise.all([attempt(), attempt()]);
    expect(first.length + second.length).toBe(1);
    expect((await queue()).filter(row => row.enabled && row.orderId === pending)).toHaveLength(1);
  }, 60000);

  it("is idempotent and does not reopen a previously reopened or manually disabled loading twice", async () => {
    const before = await activeOrderIds();
    const once = await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, ${ctx.companyId})`);
      return reactivateAutoCompletedPriorityLoadingsLockedTx(tx, ctx.companyId, [red, blue]);
    });
    expect(once).toHaveLength(0);
    expect(await activeOrderIds()).toEqual(before);
  });
});
