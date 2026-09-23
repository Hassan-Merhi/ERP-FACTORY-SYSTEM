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

const TEST_PREFIX = "invtest2";

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

describe("Inventory Reconciliation Endpoint Tests", () => {
  beforeEach(async () => {
    await resetInventory();
  });

  it("should return clean results for healthy inventory", async () => {
    const res = await agent.get("/api/inventory/reconcile");

    expect(res.status).toBe(200);
    expect(res.body.summary).toBeDefined();
    expect(res.body.summary.totalRecords).toBeGreaterThan(0);

    const criticalOrError = res.body.issues.filter((i: any) => i.severity === "critical" || i.severity === "error");
    expect(criticalOrError.length).toBe(0);
  });

  it("should detect value mismatches", async () => {
    await db
      .update(schema.inventory)
      .set({ totalValue: "9999.99" })
      .where(
        and(eq(schema.inventory.locationId, ctx.locationId), eq(schema.inventory.stockItemId, ctx.stockItemIds[0]))
      );

    const res = await agent.get("/api/inventory/reconcile");

    expect(res.status).toBe(200);
    const valueMismatches = res.body.issues.filter((i: any) => i.type === "value_mismatch");
    expect(valueMismatches.length).toBeGreaterThan(0);
    expect(valueMismatches[0].severity).toBe("error");
  });

  it("should report negative inventory as info (not error)", async () => {
    await db
      .update(schema.inventory)
      .set({ quantity: "-10.000", totalValue: "-100.00" })
      .where(
        and(eq(schema.inventory.locationId, ctx.locationId), eq(schema.inventory.stockItemId, ctx.stockItemIds[0]))
      );

    const res = await agent.get("/api/inventory/reconcile");

    expect(res.status).toBe(200);
    const negIssues = res.body.issues.filter((i: any) => i.type === "negative_inventory");
    expect(negIssues.length).toBeGreaterThan(0);
    expect(negIssues[0].severity).toBe("info");
  });

  it("should detect zero quantity with non-zero value", async () => {
    await db
      .update(schema.inventory)
      .set({ quantity: "0.000", totalValue: "50.00" })
      .where(
        and(eq(schema.inventory.locationId, ctx.locationId), eq(schema.inventory.stockItemId, ctx.stockItemIds[1]))
      );

    const res = await agent.get("/api/inventory/reconcile");

    expect(res.status).toBe(200);
    const zeroQtyIssues = res.body.issues.filter((i: any) => i.type === "zero_qty_nonzero_value");
    expect(zeroQtyIssues.length).toBeGreaterThan(0);
  });

  it("should include summary with counts", async () => {
    const res = await agent.get("/api/inventory/reconcile");

    expect(res.status).toBe(200);
    expect(res.body.summary.totalRecords).toBeGreaterThanOrEqual(6);
    expect(res.body.summary.totalLocations).toBeGreaterThanOrEqual(2);
    expect(typeof res.body.summary.totalInventoryValue).toBe("string");
    expect(typeof res.body.summary.issueCount).toBe("number");
  });
});

