import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { and, eq } from "drizzle-orm";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "p12xfer";
const VOUCHER_DATE = "2026-09-14";

let ctx: TestContext;
let agent: request.SuperAgentTest;

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

async function negativeLayerQuantity(locationId: number, stockItemId: number): Promise<number> {
  const result = await pool.query<{ qty: string }>(
    `SELECT COALESCE(SUM(qty), 0)::text AS qty
       FROM inventory_negative_layers
      WHERE company_id = $1
        AND location_id = $2
        AND stock_item_id = $3`,
    [ctx.companyId, locationId, stockItemId]
  );
  return Number(result.rows[0]?.qty ?? 0);
}

function expectInventory(
  actual: InventoryState,
  expected: { quantity: number; totalValue: number; averageRate?: number }
): void {
  expect(actual.quantity).toBeCloseTo(expected.quantity, 3);
  expect(actual.totalValue).toBeCloseTo(expected.totalValue, 2);
  if (expected.averageRate !== undefined) expect(actual.averageRate).toBeCloseTo(expected.averageRate, 2);
}

function createBody(stockItemId: number, quantity: number, clientRequestId: string) {
  return {
    sourceLocationId: ctx.locationId,
    destinationLocationId: ctx.location2Id,
    voucherDate: VOUCHER_DATE,
    notes: "Phase 12 stock transfer",
    clientRequestId,
    items: [
      {
        stockItemId,
        sourceLocationId: ctx.locationId,
        quantity,
      },
    ],
  };
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

describe("Phase 12 — stock transfer quantity/value lifecycle", () => {
  it(
    "keeps exact value symmetric across duplicate create, edit, repeated edit, cancel and retry",
    async () => {
      const stockItemId = ctx.stockItemIds[0];
      await setInventory(ctx.locationId, stockItemId, 100, 10, 1000);
      // Different destination cost is deliberate: it exposes reversal code that
      // incorrectly subtracts the transferred quantity at the blended average.
      await setInventory(ctx.location2Id, stockItemId, 50, 20, 1000);

      const clientRequestId = `${TEST_PREFIX}-duplicate-create`;
      const [first, second] = await Promise.all([
        agent.post("/api/stock-transfers").send(createBody(stockItemId, 10, clientRequestId)),
        agent.post("/api/stock-transfers").send(createBody(stockItemId, 10, clientRequestId)),
      ]);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      const responses = [first, second];
      expect(responses.filter((response) => response.body.replayed === false)).toHaveLength(1);
      expect(responses.filter((response) => response.body.replayed === true)).toHaveLength(1);
      expect(first.body.transfer.id).toBe(second.body.transfer.id);
      expect(first.body.voucher.id).toBe(second.body.voucher.id);

      expectInventory(await inventoryState(ctx.locationId, stockItemId), {
        quantity: 90,
        totalValue: 900,
        averageRate: 10,
      });
      expectInventory(await inventoryState(ctx.location2Id, stockItemId), {
        quantity: 60,
        totalValue: 1100,
        averageRate: 1100 / 60,
      });

      const voucherId = Number(first.body.voucher.id);
      const editBody = {
        voucherDate: "2026-09-15",
        description: "Phase 12 edited transfer",
        sourceLocationId: ctx.locationId,
        destinationLocationId: ctx.location2Id,
        items: [
          {
            stockItemId,
            sourceLocationId: ctx.locationId,
            quantity: 20,
            rate: 10,
          },
        ],
      };

      const edited = await agent.patch(`/api/vouchers/${voucherId}/transfer`).send(editBody);
      expect(edited.status).toBe(200);
      expect(edited.body.lifecycle.transition).toBe("posted-edit");
      expect(edited.body.lifecycle.totalAmount).toBe("200.00");

      expectInventory(await inventoryState(ctx.locationId, stockItemId), {
        quantity: 80,
        totalValue: 800,
        averageRate: 10,
      });
      expectInventory(await inventoryState(ctx.location2Id, stockItemId), {
        quantity: 70,
        totalValue: 1200,
        averageRate: 1200 / 70,
      });

      // Repeating the same edit must be a state replacement, not another move.
      const repeatedEdit = await agent.patch(`/api/vouchers/${voucherId}/transfer`).send(editBody);
      expect(repeatedEdit.status).toBe(200);
      expectInventory(await inventoryState(ctx.locationId, stockItemId), {
        quantity: 80,
        totalValue: 800,
        averageRate: 10,
      });
      expectInventory(await inventoryState(ctx.location2Id, stockItemId), {
        quantity: 70,
        totalValue: 1200,
        averageRate: 1200 / 70,
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
      expectInventory(await inventoryState(ctx.location2Id, stockItemId), {
        quantity: 50,
        totalValue: 1000,
        averageRate: 20,
      });

      const retryCancel = await agent.delete(`/api/vouchers/${voucherId}`);
      expect(retryCancel.status).toBe(200);
      expect(retryCancel.body.replayed).toBe(true);
      expect(retryCancel.body.reversedInventory).toBe(false);
      expectInventory(await inventoryState(ctx.locationId, stockItemId), {
        quantity: 100,
        totalValue: 1000,
        averageRate: 10,
      });
      expectInventory(await inventoryState(ctx.location2Id, stockItemId), {
        quantity: 50,
        totalValue: 1000,
        averageRate: 20,
      });
    },
    120000
  );

  it(
    "allows a permitted negative transfer and restores quantity, value and shortage layers on cancel/retry",
    async () => {
      const stockItemId = ctx.stockItemIds[1];
      await setInventory(ctx.locationId, stockItemId, 5, 10, 50);
      await setInventory(ctx.location2Id, stockItemId, 0, 10, 0);

      const created = await agent.post("/api/stock-transfers").send({
        ...createBody(stockItemId, 8, `${TEST_PREFIX}-negative`),
        allowNegativeInventory: true,
      });
      expect(created.status).toBe(201);
      expect(created.body.replayed).toBe(false);

      expectInventory(await inventoryState(ctx.locationId, stockItemId), {
        quantity: -3,
        totalValue: 0,
        averageRate: 10,
      });
      expectInventory(await inventoryState(ctx.location2Id, stockItemId), {
        quantity: 8,
        totalValue: 80,
        averageRate: 10,
      });
      expect(await negativeLayerQuantity(ctx.locationId, stockItemId)).toBeCloseTo(3, 3);

      const voucherId = Number(created.body.voucher.id);
      const cancelled = await agent.delete(`/api/vouchers/${voucherId}`);
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.replayed).toBe(false);
      expectInventory(await inventoryState(ctx.locationId, stockItemId), {
        quantity: 5,
        totalValue: 50,
        averageRate: 10,
      });
      expectInventory(await inventoryState(ctx.location2Id, stockItemId), { quantity: 0, totalValue: 0 });
      expect(await negativeLayerQuantity(ctx.locationId, stockItemId)).toBe(0);

      const retry = await agent.delete(`/api/vouchers/${voucherId}`);
      expect(retry.status).toBe(200);
      expect(retry.body.replayed).toBe(true);
      expectInventory(await inventoryState(ctx.locationId, stockItemId), {
        quantity: 5,
        totalValue: 50,
        averageRate: 10,
      });
      expectInventory(await inventoryState(ctx.location2Id, stockItemId), { quantity: 0, totalValue: 0 });
      expect(await negativeLayerQuantity(ctx.locationId, stockItemId)).toBe(0);
    },
    120000
  );

  it("records only one transfer document for a duplicate client request key", async () => {
    const idempotencyKey = `stock-transfer:${ctx.companyId}:${TEST_PREFIX}-duplicate-create`;
    const markerCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM audit_log
        WHERE company_id = $1
          AND table_name = 'stock_document_idempotency'
          AND record_identifier = $2`,
      [ctx.companyId, idempotencyKey]
    );
    expect(Number(markerCount.rows[0]?.count ?? 0)).toBe(1);
  });
});
