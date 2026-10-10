/**
 * Regression tests for the factory raw-material stable-cost-rate rules.
 *
 * Supplier-owned mix sources use the supplier's locked, receipt-weighted rate.
 * Container-direct sources may follow an approved container landed-cost repair.
 * Consumption, mix-batch edits and bale production must never move the locked rate.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";
import { db, pool } from "../server/db";
import * as schema from "../shared/schema";

const TEST_PREFIX = "mbstable";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let supplierAId: number;
let supplierBId: number;
let expectedRateA: number;

async function loginAsTestUser(): Promise<void> {
  const login = await agent
    .post("/api/auth/login")
    .send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  if (login.status !== 200) {
    throw new Error(`Login failed: ${login.status} ${JSON.stringify(login.body)}`);
  }
  const companySwitch = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  if (companySwitch.status !== 200) {
    throw new Error(`Company switch failed: ${companySwitch.status} ${JSON.stringify(companySwitch.body)}`);
  }
}

async function createAndLoginAs(username: string, role: string): Promise<request.SuperAgentTest> {
  const bcrypt = await import("bcryptjs");
  const hashedPassword = await bcrypt.hash("testpassword123", 10);
  const [user] = await db.insert(schema.users).values({ username, password: hashedPassword }).returning();
  await db.insert(schema.userCompanyRoles).values({ userId: user.id, companyId: ctx.companyId, role });

  const roleAgent = request.agent(ctx.app);
  const login = await roleAgent.post("/api/auth/login").send({ username, password: "testpassword123" });
  if (login.status !== 200) {
    throw new Error(`Login failed for ${username}: ${login.status} ${JSON.stringify(login.body)}`);
  }
  const companySwitch = await roleAgent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  if (companySwitch.status !== 200) {
    throw new Error(
      `Set-company failed for ${username}: ${companySwitch.status} ${JSON.stringify(companySwitch.body)}`
    );
  }
  return roleAgent;
}

async function cleanupFactoryTables(companyId: number): Promise<void> {
  await pool.query(`DELETE FROM factory_daybook_entries WHERE company_id = $1`, [companyId]);
  await pool.query(
    `DELETE FROM factory_bales WHERE mix_batch_id IN (
       SELECT id FROM factory_mix_batches WHERE company_id = $1
     )`,
    [companyId]
  );
  await pool.query(
    `DELETE FROM factory_mix_batch_sources WHERE mix_batch_id IN (
       SELECT id FROM factory_mix_batches WHERE company_id = $1
     )`,
    [companyId]
  );
  await pool.query(`DELETE FROM factory_mix_batches WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM factory_raw_material_adjustments WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM factory_raw_stock WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM factory_containers WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM factory_suppliers WHERE company_id = $1`, [companyId]);
}

async function offloadedContainer(
  containerNumber: string,
  supplierId: number,
  receivedKg: string,
  costPerKgUsd: string
) {
  const { applyOffloadMovingAverage } = await import("../server/services/factory/rawStockLockedRate");

  const [container] = await db
    .insert(schema.factoryContainers)
    .values({
      companyId: ctx.companyId,
      containerNumber,
      supplierId,
      actualReceivedKg: receivedKg,
      currencyCode: "USD",
      fxRateToUsd: "1",
      status: "OFFLOADED",
    })
    .returning();

  await db.transaction(async (tx) => {
    await applyOffloadMovingAverage(tx, {
      companyId: ctx.companyId,
      supplierId,
      newReceivedKg: Number(receivedKg),
      newContainerLandedCostPerKgUsd: Number(costPerKgUsd),
    });
    await tx.insert(schema.factoryRawStock).values({
      companyId: ctx.companyId,
      containerId: container.id,
      receivedKg,
      costPerKg: costPerKgUsd,
      costPerKgUsd,
    });
  });

  return container;
}

async function getSupplierRow(supplierName: string): Promise<any> {
  const response = await agent.get("/api/factory/raw-stock");
  expect(response.status).toBe(200);
  const row = (response.body as any[]).find((entry) => entry.supplierName === supplierName);
  expect(row).toBeTruthy();
  return row;
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

describe("Stable receipt-weighted supplier cost rate", () => {
  it("stays fixed through batch operations and only moves on a new offload", async () => {
    const first = await offloadedContainer(`${TEST_PREFIX}-C1`, supplierAId, "10000", "0.20");
    const second = await offloadedContainer(`${TEST_PREFIX}-C2`, supplierAId, "10000", "0.36");

    let row = await getSupplierRow(`${TEST_PREFIX}_SupplierA`);
    expect(Number(row.costPerKgUsd)).toBeCloseTo(0.28, 4);

    const firstBatch = await agent.post("/api/factory/mix-batches").send({
      supplierSources: [{ supplierId: supplierAId, weightKg: "1000" }],
      name: "Batch 1",
    });
    expect(firstBatch.status).toBe(200);
    expect(Number(firstBatch.body.costPerKg)).toBeCloseTo(0.28, 4);
    const batch1Id = firstBatch.body.id;

    row = await getSupplierRow(`${TEST_PREFIX}_SupplierA`);
    expect(Number(row.freeKg)).toBeCloseTo(19000, 1);
    expect(Number(row.costPerKgUsd)).toBeCloseTo(0.28, 4);

    const secondBatch = await agent.post("/api/factory/mix-batches").send({
      supplierSources: [{ supplierId: supplierAId, weightKg: "2000" }],
      name: "Batch 2",
    });
    expect(secondBatch.status).toBe(200);
    expect(Number(secondBatch.body.costPerKg)).toBeCloseTo(0.28, 4);
    const batch2Id = secondBatch.body.id;

    const topUp = await agent.post(`/api/factory/mix-batches/${batch1Id}/top-up`).send({
      supplierSources: [{ supplierId: supplierAId, weightKg: "500" }],
    });
    expect(topUp.status).toBe(200);
    expect(Number(topUp.body.costPerKg)).toBeCloseTo(0.28, 4);

    const edit = await agent.patch(`/api/factory/mix-batches/${batch2Id}`).send({
      supplierSources: [{ supplierId: supplierAId, weightKg: "1500" }],
    });
    expect(edit.status).toBe(200);
    expect(Number(edit.body.costPerKg)).toBeCloseTo(0.28, 4);

    const deletion = await agent.delete(`/api/factory/mix-batches/${batch1Id}`);
    expect(deletion.status).toBe(200);

    const thirdBatch = await agent.post("/api/factory/mix-batches").send({
      supplierSources: [{ supplierId: supplierAId, weightKg: "3000" }],
      name: "Batch 3",
    });
    expect(thirdBatch.status).toBe(200);
    expect(Number(thirdBatch.body.costPerKg)).toBeCloseTo(0.28, 4);

    row = await getSupplierRow(`${TEST_PREFIX}_SupplierA`);
    expect(Number(row.costPerKgUsd)).toBeCloseTo(0.28, 4);
    const oldRemainingKg = Number(row.remainingKg);
    const oldLockedRate = Number(row.costPerKgUsd);
    const expectedNewRate = (oldRemainingKg * oldLockedRate + 10000 * 0.4) / (oldRemainingKg + 10000);

    await offloadedContainer(`${TEST_PREFIX}-C3`, supplierAId, "10000", "0.40");
    row = await getSupplierRow(`${TEST_PREFIX}_SupplierA`);
    expect(Number(row.costPerKgUsd)).toBeCloseTo(expectedNewRate, 4);
    expectedRateA = Number(row.costPerKgUsd);

    const [firstRawStock] = await db
      .select()
      .from(schema.factoryRawStock)
      .where(eq(schema.factoryRawStock.containerId, first.id));
    const [secondRawStock] = await db
      .select()
      .from(schema.factoryRawStock)
      .where(eq(schema.factoryRawStock.containerId, second.id));
    expect(Number(firstRawStock.costPerKgUsd)).toBeCloseTo(0.2, 6);
    expect(Number(secondRawStock.costPerKgUsd)).toBeCloseTo(0.36, 6);
  });

  it("keeps supplier isolation", async () => {
    await offloadedContainer(`${TEST_PREFIX}-B1`, supplierBId, "5000", "1.00");
    let supplierB = await getSupplierRow(`${TEST_PREFIX}_SupplierB`);
    expect(Number(supplierB.costPerKgUsd)).toBeCloseTo(1, 4);

    const batch = await agent.post("/api/factory/mix-batches").send({
      supplierSources: [{ supplierId: supplierBId, weightKg: "1000" }],
      name: "Batch B1",
    });
    expect(batch.status).toBe(200);

    const supplierA = await getSupplierRow(`${TEST_PREFIX}_SupplierA`);
    expect(Number(supplierA.costPerKgUsd)).toBeCloseTo(expectedRateA, 4);
    supplierB = await getSupplierRow(`${TEST_PREFIX}_SupplierB`);
    expect(Number(supplierB.costPerKgUsd)).toBeCloseTo(1, 4);
  });
});

describe("Adjustments, tamper resistance and explicit corrections", () => {
  let supplierCId: number;

  beforeAll(async () => {
    const [supplier] = await db
      .insert(schema.factorySuppliers)
      .values({ companyId: ctx.companyId, name: `${TEST_PREFIX}_SupplierC` })
      .returning();
    supplierCId = supplier.id;
  });

  it("keeps ADD/REMOVE quantity-only while using them in the next receipt base", async () => {
    await offloadedContainer(`${TEST_PREFIX}-CC1`, supplierCId, "19000", "0.50");
    let row = await getSupplierRow(`${TEST_PREFIX}_SupplierC`);
    expect(Number(row.costPerKgUsd)).toBeCloseTo(0.5, 4);

    const addition = await agent.post("/api/factory/raw-stock/adjustment").send({
      type: "ADD",
      kg: "1000",
      costPerKg: "9.99",
      supplierId: supplierCId,
      date: "2026-01-01",
    });
    expect(addition.status).toBe(200);
    row = await getSupplierRow(`${TEST_PREFIX}_SupplierC`);
    expect(Number(row.costPerKgUsd)).toBeCloseTo(0.5, 4);
    expect(Number(row.remainingKg)).toBeCloseTo(20000, 1);

    await offloadedContainer(`${TEST_PREFIX}-CC2`, supplierCId, "20000", "0.80");
    row = await getSupplierRow(`${TEST_PREFIX}_SupplierC`);
    expect(Number(row.costPerKgUsd)).toBeCloseTo(0.65, 4);

    const removal = await agent.post("/api/factory/raw-stock/adjustment").send({
      type: "REMOVE",
      kg: "500",
      supplierId: supplierCId,
      date: "2026-01-02",
    });
    expect(removal.status).toBe(200);
    row = await getSupplierRow(`${TEST_PREFIX}_SupplierC`);
    expect(Number(row.costPerKgUsd)).toBeCloseTo(0.65, 4);
    expect(Number(row.remainingKg)).toBeCloseTo(39500, 1);
  });

  it("ignores client cost tampering on create", async () => {
    const lockedRate = Number((await getSupplierRow(`${TEST_PREFIX}_SupplierC`)).costPerKgUsd);
    const response = await agent.post("/api/factory/mix-batches").send({
      supplierSources: [{ supplierId: supplierCId, weightKg: "100", costPerKg: "9.99" }],
      name: "Batch Tamper Create",
    });
    expect(response.status).toBe(200);
    expect(Number(response.body.costPerKg)).toBeCloseTo(lockedRate, 4);

    const sources = await db
      .select()
      .from(schema.factoryMixBatchSources)
      .where(eq(schema.factoryMixBatchSources.mixBatchId, response.body.id));
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((source) => Math.abs(Number(source.costPerKg) - lockedRate) < 0.0001)).toBe(true);
  });

  it("ignores client cost tampering on edit", async () => {
    const lockedRate = Number((await getSupplierRow(`${TEST_PREFIX}_SupplierC`)).costPerKgUsd);
    const created = await agent.post("/api/factory/mix-batches").send({
      supplierSources: [{ supplierId: supplierCId, weightKg: "50" }],
      name: "Batch Tamper Edit",
    });
    expect(created.status).toBe(200);

    const edited = await agent.patch(`/api/factory/mix-batches/${created.body.id}`).send({
      supplierSources: [{ supplierId: supplierCId, weightKg: "80", costPerKg: "9.99" }],
    });
    expect(edited.status).toBe(200);
    expect(Number(edited.body.costPerKg)).toBeCloseTo(lockedRate, 4);
  });

  it("ignores client cost tampering on top-up", async () => {
    const lockedRate = Number((await getSupplierRow(`${TEST_PREFIX}_SupplierC`)).costPerKgUsd);
    const created = await agent.post("/api/factory/mix-batches").send({
      supplierSources: [{ supplierId: supplierCId, weightKg: "40" }],
      name: "Batch Tamper Top-up",
    });
    expect(created.status).toBe(200);

    const topUp = await agent.post(`/api/factory/mix-batches/${created.body.id}/top-up`).send({
      supplierSources: [{ supplierId: supplierCId, weightKg: "30", costPerKg: "9.99" }],
    });
    expect(topUp.status).toBe(200);
    expect(Number(topUp.body.costPerKg)).toBeCloseTo(lockedRate, 4);
  });

  // Phase 19 C (F2): the uniform update-cost correction is retired (410); the
  // locked rate is unchanged.
  it("refuses the retired update-cost correction", async () => {
    const before = Number((await getSupplierRow(`${TEST_PREFIX}_SupplierC`)).costPerKgUsd);
    const response = await agent.post("/api/factory/raw-stock/update-cost").send({
      supplierId: supplierCId,
      newCostPerKg: "0.70",
    });
    expect(response.status).toBe(410);
    expect(Number((await getSupplierRow(`${TEST_PREFIX}_SupplierC`)).costPerKgUsd)).toBeCloseTo(before, 4);
  });
});

describe("Landed-cost correction", () => {
  it("does not reintroduce already-consumed kilograms", async () => {
    const { cascadeContainerCostChange } = await import("../server/services/factory/rawStockCostCascade");
    const [supplier] = await db
      .insert(schema.factorySuppliers)
      .values({ companyId: ctx.companyId, name: `${TEST_PREFIX}_SupplierD` })
      .returning();
    const container = await offloadedContainer(`${TEST_PREFIX}-D1`, supplier.id, "10000", "1.00");
    await db
      .update(schema.factoryRawStock)
      .set({ usedKg: "6000" })
      .where(eq(schema.factoryRawStock.containerId, container.id));

    await db.transaction(async (tx) => {
      await cascadeContainerCostChange(tx, {
        companyId: ctx.companyId,
        containerId: container.id,
        newCostPerKg: 1.2,
        newCostPerKgUsd: 1.2,
      });
    });
    expect(Number((await getSupplierRow(`${TEST_PREFIX}_SupplierD`)).costPerKgUsd)).toBeCloseTo(1.2, 4);
  });

  it("updates an open container-direct source but preserves supplier-owned historical sources", async () => {
    const { cascadeContainerCostChange } = await import("../server/services/factory/rawStockCostCascade");
    const [supplier] = await db
      .insert(schema.factorySuppliers)
      .values({ companyId: ctx.companyId, name: `${TEST_PREFIX}_SupplierE` })
      .returning();
    const container = await offloadedContainer(`${TEST_PREFIX}-E1`, supplier.id, "10000", "1.00");

    const [openBatch] = await db
      .insert(schema.factoryMixBatches)
      .values({
        companyId: ctx.companyId,
        batchCode: `${TEST_PREFIX}-OPEN`,
        status: "ACTIVE",
        totalWeightKg: "1000",
        usedKg: "0",
        costPerKg: "1.00",
        totalCost: "1000.00",
      })
      .returning();
    const [openSource] = await db
      .insert(schema.factoryMixBatchSources)
      .values({
        mixBatchId: openBatch.id,
        containerId: container.id,
        supplierId: null,
        weightKg: "1000",
        costPerKg: "1.00",
        totalCost: "1000.00",
      })
      .returning();

    const [closedBatch] = await db
      .insert(schema.factoryMixBatches)
      .values({
        companyId: ctx.companyId,
        batchCode: `${TEST_PREFIX}-CLOSED`,
        status: "COMPLETED",
        totalWeightKg: "500",
        usedKg: "500",
        costPerKg: "1.00",
        totalCost: "500.00",
      })
      .returning();
    const [closedSource] = await db
      .insert(schema.factoryMixBatchSources)
      .values({
        mixBatchId: closedBatch.id,
        containerId: container.id,
        supplierId: supplier.id,
        inventorySupplierId: supplier.id,
        weightKg: "500",
        costPerKg: "1.00",
        totalCost: "500.00",
      })
      .returning();

    await db.transaction(async (tx) => {
      await cascadeContainerCostChange(tx, {
        companyId: ctx.companyId,
        containerId: container.id,
        newCostPerKg: 1.5,
        newCostPerKgUsd: 1.5,
      });
    });

    const [refreshedOpenSource] = await db
      .select()
      .from(schema.factoryMixBatchSources)
      .where(eq(schema.factoryMixBatchSources.id, openSource.id));
    const [refreshedOpenBatch] = await db
      .select()
      .from(schema.factoryMixBatches)
      .where(eq(schema.factoryMixBatches.id, openBatch.id));
    expect(Number(refreshedOpenSource.costPerKg)).toBeCloseTo(1.5, 4);
    expect(Number(refreshedOpenBatch.costPerKg)).toBeCloseTo(1.5, 4);

    const [refreshedClosedSource] = await db
      .select()
      .from(schema.factoryMixBatchSources)
      .where(eq(schema.factoryMixBatchSources.id, closedSource.id));
    const [refreshedClosedBatch] = await db
      .select()
      .from(schema.factoryMixBatches)
      .where(eq(schema.factoryMixBatches.id, closedBatch.id));
    expect(Number(refreshedClosedSource.costPerKg)).toBeCloseTo(1, 4);
    expect(Number(refreshedClosedBatch.costPerKg)).toBeCloseTo(1, 4);
  });
});

describe("Diagnostic endpoint", () => {
  let normalAgent: request.SuperAgentTest;
  let adminAgent: request.SuperAgentTest;
  let developerAgent: request.SuperAgentTest;

  beforeAll(async () => {
    normalAgent = await createAndLoginAs(`${TEST_PREFIX}_diag_normal`, "Normal User");
    adminAgent = await createAndLoginAs(`${TEST_PREFIX}_diag_admin`, "Admin");
    developerAgent = await createAndLoginAs(`${TEST_PREFIX}_diag_dev`, "Developer");
  }, 30000);

  it("rejects a nonprivileged user", async () => {
    expect((await normalAgent.get("/api/factory/raw-stock/diagnostics/locked-rates")).status).toBe(403);
  });

  it("allows an Admin", async () => {
    expect((await adminAgent.get("/api/factory/raw-stock/diagnostics/locked-rates")).status).toBe(200);
  });

  it("allows a Developer", async () => {
    expect((await developerAgent.get("/api/factory/raw-stock/diagnostics/locked-rates")).status).toBe(200);
  });

  it("performs no writes", async () => {
    const before = await db
      .select({ id: schema.factorySuppliers.id, rate: schema.factorySuppliers.currentRawMaterialCostPerKgUsd })
      .from(schema.factorySuppliers)
      .where(eq(schema.factorySuppliers.companyId, ctx.companyId));

    expect((await adminAgent.get("/api/factory/raw-stock/diagnostics/locked-rates")).status).toBe(200);
    const afterAdmin = await db
      .select({ id: schema.factorySuppliers.id, rate: schema.factorySuppliers.currentRawMaterialCostPerKgUsd })
      .from(schema.factorySuppliers)
      .where(eq(schema.factorySuppliers.companyId, ctx.companyId));
    expect(afterAdmin).toEqual(before);

    expect((await developerAgent.get("/api/factory/raw-stock/diagnostics/locked-rates")).status).toBe(200);
    const afterDeveloper = await db
      .select({ id: schema.factorySuppliers.id, rate: schema.factorySuppliers.currentRawMaterialCostPerKgUsd })
      .from(schema.factorySuppliers)
      .where(eq(schema.factorySuppliers.companyId, ctx.companyId));
    expect(afterDeveloper).toEqual(before);
  });
});

describe("Delete/reverse", () => {
  it("restores quantity and used value exactly once without changing the locked rate", async () => {
    const [supplier] = await db
      .insert(schema.factorySuppliers)
      .values({ companyId: ctx.companyId, name: `${TEST_PREFIX}_SupplierF` })
      .returning();
    await offloadedContainer(`${TEST_PREFIX}-F1`, supplier.id, "5000", "0.90");
    const rateBefore = Number((await getSupplierRow(`${TEST_PREFIX}_SupplierF`)).costPerKgUsd);

    const created = await agent.post("/api/factory/mix-batches").send({
      supplierSources: [{ supplierId: supplier.id, weightKg: "1000" }],
      name: "Batch F1",
    });
    expect(created.status).toBe(200);
    let row = await getSupplierRow(`${TEST_PREFIX}_SupplierF`);
    expect(Number(row.freeKg)).toBeCloseTo(4000, 1);
    expect(Number(row.usedValueUsd)).toBeCloseTo(900, 1);

    expect((await agent.delete(`/api/factory/mix-batches/${created.body.id}`)).status).toBe(200);
    row = await getSupplierRow(`${TEST_PREFIX}_SupplierF`);
    expect(Number(row.freeKg)).toBeCloseTo(5000, 1);
    expect(Number(row.usedValueUsd)).toBeCloseTo(0, 1);
    expect(Number(row.costPerKgUsd)).toBeCloseTo(rateBefore, 4);
  });
});

describe("KPI reconciliation", () => {
  it("keeps remaining value equal to free kilograms times locked rate", async () => {
    const [supplier] = await db
      .insert(schema.factorySuppliers)
      .values({ companyId: ctx.companyId, name: `${TEST_PREFIX}_SupplierG` })
      .returning();
    await offloadedContainer(`${TEST_PREFIX}-G1`, supplier.id, "8000", "0.75");
    expect(
      (
        await agent.post("/api/factory/mix-batches").send({
          supplierSources: [{ supplierId: supplier.id, weightKg: "3000" }],
          name: "Batch G1",
        })
      ).status
    ).toBe(200);

    const row = await getSupplierRow(`${TEST_PREFIX}_SupplierG`);
    const freeKg = Number(row.freeKg);
    const rate = Number(row.costPerKgUsd);
    expect(freeKg).toBeCloseTo(5000, 1);
    expect(Number(row.valueRemainingUsd)).toBeCloseTo(freeKg * rate, 2);
  });
});
