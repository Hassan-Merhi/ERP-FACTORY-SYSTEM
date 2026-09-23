import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import {
  seedTestData,
  cleanupTestData,
  getInventoryQty,
  getInventoryRecord,
  closeTestServer,
  type TestContext,
} from "./setup";
import { db } from "../server/db";
import { eq, and, sql } from "drizzle-orm";
import * as schema from "../shared/schema";

const TEST_PREFIX = "invtest";

let ctx: TestContext;
let agent: request.SuperAgentTest;

async function loginAsTestUser() {
  const loginRes = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });

  if (loginRes.status !== 200) {
    throw new Error(`Login failed: ${loginRes.status} ${JSON.stringify(loginRes.body)}`);
  }

  const switchRes = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

  if (switchRes.status !== 200) {
    console.warn("Switch company response:", switchRes.status, switchRes.body);
  }
}

async function resetInventory() {
  for (const stockItemId of ctx.stockItemIds) {
    const existing = await getInventoryRecord(ctx.locationId, stockItemId);
    if (existing) {
      await db
        .update(schema.inventory)
        .set({
          quantity: "100.000",
          averageRate: "10.00",
          totalValue: "1000.00",
        })
        .where(eq(schema.inventory.id, existing.id));
    } else {
      await db.insert(schema.inventory).values({
        companyId: ctx.companyId,
        locationId: ctx.locationId,
        stockItemId,
        quantity: "100.000",
        averageRate: "10.00",
        totalValue: "1000.00",
      });
    }

    const existing2 = await getInventoryRecord(ctx.location2Id, stockItemId);
    if (existing2) {
      await db
        .update(schema.inventory)
        .set({
          quantity: "50.000",
          averageRate: "10.00",
          totalValue: "500.00",
        })
        .where(eq(schema.inventory.id, existing2.id));
    } else {
      await db.insert(schema.inventory).values({
        companyId: ctx.companyId,
        locationId: ctx.location2Id,
        stockItemId,
        quantity: "50.000",
        averageRate: "10.00",
        totalValue: "500.00",
      });
    }
  }
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  await loginAsTestUser();
}, 60000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 30000);

describe("POS Sale Inventory Tests", () => {
  beforeEach(async () => {
    await resetInventory();
  });

  it("should decrease inventory correctly when creating a sale", async () => {
    const initialQty = await getInventoryQty(ctx.locationId, ctx.stockItemIds[0]);
    expect(initialQty).toBe(100);

    const res = await agent.post("/api/pos/sales").send({
      locationId: ctx.locationId,
      items: [
        {
          stockItemId: ctx.stockItemIds[0],
          quantity: 5,
          rate: 15,
        },
      ],
      paymentAccountType: "ledger",
      paymentAccountId: ctx.cashAccountId,
      voucherDate: new Date().toISOString().split("T")[0],
    });

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);

    const newQty = await getInventoryQty(ctx.locationId, ctx.stockItemIds[0]);
    expect(newQty).toBe(95);
  });

  it("should decrease inventory for multiple items in one sale", async () => {
    const res = await agent.post("/api/pos/sales").send({
      locationId: ctx.locationId,
      items: [
        { stockItemId: ctx.stockItemIds[0], quantity: 3, rate: 15 },
        { stockItemId: ctx.stockItemIds[1], quantity: 7, rate: 20 },
      ],
      paymentAccountType: "ledger",
      paymentAccountId: ctx.cashAccountId,
      voucherDate: new Date().toISOString().split("T")[0],
    });

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);

    const qty0 = await getInventoryQty(ctx.locationId, ctx.stockItemIds[0]);
    const qty1 = await getInventoryQty(ctx.locationId, ctx.stockItemIds[1]);
    expect(qty0).toBe(97);
    expect(qty1).toBe(93);
  });

  it("should reject sale with invalid stockItemId", async () => {
    const res = await agent.post("/api/pos/sales").send({
      locationId: ctx.locationId,
      items: [{ stockItemId: "invalid", quantity: 5, rate: 15 }],
      paymentAccountType: "ledger",
      paymentAccountId: ctx.cashAccountId,
      voucherDate: new Date().toISOString().split("T")[0],
    });

    expect(res.status).toBe(400);

    const qty = await getInventoryQty(ctx.locationId, ctx.stockItemIds[0]);
    expect(qty).toBe(100);
  });

  it("should reject sale with invalid quantity", async () => {
    const res = await agent.post("/api/pos/sales").send({
      locationId: ctx.locationId,
      items: [{ stockItemId: ctx.stockItemIds[0], quantity: "abc", rate: 15 }],
      paymentAccountType: "ledger",
      paymentAccountId: ctx.cashAccountId,
      voucherDate: new Date().toISOString().split("T")[0],
    });

    expect(res.status).toBe(400);
  });
});

