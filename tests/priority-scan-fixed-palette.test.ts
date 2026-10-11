/**
 * Server enforcement of the fixed eleven-color Priority Scan palette.
 *
 * The UI only offers the approved swatches, but the write API is the real
 * boundary: it must refuse custom colors, persist the canonical HEX value,
 * let an existing legacy-colored priority move without being recolored and
 * never touch the colors already recorded in allocation history.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PRIORITY_SCAN_COLORS } from "@shared/priorityScanColors";
import { pool } from "../server/db";
import { ensurePriorityScanSchema } from "../server/startup/priorityScanSchema";
import { closeTestServer, cleanupTestData, seedTestData, type TestContext } from "./setup";

const PREFIX = "priorityscanpal";
let ctx: TestContext;
let agent: request.SuperAgentTest;
let customerId: number;
let proformaId: number;
let otherCompanyId: number | null = null;

const configPath = (orderId: number) => `/api/factory/customer-orders/${orderId}/loading-list/priority-scan-config`;

async function createLoading(companyId = ctx.companyId): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status, proforma_id_used)
     VALUES ($1, $2, '2026-10-10', 'LOADING', $3) RETURNING id`,
    [companyId, customerId, proformaId]
  );
  return result.rows[0].id;
}

async function storedConfig(orderId: number) {
  const { rows } = await pool.query<{ color: string; color_key: string; priority: number; enabled: boolean }>(
    `SELECT color, color_key, priority, enabled FROM customer_order_priority_scan_configs
     WHERE company_id = $1 AND order_id = $2`,
    [ctx.companyId, orderId]
  );
  return rows[0];
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

async function disableAll(): Promise<void> {
  await pool.query(`DELETE FROM customer_order_priority_scan_configs WHERE company_id = $1`, [ctx.companyId]);
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
  if (otherCompanyId) {
    await pool.query(`DELETE FROM customer_order_priority_scan_configs WHERE company_id = $1`, [otherCompanyId]);
    await pool.query(`DELETE FROM customer_orders WHERE company_id = $1`, [otherCompanyId]);
    await pool.query(`DELETE FROM companies WHERE id = $1`, [otherCompanyId]);
  }
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60000);

describe("Priority Scan fixed palette write API", () => {
  it("accepts all eleven approved colors at once and stores their canonical HEX value", async () => {
    await disableAll();
    for (const [index, color] of PRIORITY_SCAN_COLORS.entries()) {
      const orderId = await createLoading();
      // Lower-case input proves the comparison is case-insensitive.
      const saved = await agent
        .put(configPath(orderId))
        .send({ color: color.toLowerCase(), priority: index + 1, enabled: true });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({ color, colorKey: color.toLowerCase(), priority: index + 1, enabled: true });
      expect(await storedConfig(orderId)).toMatchObject({ color, color_key: color.toLowerCase(), enabled: true });
    }

    // Every approved color is now active, so a twelfth loading has nothing left.
    const twelfth = await createLoading();
    for (const color of PRIORITY_SCAN_COLORS) {
      const duplicate = await agent.put(configPath(twelfth)).send({ color, priority: 12, enabled: true });
      expect(duplicate.status).toBe(409);
    }
    expect(await storedConfig(twelfth)).toBeUndefined();
  }, 60000);

  it.each([
    ["an unapproved HEX", "#123456"],
    ["a former default preset", "#2563eb"],
    ["a named color", "red"],
    ["an RGB expression", "rgb(127, 255, 0)"],
    ["a short HEX", "#fd0"],
    ["padding around an approved color", " #7FFF00 "],
    ["a CSS injection attempt", "#7FFF00; background:url(x)"],
    ["a non-string", 0x7fff00],
    ["an empty string", ""],
  ])("rejects %s without writing a configuration", async (_case, color) => {
    await disableAll();
    const orderId = await createLoading();
    const response = await agent.put(configPath(orderId)).send({ color, priority: 1, enabled: true });
    expect(response.status).toBe(400);
    expect(String(response.body.message)).toMatch(/11 approved/);
    expect(await storedConfig(orderId)).toBeUndefined();
  });

  it("requires an approved color to create, disable or re-enable a priority", async () => {
    await disableAll();
    const orderId = await createLoading();
    expect((await agent.put(configPath(orderId)).send({ priority: 1 })).status).toBe(400);
    expect((await agent.put(configPath(orderId)).send({ priority: 1, enabled: false })).status).toBe(400);
    // A move-only request is not a way to create a priority without a color.
    const moveMissing = await agent.put(configPath(orderId)).send({ priority: 1, enabled: true });
    expect(moveMissing.status).toBe(409);
    expect(await storedConfig(orderId)).toBeUndefined();
  });

  it("moves an active legacy-colored priority without recoloring it or its history", async () => {
    await disableAll();
    const first = await createLoading();
    const legacy = await createLoading();
    expect((await agent.put(configPath(first)).send({ color: "#FFD700", priority: 1, enabled: true })).status).toBe(
      200
    );
    // A priority saved before the fixed palette existed.
    await pool.query(
      `INSERT INTO customer_order_priority_scan_configs (company_id, order_id, color, color_key, priority, enabled)
       VALUES ($1, $2, '#dc2626', '#dc2626', 2, TRUE)`,
      [ctx.companyId, legacy]
    );
    await pool.query(
      `INSERT INTO factory_priority_scan_history
        (company_id, order_id, bale_id, reference_number, article_code, priority, color, business_date, scanned_by)
       VALUES ($1, $2, 990001, $3, 'CCR', 2, '#dc2626', CURRENT_DATE, 'legacy-user')`,
      [ctx.companyId, legacy, `${PREFIX}-LEGACY-1`]
    );

    const moved = await agent.put(configPath(legacy)).send({ priority: 1, enabled: true });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ color: "#dc2626", colorKey: "#dc2626", priority: 1, enabled: true });
    expect(await storedConfig(first)).toMatchObject({ color: "#FFD700", priority: 2, enabled: true });

    // The legacy color stays reserved: no other loading can take it either way.
    const { rows: history } = await pool.query<{ color: string; priority: number }>(
      `SELECT color, priority FROM factory_priority_scan_history WHERE company_id = $1 AND order_id = $2`,
      [ctx.companyId, legacy]
    );
    expect(history).toEqual([{ color: "#dc2626", priority: 2 }]);

    // Re-saving the legacy color itself is refused; an approved swatch must be chosen.
    const resave = await agent.put(configPath(legacy)).send({ color: "#dc2626", priority: 1, enabled: true });
    expect(resave.status).toBe(400);
    expect(await storedConfig(legacy)).toMatchObject({ color: "#dc2626", priority: 1 });

    const recolor = await agent.put(configPath(legacy)).send({ color: "#B0E0E6", priority: 1, enabled: true });
    expect(recolor.status).toBe(200);
    expect(await storedConfig(legacy)).toMatchObject({ color: "#B0E0E6", priority: 1 });
    // History keeps the color the bale was originally allocated with.
    const { rows: after } = await pool.query<{ color: string }>(
      `SELECT color FROM factory_priority_scan_history WHERE company_id = $1 AND order_id = $2`,
      [ctx.companyId, legacy]
    );
    expect(after).toEqual([{ color: "#dc2626" }]);
  });

  it("reserves position-only moves for priority managers", async () => {
    await disableAll();
    const orderId = await createLoading();
    expect((await agent.put(configPath(orderId)).send({ color: "#808000", priority: 1, enabled: true })).status).toBe(
      200
    );
    const override = await agent
      .post("/api/factory/admin-verify")
      .send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
    expect(override.status).toBe(200);
    await setRole("Manager");
    try {
      const move = await agent.put(configPath(orderId)).send({ priority: 1, enabled: true });
      expect(move.status).toBe(403);
      // Non-managers may still pick an approved color, but not a custom one.
      expect((await agent.put(configPath(orderId)).send({ color: "#614051", enabled: true })).status).toBe(200);
      expect((await agent.put(configPath(orderId)).send({ color: "#000000", enabled: true })).status).toBe(400);
    } finally {
      await setRole("Admin");
    }
    expect(await storedConfig(orderId)).toMatchObject({ color: "#614051", enabled: true });
  });

  it("cannot configure or move another company's loading", async () => {
    await disableAll();
    const company = await pool.query<{ id: number }>(
      `INSERT INTO companies (name, code, company_type, base_currency) VALUES ($1, $2, 'factory', 'USD') RETURNING id`,
      [`${PREFIX} Other`, `${PREFIX.toUpperCase()}-OTHER`]
    );
    otherCompanyId = company.rows[0].id;
    const foreign = await pool.query<{ id: number }>(
      `INSERT INTO customer_orders (company_id, customer_id, order_date, status)
       VALUES ($1, $2, '2026-10-10', 'LOADING') RETURNING id`,
      [otherCompanyId, customerId]
    );
    const foreignId = foreign.rows[0].id;
    await pool.query(
      `INSERT INTO customer_order_priority_scan_configs (company_id, order_id, color, color_key, priority, enabled)
       VALUES ($1, $2, '#7FFF00', '#7fff00', 1, TRUE)`,
      [otherCompanyId, foreignId]
    );

    expect((await agent.put(configPath(foreignId)).send({ color: "#FFD700", priority: 1, enabled: true })).status).toBe(
      404
    );
    expect((await agent.put(configPath(foreignId)).send({ priority: 2, enabled: true })).status).toBe(404);

    // The other company's active color does not block this company.
    const own = await createLoading();
    expect((await agent.put(configPath(own)).send({ color: "#7FFF00", priority: 1, enabled: true })).status).toBe(200);

    const list = await agent.get("/api/factory/customer-orders/loading-list/priority-scan-configs");
    expect(list.status).toBe(200);
    expect(list.body.some((row: { orderId: number }) => row.orderId === foreignId)).toBe(false);
    const { rows } = await pool.query<{ color: string; priority: number }>(
      `SELECT color, priority FROM customer_order_priority_scan_configs WHERE company_id = $1`,
      [otherCompanyId]
    );
    expect(rows).toEqual([{ color: "#7FFF00", priority: 1 }]);
  });
});
