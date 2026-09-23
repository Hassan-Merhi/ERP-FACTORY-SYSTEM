/**
 * Wave 4 — Deleted Items restore and permanent delete against PostgreSQL.
 *
 * Permanent delete removes a row and the rows that reference it, so the two
 * things that matter are (1) it removes everything that would otherwise block
 * or orphan the delete, and (2) it can never touch another company's data:
 * several branches delete dependents by id before the company-scoped delete of
 * the item itself, so the company-scope middleware in front of the route is
 * what keeps a crafted id from wiping another tenant's inventory.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX_A = "w4delA";
const PREFIX_B = "w4delB";

let a: TestContext;
let b: TestContext;
let agent: request.SuperAgentTest;

async function count(sql: string, params: unknown[]) {
  const result = await pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${sql}`, params);
  return result.rows[0].n;
}

async function softDeletedStockItem(ctx: TestContext, code: string) {
  const item = await pool.query<{ id: number }>(
    `INSERT INTO stock_items (company_id, code, name, uom, stock_group_id, active, deleted_at)
     VALUES ($1, $2, $3, 'PCS', $4, false, NOW()) RETURNING id`,
    [ctx.companyId, code, `${code} name`, ctx.stockGroupId]
  );
  const id = item.rows[0].id;
  await pool.query(
    `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value)
     VALUES ($1, $2, $3, '5', '2', '10')`,
    [ctx.companyId, ctx.locationId, id]
  );
  return id;
}

beforeAll(async () => {
  a = await seedTestData(PREFIX_A);
  b = await seedTestData(PREFIX_B);
  agent = request.agent(a.app) as request.SuperAgentTest;
  const login = await agent
    .post("/api/auth/login")
    .send({ username: `${PREFIX_A}_testuser`, password: "testpassword123" });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status} ${login.text}`);
  const selected = await agent.post("/api/auth/set-company").send({ companyId: a.companyId });
  if (selected.status !== 200) throw new Error(`set-company failed: ${selected.status} ${selected.text}`);
}, 120_000);

afterAll(async () => {
  for (const ctx of [a, b]) {
    if (!ctx) continue;
    await pool.query(`DELETE FROM inventory WHERE company_id = $1`, [ctx.companyId]).catch(() => undefined);
    await pool
      .query(`DELETE FROM stock_items WHERE company_id = $1 AND code LIKE 'W4DEL%'`, [ctx.companyId])
      .catch(() => undefined);
  }
  if (a) await cleanupTestData(PREFIX_A);
  if (b) await cleanupTestData(PREFIX_B);
  closeTestServer();
}, 120_000);

describe("deleted items", () => {
  it("lists a soft-deleted stock item and restores it", async () => {
    const id = await softDeletedStockItem(a, "W4DEL-RESTORE");

    const list = await agent.get("/api/deleted-items");
    expect(list.status, list.text).toBe(200);
    expect(JSON.stringify(list.body)).toContain("W4DEL-RESTORE");

    const restored = await agent.post(`/api/deleted-items/stockItem/${id}/restore`);
    expect(restored.status, restored.text).toBe(200);
    const row = await pool.query(`SELECT deleted_at FROM stock_items WHERE id = $1`, [id]);
    expect(row.rows[0].deleted_at).toBeNull();
  });

  it("permanently deletes a stock item together with its inventory rows", async () => {
    const id = await softDeletedStockItem(a, "W4DEL-PERM");
    expect(await count(`inventory WHERE stock_item_id = $1`, [id])).toBe(1);

    const response = await agent.delete(`/api/deleted-items/stockItem/${id}/permanent`);
    expect(response.status, response.text).toBe(200);
    expect(await count(`stock_items WHERE id = $1`, [id])).toBe(0);
    expect(await count(`inventory WHERE stock_item_id = $1`, [id])).toBe(0);
  });

  it("refuses another company's item and leaves its dependent rows untouched", async () => {
    const foreignId = await softDeletedStockItem(b, "W4DEL-FOREIGN");

    const response = await agent.delete(`/api/deleted-items/stockItem/${foreignId}/permanent`);
    expect(response.status).toBe(404);
    expect(await count(`stock_items WHERE id = $1`, [foreignId])).toBe(1);
    expect(await count(`inventory WHERE stock_item_id = $1`, [foreignId])).toBe(1);

    const restore = await agent.post(`/api/deleted-items/stockItem/${foreignId}/restore`);
    expect(restore.status).toBe(404);
    const row = await pool.query(`SELECT deleted_at FROM stock_items WHERE id = $1`, [foreignId]);
    expect(row.rows[0].deleted_at).not.toBeNull();
  });

  it("refuses to permanently delete a live item that was never moved to Deleted Items", async () => {
    const live = await pool.query<{ id: number }>(
      `INSERT INTO stock_items (company_id, code, name, uom, stock_group_id, active)
       VALUES ($1, 'W4DEL-LIVE', 'W4DEL-LIVE name', 'PCS', $2, true) RETURNING id`,
      [a.companyId, a.stockGroupId]
    );
    const id = live.rows[0].id;
    await pool.query(
      `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value)
       VALUES ($1, $2, $3, '5', '2', '10')`,
      [a.companyId, a.locationId, id]
    );

    const response = await agent.delete(`/api/deleted-items/stockItem/${id}/permanent`);
    expect(response.status, response.text).toBe(404);
    expect(response.body.message).toContain("not found in Deleted Items");
    expect(await count(`stock_items WHERE id = $1`, [id])).toBe(1);
    expect(await count(`inventory WHERE stock_item_id = $1`, [id])).toBe(1);
  });

  it("refuses to permanently delete a live voucher", async () => {
    const voucher = await pool.query<{ id: number }>(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
       VALUES ($1, 'W4DEL-V1', 'Journal', CURRENT_DATE, '0') RETURNING id`,
      [a.companyId]
    );
    const id = voucher.rows[0].id;
    try {
      const response = await agent.delete(`/api/deleted-items/voucher/${id}/permanent`);
      expect(response.status, response.text).toBe(404);
      expect(await count(`vouchers WHERE id = $1`, [id])).toBe(1);
    } finally {
      await pool.query(`DELETE FROM vouchers WHERE id = $1`, [id]);
    }
  });

  it("rejects malformed ids and unknown types", async () => {
    expect((await agent.delete(`/api/deleted-items/stockItem/abc/permanent`)).status).toBeGreaterThanOrEqual(400);
    const unknown = await agent.delete(`/api/deleted-items/notAType/1/permanent`);
    expect(unknown.status).toBeGreaterThanOrEqual(400);
  });

  it("reserves global supplier maintenance for developers", async () => {
    const response = await agent.delete(`/api/deleted-items/supplier/1/permanent`);
    // The seeded user is not a Developer in this company.
    expect([403, 404]).toContain(response.status);
  });
});
