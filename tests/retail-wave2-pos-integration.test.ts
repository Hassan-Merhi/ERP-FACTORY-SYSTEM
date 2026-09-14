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

    await db.insert(schema.userCompanyRoles).values({ userId, companyId, role: "Admin" });
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
        size: "M",
        barcode: "RWP2-BARCODE-001",
        sku: "RWP2-TEE-M",
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
      size: "M",
      sku: "RWP2-TEE-M",
      barcode: "RWP2-BARCODE-001",
      price: 10,
      quantity: 5,
    });

    const saleBody = {
      locationId,
      idempotencyKey: "retail-wave2-integration-sale-001",
      items: [{ variantId: scan.body.variantId, quantity: 2 }],
    };

    const sale = await agent.post("/api/pos/retail/sales").send(saleBody);
    expect(sale.status).toBe(201);
    expect(sale.body.replayed).toBe(false);
    expect(sale.body.sale.locationId).toBe(locationId);
    expect(sale.body.sale.items).toHaveLength(1);
    expect(sale.body.sale.items[0]).toMatchObject({ variantId, size: "M", barcode: "RWP2-BARCODE-001", quantity: 2 });
    expect(await retailQuantity()).toBe(3);

    const saleReplay = await agent.post("/api/pos/retail/sales").send(saleBody);
    expect(saleReplay.status).toBe(200);
    expect(saleReplay.body.replayed).toBe(true);
    expect(saleReplay.body.sale.id).toBe(sale.body.sale.id);
    expect(await retailQuantity()).toBe(3);

    const saleItemId = Number(sale.body.sale.items[0].id);
    const returnBody = {
      locationId,
      idempotencyKey: "retail-wave2-integration-return-001",
      items: [{ saleItemId, quantity: 2 }],
    };

    const returned = await agent.post(`/api/pos/retail/sales/${sale.body.sale.id}/returns`).send(returnBody);
    expect(returned.status).toBe(201);
    expect(returned.body.replayed).toBe(false);
    expect(await retailQuantity()).toBe(5);

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
});
