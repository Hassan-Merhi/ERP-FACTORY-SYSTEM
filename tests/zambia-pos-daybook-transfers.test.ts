/**
 * Phase 5: stock transfers must appear in the POS Daybook when the cashier
 * receives or sends stock from any currently assigned company location.
 * Source cashiers see their own item legs; destination cashiers receive all
 * legs. POS responses never expose costing or unrelated transfer details.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = `zposxfer${Date.now().toString(36)}`;
const today = new Date().toISOString().slice(0, 10);
let ctx: TestContext;
let cashier: request.SuperAgentTest;
let cashierId: string;
let location3 = 0;
let incoming = 0;
let outgoing = 0;
let multiSource = 0;
let unrelated = 0;
let unrelatedPurchase = 0;

async function transfer(
  number: string,
  headerLocationId: number | null,
  sourceLocationId: number | null,
  destinationLocationId: number,
  lines: Array<{ stockItemId: number; sourceLocationId: number; quantity: string }>
): Promise<number> {
  const voucher = await pool.query<{ id: number }>(
    `INSERT INTO vouchers
       (company_id, location_id, voucher_number, voucher_type, voucher_date, total_amount)
       VALUES ($1, $2, $3, 'Stock Transfer', $4, '999.00') RETURNING id`,
    [ctx.companyId, headerLocationId, `${PREFIX}-${number}`, today]
  );
  const voucherId = voucher.rows[0].id;
  const header = await pool.query<{ id: number }>(
    `INSERT INTO stock_transfer_vouchers
       (voucher_id, source_location_id, destination_location_id, notes, inventory_applied)
       VALUES ($1, $2, $3, 'Test transfer notes', true) RETURNING id`,
    [voucherId, sourceLocationId, destinationLocationId]
  );
  for (const item of lines) {
    await pool.query(
      `INSERT INTO stock_transfer_items
         (transfer_id, stock_item_id, source_location_id, quantity, rate, total_amount)
         VALUES ($1, $2, $3, $4, '44.00', '444.00')`,
      [header.rows[0].id, item.stockItemId, item.sourceLocationId, item.quantity]
    );
  }
  return voucherId;
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  const third = await pool.query<{ id: number }>(
    `INSERT INTO locations (company_id, code, name)
     VALUES ($1, $2, $3) RETURNING id`,
    [ctx.companyId, `${PREFIX}-WH3`, `${PREFIX}-Third Warehouse`]
  );
  location3 = third.rows[0].id;

  const bcrypt = await import("bcryptjs");
  const user = await pool.query<{ id: string }>(
    "INSERT INTO users (username, password, active) VALUES ($1, $2, true) RETURNING id",
    [`${PREFIX}_cashier`, await bcrypt.hash("testpassword123", 10)]
  );
  cashierId = user.rows[0].id;
  await pool.query(
    `INSERT INTO user_company_roles
       (user_id, company_id, role, assigned_location_id, cash_account_id)
       VALUES ($1, $2, 'POS', $3, $4)`,
    [cashierId, ctx.companyId, ctx.locationId, ctx.cashAccountId]
  );
  await pool.query(
    "INSERT INTO user_locations (user_id, company_id, location_id) VALUES ($1, $2, $3)",
    [cashierId, ctx.companyId, ctx.locationId]
  );
  cashier = request.agent(ctx.app) as request.SuperAgentTest;
  expect(
    (await cashier.post("/api/auth/login").send({
      username: `${PREFIX}_cashier`,
      password: "testpassword123",
    })).status
  ).toBe(200);
  expect((await cashier.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);

  incoming = await transfer("IN", ctx.location2Id, ctx.location2Id, ctx.locationId, [
    { stockItemId: ctx.stockItemIds[0], sourceLocationId: ctx.location2Id, quantity: "2.000" },
    { stockItemId: ctx.stockItemIds[1], sourceLocationId: location3, quantity: "3.000" },
  ]);
  outgoing = await transfer("OUT", ctx.location2Id, null, ctx.location2Id, [
    { stockItemId: ctx.stockItemIds[0], sourceLocationId: ctx.locationId, quantity: "4.000" },
  ]);
  multiSource = await transfer("MULTI", ctx.location2Id, null, ctx.location2Id, [
    { stockItemId: ctx.stockItemIds[0], sourceLocationId: ctx.locationId, quantity: "5.000" },
    { stockItemId: ctx.stockItemIds[1], sourceLocationId: location3, quantity: "6.000" },
  ]);
  unrelated = await transfer("OTHER", ctx.location2Id, ctx.location2Id, location3, [
    { stockItemId: ctx.stockItemIds[2], sourceLocationId: ctx.location2Id, quantity: "7.000" },
  ]);
  const purchase = await pool.query<{ id: number }>(
    `INSERT INTO vouchers
       (company_id, location_id, voucher_number, voucher_type, voucher_date, total_amount)
       VALUES ($1, $2, $3, 'Purchase', $4, '1200.00') RETURNING id`,
    [ctx.companyId, ctx.locationId, `${PREFIX}-PURCHASE`, today]
  );
  unrelatedPurchase = purchase.rows[0].id;
}, 120_000);

afterAll(async () => {
  if (ctx) await cleanupTestData(PREFIX);
  closeTestServer();
}, 120_000);

function ids(rows: Array<{ id?: number; voucherId?: number }>): number[] {
  return rows.map((row) => row.id ?? row.voucherId ?? -1);
}

describe("Zambia POS Daybook stock transfers", () => {
  it("shows receiving, sending and mixed-source transfers but never unrelated transfers", async () => {
    const response = await cashier.get("/api/vouchers").query({ startDate: today, endDate: today });
    expect(response.status, response.text).toBe(200);
    const seen = ids(response.body);
    expect(seen).toEqual(expect.arrayContaining([incoming, outgoing, multiSource]));
    expect(seen).not.toContain(unrelated);
    expect(seen).not.toContain(unrelatedPurchase);
    for (const voucher of response.body.filter((row: { id: number }) => seen.includes(row.id))) {
      expect(voucher.totalAmount).toBe("0");
      expect(voucher.locationId).toBe(ctx.locationId);
    }
  }, 60_000);

  it("supports the paginated voucher reader without losing destination transfers or leaking others", async () => {
    const response = await cashier.get("/api/vouchers").query({
      pagination: "1",
      page: "1",
      pageSize: "100",
      startDate: today,
      endDate: today,
    });
    expect(response.status, response.text).toBe(200);
    expect(ids(response.body.items)).toEqual(expect.arrayContaining([incoming, outgoing, multiSource]));
    expect(ids(response.body.items)).not.toContain(unrelated);
    expect(ids(response.body.items)).not.toContain(unrelatedPurchase);
    expect(response.body.total).toBe(3);
    expect(response.body.items.every((row: { totalAmount: string }) => row.totalAmount === "0")).toBe(true);
  }, 60_000);

  it("allows destination to view every received item but never its valuation", async () => {
    const result = await cashier.get(`/api/vouchers/${incoming}`);
    expect(result.status, result.text).toBe(200);
    expect(result.body.transferData.items).toHaveLength(2);
    expect(result.body.transferData.destinationLocationId).toBe(ctx.locationId);
    expect(result.body.transferData.inventoryApplied).toBe(true);
    expect(result.body.totalAmount).toBe("0");
    expect(result.body.entries).toEqual([]);
    expect(JSON.stringify(result.body)).not.toMatch(/costPrice|totalCost|totalAmount.*999|rate.*44|valueMoved/);
    for (const item of result.body.transferData.items) {
      expect(item.rate).toBeUndefined();
      expect(item.totalAmount).toBeUndefined();
      expect(item.valueMoved).toBeUndefined();
    }
  }, 60_000);

  it("shows only assigned source legs of a mixed-source transfer", async () => {
    const result = await cashier.get(`/api/vouchers/${multiSource}`);
    expect(result.status, result.text).toBe(200);
    expect(result.body.transferData.items).toHaveLength(1);
    expect(result.body.transferData.items[0].stockItemId).toBe(ctx.stockItemIds[0]);
    expect(result.body.transferData.items[0].quantity).toBe("5.000");
    expect(result.body.transferData.items[0].rate).toBeUndefined();
    expect(result.body.transferData.sourceLocationId).toBe(ctx.locationId);
    expect(result.body.transferData.destinationLocationId).toBe(ctx.location2Id);
  }, 60_000);

  it("rejects direct access to unrelated transfers across all existing POS read APIs", async () => {
    expect((await cashier.get(`/api/vouchers/${unrelated}`)).status).toBe(404);
    expect((await cashier.get(`/api/vouchers/${unrelatedPurchase}`)).status).toBe(404);
    expect((await cashier.get("/api/pos-transfer-detail").query({ voucherId: unrelated })).status).toBe(404);
    expect((await cashier.get("/api/stock-transfers").query({ voucherId: unrelated })).status).toBe(404);
    const listed = await cashier.get("/api/stock-transfers/list").query({ startDate: today, endDate: today });
    expect(listed.status, listed.text).toBe(200);
    expect(ids(listed.body)).not.toContain(unrelated);
    const sourceTransfer = listed.body.find((row: { voucherId: number }) => row.voucherId === multiSource);
    expect(sourceTransfer).toMatchObject({ itemCount: 1, totalAmount: 0 });
  }, 60_000);

  it("redacts financial fields in the older POS transfer-detail API too", async () => {
    const result = await cashier.get("/api/pos-transfer-detail").query({ voucherId: incoming });
    expect(result.status, result.text).toBe(200);
    expect(result.body.items).toHaveLength(2);
    expect(result.body.items[0].rate).toBeUndefined();
    expect(result.body.items[0].totalAmount).toBeUndefined();
    expect(result.body.revisions).toEqual([]);
  }, 60_000);

  it("honors live revocation without relogin and permits view-only reading", async () => {
    await pool.query(
      "UPDATE user_company_roles SET pos_view_only = true WHERE user_id = $1 AND company_id = $2",
      [cashierId, ctx.companyId]
    );
    expect((await cashier.get(`/api/vouchers/${incoming}`)).status).toBe(200);
    await pool.query(
      "DELETE FROM user_locations WHERE user_id = $1 AND company_id = $2",
      [cashierId, ctx.companyId]
    );
    await pool.query(
      "UPDATE user_company_roles SET assigned_location_id = NULL WHERE user_id = $1 AND company_id = $2",
      [cashierId, ctx.companyId]
    );
    try {
      const hidden = await cashier.get("/api/vouchers").query({ startDate: today, endDate: today });
      expect(hidden.status).toBe(200);
      expect(hidden.body).toEqual([]);
      expect((await cashier.get(`/api/vouchers/${incoming}`)).status).toBe(404);
      expect((await cashier.get("/api/pos-transfer-detail").query({ voucherId: incoming })).status).toBe(404);
    } finally {
      await pool.query(
        "UPDATE user_company_roles SET assigned_location_id = $1, pos_view_only = false WHERE user_id = $2 AND company_id = $3",
        [ctx.locationId, cashierId, ctx.companyId]
      );
      await pool.query(
        "INSERT INTO user_locations (user_id, company_id, location_id) VALUES ($1, $2, $3)",
        [cashierId, ctx.companyId, ctx.locationId]
      );
    }
  }, 60_000);
});
