import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { KNOWN_SECURITY_PERMISSIONS } from "../server/services/security/namedPermissionService";
import { isValidEan13 } from "../server/services/retail/retailBarcodeService";
import { cleanupTestData, closeTestServer, setupTestApp } from "./setup";

/**
 * Real-world fashion flow against PostgreSQL:
 * photograph/add → generated barcode → label → scan → sell → sold out → return →
 * receive → transfer → adjust → exchange → reports, plus archive and company isolation.
 */
const TEST_PREFIX = "retailfashionlife";
const describeWithDatabase = process.env.DATABASE_URL ? describe : describe.skip;

let app: Awaited<ReturnType<typeof setupTestApp>>;
let manager: request.SuperAgentTest;
let cashier: request.SuperAgentTest;
let companyId = 0;
let otherCompanyId = 0;
let mainId = 0;
let warehouseId = 0;

async function purge(): Promise<void> {
  const companies = await db
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .where(sql`${schema.companies.name} LIKE ${`%${TEST_PREFIX}%`}`);
  for (const company of companies) {
    const params = [company.id];
    for (const table of [
      "retail_label_print_events",
      "retail_pos_return_items",
      "retail_pos_returns",
      "retail_pos_sale_items",
      "retail_pos_sales",
      "retail_stock_movements",
      "retail_stock_operations",
      "retail_variant_inventory",
      "retail_product_variants",
      "retail_products",
      "retail_brands",
      "retail_barcode_sequences",
    ]) {
      await pool.query(`DELETE FROM ${table} WHERE company_id = $1`, params);
    }
  }
}

async function createUser(username: string, role: string, password: string, assignedLocationId?: number) {
  const [user] = await db.insert(schema.users).values({ username, password }).returning({ id: schema.users.id });
  await db.insert(schema.userCompanyRoles).values({ userId: user.id, companyId, role, assignedLocationId });
  await db
    .insert(schema.userSecurityPermissions)
    .values(
      KNOWN_SECURITY_PERMISSIONS.map((permission) => ({ userId: user.id, companyId, permission, grantedBy: user.id }))
    );
  if (assignedLocationId) {
    await db.insert(schema.userLocations).values({ userId: user.id, companyId, locationId: assignedLocationId });
  }
  return user.id;
}

async function login(username: string) {
  const agent = request.agent(app);
  expect((await agent.post("/api/auth/login").send({ username, password: "testpassword123" })).status).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId })).status).toBe(200);
  return agent;
}

const stockAt = async (barcode: string, locationId: number) => {
  const lookup = await manager.get(`/api/retail/stock/lookup?barcode=${barcode}`);
  expect(lookup.status).toBe(200);
  return (
    (lookup.body.stocks as Array<{ locationId: number; quantity: number }>).find(
      (stock) => stock.locationId === locationId
    )?.quantity ?? 0
  );
};

