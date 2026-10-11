/**
 * Regression tests for the factory raw-material landed-cost reconciliation bug:
 *
 *   1. cascadeContainerCostChange must correctly propagate a corrected
 *      container cost/kg down to container-direct mix batch sources, recompute
 *      each affected batch's weighted-average cost across ALL its sources, and
 *      cascade the new blended cost to bales.
 *   2. GET /api/factory/raw-stock/history/:supplierId must report each
 *      supplier's OWN weighted cost/kg (from factory_mix_batch_sources), not
 *      the batch's blended cost/kg.
 *   3. POST /api/factory/raw-stock/offload must refuse to silently default a
 *      non-USD container's FX rate to 1 when no confirmed rate is available.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";
import { db, pool } from "../server/db";
import { eq } from "drizzle-orm";
import * as schema from "../shared/schema";
import { cascadeContainerCostChange } from "../server/services/factory/rawStockCostCascade";

const TEST_PREFIX = "lcrtest";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let supplierAId: number;
let supplierBId: number;

async function loginAsTestUser() {
  const loginRes = await agent
    .post("/api/auth/login")
    .send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  if (loginRes.status !== 200) {
    throw new Error(`Login failed: ${loginRes.status} ${JSON.stringify(loginRes.body)}`);
  }
  const switchRes = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  if (switchRes.status !== 200) {
    console.warn("Switch company response:", switchRes.status, switchRes.body);
  }
}

async function cleanupFactoryTables(companyId: number) {
  await pool.query(`DELETE FROM factory_daybook_entries WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM factory_fx_rates WHERE company_id = $1`, [companyId]);
  await pool.query(
    `DELETE FROM factory_bales WHERE mix_batch_id IN (SELECT id FROM factory_mix_batches WHERE company_id = $1)`,
    [companyId]
  );
  await pool.query(
    `DELETE FROM factory_mix_batch_sources WHERE mix_batch_id IN (SELECT id FROM factory_mix_batches WHERE company_id = $1)`,
    [companyId]
  );
  await pool.query(`DELETE FROM factory_mix_batches WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM factory_raw_stock WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM factory_containers WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM factory_suppliers WHERE company_id = $1`, [companyId]);
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  await db.update(schema.companies).set({ companyType: "factory" }).where(eq(schema.companies.id, ctx.companyId));
  agent = request.agent(ctx.app);
  await loginAsTestUser();

  const [supplierA] = await db
    .insert(schema.factorySuppliers)
    .values({ companyId: ctx.companyId, name: `${TEST_PREFIX}_SupplierA` })
    .returning();
  const [supplierB] = await db
    .insert(schema.factorySuppliers)
    .values({ companyId: ctx.companyId, name: `${TEST_PREFIX}_SupplierB` })
    .returning();
  supplierAId = supplierA.id;
  supplierBId = supplierB.id;
}, 60000);

afterAll(async () => {
  await cleanupFactoryTables(ctx.companyId);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 30000);

describe("cascadeContainerCostChange", () => {
  it("propagates a corrected container-direct cost through sources, batch weighted-average, and bales", async () => {
    const [container] = await db
      .insert(schema.factoryContainers)
      .values({
        companyId: ctx.companyId,
        containerNumber: `${TEST_PREFIX}-C1`,
        supplierId: supplierAId,
        actualReceivedKg: "1000",
        currencyCode: "USD",
        fxRateToUsd: "1",
        status: "OFFLOADED",
      })
      .returning();

    const [otherContainer] = await db
      .insert(schema.factoryContainers)
      .values({
        companyId: ctx.companyId,
        containerNumber: `${TEST_PREFIX}-C2`,
        supplierId: supplierBId,
        actualReceivedKg: "500",
        currencyCode: "USD",
        fxRateToUsd: "1",
        status: "OFFLOADED",
      })
      .returning();

    await db.insert(schema.factoryRawStock).values({
      companyId: ctx.companyId,
      containerId: container.id,
      receivedKg: "1000",
      costPerKg: "0.50",
      costPerKgUsd: "0.50",
    });
    await db.insert(schema.factoryRawStock).values({
      companyId: ctx.companyId,
      containerId: otherContainer.id,
      receivedKg: "500",
      costPerKg: "0.80",
      costPerKgUsd: "0.80",
    });

    const [batch] = await db
      .insert(schema.factoryMixBatches)
      .values({
        companyId: ctx.companyId,
        batchCode: `${TEST_PREFIX}-B1`,
        totalWeightKg: "800",
        costPerKg: "0.575",
        totalCost: "460.00",
        status: "ACTIVE",
      })
      .returning();

    // This source is intentionally container-direct. Supplier-priced sources are
    // owned by the locked-rate historical replay and must not be overwritten by
    // an individual-container cascade.
    await db.insert(schema.factoryMixBatchSources).values({
      mixBatchId: batch.id,
      containerId: container.id,
      supplierId: null,
      weightKg: "600",
      costPerKg: "0.50",
      totalCost: "300.00",
    });
    await db.insert(schema.factoryMixBatchSources).values({
      mixBatchId: batch.id,
      containerId: otherContainer.id,
      supplierId: null,
      weightKg: "200",
      costPerKg: "0.80",
      totalCost: "160.00",
    });

    const [bale] = await db
      .insert(schema.factoryBales)
      .values({
        companyId: ctx.companyId,
        mixBatchId: batch.id,
        baleCode: `${TEST_PREFIX}-BALE1`,
        referenceNumber: `${TEST_PREFIX}-REF1`,
        weightKg: "100",
        costPerKg: "0.575",
        totalCost: "57.50",
        status: "PRESSED",
      })
      .returning();

    const result = await db.transaction(async (tx) =>
      cascadeContainerCostChange(tx, {
        companyId: ctx.companyId,
        containerId: container.id,
        newCostPerKg: 0.6,
        newCostPerKgUsd: 0.6,
      })
    );

    const [updatedRawStock] = await db
      .select()
      .from(schema.factoryRawStock)
      .where(eq(schema.factoryRawStock.containerId, container.id));
    expect(parseFloat(updatedRawStock.costPerKg)).toBeCloseTo(0.6, 4);
    expect(parseFloat(updatedRawStock.costPerKgUsd!)).toBeCloseTo(0.6, 4);

    const [srcA] = await db
      .select()
      .from(schema.factoryMixBatchSources)
      .where(eq(schema.factoryMixBatchSources.containerId, container.id));
    expect(parseFloat(srcA.costPerKg)).toBeCloseTo(0.6, 4);
    expect(parseFloat(srcA.totalCost)).toBeCloseTo(360, 2);

    const [srcB] = await db
      .select()
      .from(schema.factoryMixBatchSources)
      .where(eq(schema.factoryMixBatchSources.containerId, otherContainer.id));
    expect(parseFloat(srcB.costPerKg)).toBeCloseTo(0.8, 4);

    const [updatedBatch] = await db
      .select()
      .from(schema.factoryMixBatches)
      .where(eq(schema.factoryMixBatches.id, batch.id));
    expect(parseFloat(updatedBatch.costPerKg)).toBeCloseTo(0.65, 4);
    expect(parseFloat(updatedBatch.totalCost)).toBeCloseTo(520, 2);

    const [updatedBale] = await db.select().from(schema.factoryBales).where(eq(schema.factoryBales.id, bale.id));
    expect(parseFloat(updatedBale.costPerKg)).toBeCloseTo(0.65, 4);
    expect(parseFloat(updatedBale.totalCost)).toBeCloseTo(65, 2);

    expect(result.affectedBatches.length).toBe(1);
    expect(result.affectedBales.length).toBe(1);
  });
});

describe("GET /api/factory/raw-stock/history/:supplierId", () => {
  it("reports the supplier's own weighted cost/kg, not the batch's blended cost/kg", async () => {
    const [container] = await db
      .insert(schema.factoryContainers)
      .values({
        companyId: ctx.companyId,
        containerNumber: `${TEST_PREFIX}-C3`,
        supplierId: supplierAId,
        actualReceivedKg: "300",
        currencyCode: "USD",
        fxRateToUsd: "1",
        status: "OFFLOADED",
      })
      .returning();

    const [batch] = await db
      .insert(schema.factoryMixBatches)
      .values({
        companyId: ctx.companyId,
        batchCode: `${TEST_PREFIX}-B2`,
        totalWeightKg: "500",
        costPerKg: "1.20",
        totalCost: "600.00",
        status: "ACTIVE",
      })
      .returning();

    await db.insert(schema.factoryMixBatchSources).values({
      mixBatchId: batch.id,
      containerId: container.id,
      supplierId: supplierAId,
      weightKg: "300",
      costPerKg: "0.40",
      totalCost: "120.00",
    });
    await db.insert(schema.factoryMixBatchSources).values({
      mixBatchId: batch.id,
      supplierId: supplierBId,
      weightKg: "200",
      costPerKg: "2.40",
      totalCost: "480.00",
    });

    const res = await agent.get(`/api/factory/raw-stock/history/${supplierAId}`);
    expect(res.status).toBe(200);
    const batchEntry =
      (res.body.entries || res.body.timeline || res.body).find?.((entry: any) => entry.batchId === batch.id) ??
      (Array.isArray(res.body) ? res.body.find((entry: any) => entry.batchId === batch.id) : undefined);
    expect(batchEntry).toBeTruthy();
    expect(batchEntry.costPerKg).toBeCloseTo(0.4, 4);
  });
});

describe("POST /api/factory/raw-stock/offload — FX safeguard", () => {
  it("rejects a non-USD offload instead of silently defaulting FX to 1 when no rate is available", async () => {
    const [container] = await db
      .insert(schema.factoryContainers)
      .values({
        companyId: ctx.companyId,
        containerNumber: `${TEST_PREFIX}-C4`,
        supplierId: supplierAId,
        actualReceivedKg: "1000",
        currencyCode: "ZZZ",
        status: "PENDING",
      })
      .returning();

    const res = await agent.post("/api/factory/raw-stock/offload").send({
      containerId: container.id,
      receivedKg: "1000",
    });

    // Phase 19 C (M2): no recorded dated factory rate → 409 FACTORY_FX_RATE_REQUIRED.
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body).toLowerCase()).toContain("fx");
  }, 60_000);
});
