import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "../shared/schema";
import { db } from "../server/db";
import { adjustInventory, reverseInventoryByExactValue } from "../server/inventoryHelper";
import {
  cleanupTestData,
  closeTestServer,
  getInventoryQty,
  getInventoryRecord,
  seedTestData,
  type TestContext,
} from "./setup";

const TEST_PREFIX = "invhard";

let ctx: TestContext;
let agent: request.SuperAgentTest;

async function loginAndSelectCompany(): Promise<void> {
  const loginRes = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  expect(loginRes.status).toBe(200);

  const switchRes = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  expect(switchRes.status).toBe(200);
}

async function setInventory(
  locationId: number,
  stockItemId: number,
  quantity: number,
  averageRate: number,
  totalValue: number
): Promise<void> {
  const existing = await getInventoryRecord(locationId, stockItemId);

  if (existing) {
    await db
      .update(schema.inventory)
      .set({
        quantity: quantity.toFixed(3),
        averageRate: averageRate.toFixed(2),
        totalValue: totalValue.toFixed(2),
      })
      .where(eq(schema.inventory.id, existing.id));
    return;
  }

  await db.insert(schema.inventory).values({
    companyId: ctx.companyId,
    locationId,
    stockItemId,
    quantity: quantity.toFixed(3),
    averageRate: averageRate.toFixed(2),
    totalValue: totalValue.toFixed(2),
  });
}

async function resetInventory(): Promise<void> {
  await db.execute(sql`
    DELETE FROM inventory_negative_layers
    WHERE company_id = ${ctx.companyId}
      AND location_id IN (${ctx.locationId}, ${ctx.location2Id})
  `);

  for (const stockItemId of ctx.stockItemIds) {
    await setInventory(ctx.locationId, stockItemId, 100, 10, 1000);
    await setInventory(ctx.location2Id, stockItemId, 50, 10, 500);
  }
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  await loginAndSelectCompany();
}, 60_000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 30_000);

beforeEach(async () => {
  await resetInventory();
});

describe("Inventory API hardening", () => {
  it("applies rapid sequential adjustments without losing company context", async () => {
    for (let index = 0; index < 5; index += 1) {
      const res = await agent.post("/api/inventory/quick-adjust").send({
        stockItemId: ctx.stockItemIds[0],
        locationId: ctx.locationId,
        quantity: 2,
        type: "add",
      });

      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
    }

    expect(await getInventoryQty(ctx.locationId, ctx.stockItemIds[0])).toBe(110);
  });

  it("conserves total quantity when a transfer intentionally creates negative source stock", async () => {
    const initialTotal =
      (await getInventoryQty(ctx.locationId, ctx.stockItemIds[0])) +
      (await getInventoryQty(ctx.location2Id, ctx.stockItemIds[0]));

    const res = await agent.post("/api/stock-transfers").send({
      sourceLocationId: ctx.locationId,
      destinationLocationId: ctx.location2Id,
      items: [
        {
          stockItemId: ctx.stockItemIds[0],
          quantity: 150,
          sourceLocationId: ctx.locationId,
        },
      ],
      notes: "Negative-source transfer invariant test",
      voucherDate: new Date().toISOString().split("T")[0],
    });

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);

    const sourceQty = await getInventoryQty(ctx.locationId, ctx.stockItemIds[0]);
    const destinationQty = await getInventoryQty(ctx.location2Id, ctx.stockItemIds[0]);
    expect(sourceQty).toBe(-50);
    expect(destinationQty).toBe(200);
    expect(sourceQty + destinationQty).toBe(initialTotal);
  });

  it("keeps inventory unchanged after a rejected excessive quick subtraction", async () => {
    const res = await agent.post("/api/inventory/quick-adjust").send({
      stockItemId: ctx.stockItemIds[0],
      locationId: ctx.locationId,
      quantity: 101,
      type: "subtract",
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await getInventoryQty(ctx.locationId, ctx.stockItemIds[0])).toBe(100);
  });
});

