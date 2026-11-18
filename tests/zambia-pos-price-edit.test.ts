/**
 * Phase 4 integration: POS cashiers may edit assigned-location selling prices,
 * not unassigned locations, global catalogue prices or protected accounts.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "zposprice4";
let ctx: TestContext;
let agent: request.SuperAgentTest;

async function setRole(role: string): Promise<void> {
  await pool.query(
    "UPDATE user_company_roles SET role = $1, pos_view_only = false WHERE user_id = $2 AND company_id = $3",
    [role, ctx.userId, ctx.companyId]
  );
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
}

async function assign(locationId: number): Promise<void> {
  await pool.query(
    "INSERT INTO user_locations (user_id, company_id, location_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    [ctx.userId, ctx.companyId, locationId]
  );
}

async function currentPrice(locationId: number): Promise<string | null> {
  const { rows } = await pool.query<{ selling_price: string }>(
    "SELECT selling_price FROM stock_item_location_prices WHERE stock_item_id = $1 AND location_id = $2",
    [ctx.stockItemIds[0], locationId]
  );
  return rows[0]?.selling_price ?? null;
}

async function writePrice(locationId: unknown, sellingPrice: unknown) {
  return agent.post(`/api/stock-items/${ctx.stockItemIds[0]}/location-prices`).send({ locationId, sellingPrice });
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  agent = request.agent(ctx.app);
  expect(
    (await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" }))
      .status
  ).toBe(200);
  await setRole("Admin");
  await assign(ctx.locationId);
}, 120_000);

afterAll(async () => {
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60_000);

describe("Zambia POS price editing", () => {
  it("allows assigned POS users to enter exact prices without changing base stock-item rates", async () => {
    await setRole("POS");
    const saved = await writePrice(ctx.locationId, "49.95");
    expect(saved.status).toBe(200);
    expect(saved.body.cascaded).toBe(false);
    expect(await currentPrice(ctx.locationId)).toBe("49.95");
    const list = await agent.get("/api/pos/price-list").query({ locationId: ctx.locationId });
    expect(list.status).toBe(200);
    const row = list.body.find((r: { stockItemId: number }) => r.stockItemId === ctx.stockItemIds[0]);
    expect(row.sellingPrice).toBe("49.95");
    expect(row.hasCustomPrice).toBe(true);
    const base = await pool.query<{ selling_price: string | null }>(
      "SELECT selling_price FROM stock_items WHERE id = $1",
      [ctx.stockItemIds[0]]
    );
    expect(base.rows[0].selling_price).not.toBe("49.95");
  }, 60_000);

  it("refuses unassigned locations, invalid IDs, invalid money and bulk price edits", async () => {
    await setRole("POS");
    const before = await currentPrice(ctx.location2Id);
    const unassigned = await writePrice(ctx.location2Id, "123.00");
    expect(unassigned.status).toBe(403);
    expect(unassigned.body.code).toBe("POS_PRICE_LOCATION_DENIED");
    expect(await currentPrice(ctx.location2Id)).toBe(before);
    for (const price of ["-1", "1.234", "1e4", "Infinity", "NaN", "100000000000000"]) {
      const response = await writePrice(ctx.locationId, price);
      expect(response.status, price).toBe(400);
      expect(response.body.code).toBe("POS_PRICE_INPUT_INVALID");
    }
    expect((await writePrice("1e2", "15.00")).status).toBe(400);
    const bulk = await agent.post("/api/stock-items/bulk-update-prices").send({
      prices: [{ barcode: `${PREFIX}-ITEM1`, sellingPrice: "19" }],
    });
    expect(bulk.status).toBe(403);
  }, 60_000);

  it("immediately refuses view-only POS or revoked location assignment without relogin", async () => {
    await setRole("POS");
    await pool.query("UPDATE user_company_roles SET pos_view_only = true WHERE user_id = $1 AND company_id = $2", [
      ctx.userId,
      ctx.companyId,
    ]);
    const viewOnly = await writePrice(ctx.locationId, "22.00");
    expect(viewOnly.status).toBe(403);
    expect(viewOnly.body.code).toBe("POS_PRICE_WRITE_DENIED");
    await pool.query("UPDATE user_company_roles SET pos_view_only = false WHERE user_id = $1 AND company_id = $2", [
      ctx.userId,
      ctx.companyId,
    ]);
    await pool.query("DELETE FROM user_locations WHERE user_id = $1 AND company_id = $2", [
      ctx.userId,
      ctx.companyId,
    ]);
    try {
      const removed = await writePrice(ctx.locationId, "22.00");
      expect(removed.status).toBe(403);
      expect(removed.body.code).toBe("POS_PRICE_LOCATION_DENIED");
    } finally {
      await assign(ctx.locationId);
    }
  }, 60_000);

  it("updates inherited master and followers together when editing an assigned follower", async () => {
    await setRole("Admin");
    await agent.put("/api/location-price-groups").send({
      groups: [{ masterLocationId: ctx.locationId, followerLocationIds: [ctx.location2Id] }],
    }).expect(200);
    await assign(ctx.location2Id);
    await setRole("POS");
    try {
      const result = await writePrice(ctx.location2Id, "79.20");
      expect(result.status).toBe(200);
      expect(result.body.cascaded).toBe(true);
      expect(await currentPrice(ctx.locationId)).toBe("79.20");
      expect(await currentPrice(ctx.location2Id)).toBe("79.20");
      const list = await agent.get("/api/pos/price-list").query({ locationId: ctx.location2Id });
      expect(list.status).toBe(200);
      const row = list.body.find((r: { stockItemId: number }) => r.stockItemId === ctx.stockItemIds[0]);
      expect(row.sellingPrice).toBe("79.20");
    } finally {
      await setRole("Admin");
      await agent.put("/api/location-price-groups").send({ groups: [] }).expect(200);
    }
  }, 60_000);

  it("keeps admin edits working and blocks a live role revocation", async () => {
    await setRole("Admin");
    expect((await writePrice(ctx.locationId, "123.45")).status).toBe(200);
    await setRole("POS");
    await pool.query("UPDATE user_company_roles SET role = 'View Only' WHERE user_id = $1 AND company_id = $2", [
      ctx.userId,
      ctx.companyId,
    ]);
    expect((await writePrice(ctx.locationId, "199.00")).status).toBe(403);
    expect(await currentPrice(ctx.locationId)).toBe("123.45");
    await setRole("Admin");
  }, 60_000);
});