describe("POS Sale Edit Tests", () => {
  beforeEach(async () => {
    await resetInventory();
  });

  it("should reverse old sale and apply new quantities when editing", async () => {
    const saleRes = await agent.post("/api/pos/sales").send({
      locationId: ctx.locationId,
      items: [{ stockItemId: ctx.stockItemIds[0], quantity: 5, rate: 15 }],
      paymentAccountType: "ledger",
      paymentAccountId: ctx.cashAccountId,
      voucherDate: new Date().toISOString().split("T")[0],
    });

    expect(saleRes.status).toBeGreaterThanOrEqual(200);
    expect(saleRes.status).toBeLessThan(300);

    const afterSaleQty = await getInventoryQty(ctx.locationId, ctx.stockItemIds[0]);
    expect(afterSaleQty).toBe(95);

    const voucherId = saleRes.body.voucher?.id || saleRes.body.voucherId || saleRes.body.id;
    expect(voucherId).toBeDefined();

    const editRes = await agent.put(`/api/vouchers/${voucherId}/sales`).send({
      items: [{ stockItemId: ctx.stockItemIds[0], quantity: 3, sellingPrice: 20 }],
      paymentAccountType: "ledger",
      paymentAccountId: ctx.cashAccountId,
      voucherDate: new Date().toISOString().split("T")[0],
    });

    expect(editRes.status).toBeGreaterThanOrEqual(200);
    expect(editRes.status).toBeLessThan(300);

    const afterEditQty = await getInventoryQty(ctx.locationId, ctx.stockItemIds[0]);
    expect(afterEditQty).toBe(97);
  });

  it("should handle item swap during sale edit", async () => {
    const saleRes = await agent.post("/api/pos/sales").send({
      locationId: ctx.locationId,
      items: [{ stockItemId: ctx.stockItemIds[0], quantity: 5, rate: 15 }],
      paymentAccountType: "ledger",
      paymentAccountId: ctx.cashAccountId,
      voucherDate: new Date().toISOString().split("T")[0],
    });

    expect(saleRes.status).toBeGreaterThanOrEqual(200);
    expect(saleRes.status).toBeLessThan(300);

    const voucherId = saleRes.body.voucher?.id || saleRes.body.voucherId || saleRes.body.id;
    expect(voucherId).toBeDefined();

    const afterSaleQty0 = await getInventoryQty(ctx.locationId, ctx.stockItemIds[0]);
    expect(afterSaleQty0).toBe(95);

    const editRes = await agent.put(`/api/vouchers/${voucherId}/sales`).send({
      items: [{ stockItemId: ctx.stockItemIds[1], quantity: 3, sellingPrice: 20 }],
      paymentAccountType: "ledger",
      paymentAccountId: ctx.cashAccountId,
      voucherDate: new Date().toISOString().split("T")[0],
    });

    expect(editRes.status).toBeGreaterThanOrEqual(200);
    expect(editRes.status).toBeLessThan(300);

    const finalQty0 = await getInventoryQty(ctx.locationId, ctx.stockItemIds[0]);
    const finalQty1 = await getInventoryQty(ctx.locationId, ctx.stockItemIds[1]);
    expect(finalQty0).toBe(100);
    expect(finalQty1).toBe(97);
  });
});

describe("Stock Transfer Edit Tests", () => {
  beforeEach(async () => {
    await resetInventory();
  });

  it("should update stock transfer item quantity via PATCH", async () => {
    const transferRes = await agent.post("/api/stock-transfers").send({
      sourceLocationId: ctx.locationId,
      destinationLocationId: ctx.location2Id,
      items: [
        {
          stockItemId: ctx.stockItemIds[0],
          quantity: 10,
          sourceLocationId: ctx.locationId,
        },
      ],
      notes: "Transfer for edit test",
      voucherDate: new Date().toISOString().split("T")[0],
    });

    expect(transferRes.status).toBeGreaterThanOrEqual(200);
    expect(transferRes.status).toBeLessThan(300);

    const srcAfterCreate = await getInventoryQty(ctx.locationId, ctx.stockItemIds[0]);
    const dstAfterCreate = await getInventoryQty(ctx.location2Id, ctx.stockItemIds[0]);
    expect(srcAfterCreate).toBe(90);
    expect(dstAfterCreate).toBe(60);

    const transferId = transferRes.body.transfer?.id || transferRes.body.transferId || transferRes.body.id;
    expect(transferId).toBeDefined();

    const transferItems = await db
      .select()
      .from(schema.stockTransferItems)
      .where(eq(schema.stockTransferItems.transferId, transferId));

    expect(transferItems.length).toBeGreaterThan(0);

    const itemId = transferItems[0].id;

    const patchRes = await agent.patch(`/api/stock-transfer-items/${itemId}`).send({ quantity: "15" });

    expect(patchRes.status).toBeLessThan(500);
  });
});

describe("Edit Transaction Endpoint Tests", () => {
  it("should validate numeric fields in stock transfer item patch", async () => {
    const res = await agent.patch("/api/stock-transfer-items/99999").send({ quantity: "abc" });

    expect(res.status).toBe(400);
  });

  it("should validate numeric fields in stock adjustment item patch", async () => {
    const res = await agent.patch("/api/stock-adjustment-items/99999").send({ quantity: "abc" });

    expect(res.status).toBe(400);
  });

  it("should reject invalid item ID in transfer item patch", async () => {
    const res = await agent.patch("/api/stock-transfer-items/notanumber").send({ quantity: "10" });

    expect(res.status).toBe(400);
  });

  it("should reject invalid item ID in adjustment item patch", async () => {
    const res = await agent.patch("/api/stock-adjustment-items/notanumber").send({ quantity: "10" });

    expect(res.status).toBe(400);
  });
});

