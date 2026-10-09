import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { KNOWN_SECURITY_PERMISSIONS } from "../server/services/security/namedPermissionService";
import { cleanupTestData, closeTestServer, setupTestApp } from "./setup";

const TEST_PREFIX = "retailw2sc";
const describeWithDatabase = process.env.DATABASE_URL ? describe : describe.skip;

let app: Awaited<ReturnType<typeof setupTestApp>>;
let cashier: request.SuperAgentTest;
let manager: request.SuperAgentTest;
let companyId = 0;
let locationId = 0;
let variantAId = 0;
let variantBId = 0;
let variantCId = 0;
let cashierId = "";
let managerId = "";

const CASHIER_PASSWORD = "stockcount-cashier-123";
const MANAGER_PASSWORD = "stockcount-manager-123";

async function purgeFixture(): Promise<void> {
  const companies = await db
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .where(sql`${schema.companies.name} LIKE ${`%${TEST_PREFIX}%`}`);
  for (const company of companies) {
    const params = [company.id];
    await pool.query("DELETE FROM retail_stock_count_events WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_stock_count_lines WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_stock_count_sessions WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_pos_return_items WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_pos_returns WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_pos_sale_items WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_pos_sales WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_stock_movements WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_stock_operations WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_variant_inventory WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_product_variants WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_products WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_brands WHERE company_id = $1", params);
  }
}

async function login(username: string, password: string): Promise<request.SuperAgentTest> {
  const agent = request.agent(app);
  const response = await agent.post("/api/auth/login").send({ username, password });
  expect(response.status).toBe(200);
  const companySwitch = await agent.post("/api/auth/set-company").send({ companyId });
  expect(companySwitch.status).toBe(200);
  return agent;
}

async function quantityOf(variantId: number): Promise<number> {
  const [row] = await db
    .select({ quantity: schema.retailVariantInventory.quantity })
    .from(schema.retailVariantInventory)
    .where(
      and(
        eq(schema.retailVariantInventory.companyId, companyId),
        eq(schema.retailVariantInventory.variantId, variantId),
        eq(schema.retailVariantInventory.locationId, locationId)
      )
    )
    .limit(1);
  return Number(row?.quantity ?? 0);
}

async function stockCountMovements(sessionId: number) {
  return db
    .select({
      id: schema.retailStockMovements.id,
      variantId: schema.retailStockMovements.variantId,
      movementType: schema.retailStockMovements.movementType,
      delta: schema.retailStockMovements.quantityDelta,
      before: schema.retailStockMovements.quantityBefore,
      after: schema.retailStockMovements.quantityAfter,
      referenceType: schema.retailStockMovements.referenceType,
      referenceId: schema.retailStockMovements.referenceId,
      eventKey: schema.retailStockMovements.eventKey,
      metadata: schema.retailStockMovements.metadata,
    })
    .from(schema.retailStockMovements)
    .where(
      and(
        eq(schema.retailStockMovements.companyId, companyId),
        eq(schema.retailStockMovements.referenceType, "retail_stock_count"),
        eq(schema.retailStockMovements.referenceId, String(sessionId))
      )
    );
}

