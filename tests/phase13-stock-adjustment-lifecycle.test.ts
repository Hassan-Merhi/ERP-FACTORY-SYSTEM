import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { and, eq } from "drizzle-orm";
import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "p13adj";
const VOUCHER_DATE = "2026-09-14";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let sequence = 0;

type InventoryState = { quantity: number; averageRate: number; totalValue: number };

async function setInventory(
  locationId: number,
  stockItemId: number,
  quantity: number,
  averageRate: number,
  totalValue: number
): Promise<void> {
  const [existing] = await db
    .select({ id: schema.inventory.id })
    .from(schema.inventory)
    .where(and(eq(schema.inventory.locationId, locationId), eq(schema.inventory.stockItemId, stockItemId)))
    .limit(1);
  const values = {
    quantity: quantity.toFixed(3),
    averageRate: averageRate.toFixed(2),
    totalValue: totalValue.toFixed(2),
    lastUpdated: new Date(),
  };
  if (existing) {
    await db.update(schema.inventory).set(values).where(eq(schema.inventory.id, existing.id));
  } else {
    await db.insert(schema.inventory).values({
      companyId: ctx.companyId,
      locationId,
      stockItemId,
      ...values,
    });
  }
}

async function inventoryState(locationId: number, stockItemId: number): Promise<InventoryState> {
  const [row] = await db
    .select({
      quantity: schema.inventory.quantity,
      averageRate: schema.inventory.averageRate,
      totalValue: schema.inventory.totalValue,
    })
    .from(schema.inventory)
    .where(and(eq(schema.inventory.locationId, locationId), eq(schema.inventory.stockItemId, stockItemId)))
    .limit(1);
  if (!row) return { quantity: 0, averageRate: 0, totalValue: 0 };
  return {
    quantity: Number(row.quantity),
    averageRate: Number(row.averageRate),
    totalValue: Number(row.totalValue),
  };
}

function expectInventory(
  actual: InventoryState,
  expected: { quantity: number; totalValue: number; averageRate?: number }
): void {
  expect(actual.quantity).toBeCloseTo(expected.quantity, 3);
  expect(actual.totalValue).toBeCloseTo(expected.totalValue, 2);
  if (expected.averageRate !== undefined) expect(actual.averageRate).toBeCloseTo(expected.averageRate, 2);
}

async function createVoucher(voucherType: "Production" | "Consumption" | "Mixed"): Promise<number> {
  sequence += 1;
  const [voucher] = await db
    .insert(schema.vouchers)
    .values({
      companyId: ctx.companyId,
      voucherType,
      voucherNumber: `${TEST_PREFIX.toUpperCase()}-${voucherType}-${sequence}`,
      voucherDate: VOUCHER_DATE,
      description: `Phase 13 ${voucherType}`,
      totalAmount: "0",
      currency: "USD",
      optional: false,
      locationId: ctx.locationId,
    })
    .returning();
  return voucher.id;
}

function adjustmentBody(
  voucherId: number,
  adjustmentType: "Production" | "Consumption" | "Mixed",
  stockItemId: number,
  quantity: number,
  rate: number
) {
  return {
    voucherId,
    locationId: ctx.locationId,
    adjustmentType,
    notes: `Phase 13 ${adjustmentType}`,
    items: [{ stockItemId, quantity, rate }],
  };
}

async function adjustmentCount(voucherId: number): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM stock_adjustment_vouchers WHERE voucher_id = $1",
    [voucherId]
  );
  return Number(result.rows[0]?.count ?? 0);
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  expect(login.status).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
}, 120000);

