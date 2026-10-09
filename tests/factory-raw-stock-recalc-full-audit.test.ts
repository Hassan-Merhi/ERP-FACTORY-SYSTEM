/**
 * Integration tests for the full raw-stock cost audit system:
 *   - Full audit endpoint
 *   - Extended RecalcRow fields (usedKg, remainingKg, fullyUsed, activeRawStockRowExists, etc.)
 *   - costEquals 6dp precision (no EPS tolerance)
 *   - includeHistoricalContainers flag
 *   - otherChargesRows in fingerprint
 *   - Source cost mismatch scan (non-zero mismatches, not just zero-cost)
 *   - getZeroCostMixBatchSourcesPreview backward-compat (uses costPerKgUsd)
 *   - Apply-all-safe dry-run
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";
import { db, pool } from "../server/db";
import { eq } from "drizzle-orm";
import * as schema from "../shared/schema";
import {
  computeCorrectContainerCost,
  costEquals,
  costRound,
  COST_SCALE,
  getRawStockRecalcPreview,
  getMixBatchSourceCostMismatchPreview,
  getFullAuditScan,
  computeApplyAllDryRun,
  computeRecalcFingerprint,
  loadRecalcFingerprintInputs,
} from "../server/services/factory/raw-stock-recalc";

const TEST_PREFIX = "recalcaudit";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let supplierId: number;

async function makeContainer(opts: {
  containerNumber: string;
  status?: string;
  ratePerKg?: string;
  ratePerKgUsd?: string;
  currencyCode?: string;
  fxRateToUsd?: string;
  fxRateConfirmed?: boolean;
  freight?: string;
  freightCurrencyCode?: string;
  otherCharges?: string;
  commissionAmount?: string;
  actualReceivedKg?: string;
  finalPayableAmount?: string;
  finalPayableAmountUsd?: string;
}) {
  const [container] = await db
    .insert(schema.factoryContainers)
    .values({
      companyId: ctx.companyId,
      containerNumber: opts.containerNumber,
      supplierId,
      currencyCode: opts.currencyCode ?? "USD",
      fxRateToUsd: opts.fxRateToUsd ?? "1",
      fxRateToUsdOffload: opts.fxRateToUsd ?? "1",
      fxRateConfirmed: opts.fxRateConfirmed ?? true,
      status: opts.status ?? "OFFLOADED",
      actualReceivedKg: opts.actualReceivedKg ?? "1000",
      ratePerKg: opts.ratePerKg ?? "3.000000",
      ratePerKgUsd: opts.ratePerKgUsd ?? opts.ratePerKg ?? "3.000000",
      freight: opts.freight ?? "0",
      freightCurrencyCode: opts.freightCurrencyCode ?? opts.currencyCode ?? "USD",
      otherCharges: opts.otherCharges ?? "0",
      commissionAmount: opts.commissionAmount ?? "0",
      dutyStatus: "NONE",
      dutyAmount: "0",
      finalPayableAmount:
        opts.finalPayableAmount ??
        String(parseFloat(opts.ratePerKg ?? "3") * parseFloat(opts.actualReceivedKg ?? "1000")),
      finalPayableAmountUsd:
        opts.finalPayableAmountUsd ??
        String(parseFloat(opts.ratePerKg ?? "3") * parseFloat(opts.actualReceivedKg ?? "1000")),
    })
    .returning();
  return container;
}

async function makeRawStock(opts: {
  containerId: number;
  receivedKg?: string;
  usedKg?: string;
  costPerKg?: string;
  costPerKgUsd?: string;
  deletedAt?: Date | null;
}) {
  const [rs] = await db
    .insert(schema.factoryRawStock)
    .values({
      companyId: ctx.companyId,
      containerId: opts.containerId,
      receivedKg: opts.receivedKg ?? "1000",
      usedKg: opts.usedKg ?? "0",
      costPerKg: opts.costPerKg ?? "3.000000",
      costPerKgUsd: opts.costPerKgUsd ?? "3.000000",
      deletedAt: opts.deletedAt ?? null,
    })
    .returning();
  return rs;
}

async function cleanupFactoryTables(companyId: number) {
  await pool.query(
    `DELETE FROM factory_mix_batch_sources WHERE mix_batch_id IN (SELECT id FROM factory_mix_batches WHERE company_id = $1)`,
    [companyId]
  );
  await pool.query(`DELETE FROM factory_bales WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM factory_mix_batches WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM factory_raw_stock WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM factory_container_other_charges WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM factory_offload_additional_charges WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM factory_container_commissions WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM factory_containers WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM factory_suppliers WHERE company_id = $1`, [companyId]);
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  await db.update(schema.companies).set({ companyType: "factory" }).where(eq(schema.companies.id, ctx.companyId));

  agent = request.agent(ctx.app);
  const loginRes = await agent
    .post("/api/auth/login")
    .send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  if (loginRes.status !== 200) throw new Error(`Login failed: ${loginRes.status}`);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

  const [supplier] = await db
    .insert(schema.factorySuppliers)
    .values({ companyId: ctx.companyId, name: `${TEST_PREFIX}_Supplier` })
    .returning();
  supplierId = supplier.id;
}, 30000);

afterAll(async () => {
  await cleanupFactoryTables(ctx.companyId);
  await cleanupTestData(ctx);
  await closeTestServer(ctx);
}, 30000);

beforeEach(async () => {
  // Clean factory data between tests so each test starts clean
  await pool.query(
    `DELETE FROM factory_mix_batch_sources WHERE mix_batch_id IN (SELECT id FROM factory_mix_batches WHERE company_id = $1)`,
    [ctx.companyId]
  );
  await pool.query(`DELETE FROM factory_bales WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_mix_batches WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_raw_stock WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_container_other_charges WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_offload_additional_charges WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_container_commissions WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_containers WHERE company_id = $1`, [ctx.companyId]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. costEquals helper — 6dp precision, no EPS tolerance
// ─────────────────────────────────────────────────────────────────────────────
describe("costEquals — 6dp precision helper", () => {
  it("treats values equal at 6dp as matching", () => {
    expect(costEquals("3.000000", "3.000000")).toBe(true);
    expect(costEquals("3.123456", 3.123456)).toBe(true);
    expect(costEquals(null, undefined)).toBe(true);
  });

  it("detects difference at the 6th decimal place", () => {
    expect(costEquals("3.000001", "3.000000")).toBe(false);
    expect(costEquals("3.000000", "3.0000001")).toBe(true); // 7th dp rounds away
  });

  it("costRound returns exactly 6dp string", () => {
    expect(costRound(3.1234567)).toBe("3.123457");
    expect(costRound(0)).toBe("0.000000");
    expect(costRound("2.5")).toBe("2.500000");
  });

  it("COST_SCALE is 6", () => {
    expect(COST_SCALE).toBe(6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. computeCorrectContainerCost — otherChargesRows parameter
// ─────────────────────────────────────────────────────────────────────────────
describe("computeCorrectContainerCost — otherChargesRows path", () => {
  it("uses otherChargesRows instead of container.otherCharges when rows are present", async () => {
    const container = await makeContainer({
      containerNumber: `${TEST_PREFIX}-OC1`,
      ratePerKg: "2.000000",
      actualReceivedKg: "1000",
    });
    const withAggregateOC = computeCorrectContainerCost({ ...container, otherCharges: "500" } as any, [], null, []);
    // 1000*2 + 500 = 2500, /1000 = 2.5
    expect(withAggregateOC.costPerKg).toBeCloseTo(2.5, COST_SCALE - 1);

    // With a detailed otherChargesRow of $300, the aggregate $500 is ignored
    const withDetailedOC = computeCorrectContainerCost({ ...container, otherCharges: "500" } as any, [], null, [
      {
        id: 1,
        companyId: ctx.companyId,
        containerId: container.id,
        description: "test",
        amount: "300",
        currencyCode: "USD",
        fxRateToUsd: "1",
        fxRateConfirmed: true,
        fxRateDate: null,
        ledgerAccountId: null,
        createdAt: new Date(),
      },
    ]);
    // 1000*2 + 300 = 2300, /1000 = 2.3
    expect(withDetailedOC.costPerKg).toBeCloseTo(2.3, COST_SCALE - 1);
  });

  it("rounds output to exactly 6dp", async () => {
    const container = await makeContainer({
      containerNumber: `${TEST_PREFIX}-OC2`,
      ratePerKg: "2.123456789",
      actualReceivedKg: "1000",
    });
    const result = computeCorrectContainerCost(container as any, [], null, []);
    expect(result.costPerKg.toString()).toMatch(/^\d+\.\d{1,6}$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. RecalcRow — new extended fields
// ─────────────────────────────────────────────────────────────────────────────
describe("getRawStockRecalcPreview — extended RecalcRow fields", () => {
  it("includes usedKg, remainingKg, fullyUsed, activeRawStockRowExists, rawStockDeleted", async () => {
    const container = await makeContainer({ containerNumber: `${TEST_PREFIX}-EXT1`, ratePerKg: "5.000000" });
    await makeRawStock({
      containerId: container.id,
      receivedKg: "1000",
      usedKg: "600",
      costPerKg: "3.000000",
      costPerKgUsd: "3.000000",
    });

    const rows = await getRawStockRecalcPreview(ctx.companyId);
    const row = rows.find((r) => r.containerId === container.id);
    expect(row).toBeDefined();
    expect(row!.usedKg).toBeCloseTo(600);
    expect(row!.remainingKg).toBeCloseTo(400);
    expect(row!.fullyUsed).toBe(false);
    expect(row!.activeRawStockRowExists).toBe(true);
    expect(row!.rawStockDeleted).toBe(false);
    expect(row!.containerStatus).toBe("OFFLOADED");
  });

  it("reports remaining kilograms exactly", async () => {
    const container = await makeContainer({ containerNumber: `${TEST_PREFIX}-EXACT1`, ratePerKg: "5.000000" });
    await makeRawStock({
      containerId: container.id,
      receivedKg: "0.3",
      usedKg: "0.1",
      costPerKg: "3.000000",
      costPerKgUsd: "3.000000",
    });

    const rows = await getRawStockRecalcPreview(ctx.companyId);
    const row = rows.find((r) => r.containerId === container.id);
    // The float difference was 0.19999999999999998.
    expect(row!.remainingKg).toBe(0.2);
  });

  it("marks fullyUsed=true when usedKg === receivedKg", async () => {
    const container = await makeContainer({ containerNumber: `${TEST_PREFIX}-FULL1`, ratePerKg: "5.000000" });
    await makeRawStock({
      containerId: container.id,
      receivedKg: "1000",
      usedKg: "1000",
      costPerKg: "3.000000",
      costPerKgUsd: "3.000000",
    });

    const rows = await getRawStockRecalcPreview(ctx.companyId);
    const row = rows.find((r) => r.containerId === container.id);
    expect(row).toBeDefined();
    expect(row!.fullyUsed).toBe(true);
    expect(row!.remainingKg).toBe(0);
  });

  it("detects rawStockDeleted when only a soft-deleted rs row exists", async () => {
    // A container can hold at most one raw-stock row: factory_raw_stock has a
    // unique index on (company_id, container_id). So "deleted receipt" means the
    // container's single row is soft-deleted, never a deleted row sitting beside
    // an active one — that state is unreachable, both in the schema and in the
    // app, which updates the existing row rather than inserting a second.
    //
    // A container with no active raw-stock only appears in the preview through
    // the historical path, which requires a mix-batch source link. This builds
    // exactly that, which is the only shape `rawStockDeleted` can actually have.
    const container = await makeContainer({ containerNumber: `${TEST_PREFIX}-DEL1`, ratePerKg: "4.000000" });
    await makeRawStock({
      containerId: container.id,
      receivedKg: "500",
      usedKg: "500",
      costPerKg: "3.000000",
      costPerKgUsd: "3.000000",
      deletedAt: new Date(),
    });

    const [batch] = await db
      .insert(schema.factoryMixBatches)
      .values({
        companyId: ctx.companyId,
        batchCode: `${TEST_PREFIX}-MB-DEL1`,
        totalWeightKg: "500.000",
        totalCost: "1500.000000",
        status: "ACTIVE",
        costPerKg: "3.000000",
      })
      .returning();

    await db.insert(schema.factoryMixBatchSources).values({
      mixBatchId: batch.id,
      containerId: container.id,
      weightKg: "500",
      costPerKg: "3.000000",
      totalCost: "1500.000000",
      supplierId: supplierId,
    });

    const rows = await getRawStockRecalcPreview(ctx.companyId);
    const row = rows.find((r) => r.containerId === container.id);
    expect(row, "container with a mix-batch source should appear via the historical path").toBeDefined();
    expect(row?.rawStockDeleted).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. changed detection uses costEquals (6dp), not EPS
// ─────────────────────────────────────────────────────────────────────────────
describe("changed flag — 6dp costEquals, no EPS tolerance", () => {
  it("detects a 0.0001 difference as changed (was masked by EPS=0.0005)", async () => {
    // Container ratePerKg=3 USD, no charges → correct costPerKg = 3.000000
    // Stored costPerKg = 3.000100 → difference = 0.0001, below old EPS=0.0005
    const container = await makeContainer({ containerNumber: `${TEST_PREFIX}-EPS1`, ratePerKg: "3.000000" });
    await makeRawStock({ containerId: container.id, costPerKg: "3.000100", costPerKgUsd: "3.000100" });

    const rows = await getRawStockRecalcPreview(ctx.companyId);
    const row = rows.find((r) => r.containerId === container.id);
    expect(row).toBeDefined();
    expect(row!.changed).toBe(true); // 0.0001 is a real mismatch at 6dp
  });

  it("does NOT flag a 0.0000001 difference (rounds away at 6dp)", async () => {
    const container = await makeContainer({ containerNumber: `${TEST_PREFIX}-EPS2`, ratePerKg: "3.000000" });
    await makeRawStock({ containerId: container.id, costPerKg: "3.0000001", costPerKgUsd: "3.0000001" });

    const rows = await getRawStockRecalcPreview(ctx.companyId);
    const row = rows.find((r) => r.containerId === container.id);
    expect(row).toBeDefined();
    expect(row!.changed).toBe(false); // 7th decimal rounds away — identical at 6dp
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Fingerprint includes otherChargesRows
// ─────────────────────────────────────────────────────────────────────────────
describe("computeRecalcFingerprint — includes otherChargesRows", () => {
  it("produces a different fingerprint when otherChargesRows changes", async () => {
    const container = await makeContainer({ containerNumber: `${TEST_PREFIX}-FP1`, ratePerKg: "2.000000" });
    await makeRawStock({ containerId: container.id });

    const inputs1 = await loadRecalcFingerprintInputs(ctx.companyId, container.id);
    const fp1 = computeRecalcFingerprint(inputs1!);

    // Add an otherChargesRow
    await db.insert(schema.factoryContainerOtherCharges).values({
      companyId: ctx.companyId,
      containerId: container.id,
      description: "Port fee",
      amount: "200",
      currencyCode: "USD",
      fxRateToUsd: "1",
      fxRateConfirmed: true,
    });

    const inputs2 = await loadRecalcFingerprintInputs(ctx.companyId, container.id);
    const fp2 = computeRecalcFingerprint(inputs2!);

    expect(fp1).not.toBe(fp2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. CLOSED container refuses without includeHistoricalContainers flag
// ─────────────────────────────────────────────────────────────────────────────
describe("CLOSED/COMPLETED container guard", () => {
  it("refuses CLOSED without includeHistoricalContainers", async () => {
    const container = await makeContainer({
      containerNumber: `${TEST_PREFIX}-HIST1`,
      status: "CLOSED",
      ratePerKg: "5.000000",
    });
    await makeRawStock({ containerId: container.id, costPerKg: "3.000000", costPerKgUsd: "3.000000" });

    const preview = await agent.post("/api/factory/raw-stock/recalc/apply").send({ containerIds: [container.id] });
    expect(preview.status).toBe(200);
    const token = preview.body.confirmationToken;

    const apply = await agent
      .post("/api/factory/raw-stock/recalc/apply")
      .send({ containerIds: [container.id], confirm: true, confirmationToken: token });
    expect(apply.status).toBe(200);
    expect(apply.body.results[0].applied).toBe(false);
    expect(apply.body.results[0].skippedReason).toMatch(/includeHistoricalContainers/);
  });

  it("applies a CLOSED container when includeHistoricalContainers=true", async () => {
    const container = await makeContainer({
      containerNumber: `${TEST_PREFIX}-HIST2`,
      status: "CLOSED",
      ratePerKg: "5.000000",
    });
    const rs = await makeRawStock({ containerId: container.id, costPerKg: "3.000000", costPerKgUsd: "3.000000" });

    const preview = await agent
      .post("/api/factory/raw-stock/recalc/apply")
      .send({ containerIds: [container.id], includeHistoricalContainers: true });
    expect(preview.status).toBe(200);
    const token = preview.body.confirmationToken;

    const apply = await agent.post("/api/factory/raw-stock/recalc/apply").send({
      containerIds: [container.id],
      confirm: true,
      confirmationToken: token,
      includeHistoricalContainers: true,
    });
    expect(apply.status).toBe(200);
    expect(apply.body.results[0].applied).toBe(true);

    const [updated] = await db.select().from(schema.factoryRawStock).where(eq(schema.factoryRawStock.id, rs.id));
    expect(parseFloat((updated as any).costPerKg)).toBeCloseTo(5.0, 4);
  });

  it("refuses when token was issued without includeHistoricalContainers but confirm sends with it", async () => {
    const container = await makeContainer({
      containerNumber: `${TEST_PREFIX}-HIST3`,
      status: "CLOSED",
      ratePerKg: "5.000000",
    });
    await makeRawStock({ containerId: container.id, costPerKg: "3.000000", costPerKgUsd: "3.000000" });

    const preview = await agent.post("/api/factory/raw-stock/recalc/apply").send({ containerIds: [container.id] }); // no historical flag
    expect(preview.status).toBe(200);
    const token = preview.body.confirmationToken;

    // Confirm with mismatched flag → INVALID_TOKEN
    const apply = await agent.post("/api/factory/raw-stock/recalc/apply").send({
      containerIds: [container.id],
      confirm: true,
      confirmationToken: token,
      includeHistoricalContainers: true, // mismatch!
    });
    expect(apply.status).toBe(400);
    expect(apply.body.code).toBe("INVALID_TOKEN");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. getMixBatchSourceCostMismatchPreview — catches nonzero mismatches
// ─────────────────────────────────────────────────────────────────────────────
describe("getMixBatchSourceCostMismatchPreview — full mismatch scan", () => {
  it("detects a nonzero-but-wrong source cost (not just zero)", async () => {
    const container = await makeContainer({ containerNumber: `${TEST_PREFIX}-SM1`, ratePerKg: "4.000000" });
    // Active raw-stock with correct cost
    await makeRawStock({ containerId: container.id, costPerKg: "4.000000", costPerKgUsd: "4.000000" });

    // Mix batch whose source has the WRONG cost (3.0 instead of 4.0)
    const [batch] = await db
      .insert(schema.factoryMixBatches)
      .values({
        companyId: ctx.companyId,
        totalWeightKg: "500.000",
        totalCost: "1500.000000",
        batchCode: `${TEST_PREFIX}-MB1`,
        status: "ACTIVE",
        costPerKg: "3.000000",
      })
      .returning();

    await db.insert(schema.factoryMixBatchSources).values({
      mixBatchId: batch.id,
      containerId: container.id,
      weightKg: "500",
      costPerKg: "3.000000", // wrong — should be 4.0
      totalCost: "1500.000000",
      supplierId: supplierId,
    });

    const mismatches = await getMixBatchSourceCostMismatchPreview(ctx.companyId);
    const row = mismatches.find((r) => r.containerId === container.id);
    expect(row).toBeDefined();
    expect(row!.oldCostPerKgUsd).toBeCloseTo(3.0, 4);
    expect(row!.newCostPerKgUsd).toBeCloseTo(4.0, 4);
    expect(row!.fixable).toBe(true);
  });

  it("does NOT surface rows where source cost exactly matches container corrected cost", async () => {
    const container = await makeContainer({ containerNumber: `${TEST_PREFIX}-SM2`, ratePerKg: "4.000000" });
    await makeRawStock({ containerId: container.id, costPerKg: "4.000000", costPerKgUsd: "4.000000" });

    const [batch] = await db
      .insert(schema.factoryMixBatches)
      .values({
        companyId: ctx.companyId,
        totalWeightKg: "500.000",
        totalCost: "2000.000000",
        batchCode: `${TEST_PREFIX}-MB2`,
        status: "ACTIVE",
        costPerKg: "4.000000",
      })
      .returning();

    await db.insert(schema.factoryMixBatchSources).values({
      mixBatchId: batch.id,
      containerId: container.id,
      weightKg: "500",
      costPerKg: "4.000000", // correct
      totalCost: "2000.000000",
      supplierId: supplierId,
    });

    const mismatches = await getMixBatchSourceCostMismatchPreview(ctx.companyId);
    const row = mismatches.find((r) => r.containerId === container.id);
    expect(row).toBeUndefined(); // no mismatch — should be hidden
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. applyZeroCostMixBatchSourcesFix uses costPerKgUsd (not costPerKg)
// ─────────────────────────────────────────────────────────────────────────────
describe("applyZeroCostMixBatchSourcesFix — uses costPerKgUsd", () => {
  it("applies costPerKgUsd from raw stock, not native costPerKg", async () => {
    // Simulate a case where costPerKg (native) ≠ costPerKgUsd
    const container = await makeContainer({
      containerNumber: `${TEST_PREFIX}-USD1`,
      ratePerKg: "3.000000",
      currencyCode: "AUD",
      fxRateToUsd: "0.65",
      fxRateConfirmed: true,
    });
    // native cost = 3 AUD, USD cost = 3 * 0.65 = 1.95
    await makeRawStock({ containerId: container.id, costPerKg: "3.000000", costPerKgUsd: "1.950000" });

    const [batch] = await db
      .insert(schema.factoryMixBatches)
      .values({
        companyId: ctx.companyId,
        totalWeightKg: "500.000",
        totalCost: "0.000000",
        batchCode: `${TEST_PREFIX}-MB-USD1`,
        status: "ACTIVE",
        costPerKg: "0.000000",
      })
      .returning();

    const [src] = await db
      .insert(schema.factoryMixBatchSources)
      .values({
        mixBatchId: batch.id,
        containerId: container.id,
        weightKg: "500",
        costPerKg: "0.000000",
        totalCost: "0.000000",
        supplierId: supplierId,
      })
      .returning();

    // Apply zero-cost fix
    const dryRun = await agent
      .post("/api/factory/raw-stock/recalc/zero-cost-sources/apply")
      .send({ sourceIds: [src.id] });
    expect(dryRun.status).toBe(200);
    const token = dryRun.body.confirmationToken;

    const apply = await agent.post("/api/factory/raw-stock/recalc/zero-cost-sources/apply").send({
      sourceIds: [src.id],
      confirm: true,
      confirmationToken: token,
    });
    expect(apply.status).toBe(200);
    expect(apply.body.results[0].applied).toBe(true);

    // The applied rate should be the USD rate (1.95), not the native (3.0)
    const [updatedSrc] = await db
      .select()
      .from(schema.factoryMixBatchSources)
      .where(eq(schema.factoryMixBatchSources.id, src.id));
    expect(parseFloat(updatedSrc.costPerKg)).toBeCloseTo(1.95, 4); // USD cost
    expect(parseFloat(updatedSrc.totalCost)).toBeCloseTo(1.95 * 500, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. getFullAuditScan endpoint
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /api/factory/raw-stock/recalc/full-audit", () => {
  it("returns 403 for non-admin", async () => {
    // Create a viewer
    const bcrypt = await import("bcryptjs");
    const hash = await bcrypt.hash("testpassword123", 10);
    const [user] = await db
      .insert(schema.users)
      .values({ username: `${TEST_PREFIX}_viewer_audit`, password: hash })
      .returning();
    await db.insert(schema.userCompanyRoles).values({ userId: user.id, companyId: ctx.companyId, role: "Viewer" });

    const viewerAgent = request.agent(ctx.app);
    await viewerAgent
      .post("/api/auth/login")
      .send({ username: `${TEST_PREFIX}_viewer_audit`, password: "testpassword123" });
    await viewerAgent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

    const res = await viewerAgent.get("/api/factory/raw-stock/recalc/full-audit");
    expect(res.status).toBe(403);
  });

  it("returns summary + rows for admin", async () => {
    const container = await makeContainer({ containerNumber: `${TEST_PREFIX}-AUD1`, ratePerKg: "5.000000" });
    await makeRawStock({ containerId: container.id, costPerKg: "3.000000", costPerKgUsd: "3.000000" });

    const res = await agent.get("/api/factory/raw-stock/recalc/full-audit");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("summary");
    expect(res.body).toHaveProperty("rows");
    expect(res.body.summary).toHaveProperty("totalContainersScanned");
    expect(res.body.summary.safeRepairsAvailable).toBeGreaterThanOrEqual(1);
    const row = res.body.rows.find((r: any) => r.containerId === container.id);
    expect(row).toBeDefined();
    expect(row.safeToRepair).toBe(true);
    expect(row.codes).toContain("CONTAINER_COST_MISMATCH");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. source-cost-mismatches endpoint
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /api/factory/raw-stock/recalc/source-cost-mismatches", () => {
  it("returns all source mismatches (not just zero)", async () => {
    const container = await makeContainer({ containerNumber: `${TEST_PREFIX}-SCM1`, ratePerKg: "6.000000" });
    await makeRawStock({ containerId: container.id, costPerKg: "6.000000", costPerKgUsd: "6.000000" });

    const [batch] = await db
      .insert(schema.factoryMixBatches)
      .values({
        companyId: ctx.companyId,
        totalWeightKg: "800.000",
        totalCost: "4000.000000",
        batchCode: `${TEST_PREFIX}-MB-SCM1`,
        status: "ACTIVE",
        costPerKg: "5.000000",
      })
      .returning();

    await db.insert(schema.factoryMixBatchSources).values({
      mixBatchId: batch.id,
      containerId: container.id,
      weightKg: "800",
      costPerKg: "5.000000", // wrong, should be 6
      totalCost: "4000.000000",
      supplierId: supplierId,
    });

    const res = await agent.get("/api/factory/raw-stock/recalc/source-cost-mismatches");
    expect(res.status).toBe(200);
    const row = res.body.find((r: any) => r.containerId === container.id);
    expect(row).toBeDefined();
    expect(row.oldCostPerKgUsd).toBeCloseTo(5.0, 4);
    expect(row.newCostPerKgUsd).toBeCloseTo(6.0, 4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. getFullAuditScan — safeToRepair logic
// ─────────────────────────────────────────────────────────────────────────────
describe("getFullAuditScan — safeToRepair logic", () => {
  it("marks FX-unresolved containers as NOT safeToRepair", async () => {
    // Container in EUR with no confirmed FX rate
    const container = await makeContainer({
      containerNumber: `${TEST_PREFIX}-FX1`,
      currencyCode: "EUR",
      fxRateToUsd: "1",
      fxRateConfirmed: false, // unresolved
      ratePerKg: "3.000000",
    });
    await makeRawStock({ containerId: container.id });

    const audit = await getFullAuditScan(ctx.companyId);
    const row = audit.rows.find((r) => r.containerId === container.id);
    expect(row).toBeDefined();
    expect(row!.fxUnresolved).toBe(true);
    expect(row!.safeToRepair).toBe(false);
    expect(row!.codes).toContain("UNRESOLVED_FX");
  });

  it("marks fully-correct containers as CORRECT", async () => {
    const container = await makeContainer({
      containerNumber: `${TEST_PREFIX}-CORRECT1`,
      ratePerKg: "3.000000",
      finalPayableAmount: "3000",
      finalPayableAmountUsd: "3000",
    });
    await makeRawStock({ containerId: container.id, costPerKg: "3.000000", costPerKgUsd: "3.000000" });

    const audit = await getFullAuditScan(ctx.companyId);
    const row = audit.rows.find((r) => r.containerId === container.id);
    expect(row).toBeDefined();
    expect(row!.codes).toContain("CORRECT");
    expect(row!.safeToRepair).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. computeApplyAllDryRun — dry-run estimate
// ─────────────────────────────────────────────────────────────────────────────
describe("computeApplyAllDryRun", () => {
  it("returns correct counts for safe repairs", async () => {
    const container = await makeContainer({ containerNumber: `${TEST_PREFIX}-DRYRUN1`, ratePerKg: "7.000000" });
    await makeRawStock({ containerId: container.id, costPerKg: "3.000000", costPerKgUsd: "3.000000" });

    const dryRun = await computeApplyAllDryRun(ctx.companyId);
    expect(dryRun.containersToUpdate).toBeGreaterThanOrEqual(1);
    expect(dryRun.safeContainerIds).toContain(container.id);
    expect(dryRun.rawStockRowsToUpdate).toBeGreaterThanOrEqual(1);
  });

  it("excludes CLOSED containers when includeHistoricalContainers=false", async () => {
    const container = await makeContainer({
      containerNumber: `${TEST_PREFIX}-DRYRUN2`,
      status: "CLOSED",
      ratePerKg: "7.000000",
    });
    await makeRawStock({ containerId: container.id, costPerKg: "3.000000", costPerKgUsd: "3.000000" });

    const dryRunWithout = await computeApplyAllDryRun(ctx.companyId, { includeHistoricalContainers: false });
    expect(dryRunWithout.safeContainerIds).not.toContain(container.id);

    const dryRunWith = await computeApplyAllDryRun(ctx.companyId, { includeHistoricalContainers: true });
    expect(dryRunWith.safeContainerIds).toContain(container.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. getAffectedMixBatchesPreview — uses USD cost + Decimal.js
// ─────────────────────────────────────────────────────────────────────────────
describe("getAffectedMixBatchesPreview — USD cost + new fields", () => {
  it("computes newCostPerKg using costPerKgUsd, not native costPerKg", async () => {
    // AUD container — native=3, USD=1.95. A batch drawing 500kg from it.
    const container = await makeContainer({
      containerNumber: `${TEST_PREFIX}-BPREV1`,
      ratePerKg: "3.000000",
      currencyCode: "AUD",
      fxRateToUsd: "0.65",
      fxRateConfirmed: true,
      actualReceivedKg: "1000",
    });
    await makeRawStock({ containerId: container.id, costPerKg: "2.000000", costPerKgUsd: "1.300000" });

    const [batch] = await db
      .insert(schema.factoryMixBatches)
      .values({
        companyId: ctx.companyId,
        totalWeightKg: "500.000",
        totalCost: "650.000000",
        batchCode: `${TEST_PREFIX}-MB-BP1`,
        status: "ACTIVE",
        costPerKg: "1.300000",
      })
      .returning();

    await db.insert(schema.factoryMixBatchSources).values({
      mixBatchId: batch.id,
      containerId: container.id,
      weightKg: "500",
      costPerKg: "1.300000",
      totalCost: "650.000000",
      supplierId: supplierId,
    });

    const res = await agent
      .post("/api/factory/raw-stock/recalc/mix-batches-preview")
      .send({ containerIds: [container.id] });
    expect(res.status).toBe(200);
    const b = res.body.find((r: any) => r.batchId === batch.id);
    // corrected USD cost = 3 * 0.65 = 1.95, old = 1.3, so newCostPerKg = 1.95
    expect(b).toBeDefined();
    expect(b.newCostPerKg).toBeCloseTo(1.95, 4);
    // New fields
    expect(b).toHaveProperty("weightKgFromSelectedContainers");
    expect(b).toHaveProperty("costDifferencePerKg");
    expect(b).toHaveProperty("totalCostDifference");
    expect(b).toHaveProperty("sourceChanges");
    expect(b.batchDate !== undefined).toBe(true);
  });
});