describeWithDatabase("Retail Wave 2 — physical stock count sessions", () => {
  beforeAll(async () => {
    app = await setupTestApp();
    await purgeFixture();
    await cleanupTestData(TEST_PREFIX);

    const bcrypt = await import("bcryptjs");
    const [cashierRow] = await db
      .insert(schema.users)
      .values({ username: `${TEST_PREFIX}_cashier`, password: await bcrypt.hash(CASHIER_PASSWORD, 10) })
      .returning({ id: schema.users.id });
    const [managerRow] = await db
      .insert(schema.users)
      .values({ username: `${TEST_PREFIX}_manager`, password: await bcrypt.hash(MANAGER_PASSWORD, 10) })
      .returning({ id: schema.users.id });
    cashierId = cashierRow.id;
    managerId = managerRow.id;

    const [company] = await db
      .insert(schema.companies)
      .values({ code: "RW2SC", name: `${TEST_PREFIX}_Company`, companyType: "retail", baseCurrency: "USD" })
      .returning({ id: schema.companies.id });
    companyId = company.id;

    for (const [userId, role] of [
      [cashierId, "POS"],
      [managerId, "Manager"],
    ] as const) {
      await db.insert(schema.userCompanyRoles).values({ userId, companyId, role });
      await db
        .insert(schema.userSecurityPermissions)
        .values(KNOWN_SECURITY_PERMISSIONS.map((permission) => ({ userId, companyId, permission, grantedBy: userId })));
    }

    const [location] = await db
      .insert(schema.locations)
      .values({ companyId, code: "RW2SC-MAIN", name: "Wave 2 Count Main" })
      .returning({ id: schema.locations.id });
    locationId = location.id;
    for (const userId of [cashierId, managerId]) {
      await db
        .update(schema.userCompanyRoles)
        .set({ assignedLocationId: locationId })
        .where(and(eq(schema.userCompanyRoles.userId, userId), eq(schema.userCompanyRoles.companyId, companyId)));
      await db.insert(schema.userLocations).values({ userId, companyId, locationId });
    }

    const [brand] = await db
      .insert(schema.retailBrands)
      .values({ companyId, name: "Count Brand", normalizedName: "count brand" })
      .returning({ id: schema.retailBrands.id });

    const [product] = await db
      .insert(schema.retailProducts)
      .values({ companyId, code: "RW2SC-TEE", name: "Wave 2 Count Tee", brandId: brand.id })
      .returning({ id: schema.retailProducts.id });

    const variants = await db
      .insert(schema.retailProductVariants)
      .values([
        {
          companyId,
          productId: product.id,
          color: "Black",
          size: "M",
          barcode: "RW2SC-A",
          sku: "RW2SC-A-M",
          cost: "10.000000",
          sellingPrice: "20.000000",
        },
        {
          companyId,
          productId: product.id,
          color: "Blue",
          size: "L",
          barcode: "RW2SC-B",
          sku: "RW2SC-B-L",
          cost: "12.000000",
          sellingPrice: "24.000000",
        },
        {
          companyId,
          productId: product.id,
          color: "Red",
          size: "S",
          barcode: "RW2SC-C",
          sku: "RW2SC-C-S",
          cost: "8.000000",
          sellingPrice: "16.000000",
        },
      ])
      .returning({ id: schema.retailProductVariants.id });
    variantAId = variants[0].id;
    variantBId = variants[1].id;
    variantCId = variants[2].id;

    // variantA is tracked at the location; variantB has no stock row there (surprise item).
    await db.insert(schema.retailVariantInventory).values([
      { companyId, variantId: variantAId, locationId, quantity: "10.000000", averageCost: "10.000000" },
      { companyId, variantId: variantCId, locationId, quantity: "4.000000", averageCost: "8.000000" },
    ]);

    cashier = await login(`${TEST_PREFIX}_cashier`, CASHIER_PASSWORD);
    manager = await login(`${TEST_PREFIX}_manager`, MANAGER_PASSWORD);
  }, 60_000);

  afterAll(async () => {
    await purgeFixture();
    await cleanupTestData(TEST_PREFIX);
    closeTestServer();
  }, 30_000);

  it("snapshots expected quantities, counts by barcode and flags unexpected items", async () => {
    const session = await cashier.post("/api/pos/retail/stock-counts").send({ locationId });
    expect(session.status).toBe(201);
    expect(session.body.status).toBe("counting");
    expect(session.body.code).toMatch(/^SC-\d{6}$/);
    expect(session.body.snapshotAt).toBeTruthy();

    const lineA = session.body.lines.find((line: { variantId: number }) => line.variantId === variantAId);
    expect(lineA).toMatchObject({ expectedQuantity: 10, countedQuantity: null, status: "uncounted" });
    expect(session.body.lines.some((line: { variantId: number }) => line.variantId === variantBId)).toBe(false);
    const lineC = session.body.lines.find((line: { variantId: number }) => line.variantId === variantCId);
    expect(lineC.expectedQuantity).toBe(4);

    const scan = await cashier
      .post(`/api/pos/retail/stock-counts/${session.body.id}/scan`)
      .send({ barcode: "RW2SC-A" });
    expect(scan.status).toBe(200);
    expect(scan.body).toMatchObject({ countedQuantity: 1, status: "variance" });

    const second = await cashier
      .post(`/api/pos/retail/stock-counts/${session.body.id}/scan`)
      .send({ barcode: "RW2SC-A" });
    expect(second.body.countedQuantity).toBe(2);

    // A catalogue variant without a stock row at the location is an unexpected finding.
    const surprise = await cashier
      .post(`/api/pos/retail/stock-counts/${session.body.id}/scan`)
      .send({ barcode: "RW2SC-B" });
    expect(surprise.status).toBe(200);
    expect(surprise.body).toMatchObject({ status: "unexpected", unexpected: true });

    const manual = await cashier
      .patch(`/api/pos/retail/stock-counts/${session.body.id}/lines/${lineA.id}`)
      .send({ countedQuantity: 9, notes: "Found one damaged" });
    expect(manual.status).toBe(200);
    expect(manual.body).toMatchObject({ countedQuantity: 9, status: "variance" });

    const detail = await cashier.get(`/api/pos/retail/stock-counts/${session.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      status: "counting",
      lineCount: 3,
      countedLineCount: 2,
      uncountedLineCount: 1,
      varianceLineCount: 1,
      unexpectedLineCount: 1,
      expectedQuantityTotal: 14,
      countedQuantityTotal: 10,
    });
    const surpriseLine = detail.body.lines.find((line: { variantId: number }) => line.variantId === variantBId);
    expect(surpriseLine).toMatchObject({ expectedQuantity: 0, countedQuantity: 1, difference: 1 });

    // Cashiers may not finalize; the count has to be reviewed/recounted and signed off.
    const forbidden = await cashier.post(`/api/pos/retail/stock-counts/${session.body.id}/finalize`).send({});
    expect(forbidden.status).toBe(403);

    const uncountedGuard = await manager
      .post(`/api/pos/retail/stock-counts/${session.body.id}/finalize`)
      .send({ confirmVariance: true });
    expect(uncountedGuard.status).toBe(409);
    expect(uncountedGuard.body.code).toBe("STOCK_COUNT_UNCOUNTED_LINES");

    const guard = await manager
      .post(`/api/pos/retail/stock-counts/${session.body.id}/finalize`)
      .send({ allowUncounted: true });
    expect(guard.status).toBe(409);
    expect(guard.body.code).toBe("STOCK_COUNT_VARIANCE_UNCONFIRMED");

    const finalize = await manager
      .post(`/api/pos/retail/stock-counts/${session.body.id}/finalize`)
      .send({ confirmVariance: true, allowUncounted: true });
    expect(finalize.status).toBe(201);
    expect(finalize.body).toMatchObject({
      status: "finalized",
      replayed: false,
      movementCount: 2,
      uncountedLineCount: 1,
    });
    expect(finalize.body.session.status).toBe("finalized");

    // Inventory now equals the counted quantities and every movement references the session.
    expect(await quantityOf(variantAId)).toBe(9);
    expect(await quantityOf(variantBId)).toBe(1);
    const movements = await stockCountMovements(session.body.id);
    expect(movements).toHaveLength(2);
    expect(movements.every((movement) => movement.movementType === "stock_count")).toBe(true);
    expect(movements.every((movement) => movement.referenceId === String(session.body.id))).toBe(true);
    expect(movements.every((movement) => movement.eventKey.startsWith(`stock_count:${session.body.id}:`))).toBe(true);
    const movementA = movements.find((movement) => movement.variantId === variantAId);
    expect(movementA).toMatchObject({ delta: "-1.000000", before: "10.000000", after: "9.000000" });

    // Finalizing again replays the stored result without touching stock again.
    const replay = await manager.post(`/api/pos/retail/stock-counts/${session.body.id}/finalize`).send({});
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.movementCount).toBe(2);
    expect(await stockCountMovements(session.body.id)).toHaveLength(2);
    expect(await quantityOf(variantAId)).toBe(9);
  });

  it("reconciles a POS sale that happens while the count is open", async () => {
    const session = await cashier.post("/api/pos/retail/stock-counts").send({ locationId });
    expect(session.status).toBe(201);
    const lineA = session.body.lines.find((line: { variantId: number }) => line.variantId === variantAId);
    expect(lineA.expectedQuantity).toBe(9);

    // Normal sale during the count: 2 units leave the shelf.
    const sale = await cashier.post("/api/pos/retail/sales").send({
      locationId,
      idempotencyKey: "rw2sc-sale-during-count",
      items: [{ variantId: variantAId, quantity: 2 }],
    });
    expect(sale.status).toBe(201);
    expect(await quantityOf(variantAId)).toBe(7);

    // Staff physically count the 7 units that remain.
    const counted = await cashier
      .patch(`/api/pos/retail/stock-counts/${session.body.id}/lines/${lineA.id}`)
      .send({ countedQuantity: 7 });
    expect(counted.status).toBe(200);

    const finalized = await manager
      .post(`/api/pos/retail/stock-counts/${session.body.id}/finalize`)
      .send({ allowUncounted: true, confirmVariance: true });
    expect(finalized.status).toBe(201);
    expect(await quantityOf(variantAId)).toBe(7);

    // Nothing changed for variantA between count and finalize, so no movement is written at all.
    const movements = await stockCountMovements(session.body.id);
    expect(movements).toHaveLength(0);

    const report = await manager.get(`/api/pos/retail/stock-counts/${session.body.id}/variance`);
    expect(report.status).toBe(200);
    const reportLine = report.body.lines.find((line: { variantId: number }) => line.variantId === variantAId);
    expect(reportLine).toMatchObject({
      expectedQuantity: 9,
      countedQuantity: 7,
      expectedLiveQuantity: 7,
      varianceQuantity: -2,
      movementDelta: 0,
    });
    expect(reportLine.movementDuringCount).toBe(-2);
    expect(report.body.session.status).toBe("finalized");
  });

  it("supports recounting flagged lines and blocks finalize while lines are uncounted", async () => {
    const session = await cashier.post("/api/pos/retail/stock-counts").send({ locationId });
    expect(session.status).toBe(201);
    const lineA = session.body.lines.find((line: { variantId: number }) => line.variantId === variantAId);

    await cashier
      .patch(`/api/pos/retail/stock-counts/${session.body.id}/lines/${lineA.id}`)
      .send({ countedQuantity: 7, recountRequired: true, notes: "Check again" });

    const blocked = await manager.post(`/api/pos/retail/stock-counts/${session.body.id}/finalize`).send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("STOCK_COUNT_UNCOUNTED_LINES");

    const review = await cashier
      .post(`/api/pos/retail/stock-counts/${session.body.id}/review`)
      .send({ notes: "Ready" });
    expect(review.status).toBe(200);
    expect(review.body.status).toBe("review");

    const recount = await cashier.post(`/api/pos/retail/stock-counts/${session.body.id}/recount`).send({});
    expect(recount.status).toBe(200);
    expect(recount.body).toMatchObject({ status: "counting", resetLineCount: 1 });
    const recountLine = recount.body.session.lines.find((line: { variantId: number }) => line.variantId === variantAId);
    expect(recountLine).toMatchObject({ countedQuantity: null, status: "uncounted", recountRequired: false });

    const recountScan = await cashier
      .post(`/api/pos/retail/stock-counts/${session.body.id}/scan`)
      .send({ barcode: "RW2SC-A", mode: "set", quantity: 7 });
    expect(recountScan.status).toBe(200);

    const finalized = await manager
      .post(`/api/pos/retail/stock-counts/${session.body.id}/finalize`)
      .send({ confirmVariance: true, allowUncounted: true });
    expect(finalized.status).toBe(201);
    expect(await quantityOf(variantAId)).toBe(7);

    const cancelable = await cashier.post("/api/pos/retail/stock-counts").send({ locationId });
    const canceled = await manager
      .post(`/api/pos/retail/stock-counts/${cancelable.body.id}/cancel`)
      .send({ reason: "Wrong aisle" });
    expect(canceled.status).toBe(200);
    expect(canceled.body.status).toBe("canceled");

    const report = await cashier.get("/api/pos/retail/stock-counts/report");
    expect(report.status).toBe(200);
    expect(report.body.summary.sessionCount).toBeGreaterThanOrEqual(3);
    expect(report.body.sessions.some((row: { status: string }) => row.status === "finalized")).toBe(true);
  });

  it("rejects overlapping active count sessions for the same location", async () => {
    const first = await cashier.post("/api/pos/retail/stock-counts").send({ locationId });
    expect(first.status).toBe(201);
    const overlapping = await cashier.post("/api/pos/retail/stock-counts").send({ locationId });
    expect(overlapping.status).toBe(409);
    expect(overlapping.body.code).toBe("STOCK_COUNT_LOCATION_ALREADY_OPEN");

    const canceled = await manager.post(`/api/pos/retail/stock-counts/${first.body.id}/cancel`).send({});
    expect(canceled.status).toBe(200);
    const reopened = await cashier.post("/api/pos/retail/stock-counts").send({ locationId });
    expect(reopened.status).toBe(201);
    await manager.post(`/api/pos/retail/stock-counts/${reopened.body.id}/cancel`).send({});
  });

  it("does not overwrite a sale made after a physical line was counted", async () => {
    const session = await cashier.post("/api/pos/retail/stock-counts").send({ locationId });
    expect(session.status).toBe(201);
    const lineA = session.body.lines.find((line: { variantId: number }) => line.variantId === variantAId);
    const beforeSale = await quantityOf(variantAId);

    const counted = await cashier
      .patch(`/api/pos/retail/stock-counts/${session.body.id}/lines/${lineA.id}`)
      .send({ countedQuantity: beforeSale });
    expect(counted.status).toBe(200);

    const sale = await cashier.post("/api/pos/retail/sales").send({
      locationId,
      idempotencyKey: "rw2sc-sale-after-count",
      items: [{ variantId: variantAId, quantity: 1 }],
    });
    expect(sale.status).toBe(201);
    expect(await quantityOf(variantAId)).toBe(beforeSale - 1);

    const staleFinalize = await manager
      .post(`/api/pos/retail/stock-counts/${session.body.id}/finalize`)
      .send({ allowUncounted: true, confirmVariance: true });
    expect(staleFinalize.status).toBe(409);
    expect(staleFinalize.body.code).toBe("STOCK_COUNT_RECOUNT_REQUIRED");
    expect(await quantityOf(variantAId)).toBe(beforeSale - 1);
    expect(await stockCountMovements(session.body.id)).toHaveLength(0);

    // A fresh count incorporates the sale and can be finalized without restoring it.
    await new Promise((resolve) => setTimeout(resolve, 15));
    const recounted = await cashier
      .patch(`/api/pos/retail/stock-counts/${session.body.id}/lines/${lineA.id}`)
      .send({ countedQuantity: beforeSale - 1 });
    expect(recounted.status).toBe(200);
    const finalized = await manager
      .post(`/api/pos/retail/stock-counts/${session.body.id}/finalize`)
      .send({ allowUncounted: true, confirmVariance: true });
    expect(finalized.status).toBe(201);
    expect(await quantityOf(variantAId)).toBe(beforeSale - 1);
  });

});