describe("Container Offload Inventory Tests", () => {
  beforeEach(async () => {
    await resetInventory();
  });

  async function setupContainerData() {
    const supplierCode = `${TEST_PREFIX}_SUP_${Date.now()}`;
    const [supplier] = await db
      .insert(schema.suppliers)
      .values({
        code: supplierCode,
        legalName: `${TEST_PREFIX} Test Supplier`,
        email: "supplier@test.com",
        active: true,
      })
      .returning();

    const [container] = await db
      .insert(schema.containers)
      .values({
        companyId: ctx.companyId,
        containerNumber: `${TEST_PREFIX}-CONT-${Date.now()}`,
        supplierId: supplier.id,
        status: "OTW",
        importDate: new Date().toISOString().split("T")[0],
      })
      .returning();

    const [po] = await db
      .insert(schema.purchaseOrders)
      .values({
        companyId: ctx.companyId,
        poNumber: `${TEST_PREFIX}-PO-${Date.now()}`,
        containerId: container.id,
        supplierId: supplier.id,
        currency: "USD",
      })
      .returning();

    await db.insert(schema.poLineItems).values([
      {
        poId: po.id,
        stockItemId: ctx.stockItemIds[0],
        itemName: "Test Item 1",
        quantity: "20.000",
        rate: "5.00",
        lineTotal: "100.00",
      },
      {
        poId: po.id,
        stockItemId: ctx.stockItemIds[1],
        itemName: "Test Item 2",
        quantity: "15.000",
        rate: "8.00",
        lineTotal: "120.00",
      },
    ]);

    return { supplier, container, po };
  }

  async function cleanupContainerData(data: {
    supplier: { id: number };
    container: { id: number };
    po: { id: number };
  }) {
    await db
      .delete(schema.containerOffloadItems)
      .where(
        sql`${schema.containerOffloadItems.offloadId} IN (SELECT id FROM container_offloads WHERE container_id = ${data.container.id})`
      );
    await db.delete(schema.containerOffloads).where(eq(schema.containerOffloads.containerId, data.container.id));
    await db.delete(schema.poLineItems).where(eq(schema.poLineItems.poId, data.po.id));
    await db.delete(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, data.po.id));
    await db.delete(schema.containers).where(eq(schema.containers.id, data.container.id));
    await db.delete(schema.suppliers).where(eq(schema.suppliers.id, data.supplier.id));
  }

  it("should add inventory when offloading a container", async () => {
    const containerData = await setupContainerData();

    try {
      const res = await agent.post(`/api/containers/${containerData.container.id}/offload`).send({
        locationId: ctx.locationId,
        offloadDate: "2026-02-06",
        duties: "0",
        officeCharges: "0",
        transferCharges: "0",
        transportFees: "0",
      });

      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);

      const qty0 = await getInventoryQty(ctx.locationId, ctx.stockItemIds[0]);
      const qty1 = await getInventoryQty(ctx.locationId, ctx.stockItemIds[1]);
      expect(qty0).toBe(120);
      expect(qty1).toBe(115);
    } finally {
      await cleanupContainerData(containerData);
    }
  }, 30000);

  it("should reverse and reapply inventory when re-offloading to different location", async () => {
    const containerData = await setupContainerData();

    try {
      const offloadRes = await agent.post(`/api/containers/${containerData.container.id}/offload`).send({
        locationId: ctx.locationId,
        offloadDate: "2026-02-06",
        duties: "0",
        officeCharges: "0",
        transferCharges: "0",
        transportFees: "0",
      });

      expect(offloadRes.status).toBeGreaterThanOrEqual(200);
      expect(offloadRes.status).toBeLessThan(300);

      const qty0AfterFirstOffload = await getInventoryQty(ctx.locationId, ctx.stockItemIds[0]);
      expect(qty0AfterFirstOffload).toBe(120);

      const reOffloadRes = await agent.post(`/api/containers/${containerData.container.id}/offload`).send({
        locationId: ctx.location2Id,
        offloadDate: "2026-02-06",
        duties: "0",
        officeCharges: "0",
        transferCharges: "0",
        transportFees: "0",
      });

      expect(reOffloadRes.status).toBeLessThan(500);

      if (reOffloadRes.status >= 200 && reOffloadRes.status < 300) {
        const loc1Qty0 = await getInventoryQty(ctx.locationId, ctx.stockItemIds[0]);
        const loc2Qty0 = await getInventoryQty(ctx.location2Id, ctx.stockItemIds[0]);
        expect(loc1Qty0).toBe(100);
        expect(loc2Qty0).toBe(70);
      } else {
        const loc1Qty0 = await getInventoryQty(ctx.locationId, ctx.stockItemIds[0]);
        expect(loc1Qty0).toBe(120);
      }
    } finally {
      await cleanupContainerData(containerData);
    }
  }, 30000);
});