describe("Stock Transfer Tests", () => {
  beforeEach(async () => {
    await resetInventory();
  });

  it("should decrease source and increase destination inventory", async () => {
    const res = await agent.post("/api/stock-transfers").send({
      sourceLocationId: ctx.locationId,
      destinationLocationId: ctx.location2Id,
      items: [
        {
          stockItemId: ctx.stockItemIds[0],
          quantity: 10,
          sourceLocationId: ctx.locationId,
        },
      ],
      notes: "Test transfer",
      voucherDate: new Date().toISOString().split("T")[0],
    });

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);

    const srcQty = await getInventoryQty(ctx.locationId, ctx.stockItemIds[0]);
    const dstQty = await getInventoryQty(ctx.location2Id, ctx.stockItemIds[0]);
    expect(srcQty).toBe(90);
    expect(dstQty).toBe(60);
  });

  it("should handle multi-item transfers atomically", async () => {
    const res = await agent.post("/api/stock-transfers").send({
      sourceLocationId: ctx.locationId,
      destinationLocationId: ctx.location2Id,
      items: [
        {
          stockItemId: ctx.stockItemIds[0],
          quantity: 5,
          sourceLocationId: ctx.locationId,
        },
        {
          stockItemId: ctx.stockItemIds[1],
          quantity: 8,
          sourceLocationId: ctx.locationId,
        },
      ],
      notes: "Multi-item test transfer",
      voucherDate: new Date().toISOString().split("T")[0],
    });

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);

    const srcQty0 = await getInventoryQty(ctx.locationId, ctx.stockItemIds[0]);
    const srcQty1 = await getInventoryQty(ctx.locationId, ctx.stockItemIds[1]);
    const dstQty0 = await getInventoryQty(ctx.location2Id, ctx.stockItemIds[0]);
    const dstQty1 = await getInventoryQty(ctx.location2Id, ctx.stockItemIds[1]);
    expect(srcQty0).toBe(95);
    expect(srcQty1).toBe(92);
    expect(dstQty0).toBe(55);
    expect(dstQty1).toBe(58);
  });

  it("should reject transfer with same source and destination", async () => {
    const res = await agent.post("/api/stock-transfers").send({
      sourceLocationId: ctx.locationId,
      destinationLocationId: ctx.locationId,
      items: [
        {
          stockItemId: ctx.stockItemIds[0],
          quantity: 5,
          sourceLocationId: ctx.locationId,
        },
      ],
    });

    expect(res.status).toBe(400);
  });
});

describe("Quick Adjust Tests", () => {
  beforeEach(async () => {
    await resetInventory();
  });

  it("should increase inventory on add", async () => {
    const res = await agent.post("/api/inventory/quick-adjust").send({
      stockItemId: ctx.stockItemIds[0],
      locationId: ctx.locationId,
      quantity: 25,
      type: "add",
    });

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);

    const qty = await getInventoryQty(ctx.locationId, ctx.stockItemIds[0]);
    expect(qty).toBe(125);
  });

  it("should decrease inventory on subtract", async () => {
    const res = await agent.post("/api/inventory/quick-adjust").send({
      stockItemId: ctx.stockItemIds[0],
      locationId: ctx.locationId,
      quantity: 30,
      type: "subtract",
    });

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);

    const qty = await getInventoryQty(ctx.locationId, ctx.stockItemIds[0]);
    expect(qty).toBe(70);
  });

  it("should reject subtract that exceeds available stock", async () => {
    const res = await agent.post("/api/inventory/quick-adjust").send({
      stockItemId: ctx.stockItemIds[0],
      locationId: ctx.locationId,
      quantity: 150,
      type: "subtract",
    });

    expect(res.status).toBeGreaterThanOrEqual(400);

    const qty = await getInventoryQty(ctx.locationId, ctx.stockItemIds[0]);
    expect(qty).toBe(100);
  });

  it("should reject invalid quantity", async () => {
    const res = await agent.post("/api/inventory/quick-adjust").send({
      stockItemId: ctx.stockItemIds[0],
      locationId: ctx.locationId,
      quantity: -5,
      type: "add",
    });

    expect(res.status).toBe(400);
  });

  it("should handle sequential adjustments correctly", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await agent.post("/api/inventory/quick-adjust").send({
        stockItemId: ctx.stockItemIds[0],
        locationId: ctx.locationId,
        quantity: 2,
        type: "add",
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.newQuantity).toBe(100 + (i + 1) * 2);
    }

    const qty = await getInventoryQty(ctx.locationId, ctx.stockItemIds[0]);
    expect(qty).toBe(110);
  });
});

