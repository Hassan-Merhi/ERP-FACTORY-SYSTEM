import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { KNOWN_SECURITY_PERMISSIONS } from "../server/services/security/namedPermissionService";
import { cleanupTestData, closeTestServer, setupTestApp } from "./setup";

const TEST_PREFIX = "retailposwave2";
const describeWithDatabase = process.env.DATABASE_URL ? describe : describe.skip;

let app: Awaited<ReturnType<typeof setupTestApp>>;
let agent: request.SuperAgentTest;
let companyId = 0;
let locationId = 0;
let variantId = 0;
let userId = "";

async function purgeRetailRowsForFixture(): Promise<void> {
  const companies = await db
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .where(sql`${schema.companies.name} LIKE ${`%${TEST_PREFIX}%`}`);

  for (const company of companies) {
    const params = [company.id];
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

async function retailQuantity(): Promise<number> {
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

describeWithDatabase("Retail POS Wave 2 HTTP + PostgreSQL transaction flow", () => {
  beforeAll(async () => {
    app = await setupTestApp();
    await purgeRetailRowsForFixture();
    await cleanupTestData(TEST_PREFIX);

    const bcrypt = await import("bcryptjs");
    const password = await bcrypt.hash("testpassword123", 10);

    const [user] = await db
      .insert(schema.users)
      .values({ username: `${TEST_PREFIX}_testuser`, password })
      .returning({ id: schema.users.id });
    userId = user.id;

    const [company] = await db
      .insert(schema.companies)
      .values({
        code: "RWP2",
        name: `${TEST_PREFIX}_TestCompany`,
        companyType: "retail",
        baseCurrency: "USD",
      })
      .returning({ id: schema.companies.id });
    companyId = company.id;

    await db.insert(schema.userCompanyRoles).values({ userId, companyId, role: "POS" });
    await db.insert(schema.userSecurityPermissions).values(
      KNOWN_SECURITY_PERMISSIONS.map((permission) => ({
        userId,
        companyId,
        permission,
        grantedBy: userId,
      }))
    );

    const [location] = await db
      .insert(schema.locations)
      .values({ companyId, code: "RWP2-MAIN", name: "Retail Wave 2 Main" })
      .returning({ id: schema.locations.id });
    locationId = location.id;

    await db
      .update(schema.userCompanyRoles)
      .set({ assignedLocationId: locationId })
      .where(and(eq(schema.userCompanyRoles.userId, userId), eq(schema.userCompanyRoles.companyId, companyId)));
    await db.insert(schema.userLocations).values({ userId, companyId, locationId });

    const [brand] = await db
      .insert(schema.retailBrands)
      .values({
        companyId,
        name: "North Star",
        normalizedName: "north star",
      })
      .returning({ id: schema.retailBrands.id });

    const [product] = await db
      .insert(schema.retailProducts)
      .values({
        companyId,
        code: "RWP2-TEE",
        name: "Retail Wave 2 Tee",
        brandId: brand.id,
        imageUrls: ["https://example.com/retail-wave2-tee.jpg"],
      })
      .returning({ id: schema.retailProducts.id });

    const [variant] = await db
      .insert(schema.retailProductVariants)
      .values({
        companyId,
        productId: product.id,
        color: "Black",
        size: "M",
        barcode: "RWP2-BARCODE-001",
        sku: "RWP2-TEE-M",
        imageUrls: ["https://example.com/retail-wave2-tee-black.jpg"],
        cost: "4.000000",
        sellingPrice: "10.000000",
      })
      .returning({ id: schema.retailProductVariants.id });
    variantId = variant.id;

    await db.insert(schema.retailVariantInventory).values({
      companyId,
      variantId,
      locationId,
      quantity: "5.000000",
      averageCost: "4.000000",
    });

    agent = request.agent(app);
    const login = await agent.post("/api/auth/login").send({
      username: `${TEST_PREFIX}_testuser`,
      password: "testpassword123",
    });
    expect(login.status).toBe(200);

    const companySwitch = await agent.post("/api/auth/set-company").send({ companyId });
    expect(companySwitch.status).toBe(200);
  }, 60_000);

  afterAll(async () => {
    await purgeRetailRowsForFixture();
    await cleanupTestData(TEST_PREFIX);
    closeTestServer();
  }, 30_000);

  it("scan → cart variant → sale → exact deduction → retry → return → exact restoration → retry", async () => {
    const scan = await agent.get(`/api/pos/retail/barcodes/RWP2-BARCODE-001?locationId=${locationId}`);
    expect(scan.status).toBe(200);
    expect(scan.body).toMatchObject({
      variantId,
      code: "RWP2-TEE",
      name: "Retail Wave 2 Tee",
      brand: "North Star",
      color: "Black",
      size: "M",
      sku: "RWP2-TEE-M",
      imageUrls: ["https://example.com/retail-wave2-tee-black.jpg"],
      barcode: "RWP2-BARCODE-001",
      price: 10,
      quantity: 5,
    });

    const colorSearch = await agent.get(`/api/pos/retail/items?locationId=${locationId}&search=black`);
    expect(colorSearch.status).toBe(200);
    expect(colorSearch.body).toEqual([
      expect.objectContaining({
        variantId,
        color: "Black",
        size: "M",
        imageUrls: ["https://example.com/retail-wave2-tee-black.jpg"],
      }),
    ]);

    const openedShift = await agent.post("/api/pos/shifts/open").send({ locationId, openingCash: 5 });
    expect(openedShift.status).toBe(200);
    const shiftId = Number(openedShift.body.id);
    expect(shiftId).toBeGreaterThan(0);

    const saleBody = {
      locationId,
      shiftId,
      idempotencyKey: "retail-wave2-integration-sale-001",
      payments: [
        { method: "cash", amount: 8, tenderedAmount: 10 },
        { method: "card", amount: 12, reference: "TEST-CARD" },
      ],
      items: [{ variantId: scan.body.variantId, quantity: 2 }],
    };

    const sale = await agent.post("/api/pos/retail/sales").send(saleBody);
    expect(sale.status).toBe(201);
    expect(sale.body.replayed).toBe(false);
    expect(sale.body.sale.locationId).toBe(locationId);
    expect(sale.body.sale.items).toHaveLength(1);
    expect(sale.body.sale.items[0]).toMatchObject({
      variantId,
      color: "Black",
      size: "M",
      barcode: "RWP2-BARCODE-001",
      imageUrls: ["https://example.com/retail-wave2-tee-black.jpg"],
      quantity: 2,
    });
    expect(await retailQuantity()).toBe(3);
    expect(sale.body.sale.accountingVoucherId).toBeGreaterThan(0);
    expect(sale.body.sale.payments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "cash", paymentType: "payment", amount: 8, changeAmount: 2 }),
        expect.objectContaining({ method: "card", paymentType: "payment", amount: 12, reference: "TEST-CARD" }),
      ])
    );
    const [saleAccountingRequest] = await db
      .select()
      .from(schema.accountingPostingRequests)
      .where(
        and(
          eq(schema.accountingPostingRequests.companyId, companyId),
          eq(schema.accountingPostingRequests.sourceType, "retail-pos-sale"),
          eq(schema.accountingPostingRequests.sourceId, String(sale.body.sale.id))
        )
      )
      .limit(1);
    expect(saleAccountingRequest?.voucherId).toBe(sale.body.sale.accountingVoucherId);
    const openSummary = await agent.get(`/api/pos/retail/shifts/${shiftId}/summary`);
    expect(openSummary.status).toBe(200);
    expect(openSummary.body).toMatchObject({
      salesCount: 1,
      cashSales: 8,
      cashRefunds: 0,
      expectedCash: 13,
    });

    const saleReplay = await agent.post("/api/pos/retail/sales").send(saleBody);
    expect(saleReplay.status).toBe(200);
    expect(saleReplay.body.replayed).toBe(true);
    expect(saleReplay.body.sale.id).toBe(sale.body.sale.id);
    expect(await retailQuantity()).toBe(3);

    const saleItemId = Number(sale.body.sale.items[0].id);
    const returnBody = {
      locationId,
      idempotencyKey: "retail-wave2-integration-return-001",
      shiftId,
      items: [{ saleItemId, quantity: 2 }],
    };

    const returned = await agent.post(`/api/pos/retail/sales/${sale.body.sale.id}/returns`).send(returnBody);
    expect(returned.status).toBe(201);
    expect(returned.body.replayed).toBe(false);
    expect(await retailQuantity()).toBe(5);
    const refundPayments = returned.body.sale.payments.filter(
      (payment: { paymentType: string }) => payment.paymentType === "refund"
    );
    expect(refundPayments.reduce((sum: number, payment: { amount: number }) => sum + payment.amount, 0)).toBe(20);
    expect(refundPayments.map((payment: { method: string }) => payment.method).sort()).toEqual(["card", "cash"]);
    const [returnAccountingRequest] = await db
      .select()
      .from(schema.accountingPostingRequests)
      .where(
        and(
          eq(schema.accountingPostingRequests.companyId, companyId),
          eq(schema.accountingPostingRequests.sourceType, "retail-pos-return"),
          eq(schema.accountingPostingRequests.sourceId, String(returned.body.returnId))
        )
      )
      .limit(1);
    expect(returnAccountingRequest?.voucherId).toBeGreaterThan(0);

    const cashIn = await agent.post(`/api/pos/retail/shifts/${shiftId}/cash-movements`).send({
      movementType: "cash_in",
      amount: 3,
      reason: "Float top-up",
      // Wave 17 (D): the movement is journalled against its reason's account; the
      // default reason "other" has none (409), so a mapped built-in reason is sent.
      reasonCode: "owner_funding",
      idempotencyKey: "retail-wave1-cash-in-001",
    });
    expect(cashIn.status).toBe(201);
    expect(cashIn.body.summary.expectedCash).toBe(8);

    const closedShift = await agent.post(`/api/pos/shifts/${shiftId}/close`).send({ closingCash: 8 });
    expect(closedShift.status).toBe(200);
    expect(Number(closedShift.body.expectedCash)).toBe(8);
    expect(Number(closedShift.body.variance)).toBe(0);
    expect(closedShift.body.salesCount).toBe(1);
    expect(Number(closedShift.body.salesTotal)).toBe(20);

    const returnReplay = await agent.post(`/api/pos/retail/sales/${sale.body.sale.id}/returns`).send(returnBody);
    expect(returnReplay.status).toBe(200);
    expect(returnReplay.body.replayed).toBe(true);
    expect(await retailQuantity()).toBe(5);

    const movements = await db
      .select({
        type: schema.retailStockMovements.movementType,
        delta: schema.retailStockMovements.quantityDelta,
        before: schema.retailStockMovements.quantityBefore,
        after: schema.retailStockMovements.quantityAfter,
      })
      .from(schema.retailStockMovements)
      .where(
        and(
          eq(schema.retailStockMovements.companyId, companyId),
          eq(schema.retailStockMovements.variantId, variantId),
          eq(schema.retailStockMovements.locationId, locationId)
        )
      );

    expect(movements).toHaveLength(2);
    expect(movements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "sale", delta: "-2.000000", before: "5.000000", after: "3.000000" }),
        expect.objectContaining({ type: "return", delta: "2.000000", before: "3.000000", after: "5.000000" }),
      ])
    );
  }, 30_000);
  it("keeps long-key split tenders distinct and leaves an unshifted refund off the closed shift", async () => {
    const openedShift = await agent.post("/api/pos/shifts/open").send({ locationId, openingCash: 0 });
    expect(openedShift.status).toBe(200);
    const shiftId = Number(openedShift.body.id);

    // 190 characters: the derived per-payment keys would collide if they were truncated to 191.
    const longKey = `retail-wave1-long-key-${"x".repeat(168)}`;
    expect(longKey).toHaveLength(190);
    const sale = await agent.post("/api/pos/retail/sales").send({
      locationId,
      shiftId,
      idempotencyKey: longKey,
      payments: [
        { method: "cash", amount: 4, tenderedAmount: 4 },
        { method: "card", amount: 6, reference: "LONG-KEY-CARD" },
      ],
      items: [{ variantId, quantity: 1 }],
    });
    expect(sale.status).toBe(201);
    const salePayments = sale.body.sale.payments.filter(
      (payment: { paymentType: string }) => payment.paymentType === "payment"
    );
    expect(salePayments.map((payment: { method: string }) => payment.method).sort()).toEqual(["card", "cash"]);
    expect(new Set(salePayments.map((payment: { id: number }) => payment.id)).size).toBe(2);

    const closedShift = await agent.post(`/api/pos/shifts/${shiftId}/close`).send({ closingCash: 4 });
    expect(closedShift.status).toBe(200);
    expect(Number(closedShift.body.expectedCash)).toBe(4);

    const lateMovement = await agent.post(`/api/pos/retail/shifts/${shiftId}/cash-movements`).send({
      movementType: "cash_out",
      amount: 1,
      reason: "After close",
      idempotencyKey: "retail-wave1-after-close-001",
    });
    expect(lateMovement.status).toBe(409);

    const returned = await agent.post(`/api/pos/retail/sales/${sale.body.sale.id}/returns`).send({
      locationId,
      idempotencyKey: "retail-wave1-unshifted-return-001",
      items: [{ saleItemId: Number(sale.body.sale.items[0].id), quantity: 1 }],
    });
    expect(returned.status).toBe(201);
    const refunds = await db
      .select({ shiftId: schema.retailPosPayments.shiftId })
      .from(schema.retailPosPayments)
      .where(
        and(
          eq(schema.retailPosPayments.companyId, companyId),
          eq(schema.retailPosPayments.saleId, Number(sale.body.sale.id)),
          eq(schema.retailPosPayments.paymentType, "refund")
        )
      );
    expect(refunds.length).toBeGreaterThan(0);
    expect(refunds.every((refund) => refund.shiftId === null)).toBe(true);

    const summary = await agent.get(`/api/pos/retail/shifts/${shiftId}/summary`);
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({ cashSales: 4, cashRefunds: 0, expectedCash: 4 });
  }, 30_000);
});