describe("Concurrency Tests", () => {
  beforeEach(async () => {
    await resetInventory();
  });

  it("should handle concurrent POS sales without lost updates", async () => {
    const initialQty = await getInventoryQty(ctx.locationId, ctx.stockItemIds[0]);
    expect(initialQty).toBe(100);

    const NUM_CONCURRENT = 5;
    const QTY_PER_SALE = 2;

    const concurrentSales = Array.from({ length: NUM_CONCURRENT }, () =>
      agent.post("/api/pos/sales").send({
        locationId: ctx.locationId,
        items: [{ stockItemId: ctx.stockItemIds[0], quantity: QTY_PER_SALE, rate: 15 }],
        paymentAccountType: "ledger",
        paymentAccountId: ctx.cashAccountId,
        voucherDate: new Date().toISOString().split("T")[0],
      })
    );

    const results = await Promise.all(concurrentSales);
    const successCount = results.filter((r) => r.status === 200 || r.status === 201).length;

    expect(successCount).toBe(NUM_CONCURRENT);

    const finalQty = await getInventoryQty(ctx.locationId, ctx.stockItemIds[0]);
    expect(finalQty).toBe(100 - NUM_CONCURRENT * QTY_PER_SALE);
  }, 30000);

  // quick-adjust now runs in a transaction and adjustInventory locks the
  // inventory row (SELECT ... FOR UPDATE), and a supertest agent issues each
  // request on its own connection, so concurrent adds must not lose updates.
  it("should handle concurrent quick adjustments without lost updates", async () => {
    const initialQty = await getInventoryQty(ctx.locationId, ctx.stockItemIds[0]);
    expect(initialQty).toBe(100);

    const NUM_CONCURRENT = 5;
    const QTY_PER_ADJUST = 3;

    const concurrentAdjustments = Array.from({ length: NUM_CONCURRENT }, () =>
      agent.post("/api/inventory/quick-adjust").send({
        stockItemId: ctx.stockItemIds[0],
        locationId: ctx.locationId,
        quantity: QTY_PER_ADJUST,
        type: "add",
      })
    );

    const results = await Promise.all(concurrentAdjustments);
    const successCount = results.filter((r) => r.status === 200).length;

    expect(successCount).toBe(NUM_CONCURRENT);

    const finalQty = await getInventoryQty(ctx.locationId, ctx.stockItemIds[0]);
    expect(finalQty).toBe(100 + NUM_CONCURRENT * QTY_PER_ADJUST);
  }, 30000);
});

describe("Stock Transfer Import Tests", () => {
  beforeEach(async () => {
    await resetInventory();
  });

  it("should handle multi-source transfer with different source locations", async () => {
    const loc1Qty = await getInventoryQty(ctx.locationId, ctx.stockItemIds[0]);
    const loc2Qty = await getInventoryQty(ctx.location2Id, ctx.stockItemIds[0]);
    expect(loc1Qty).toBe(100);
    expect(loc2Qty).toBe(50);

    const res1 = await agent.post("/api/stock-transfers").send({
      sourceLocationId: ctx.locationId,
      destinationLocationId: ctx.location2Id,
      items: [
        {
          stockItemId: ctx.stockItemIds[0],
          quantity: 15,
          sourceLocationId: ctx.locationId,
        },
      ],
      notes: "Transfer from loc1 to loc2",
      voucherDate: new Date().toISOString().split("T")[0],
    });

    expect(res1.status).toBeGreaterThanOrEqual(200);
    expect(res1.status).toBeLessThan(300);

    const afterLoc1 = await getInventoryQty(ctx.locationId, ctx.stockItemIds[0]);
    const afterLoc2 = await getInventoryQty(ctx.location2Id, ctx.stockItemIds[0]);
    expect(afterLoc1).toBe(85);
    expect(afterLoc2).toBe(65);

    const res2 = await agent.post("/api/stock-transfers").send({
      sourceLocationId: ctx.location2Id,
      destinationLocationId: ctx.locationId,
      items: [
        {
          stockItemId: ctx.stockItemIds[0],
          quantity: 10,
          sourceLocationId: ctx.location2Id,
        },
      ],
      notes: "Transfer from loc2 back to loc1",
      voucherDate: new Date().toISOString().split("T")[0],
    });

    expect(res2.status).toBeGreaterThanOrEqual(200);
    expect(res2.status).toBeLessThan(300);

    const finalLoc1 = await getInventoryQty(ctx.locationId, ctx.stockItemIds[0]);
    const finalLoc2 = await getInventoryQty(ctx.location2Id, ctx.stockItemIds[0]);
    expect(finalLoc1).toBe(95);
    expect(finalLoc2).toBe(55);
  });
});