describe("Voucher Delete Inventory Reversal Tests", () => {
  beforeEach(async () => {
    await resetInventory();
  });

  it("should restore inventory when deleting a sales voucher", async () => {
    const saleRes = await agent.post("/api/pos/sales").send({
      locationId: ctx.locationId,
      items: [{ stockItemId: ctx.stockItemIds[0], quantity: 10, rate: 15 }],
      paymentAccountType: "ledger",
      paymentAccountId: ctx.cashAccountId,
      voucherDate: new Date().toISOString().split("T")[0],
    });

    expect(saleRes.status).toBeGreaterThanOrEqual(200);
    expect(saleRes.status).toBeLessThan(300);

    const afterSaleQty = await getInventoryQty(ctx.locationId, ctx.stockItemIds[0]);
    expect(afterSaleQty).toBe(90);

    const voucherId = saleRes.body.voucher?.id || saleRes.body.voucherId || saleRes.body.id;
    expect(voucherId).toBeDefined();

    const deleteRes = await agent.delete(`/api/vouchers/${voucherId}`);

    expect(deleteRes.status).toBeGreaterThanOrEqual(200);
    expect(deleteRes.status).toBeLessThan(300);

    const afterDeleteQty = await getInventoryQty(ctx.locationId, ctx.stockItemIds[0]);
    expect(afterDeleteQty).toBe(100);
  });
});

describe("Input Validation Tests", () => {
  it("should reject POS sale with NaN locationId", async () => {
    const res = await agent.post("/api/pos/sales").send({
      locationId: "notanumber",
      items: [{ stockItemId: ctx.stockItemIds[0], quantity: 5, sellingPrice: 15 }],
      paymentAccountType: "ledger",
      paymentAccountId: ctx.cashAccountId,
    });

    expect(res.status).toBe(400);
  });

  it("should reject stock transfer with invalid item quantity", async () => {
    const res = await agent.post("/api/stock-transfers").send({
      sourceLocationId: ctx.locationId,
      destinationLocationId: ctx.location2Id,
      items: [
        {
          stockItemId: ctx.stockItemIds[0],
          quantity: "not_a_number",
          sourceLocationId: ctx.locationId,
        },
      ],
    });

    expect(res.status).toBe(400);
  });

  it("should reject quick adjust with missing fields", async () => {
    const res = await agent.post("/api/inventory/quick-adjust").send({
      stockItemId: ctx.stockItemIds[0],
    });

    expect(res.status).toBe(400);
  });
});