describeWithDatabase("Retail fashion lifecycle (PostgreSQL)", () => {
  beforeAll(async () => {
    app = await setupTestApp();
    await purge();
    await cleanupTestData(TEST_PREFIX);
    const bcrypt = await import("bcryptjs");
    const password = await bcrypt.hash("testpassword123", 10);

    const [company] = await db
      .insert(schema.companies)
      .values({ code: "RFL1", name: `${TEST_PREFIX}_Shop`, companyType: "retail", baseCurrency: "USD" })
      .returning({ id: schema.companies.id });
    companyId = company.id;
    const [other] = await db
      .insert(schema.companies)
      .values({ code: "RFL2", name: `${TEST_PREFIX}_Other`, companyType: "retail", baseCurrency: "USD" })
      .returning({ id: schema.companies.id });
    otherCompanyId = other.id;
    const [main] = await db
      .insert(schema.locations)
      .values({ companyId, code: "RFL-MAIN", name: "RFL Main" })
      .returning({ id: schema.locations.id });
    const [warehouse] = await db
      .insert(schema.locations)
      .values({ companyId, code: "RFL-WH", name: "RFL Warehouse" })
      .returning({ id: schema.locations.id });
    mainId = main.id;
    warehouseId = warehouse.id;

    await createUser(`${TEST_PREFIX}_manager`, "Manager", password);
    await createUser(`${TEST_PREFIX}_cashier`, "POS", password, mainId);
    manager = await login(`${TEST_PREFIX}_manager`);
    cashier = await login(`${TEST_PREFIX}_cashier`);
  }, 90_000);

  afterAll(async () => {
    await purge();
    await pool.query("DELETE FROM companies WHERE id = $1", [otherCompanyId]).catch(() => undefined);
    await cleanupTestData(TEST_PREFIX);
    closeTestServer();
  }, 30_000);

  it("runs the full photograph → label → scan → sell → return → move → report lifecycle", async () => {
    // Wave 2: quick add one style with two exact variants, quantity defaulting to 1.
    const added = await manager.post("/api/retail/quick-add").send({
      idempotencyKey: "rfl-quick-add-0001",
      brandName: "Zara",
      name: "Wide Leg Trouser",
      category: "Trousers",
      locationId: mainId,
      variants: [
        { color: "Black", size: "M", sellingPrice: 50, cost: 20, imageUrls: ["https://example.com/black.jpg"] },
        { color: "Beige", size: "S", sellingPrice: 45, cost: 18, imageUrls: ["https://example.com/beige.jpg"] },
      ],
    });
    expect(added.status).toBe(201);
    const [blackM, beigeS] = added.body.variants as Array<{ variantId: number; barcode: string }>;
    // Wave 3: generated, valid, unique in-store barcodes.
    expect(isValidEan13(blackM.barcode) && blackM.barcode.startsWith("2")).toBe(true);
    // The intake response carries the received units so labels can be printed one per unit.
    expect(added.body.variants.map((variant: { receivedQuantity: number }) => variant.receivedQuantity)).toEqual([
      1, 1,
    ]);
    expect(blackM.barcode).not.toBe(beigeS.barcode);

    const duplicate = await manager.post("/api/retail/quick-add").send({
      idempotencyKey: "rfl-quick-add-0002",
      brandName: "zara",
      name: "wide leg trouser",
      locationId: mainId,
      variants: [{ color: "BLACK", size: "m", sellingPrice: 1 }],
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe("VARIANT_EXISTS");

    const labels = await manager
      .post("/api/retail/labels")
      .send({ layout: "thermal-50x30", items: [{ variantId: blackM.variantId, copies: 1 }] });
    expect(labels.status).toBe(201);
    expect(labels.body.labels[0]).toMatchObject({ barcode: blackM.barcode, color: "Black", size: "M", brand: "Zara" });
    const reprint = await manager
      .post("/api/retail/labels")
      .send({ layout: "a4-24", items: [{ variantId: blackM.variantId }] });
    expect(reprint.body.labels[0]).toMatchObject({ barcode: blackM.barcode, isReprint: true });

    // Wave 4: scan the printed barcode at the till and sell the single unit.
    const scan = await cashier.get(`/api/pos/retail/barcodes/${blackM.barcode}?locationId=${mainId}`);
    expect(scan.status).toBe(200);
    expect(scan.body).toMatchObject({ variantId: blackM.variantId, color: "Black", size: "M", quantity: 1 });
    const sale = await cashier.post("/api/pos/retail/sales").send({
      locationId: mainId,
      idempotencyKey: "rfl-sale-0001",
      items: [{ variantId: blackM.variantId, quantity: 1 }],
    });
    expect(sale.status).toBe(201);
    expect(await stockAt(blackM.barcode, mainId)).toBe(0);
    const soldOut = await cashier.post("/api/pos/retail/sales").send({
      locationId: mainId,
      idempotencyKey: "rfl-sale-0002",
      items: [{ variantId: blackM.variantId, quantity: 1 }],
    });
    expect(soldOut.status).toBe(409);
    const unknown = await cashier.get(`/api/pos/retail/barcodes/NOT-A-LABEL?locationId=${mainId}`);
    expect(unknown.status).toBe(404);

    // Return restores the exact variant.
    const saleItemId = sale.body.sale.items[0].id;
    const returned = await cashier.post(`/api/pos/retail/sales/${sale.body.sale.id}/returns`).send({
      locationId: mainId,
      idempotencyKey: "rfl-return-0001",
      items: [{ saleItemId, quantity: 1 }],
    });
    expect(returned.status).toBe(201);
    expect(await stockAt(blackM.barcode, mainId)).toBe(1);

    // Wave 5: receive, transfer and adjust by barcode.
    expect(
      (
        await manager.post("/api/pos/retail/receipts").send({
          idempotencyKey: "rfl-receive-0001",
          variantId: beigeS.variantId,
          locationId: mainId,
          quantity: 3,
          unitCost: 18,
        })
      ).status
    ).toBe(201);
    expect(
      (
        await manager.post("/api/pos/retail/transfers").send({
          idempotencyKey: "rfl-transfer-0001",
          variantId: beigeS.variantId,
          fromLocationId: mainId,
          toLocationId: warehouseId,
          quantity: 2,
        })
      ).status
    ).toBe(201);
    expect(
      (
        await manager.post("/api/pos/retail/adjustments").send({
          idempotencyKey: "rfl-adjust-0001",
          variantId: beigeS.variantId,
          locationId: warehouseId,
          quantityDelta: -1,
          reason: "Damaged",
        })
      ).status
    ).toBe(201);
    expect(await stockAt(beigeS.barcode, mainId)).toBe(2);
    expect(await stockAt(beigeS.barcode, warehouseId)).toBe(1);
    const history = await manager.get(`/api/retail/variants/${beigeS.variantId}/movements`);
    expect(history.body.map((row: { movementType: string }) => row.movementType)).toEqual(
      expect.arrayContaining(["receive", "transfer_out", "transfer_in", "adjustment"])
    );
    expect(history.body.find((row: { movementType: string }) => row.movementType === "adjustment")).toMatchObject({
      quantityBefore: 2,
      quantityDelta: -1,
      quantityAfter: 1,
      reason: "Damaged",
      createdBy: `${TEST_PREFIX}_manager`,
    });

    // Wave 7: exchange Black / M for Beige / S keeps both sides traceable.
    const resale = await cashier.post("/api/pos/retail/sales").send({
      locationId: mainId,
      idempotencyKey: "rfl-sale-0003",
      items: [{ variantId: blackM.variantId, quantity: 1 }],
    });
    const exchange = await cashier.post("/api/pos/retail/exchanges").send({
      idempotencyKey: "rfl-exchange-0001",
      saleId: resale.body.sale.id,
      locationId: mainId,
      returnItems: [{ saleItemId: resale.body.sale.items[0].id, quantity: 1 }],
      newItems: [{ variantId: beigeS.variantId, quantity: 1 }],
    });
    expect(exchange.status).toBe(201);
    expect(exchange.body.balanceDue).toBe(-5);
    expect(await stockAt(blackM.barcode, mainId)).toBe(1);
    expect(await stockAt(beigeS.barcode, mainId)).toBe(1);

    // Reports reflect exact variants and the reconciliation audit stays clean.
    const stockReport = await manager.get(`/api/retail/reporting/stock?search=Wide`);
    expect(stockReport.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ brand: "Zara", color: "Beige", size: "S", quantity: 2 }),
        expect.objectContaining({ brand: "Zara", color: "Black", size: "M", quantity: 1 }),
      ])
    );
    const sales = await manager.get(`/api/retail/reporting/variant-sales`);
    expect(sales.body.find((row: { variantId: number }) => row.variantId === blackM.variantId)).toMatchObject({
      soldQuantity: 2,
      returnedQuantity: 2,
      netQuantity: 0,
    });
    const audit = await manager.get("/api/retail/reporting/audit");
    expect(audit.body.ready).toBe(true);

    // Archive hides the variant from selling without deleting history; restore brings it back.
    expect(
      (await manager.patch(`/api/retail/variants/${blackM.variantId}/active`).send({ active: false })).status
    ).toBe(200);
    const archivedScan = await cashier.get(`/api/pos/retail/barcodes/${blackM.barcode}?locationId=${mainId}`);
    expect(archivedScan.status).toBe(409);
    expect(archivedScan.body.code).toBe("ITEM_INACTIVE");
    expect((await manager.get(`/api/retail/variants/${blackM.variantId}/movements`)).body.length).toBeGreaterThan(0);
    await manager.patch(`/api/retail/variants/${blackM.variantId}/active`).send({ active: true });

    // A sale that is partially returned and then canceled leaves the variant sales report unchanged.
    const salesBefore = (await manager.get(`/api/retail/reporting/variant-sales`)).body.find(
      (row: { variantId: number }) => row.variantId === blackM.variantId
    );
    await manager.post("/api/pos/retail/receipts").send({
      idempotencyKey: "rfl-receive-0002",
      variantId: blackM.variantId,
      locationId: mainId,
      quantity: 1,
    });
    const twoUnits = await manager.post("/api/pos/retail/sales").send({
      locationId: mainId,
      idempotencyKey: "rfl-sale-0004",
      items: [{ variantId: blackM.variantId, quantity: 2 }],
    });
    expect(twoUnits.status).toBe(201);
    await manager.post(`/api/pos/retail/sales/${twoUnits.body.sale.id}/returns`).send({
      locationId: mainId,
      idempotencyKey: "rfl-return-0002",
      items: [{ saleItemId: twoUnits.body.sale.items[0].id, quantity: 1 }],
    });
    const canceled = await manager.post(`/api/pos/retail/sales/${twoUnits.body.sale.id}/cancel`).send({
      locationId: mainId,
      idempotencyKey: "rfl-cancel-0001",
    });
    expect(canceled.status).toBe(201);
    // A cancellation refunds the remaining paid value and reverses it in the ledger.
    const cancelPayments: Array<{ paymentType: string; amount: number }> = canceled.body.sale.payments ?? [];
    const paidTotal = cancelPayments.filter((p) => p.paymentType === "payment").reduce((sum, p) => sum + p.amount, 0);
    const refundedTotal = cancelPayments
      .filter((p) => p.paymentType === "refund")
      .reduce((sum, p) => sum + p.amount, 0);
    expect(paidTotal).toBeGreaterThan(0);
    expect(refundedTotal).toBeCloseTo(paidTotal, 6);
    const cancelPosting = await pool.query(
      "SELECT voucher_id FROM accounting_posting_requests WHERE source_type = 'retail-pos-cancel' AND source_id = $1",
      [String(twoUnits.body.sale.id)]
    );
    expect(Number(cancelPosting.rows[0]?.voucher_id ?? 0)).toBeGreaterThan(0);
    const salesAfter = (await manager.get(`/api/retail/reporting/variant-sales`)).body.find(
      (row: { variantId: number }) => row.variantId === blackM.variantId
    );
    expect(salesAfter).toMatchObject({
      soldQuantity: salesBefore.soldQuantity,
      returnedQuantity: salesBefore.returnedQuantity,
      netRevenue: salesBefore.netRevenue,
    });
    expect(await stockAt(blackM.barcode, mainId)).toBe(2);

    // Permissions: cashiers sell but cannot receive or read reports.
    expect(
      (
        await cashier.post("/api/pos/retail/receipts").send({
          idempotencyKey: "rfl-receive-cashier",
          variantId: beigeS.variantId,
          locationId: mainId,
          quantity: 1,
        })
      ).status
    ).toBe(403);
    expect((await cashier.get("/api/retail/reporting/stock")).status).toBe(403);
  }, 120_000);
});