afterAll(async () => {
  await pool.query("DELETE FROM inventory_negative_layers WHERE company_id = $1", [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("Phase 13 — stock adjustment quantity/value lifecycle", () => {
  it(
    "keeps a Production adjustment exact through create, edit, repeated edit, cancel and retry",
    async () => {
      const stockItemId = ctx.stockItemIds[0];
      await setInventory(ctx.locationId, stockItemId, 100, 10, 1000);
      const voucherId = await createVoucher("Production");

      const created = await agent
        .post("/api/stock-adjustments")
        .send(adjustmentBody(voucherId, "Production", stockItemId, 10, 20));
      expect(created.status).toBe(201);
      expect(await adjustmentCount(voucherId)).toBe(1);
      expectInventory(await inventoryState(ctx.locationId, stockItemId), {
        quantity: 110,
        totalValue: 1200,
        averageRate: 1200 / 110,
      });

      const editBody = {
        voucherDate: "2026-09-15",
        description: "Phase 13 edited production",
        locationId: ctx.locationId,
        adjustmentType: "Production" as const,
        items: [{ stockItemId, quantity: 5, rate: 30 }],
      };
      const edited = await agent.patch(`/api/vouchers/${voucherId}/adjustment`).send(editBody);
      expect(edited.status).toBe(200);
      expect(Number(edited.body.totalAmount)).toBeCloseTo(150, 2);
      expectInventory(await inventoryState(ctx.locationId, stockItemId), {
        quantity: 105,
        totalValue: 1150,
        averageRate: 1150 / 105,
      });

      const repeated = await agent.patch(`/api/vouchers/${voucherId}/adjustment`).send(editBody);
      expect(repeated.status).toBe(200);
      expectInventory(await inventoryState(ctx.locationId, stockItemId), {
        quantity: 105,
        totalValue: 1150,
        averageRate: 1150 / 105,
      });

      const cancelled = await agent.delete(`/api/vouchers/${voucherId}`);
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.replayed).toBe(false);
      expect(cancelled.body.reversedInventory).toBe(true);
      expectInventory(await inventoryState(ctx.locationId, stockItemId), {
        quantity: 100,
        totalValue: 1000,
        averageRate: 10,
      });

      const retry = await agent.delete(`/api/vouchers/${voucherId}`);
      expect(retry.status).toBe(200);
      expect(retry.body.replayed).toBe(true);
      expect(retry.body.reversedInventory).toBe(false);
      expectInventory(await inventoryState(ctx.locationId, stockItemId), {
        quantity: 100,
        totalValue: 1000,
        averageRate: 10,
      });
    },
    120000
  );

  it(
    "uses the live inventory value for Consumption and restores that exact value on cancel",
    async () => {
      const stockItemId = ctx.stockItemIds[1];
      await setInventory(ctx.locationId, stockItemId, 100, 10, 1000);
      const voucherId = await createVoucher("Consumption");

      // Client rate is intentionally different. Consumption must use the locked
      // inventory cost (10), not the browser-supplied 99.
      const created = await agent
        .post("/api/stock-adjustments")
        .send(adjustmentBody(voucherId, "Consumption", stockItemId, -10, 99));
      expect(created.status).toBe(201);
      expect(Number(created.body.items[0].rate)).toBeCloseTo(10, 2);
      expect(Number(created.body.items[0].totalAmount)).toBeCloseTo(100, 2);
      expectInventory(await inventoryState(ctx.locationId, stockItemId), {
        quantity: 90,
        totalValue: 900,
        averageRate: 10,
      });

      const cancelled = await agent.delete(`/api/vouchers/${voucherId}`);
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.replayed).toBe(false);
      expectInventory(await inventoryState(ctx.locationId, stockItemId), {
        quantity: 100,
        totalValue: 1000,
        averageRate: 10,
      });
    },
    120000
  );

  it(
    "applies one Production adjustment when duplicate submissions race and preserves value on sequential retry",
    async () => {
      const stockItemId = ctx.stockItemIds[0];
      await setInventory(ctx.locationId, stockItemId, 100, 10, 1000);
      const voucherId = await createVoucher("Production");
      const body = adjustmentBody(voucherId, "Production", stockItemId, 5, 20);

      const [first, second] = await Promise.all([
        agent.post("/api/stock-adjustments").send(body),
        agent.post("/api/stock-adjustments").send(body),
      ]);
      expect([first.status, second.status].sort()).toEqual([201, 409]);
      expect(await adjustmentCount(voucherId)).toBe(1);
      expectInventory(await inventoryState(ctx.locationId, stockItemId), {
        quantity: 105,
        totalValue: 1100,
        averageRate: 1100 / 105,
      });

      const sequentialRetry = await agent.post("/api/stock-adjustments").send(body);
      expect(sequentialRetry.status).toBe(409);
      expect(await adjustmentCount(voucherId)).toBe(1);
      expectInventory(await inventoryState(ctx.locationId, stockItemId), {
        quantity: 105,
        totalValue: 1100,
        averageRate: 1100 / 105,
      });
    },
    120000
  );
});