describe("adjustInventory Helper Tests", () => {
  beforeEach(async () => {
    await resetInventory();
  });

  it("should handle insert-or-update correctly", async () => {
    const { adjustInventory } = await import("../server/inventoryHelper");

    const result = await adjustInventory(db as any, ctx.locationId, ctx.stockItemIds[0], 10, ctx.companyId, 12.0);

    expect(result.previousQuantity).toBe(100);
    expect(result.newQuantity).toBe(110);
    expect(result.created).toBe(false);
  });

  it("should create inventory record when none exists", async () => {
    const { adjustInventory } = await import("../server/inventoryHelper");

    const [newItem] = await db
      .insert(schema.stockItems)
      .values({
        companyId: ctx.companyId,
        code: `${TEST_PREFIX}-NEWITEM`,
        name: "Brand New Item",
        uom: "PCS",
        stockGroupId: ctx.stockGroupId,
        active: true,
      })
      .returning();

    const result = await adjustInventory(db as any, ctx.locationId, newItem.id, 25, ctx.companyId, 8.0);

    expect(result.previousQuantity).toBe(0);
    expect(result.newQuantity).toBe(25);
    expect(result.created).toBe(true);
    expect(result.averageRate).toBe(8.0);

    await db.delete(schema.inventory).where(eq(schema.inventory.stockItemId, newItem.id));
    await db.delete(schema.stockItems).where(eq(schema.stockItems.id, newItem.id));
  });

  it("should allow negative inventory", async () => {
    const { adjustInventory } = await import("../server/inventoryHelper");

    const result = await adjustInventory(db as any, ctx.locationId, ctx.stockItemIds[0], -150, ctx.companyId);

    expect(result.newQuantity).toBe(-50);
    expect(result.created).toBe(false);
  });

  it("should never produce a negative average_rate (Bug 2 fix)", async () => {
    const { adjustInventory } = await import("../server/inventoryHelper");

    await db
      .update(schema.inventory)
      .set({
        quantity: "-100.000",
        averageRate: "50.00",
        totalValue: "-5000.00",
      })
      .where(
        and(eq(schema.inventory.locationId, ctx.locationId), eq(schema.inventory.stockItemId, ctx.stockItemIds[0]))
      );

    const result = await adjustInventory(db as any, ctx.locationId, ctx.stockItemIds[0], 200, ctx.companyId, 1.0);

    expect(result.newQuantity).toBe(100);
    expect(result.averageRate).toBeGreaterThanOrEqual(0);
    expect(result.newTotalValue).toBeGreaterThanOrEqual(0);
  });

  it("should clamp negative prevRate to zero during deduction (Bug 2 fix)", async () => {
    const { adjustInventory } = await import("../server/inventoryHelper");

    await db
      .update(schema.inventory)
      .set({
        quantity: "100.000",
        averageRate: "-48.00",
        totalValue: "-4800.00",
      })
      .where(
        and(eq(schema.inventory.locationId, ctx.locationId), eq(schema.inventory.stockItemId, ctx.stockItemIds[0]))
      );

    const result = await adjustInventory(db as any, ctx.locationId, ctx.stockItemIds[0], -200, ctx.companyId);

    expect(result.newQuantity).toBe(-100);
    expect(result.newTotalValue).toBe(0);
    expect(result.averageRate).toBe(0);
  });

  // qty <= 0 carries no value. The average rate is deliberately kept as "cost
  // memory" (inventoryHelper.ts): it prices the negative-stock layer and the next
  // receipt, so zeroing it would re-cost the shortage at 0. This used to be a
  // skipped test asserting rate = 0, which contradicts that design.
  it("should zero total_value and keep the last cost as memory when a deduction goes negative", async () => {
    const { adjustInventory } = await import("../server/inventoryHelper");
    const layerQty = async () => {
      const result = await db.execute(sql`
        SELECT COALESCE(SUM(qty::numeric), 0)::text AS qty
        FROM inventory_negative_layers
        WHERE location_id = ${ctx.locationId} AND stock_item_id = ${ctx.stockItemIds[0]}
      `);
      return Number(result.rows[0].qty);
    };
    const layersBefore = await layerQty();

    const result = await adjustInventory(db as any, ctx.locationId, ctx.stockItemIds[0], -150, ctx.companyId);

    expect(result.newQuantity).toBe(-50);
    expect(result.newTotalValue).toBe(0);
    expect(result.averageRate).toBe(10);

    const record = await getInventoryRecord(ctx.locationId, ctx.stockItemIds[0]);
    expect(parseFloat(record!.quantity)).toBe(-50);
    expect(parseFloat(record!.totalValue!)).toBe(0);
    expect(parseFloat(record!.averageRate)).toBe(10);

    // Only the new 50-unit shortage is recorded as a negative layer.
    expect((await layerQty()) - layersBefore).toBeCloseTo(50, 3);
  });

  it("should enforce qty > 0 implies total_value >= 0 after deduction", async () => {
    const { adjustInventory } = await import("../server/inventoryHelper");

    await db
      .update(schema.inventory)
      .set({
        quantity: "200.000",
        averageRate: "50.00",
        totalValue: "10000.00",
      })
      .where(
        and(eq(schema.inventory.locationId, ctx.locationId), eq(schema.inventory.stockItemId, ctx.stockItemIds[0]))
      );

    const result = await adjustInventory(db as any, ctx.locationId, ctx.stockItemIds[0], -190, ctx.companyId);

    expect(result.newQuantity).toBe(10);
    expect(result.newTotalValue).toBeGreaterThanOrEqual(0);
    expect(result.averageRate).toBeGreaterThanOrEqual(0);
  });
});