describe("Negative-stock costing invariants", () => {
  // Wave 11 (owner decision: negative stock is costed provisionally): the
  // 50 short are relieved at the cost memory (10.00), so the row holds -500.00
  // and the issue's COGS includes them. The test used to pin a short row at
  // zero value, which dropped the shortage's cost from the sub-ledger.
  it("relieves the shortage at the non-negative cost memory below zero", async () => {
    const result = await adjustInventory(
      db as any,
      ctx.locationId,
      ctx.stockItemIds[0],
      -150,
      ctx.companyId,
      undefined,
      "TEST"
    );

    expect(result.newQuantity).toBe(-50);
    expect(result.newTotalValue).toBe(-500);
    expect(result.averageRate).toBeGreaterThanOrEqual(0);

    const record = await getInventoryRecord(ctx.locationId, ctx.stockItemIds[0]);
    expect(Number(record!.quantity)).toBe(-50);
    expect(Number(record!.totalValue)).toBe(-500);
    expect(Number(record!.averageRate)).toBeGreaterThanOrEqual(0);
  });

  it("preserves cost memory when an exact reversal returns stock to zero", async () => {
    await setInventory(ctx.locationId, ctx.stockItemIds[0], 200, 5, 1000);

    await reverseInventoryByExactValue(
      db as any,
      ctx.locationId,
      ctx.stockItemIds[0],
      200,
      1000,
      ctx.companyId,
      "TEST"
    );

    const record = await getInventoryRecord(ctx.locationId, ctx.stockItemIds[0]);
    expect(Number(record!.quantity)).toBe(0);
    expect(Number(record!.totalValue)).toBe(0);
    expect(Number(record!.averageRate)).toBe(5);
  });

  it("is stable across repeated matched receive and exact-reversal cycles", async () => {
    await setInventory(ctx.locationId, ctx.stockItemIds[0], 0, 0, 0);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const receipt = await adjustInventory(
        db as any,
        ctx.locationId,
        ctx.stockItemIds[0],
        200,
        ctx.companyId,
        5,
        "TEST"
      );

      let record = await getInventoryRecord(ctx.locationId, ctx.stockItemIds[0]);
      expect(Number(record!.quantity)).toBe(200);
      expect(Number(record!.totalValue)).toBe(receipt.newTotalValue);
      expect(Number(record!.averageRate)).toBe(5);

      await reverseInventoryByExactValue(
        db as any,
        ctx.locationId,
        ctx.stockItemIds[0],
        200,
        receipt.newTotalValue,
        ctx.companyId,
        "TEST"
      );

      record = await getInventoryRecord(ctx.locationId, ctx.stockItemIds[0]);
      expect(Number(record!.quantity)).toBe(0);
      expect(Number(record!.totalValue)).toBe(0);
      expect(Number(record!.averageRate)).toBe(5);
    }
  });

  it("maintains the positive-stock value equation after a partial deduction", async () => {
    await setInventory(ctx.locationId, ctx.stockItemIds[0], 200, 5, 1000);

    const result = await adjustInventory(db as any, ctx.locationId, ctx.stockItemIds[0], -40, ctx.companyId);

    expect(result.newQuantity).toBe(160);
    expect(result.newTotalValue).toBe(800);
    expect(result.averageRate).toBe(5);

    const record = await getInventoryRecord(ctx.locationId, ctx.stockItemIds[0]);
    const quantity = Number(record!.quantity);
    const rate = Number(record!.averageRate);
    const value = Number(record!.totalValue);
    expect(Math.abs(quantity * rate - value)).toBeLessThan(0.01);
  });
});

describe("Inventory row isolation", () => {
  it("does not alter a different item at the same location", async () => {
    await adjustInventory(db as any, ctx.locationId, ctx.stockItemIds[0], -10, ctx.companyId);

    const untouched = await db
      .select()
      .from(schema.inventory)
      .where(
        and(eq(schema.inventory.locationId, ctx.locationId), eq(schema.inventory.stockItemId, ctx.stockItemIds[1]))
      );

    expect(Number(untouched[0].quantity)).toBe(100);
    expect(Number(untouched[0].totalValue)).toBe(1000);
  });
});
