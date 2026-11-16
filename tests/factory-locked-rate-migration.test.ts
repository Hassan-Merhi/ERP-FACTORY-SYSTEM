/**
 * Migration tests for factorySuppliers.currentRawMaterialCostPerKgUsd.
 *
 * The column is defined by the schema migrations (migrations/); these tests
 * exercise the exact data backfill (FACTORY_SUPPLIER_LOCKED_RATE_BACKFILL_SQL in
 * server/services/factory/rawStockLockedRate.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool, db } from "../server/db";
import * as schema from "../shared/schema";
import { eq } from "drizzle-orm";
import { FACTORY_SUPPLIER_LOCKED_RATE_BACKFILL_SQL } from "../server/services/factory/rawStockLockedRate";

const TEST_PREFIX = "migtest_lockrate";

let companyId: number;

async function cleanup() {
  await pool.query(
    `DELETE FROM factory_raw_stock WHERE container_id IN (SELECT id FROM factory_containers WHERE container_number LIKE $1)`,
    [`${TEST_PREFIX}%`]
  );
  await pool.query(`DELETE FROM factory_containers WHERE container_number LIKE $1`, [`${TEST_PREFIX}%`]);
  await pool.query(`DELETE FROM factory_suppliers WHERE name LIKE $1`, [`${TEST_PREFIX}%`]);
  await pool.query(`DELETE FROM companies WHERE name LIKE $1`, [`${TEST_PREFIX}%`]);
}

beforeAll(async () => {
  await cleanup();
  const [company] = await db
    .insert(schema.companies)
    .values({ code: "MIGLR01", name: `${TEST_PREFIX}_company`, baseCurrency: "USD" })
    .returning();
  companyId = company.id;
}, 30000);

afterAll(async () => {
  await cleanup();
}, 30000);

describe("Migration: factory_suppliers.current_raw_material_cost_per_kg_usd", () => {
  it("column exists with the correct type (nullable NUMERIC(20,8))", async () => {
    // The schema migrations define the column: assert it is present and correctly typed.

    const { rows } = await pool.query(
      `SELECT column_name, data_type, numeric_precision, numeric_scale, is_nullable
       FROM information_schema.columns
       WHERE table_name = 'factory_suppliers' AND column_name = 'current_raw_material_cost_per_kg_usd'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("numeric");
    expect(rows[0].numeric_precision).toBe(20);
    expect(rows[0].numeric_scale).toBe(8);
    expect(rows[0].is_nullable).toBe("YES");
  });

  it("backfills a supplier with two 10,000 kg receipts at $0.20 and $0.36 to exactly $0.28", async () => {
    const [supplier] = await db
      .insert(schema.factorySuppliers)
      .values({ companyId, name: `${TEST_PREFIX}_SupplierA` })
      .returning();

    const [container] = await db
      .insert(schema.factoryContainers)
      .values({
        companyId,
        containerNumber: `${TEST_PREFIX}-C1`,
        supplierId: supplier.id,
        status: "OFFLOADED",
        currencyCode: "USD",
        fxRateToUsd: "1",
      })
      .returning();

    await db
      .insert(schema.factoryRawStock)
      .values([{ companyId, containerId: container.id, receivedKg: "10000", costPerKg: "0.20", costPerKgUsd: "0.20" }]);

    const [container2] = await db
      .insert(schema.factoryContainers)
      .values({
        companyId,
        containerNumber: `${TEST_PREFIX}-C2`,
        supplierId: supplier.id,
        status: "OFFLOADED",
        currencyCode: "USD",
        fxRateToUsd: "1",
      })
      .returning();
    await db
      .insert(schema.factoryRawStock)
      .values([
        { companyId, containerId: container2.id, receivedKg: "10000", costPerKg: "0.36", costPerKgUsd: "0.36" },
      ]);

    // Confirm the row starts NULL (never established) before running the backfill.
    const [before] = await db
      .select({ rate: schema.factorySuppliers.currentRawMaterialCostPerKgUsd })
      .from(schema.factorySuppliers)
      .where(eq(schema.factorySuppliers.id, supplier.id));
    expect(before.rate).toBeNull();

    await pool.query(FACTORY_SUPPLIER_LOCKED_RATE_BACKFILL_SQL);

    const [after] = await db
      .select({ rate: schema.factorySuppliers.currentRawMaterialCostPerKgUsd })
      .from(schema.factorySuppliers)
      .where(eq(schema.factorySuppliers.id, supplier.id));
    expect(parseFloat(after.rate as unknown as string)).toBeCloseTo(0.28, 8);
  });

  it("excludes soft-deleted raw-stock rows, DELETED containers, and non-positive received kg from the backfill", async () => {
    const [supplier] = await db
      .insert(schema.factorySuppliers)
      .values({ companyId, name: `${TEST_PREFIX}_SupplierB` })
      .returning();

    // A legitimate receipt at $0.50/kg.
    const [goodContainer] = await db
      .insert(schema.factoryContainers)
      .values({
        companyId,
        containerNumber: `${TEST_PREFIX}-GOOD`,
        supplierId: supplier.id,
        status: "OFFLOADED",
        currencyCode: "USD",
        fxRateToUsd: "1",
      })
      .returning();
    await db.insert(schema.factoryRawStock).values({
      companyId,
      containerId: goodContainer.id,
      receivedKg: "1000",
      costPerKg: "0.50",
      costPerKgUsd: "0.50",
    });

    // A soft-deleted raw-stock row at a wildly different rate — must be excluded.
    const [deletedRowContainer] = await db
      .insert(schema.factoryContainers)
      .values({
        companyId,
        containerNumber: `${TEST_PREFIX}-DELROW`,
        supplierId: supplier.id,
        status: "OFFLOADED",
        currencyCode: "USD",
        fxRateToUsd: "1",
      })
      .returning();
    await db.insert(schema.factoryRawStock).values({
      companyId,
      containerId: deletedRowContainer.id,
      receivedKg: "5000",
      costPerKg: "9.99",
      costPerKgUsd: "9.99",
      deletedAt: new Date(),
    });

    // A container with status DELETED — must be excluded even though the raw-stock
    // row itself isn't soft-deleted.
    const [deletedContainer] = await db
      .insert(schema.factoryContainers)
      .values({
        companyId,
        containerNumber: `${TEST_PREFIX}-DELCONT`,
        supplierId: supplier.id,
        status: "DELETED",
        currencyCode: "USD",
        fxRateToUsd: "1",
      })
      .returning();
    await db.insert(schema.factoryRawStock).values({
      companyId,
      containerId: deletedContainer.id,
      receivedKg: "5000",
      costPerKg: "7.77",
      costPerKgUsd: "7.77",
    });

    // A zero-kg row — must be excluded (positive received kg required).
    const [zeroKgContainer] = await db
      .insert(schema.factoryContainers)
      .values({
        companyId,
        containerNumber: `${TEST_PREFIX}-ZEROKG`,
        supplierId: supplier.id,
        status: "OFFLOADED",
        currencyCode: "USD",
        fxRateToUsd: "1",
      })
      .returning();
    await db.insert(schema.factoryRawStock).values({
      companyId,
      containerId: zeroKgContainer.id,
      receivedKg: "0",
      costPerKg: "5.55",
      costPerKgUsd: "5.55",
    });

    await pool.query(FACTORY_SUPPLIER_LOCKED_RATE_BACKFILL_SQL);

    const [after] = await db
      .select({ rate: schema.factorySuppliers.currentRawMaterialCostPerKgUsd })
      .from(schema.factorySuppliers)
      .where(eq(schema.factorySuppliers.id, supplier.id));
    expect(parseFloat(after.rate as unknown as string)).toBeCloseTo(0.5, 8);
  });

  it("never overwrites an existing non-NULL locked rate", async () => {
    const [supplier] = await db
      .insert(schema.factorySuppliers)
      .values({
        companyId,
        name: `${TEST_PREFIX}_SupplierC`,
        currentRawMaterialCostPerKgUsd: "1.2345",
      })
      .returning();

    const [container] = await db
      .insert(schema.factoryContainers)
      .values({
        companyId,
        containerNumber: `${TEST_PREFIX}-C3`,
        supplierId: supplier.id,
        status: "OFFLOADED",
        currencyCode: "USD",
        fxRateToUsd: "1",
      })
      .returning();
    // Historical receipts at a completely different rate — if the backfill ever
    // overwrote a non-NULL rate, this would flip the value to 9.99.
    await db.insert(schema.factoryRawStock).values({
      companyId,
      containerId: container.id,
      receivedKg: "1000",
      costPerKg: "9.99",
      costPerKgUsd: "9.99",
    });

    await pool.query(FACTORY_SUPPLIER_LOCKED_RATE_BACKFILL_SQL);

    const [after] = await db
      .select({ rate: schema.factorySuppliers.currentRawMaterialCostPerKgUsd })
      .from(schema.factorySuppliers)
      .where(eq(schema.factorySuppliers.id, supplier.id));
    expect(parseFloat(after.rate as unknown as string)).toBeCloseTo(1.2345, 8);
  });

  it("leaves a supplier with zero valid historical raw-stock rows as NULL", async () => {
    const [supplier] = await db
      .insert(schema.factorySuppliers)
      .values({ companyId, name: `${TEST_PREFIX}_SupplierD` })
      .returning();

    await pool.query(FACTORY_SUPPLIER_LOCKED_RATE_BACKFILL_SQL);

    const [after] = await db
      .select({ rate: schema.factorySuppliers.currentRawMaterialCostPerKgUsd })
      .from(schema.factorySuppliers)
      .where(eq(schema.factorySuppliers.id, supplier.id));
    expect(after.rate).toBeNull();
  });

  it("running the column-add and backfill SQL repeatedly is safe (idempotent)", async () => {
    const [supplier] = await db
      .insert(schema.factorySuppliers)
      .values({ companyId, name: `${TEST_PREFIX}_SupplierE` })
      .returning();
    const [container] = await db
      .insert(schema.factoryContainers)
      .values({
        companyId,
        containerNumber: `${TEST_PREFIX}-C5`,
        supplierId: supplier.id,
        status: "OFFLOADED",
        currencyCode: "USD",
        fxRateToUsd: "1",
      })
      .returning();
    await db.insert(schema.factoryRawStock).values({
      companyId,
      containerId: container.id,
      receivedKg: "2000",
      costPerKg: "0.33",
      costPerKgUsd: "0.33",
    });

    await pool.query(FACTORY_SUPPLIER_LOCKED_RATE_BACKFILL_SQL);
    const [firstRun] = await db
      .select({ rate: schema.factorySuppliers.currentRawMaterialCostPerKgUsd })
      .from(schema.factorySuppliers)
      .where(eq(schema.factorySuppliers.id, supplier.id));
    expect(parseFloat(firstRun.rate as unknown as string)).toBeCloseTo(0.33, 8);

    // Re-running the backfill must not throw and must not change the value.
    await expect(pool.query(FACTORY_SUPPLIER_LOCKED_RATE_BACKFILL_SQL)).resolves.toBeDefined();

    const [secondRun] = await db
      .select({ rate: schema.factorySuppliers.currentRawMaterialCostPerKgUsd })
      .from(schema.factorySuppliers)
      .where(eq(schema.factorySuppliers.id, supplier.id));
    expect(parseFloat(secondRun.rate as unknown as string)).toBeCloseTo(0.33, 8);
  });

  it("GET /api/factory/raw-stock never returns a $0 rate merely because the backfill was skipped for this row", async () => {
    // Simulate a supplier the one-time migrations_log-gated backfill never reached
    // (e.g. created between the migration's one run and now) — still NULL in the
    // column. The live read path (getLockedSupplierRateReadOnly / getLockedSupplierRate)
    // must derive the same non-zero stable rate from history instead of surfacing 0.
    const { seedTestData, cleanupTestData, closeTestServer } = await import("./setup");
    const request = (await import("supertest")).default;
    const { eq: eqOp } = await import("drizzle-orm");

    const prefix = "migtest_lockrate_api";
    const ctx = await seedTestData(prefix);
    try {
      await db.update(schema.companies).set({ companyType: "factory" }).where(eqOp(schema.companies.id, ctx.companyId));
      const agent = request.agent(ctx.app);
      const loginRes = await agent
        .post("/api/auth/login")
        .send({ username: `${prefix}_testuser`, password: "testpassword123" });
      expect(loginRes.status).toBe(200);
      await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

      const [supplier] = await db
        .insert(schema.factorySuppliers)
        .values({ companyId: ctx.companyId, name: `${prefix}_Supplier` })
        .returning();
      const [container] = await db
        .insert(schema.factoryContainers)
        .values({
          companyId: ctx.companyId,
          containerNumber: `${prefix}-C1`,
          supplierId: supplier.id,
          status: "OFFLOADED",
          currencyCode: "USD",
          fxRateToUsd: "1",
        })
        .returning();
      await db.insert(schema.factoryRawStock).values({
        companyId: ctx.companyId,
        containerId: container.id,
        receivedKg: "4000",
        costPerKg: "0.45",
        costPerKgUsd: "0.45",
      });
      // currentRawMaterialCostPerKgUsd left NULL on purpose — never backfilled for this row.

      const res = await agent.get("/api/factory/raw-stock");
      expect(res.status).toBe(200);
      const row = (res.body as any[]).find((r) => r.supplierName === `${prefix}_Supplier`);
      expect(row).toBeTruthy();
      expect(parseFloat(row.costPerKgUsd)).toBeCloseTo(0.45, 4);
      expect(parseFloat(row.costPerKgUsd)).not.toBe(0);
    } finally {
      await pool.query(
        `DELETE FROM factory_raw_stock WHERE container_id IN (SELECT id FROM factory_containers WHERE container_number LIKE $1)`,
        [`${prefix}%`]
      );
      await pool.query(`DELETE FROM factory_containers WHERE container_number LIKE $1`, [`${prefix}%`]);
      await pool.query(`DELETE FROM factory_suppliers WHERE name LIKE $1`, [`${prefix}%`]);
      await cleanupTestData(prefix);
      closeTestServer();
    }
  }, 30000);
});