describe("reverseInventoryByExactValue Tests", () => {
  beforeEach(async () => {
    await resetInventory();
  });

  it("should subtract exact value, zero the value below zero and keep cost memory", async () => {
    const { reverseInventoryByExactValue } = await import("../server/inventoryHelper");

    await db
      .update(schema.inventory)
      .set({
        quantity: "190.000",
        averageRate: "5.56",
        totalValue: "1056.40",
      })
      .where(
        and(eq(schema.inventory.locationId, ctx.locationId), eq(schema.inventory.stockItemId, ctx.stockItemIds[0]))
      );

    await reverseInventoryByExactValue(db as any, ctx.locationId, ctx.stockItemIds[0], 200, 500);

    const record = await getInventoryRecord(ctx.locationId, ctx.stockItemIds[0]);
    const qty = parseFloat(record!.quantity);
    const value = parseFloat(record!.totalValue!);
    const rate = parseFloat(record!.averageRate);

    expect(qty).toBeCloseTo(-10, 1);
    expect(value).toBe(0);
    expect(rate).toBeCloseTo(5.56, 2);
  });

  it("should subtract the exact value while stock stays positive", async () => {
    const { reverseInventoryByExactValue } = await import("../server/inventoryHelper");

    await reverseInventoryByExactValue(db as any, ctx.locationId, ctx.stockItemIds[0], 40, 520);

    const record = await getInventoryRecord(ctx.locationId, ctx.stockItemIds[0]);
    // 100 @ 10 = 1000; reversing 40 units worth 520 leaves 60 units worth 480.
    expect(parseFloat(record!.quantity)).toBeCloseTo(60, 3);
    expect(parseFloat(record!.totalValue!)).toBeCloseTo(480, 2);
    expect(parseFloat(record!.averageRate)).toBeCloseTo(8, 4);
  });

  it("should produce idempotent results across reverse/re-offload cycles", async () => {
    const { adjustInventory, reverseInventoryByExactValue } = await import("../server/inventoryHelper");

    const offloadQty = 200;
    const offloadRate = 5.0;
    const offloadValue = offloadQty * offloadRate;

    await db
      .update(schema.inventory)
      .set({
        quantity: "0.000",
        averageRate: "0.00",
        totalValue: "0.00",
      })
      .where(
        and(eq(schema.inventory.locationId, ctx.locationId), eq(schema.inventory.stockItemId, ctx.stockItemIds[0]))
      );

    await adjustInventory(db as any, ctx.locationId, ctx.stockItemIds[0], offloadQty, ctx.companyId, offloadRate);

    const afterFirstOffload = await getInventoryRecord(ctx.locationId, ctx.stockItemIds[0]);
    const firstQty = parseFloat(afterFirstOffload!.quantity);
    const firstValue = parseFloat(afterFirstOffload!.totalValue!);
    const firstRate = parseFloat(afterFirstOffload!.averageRate);

    for (let cycle = 0; cycle < 3; cycle++) {
      await reverseInventoryByExactValue(db as any, ctx.locationId, ctx.stockItemIds[0], offloadQty, offloadValue);

      const afterReverse = await getInventoryRecord(ctx.locationId, ctx.stockItemIds[0]);
      expect(parseFloat(afterReverse!.quantity)).toBeCloseTo(0, 1);
      expect(parseFloat(afterReverse!.totalValue!)).toBe(0);
      // Cost memory survives the reversal, so the re-offload lands on the same rate.
      expect(parseFloat(afterReverse!.averageRate)).toBeCloseTo(offloadRate, 4);

      await adjustInventory(db as any, ctx.locationId, ctx.stockItemIds[0], offloadQty, ctx.companyId, offloadRate);

      const afterReoffload = await getInventoryRecord(ctx.locationId, ctx.stockItemIds[0]);
      expect(parseFloat(afterReoffload!.quantity)).toBeCloseTo(firstQty, 1);
      expect(parseFloat(afterReoffload!.totalValue!)).toBeCloseTo(firstValue, 2);
      expect(parseFloat(afterReoffload!.averageRate)).toBeCloseTo(firstRate, 2);
    }
  });

  it("should handle negative-stock offload reversal without value inflation", async () => {
    const { adjustInventory, reverseInventoryByExactValue } = await import("../server/inventoryHelper");

    await db
      .update(schema.inventory)
      .set({
        quantity: "-10.000",
        averageRate: "0.00",
        totalValue: "0.00",
      })
      .where(
        and(eq(schema.inventory.locationId, ctx.locationId), eq(schema.inventory.stockItemId, ctx.stockItemIds[0]))
      );

    const offloadQty = 200;
    const offloadRate = 1.0;
    const offloadValue = offloadQty * offloadRate;

    await adjustInventory(db as any, ctx.locationId, ctx.stockItemIds[0], offloadQty, ctx.companyId, offloadRate);

    const afterOffload = await getInventoryRecord(ctx.locationId, ctx.stockItemIds[0]);
    expect(parseFloat(afterOffload!.quantity)).toBeCloseTo(190, 1);
    expect(parseFloat(afterOffload!.averageRate)).toBeGreaterThanOrEqual(0);
    expect(parseFloat(afterOffload!.totalValue!)).toBeGreaterThanOrEqual(0);

    await reverseInventoryByExactValue(db as any, ctx.locationId, ctx.stockItemIds[0], offloadQty, offloadValue);

    const afterReverse = await getInventoryRecord(ctx.locationId, ctx.stockItemIds[0]);
    const reverseQty = parseFloat(afterReverse!.quantity);
    const reverseValue = parseFloat(afterReverse!.totalValue!);
    const reverseRate = parseFloat(afterReverse!.averageRate);

    expect(reverseQty).toBeCloseTo(-10, 1);
    expect(reverseValue).toBe(0);
    expect(reverseRate).toBeCloseTo(parseFloat(afterOffload!.averageRate), 4);

    await adjustInventory(db as any, ctx.locationId, ctx.stockItemIds[0], offloadQty, ctx.companyId, offloadRate);

    const afterReoffload = await getInventoryRecord(ctx.locationId, ctx.stockItemIds[0]);
    expect(parseFloat(afterReoffload!.quantity)).toBeCloseTo(190, 1);
    expect(parseFloat(afterReoffload!.averageRate)).toBeGreaterThanOrEqual(0);
    expect(parseFloat(afterReoffload!.totalValue!)).toBeGreaterThanOrEqual(0);
    expect(parseFloat(afterReoffload!.totalValue!)).toBeLessThan(1000);
  });

  it("should enforce all four invariants after every operation", async () => {
    const { adjustInventory, reverseInventoryByExactValue } = await import("../server/inventoryHelper");

    function assertInvariants(record: any, label: string) {
      const qty = parseFloat(record.quantity);
      const value = parseFloat(record.totalValue || "0");
      const rate = parseFloat(record.averageRate);

      expect(rate).toBeGreaterThanOrEqual(0);

      if (qty <= 0) {
        expect(value).toBe(0);
      }

      if (qty > 0) {
        expect(value).toBeGreaterThanOrEqual(0);
      }

      if (qty > 0 && rate > 0) {
        expect(Math.abs(qty * rate - value)).toBeLessThan(1.0);
      }
    }

    await db
      .update(schema.inventory)
      .set({
        quantity: "-100.000",
        averageRate: "0.00",
        totalValue: "0.00",
      })
      .where(
        and(eq(schema.inventory.locationId, ctx.locationId), eq(schema.inventory.stockItemId, ctx.stockItemIds[0]))
      );

    const offloadQty = 200;
    const offloadValue = 200;

    await adjustInventory(db as any, ctx.locationId, ctx.stockItemIds[0], offloadQty, ctx.companyId, 1.0);

    let record = await getInventoryRecord(ctx.locationId, ctx.stockItemIds[0]);
    assertInvariants(record, "after offload");

    await reverseInventoryByExactValue(db as any, ctx.locationId, ctx.stockItemIds[0], offloadQty, offloadValue);

    record = await getInventoryRecord(ctx.locationId, ctx.stockItemIds[0]);
    assertInvariants(record, "after reverse");

    await adjustInventory(db as any, ctx.locationId, ctx.stockItemIds[0], offloadQty, ctx.companyId, 1.0);

    record = await getInventoryRecord(ctx.locationId, ctx.stockItemIds[0]);
    assertInvariants(record, "after re-offload");
  });
});
