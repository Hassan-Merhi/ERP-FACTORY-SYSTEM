import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { KNOWN_SECURITY_PERMISSIONS } from "../server/services/security/namedPermissionService";
import { cleanupTestData, closeTestServer, setupTestApp } from "./setup";

const TEST_PREFIX = "retailw2cpt";
const describeWithDatabase = process.env.DATABASE_URL ? describe : describe.skip;

let app: Awaited<ReturnType<typeof setupTestApp>>;
let cashier: request.SuperAgentTest;
let manager: request.SuperAgentTest;
let companyId = 0;
let locationId = 0;
let brandId = 0;
let productId = 0;
let variantAId = 0;
let variantBId = 0;
let cashierId = "";
let managerId = "";

const CASHIER_PASSWORD = "cashier-password-123";
const MANAGER_PASSWORD = "manager-password-123";

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
    await pool.query("DELETE FROM retail_discount_approvals WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_promotions WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_pos_settings WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_pos_return_items WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_pos_returns WHERE company_id = $1", params);
    await pool.query("UPDATE retail_pos_sales SET approval_id = NULL WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_pos_sale_items WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_pos_sales WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_stock_movements WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_stock_operations WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_variant_inventory WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_product_variants WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_products WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_brands WHERE company_id = $1", params);
    await pool.query("DELETE FROM customers WHERE company_id = $1", params);
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

async function variantQuantity(variantId: number): Promise<number> {
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

async function updateSettings(patch: Record<string, unknown>): Promise<void> {
  const response = await manager.put("/api/pos/retail/settings").send(patch);
  expect(response.status).toBe(200);
}

/** Net debit minus credit per ledger code on a voucher, for the Retail accounts. */
async function retailJournal(voucherId: number): Promise<Record<string, number>> {
  const result = await pool.query<{ code: string; net: string }>(
    `SELECT la.code, SUM(COALESCE(ve.debit_amount, 0) - COALESCE(ve.credit_amount, 0)) AS net
       FROM voucher_entries ve
       JOIN ledger_accounts la ON la.id = ve.ledger_account_id
      WHERE ve.voucher_id = $1
      GROUP BY la.code`,
    [voucherId]
  );
  return Object.fromEntries(result.rows.map((row) => [row.code, Number(row.net)]));
}

describeWithDatabase("Retail Wave 2 — customers, pricing, discounts and tax", () => {
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
      .values({
        code: "RW2CPT",
        name: `${TEST_PREFIX}_Company`,
        companyType: "retail",
        baseCurrency: "USD",
      })
      .returning({ id: schema.companies.id });
    companyId = company.id;

    for (const [userId, role] of [
      [cashierId, "POS"],
      [managerId, "Manager"],
    ] as const) {
      await db.insert(schema.userCompanyRoles).values({ userId, companyId, role });
      await db.insert(schema.userSecurityPermissions).values(
        KNOWN_SECURITY_PERMISSIONS.map((permission) => ({
          userId,
          companyId,
          permission,
          grantedBy: userId,
        }))
      );
    }

    const [location] = await db
      .insert(schema.locations)
      .values({ companyId, code: "RW2CPT-MAIN", name: "Wave 2 Pricing Main" })
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
      .values({ companyId, name: "Wave 2 Brand", normalizedName: "wave 2 brand" })
      .returning({ id: schema.retailBrands.id });
    brandId = brand.id;

    const [product] = await db
      .insert(schema.retailProducts)
      .values({ companyId, code: "RW2CPT-TEE", name: "Wave 2 Pricing Tee", brandId })
      .returning({ id: schema.retailProducts.id });
    productId = product.id;

    const variants = await db
      .insert(schema.retailProductVariants)
      .values([
        {
          companyId,
          productId,
          color: "Black",
          size: "M",
          barcode: "RW2CPT-A",
          sku: "RW2CPT-A-M",
          cost: "40.000000",
          sellingPrice: "100.000000",
        },
        {
          companyId,
          productId,
          color: "Blue",
          size: "L",
          barcode: "RW2CPT-B",
          sku: "RW2CPT-B-L",
          cost: "20.000000",
          sellingPrice: "50.000000",
        },
      ])
      .returning({ id: schema.retailProductVariants.id });
    variantAId = variants[0].id;
    variantBId = variants[1].id;

    await db.insert(schema.retailVariantInventory).values([
      { companyId, variantId: variantAId, locationId, quantity: "20.000000", averageCost: "40.000000" },
      { companyId, variantId: variantBId, locationId, quantity: "10.000000", averageCost: "20.000000" },
    ]);

    cashier = await login(`${TEST_PREFIX}_cashier`, CASHIER_PASSWORD);
    manager = await login(`${TEST_PREFIX}_manager`, MANAGER_PASSWORD);
  }, 60_000);

  afterAll(async () => {
    await purgeFixture();
    await cleanupTestData(TEST_PREFIX);
    closeTestServer();
  }, 30_000);

  it("prices a cart preview without selling anything", async () => {
    await updateSettings({ discountLimitPercent: 10, taxEnabled: false });

    const preview = await cashier.post("/api/pos/retail/cart-preview").send({
      locationId,
      items: [
        { variantId: variantAId, quantity: 1 },
        {
          variantId: variantBId,
          quantity: 1,
          discountType: "percent",
          discountValue: 20,
          discountReason: "Loyal customer",
        },
      ],
      orderDiscount: { type: "fixed", value: 10, reason: "Manager goodwill" },
    });
    expect(preview.status).toBe(200);
    expect(preview.body.pricing.listSubtotal).toBe(150);
    // 20% off 50 + the 10 whole-sale discount allocated across the two lines.
    expect(preview.body.pricing.discountTotal).toBe(20);
    expect(preview.body.pricing.subtotal).toBe(130);
    expect(preview.body.pricing.totalAmount).toBe(130);
    expect(preview.body.policy.requiresApproval).toBe(true);
    expect(preview.body.policy.reasons).toContain("discount_above_limit");

    const [saleCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.retailPosSales)
      .where(eq(schema.retailPosSales.companyId, companyId));
    expect(saleCount.count).toBe(0);
  });

  it("keeps walk-in checkouts exactly as Wave 1 priced them", async () => {
    const response = await cashier.post("/api/pos/retail/sales").send({
      locationId,
      idempotencyKey: "rw2cpt-walkin-001",
      items: [{ variantId: variantAId, quantity: 2 }],
    });
    expect(response.status).toBe(201);
    const sale = response.body.sale;
    expect(sale).toMatchObject({
      customerId: null,
      customerName: "Walk-in",
      listSubtotal: 200,
      discountTotal: 0,
      subtotal: 200,
      taxEnabled: false,
      taxAmount: 0,
      totalAmount: 200,
      orderDiscountAmount: 0,
    });
    expect(sale.items[0]).toMatchObject({
      originalUnitPrice: 100,
      unitPrice: 100,
      grossUnitPrice: 100,
      lineDiscountAmount: 0,
      taxAmount: 0,
      lineTotal: 200,
      priceOverride: false,
      promotionId: null,
    });
    expect(await variantQuantity(variantAId)).toBe(18);
  });

  it("quick-creates a customer, sells to them and exposes purchase/receipt history", async () => {
    const forbidden = await cashier.post("/api/retail/promotions").send({});
    // (customers are retail-scoped, not permission-gated)
    void forbidden;

    const created = await cashier
      .post("/api/pos/retail/customers")
      .send({ legalName: "Layla Haddad", phone: "03 123 456" });
    expect(created.status).toBe(201);
    expect(created.body.legalName).toBe("Layla Haddad");
    expect(created.body.code).toMatch(/^CUST\d+$/);

    const search = await cashier.get("/api/pos/retail/customers?search=3123456");
    expect(search.status).toBe(200);
    expect(search.body.map((row: { id: number }) => row.id)).toContain(created.body.id);

    const sale = await cashier.post("/api/pos/retail/sales").send({
      locationId,
      idempotencyKey: "rw2cpt-customer-001",
      customerId: created.body.id,
      items: [{ variantId: variantBId, quantity: 1 }],
    });
    expect(sale.status).toBe(201);
    expect(sale.body.sale.customerId).toBe(created.body.id);
    expect(sale.body.sale.customerName).toBe("Layla Haddad");

    const history = await cashier.get(`/api/pos/retail/customers/${created.body.id}/history`);
    expect(history.status).toBe(200);
    expect(history.body.summary.saleCount).toBe(1);
    expect(history.body.summary.totalSpent).toBe(50);
    expect(history.body.sales[0].id).toBe(sale.body.sale.id);

    const byReceipt = await cashier.get(`/api/pos/retail/sales/search?receipt=%23${sale.body.sale.id}`);
    expect(byReceipt.status).toBe(200);
    expect(byReceipt.body.map((entry: { id: number }) => entry.id)).toContain(sale.body.sale.id);

    const byBarcode = await cashier.get("/api/pos/retail/sales/search?barcode=RW2CPT-B");
    expect(byBarcode.body.map((entry: { id: number }) => entry.id)).toContain(sale.body.sale.id);

    const byCustomer = await cashier.get(`/api/pos/retail/sales/search?customerId=${created.body.id}`);
    expect(byCustomer.body).toHaveLength(1);
    expect(byCustomer.body[0].id).toBe(sale.body.sale.id);
  });

  it("snapshots line and whole-sale discounts without destroying the original price", async () => {
    await updateSettings({
      discountLimitPercent: 50,
      requireManagerApproval: true,
      priceOverrideRequiresApproval: true,
    });

    const response = await cashier.post("/api/pos/retail/sales").send({
      locationId,
      idempotencyKey: "rw2cpt-discount-001",
      orderDiscount: { type: "fixed", value: 10, reason: "Loyalty gesture" },
      items: [
        {
          variantId: variantAId,
          quantity: 1,
          discountType: "percent",
          discountValue: 10,
          discountReason: "Damaged hanger",
        },
      ],
    });
    expect(response.status).toBe(201);
    const sale = response.body.sale;
    expect(sale).toMatchObject({
      listSubtotal: 100,
      discountTotal: 20,
      subtotal: 80,
      orderDiscountType: "fixed",
      orderDiscountValue: 10,
      orderDiscountAmount: 10,
      orderDiscountReason: "Loyalty gesture",
      totalAmount: 80,
    });
    expect(sale.items[0]).toMatchObject({
      originalUnitPrice: 100,
      unitPrice: 80,
      grossUnitPrice: 80,
      lineDiscountAmount: 20,
      lineDiscountType: "percent",
      lineDiscountValue: 10,
      discountReason: "Damaged hanger",
      priceOverride: false,
    });

    const noReason = await cashier.post("/api/pos/retail/sales").send({
      locationId,
      idempotencyKey: "rw2cpt-discount-002",
      items: [{ variantId: variantAId, quantity: 1, discountType: "percent", discountValue: 10 }],
    });
    expect(noReason.status).toBe(400);
    expect(noReason.body.code).toBe("DISCOUNT_REASON_REQUIRED");
  });

  it("requires and consumes a manager approval above the configured limit", async () => {
    await updateSettings({ discountLimitPercent: 5 });

    const cart = {
      locationId,
      items: [
        {
          variantId: variantAId,
          quantity: 1,
          discountType: "percent" as const,
          discountValue: 20,
          discountReason: "Clearance",
        },
      ],
    };

    const blocked = await cashier
      .post("/api/pos/retail/sales")
      .send({ ...cart, idempotencyKey: "rw2cpt-approval-001" });
    expect(blocked.status).toBe(428);
    expect(blocked.body.code).toBe("DISCOUNT_APPROVAL_REQUIRED");
    expect(blocked.body.reasons).toContain("discount_above_limit");

    const wrongPassword = await cashier.post("/api/pos/retail/discount-approvals").send({
      managerUsername: `${TEST_PREFIX}_manager`,
      managerPassword: "not-the-password",
      ...cart,
    });
    expect(wrongPassword.status).toBe(401);

    const approval = await cashier.post("/api/pos/retail/discount-approvals").send({
      managerUsername: `${TEST_PREFIX}_manager`,
      managerPassword: MANAGER_PASSWORD,
      reason: "Clearance",
      ...cart,
    });
    expect(approval.status).toBe(201);
    expect(approval.body.allowsPriceOverride).toBe(false);
    expect(approval.body.maxDiscountPercent).toBeCloseTo(20, 5);

    const approved = await cashier
      .post("/api/pos/retail/sales")
      .send({ ...cart, idempotencyKey: "rw2cpt-approval-001", approvalToken: approval.body.approvalToken });
    expect(approved.status).toBe(201);
    expect(approved.body.sale.approvedByName).toBe(`${TEST_PREFIX}_manager`);
    expect(approved.body.sale.items[0].unitPrice).toBe(80);

    // Replaying the same sale with the same token is an idempotent retry.
    const replay = await cashier
      .post("/api/pos/retail/sales")
      .send({ ...cart, idempotencyKey: "rw2cpt-approval-001", approvalToken: approval.body.approvalToken });
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);

    // The same approval cannot pay for a second sale with a different cart…
    const differentCart = await cashier.post("/api/pos/retail/sales").send({
      ...cart,
      idempotencyKey: "rw2cpt-approval-002",
      items: [{ ...cart.items[0], quantity: 2 }],
      approvalToken: approval.body.approvalToken,
    });
    expect(differentCart.status).toBe(428);
    expect(differentCart.body.code).toBe("DISCOUNT_APPROVAL_INVALID");

    // …nor for the same cart under a new idempotency key.
    const reused = await cashier
      .post("/api/pos/retail/sales")
      .send({ ...cart, idempotencyKey: "rw2cpt-approval-003", approvalToken: approval.body.approvalToken });
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe("DISCOUNT_APPROVAL_ALREADY_USED");
  });

  it("refuses a legacy SHA-256 manager hash instead of comparing it weakly", async () => {
    const { randomBytes } = await import("node:crypto");
    const bcrypt = await import("bcryptjs");
    // A legacy row stores a 64-hex digest. The value is random on purpose: the approval
    // path must refuse the shape outright, without ever comparing a weak digest — so the
    // test asserts the shape rather than computing an insecure hash of the password.
    const legacyShapedHash = randomBytes(32).toString("hex");
    expect(legacyShapedHash).toMatch(/^[a-f0-9]{64}$/);
    await db.update(schema.users).set({ password: legacyShapedHash }).where(eq(schema.users.id, managerId));
    try {
      const response = await cashier.post("/api/pos/retail/discount-approvals").send({
        managerUsername: `${TEST_PREFIX}_manager`,
        managerPassword: MANAGER_PASSWORD,
        locationId,
        items: [{ variantId: variantAId, quantity: 1, discountType: "percent", discountValue: 20 }],
      });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe("MANAGER_PASSWORD_RESET_REQUIRED");
    } finally {
      await db
        .update(schema.users)
        .set({ password: await bcrypt.hash(MANAGER_PASSWORD, 10) })
        .where(eq(schema.users.id, managerId));
    }
  });

  it("requires approval for manual price overrides and keeps the original price", async () => {
    await updateSettings({ discountLimitPercent: 50, priceOverrideRequiresApproval: true });
    const cart = {
      locationId,
      items: [{ variantId: variantBId, quantity: 1, priceOverride: 25, discountReason: "Price match" }],
    };

    const blocked = await cashier
      .post("/api/pos/retail/sales")
      .send({ ...cart, idempotencyKey: "rw2cpt-override-001" });
    expect(blocked.status).toBe(428);
    expect(blocked.body.reasons).toContain("price_override");

    const approval = await cashier.post("/api/pos/retail/discount-approvals").send({
      managerUsername: `${TEST_PREFIX}_manager`,
      managerPassword: MANAGER_PASSWORD,
      reason: "Price match",
      ...cart,
    });
    expect(approval.status).toBe(201);
    expect(approval.body.allowsPriceOverride).toBe(true);

    const sale = await cashier
      .post("/api/pos/retail/sales")
      .send({ ...cart, idempotencyKey: "rw2cpt-override-001", approvalToken: approval.body.approvalToken });
    expect(sale.status).toBe(201);
    expect(sale.body.sale.items[0]).toMatchObject({
      originalUnitPrice: 50,
      unitPrice: 25,
      grossUnitPrice: 25,
      priceOverride: true,
      lineDiscountType: "override",
      lineDiscountAmount: 25,
      approvedByUserId: managerId,
    });
  });

  it("applies active promotions automatically and shows them in the item payload", async () => {
    const asCashier = await cashier.post("/api/retail/promotions").send({
      name: "Cashier cannot create",
      scope: "all",
      discountType: "percent",
      value: 5,
    });
    expect(asCashier.status).toBe(403);

    const promotion = await manager.post("/api/retail/promotions").send({
      name: "Wave 2 promo",
      scope: "variant",
      variantId: variantBId,
      discountType: "percent",
      value: 10,
      startsAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(promotion.status).toBe(201);

    const items = await cashier.get(`/api/pos/retail/items?locationId=${locationId}&search=RW2CPT-B`);
    expect(items.status).toBe(200);
    expect(items.body[0].promotion).toMatchObject({ id: promotion.body.id, discountType: "percent", value: 10 });
    expect(items.body[0].promotion.promotionPrice).toBe(45);

    await updateSettings({ discountLimitPercent: 5 });
    const sale = await cashier.post("/api/pos/retail/sales").send({
      locationId,
      idempotencyKey: "rw2cpt-promo-001",
      items: [{ variantId: variantBId, quantity: 1 }],
    });
    expect(sale.status).toBe(201);
    expect(sale.body.sale.items[0]).toMatchObject({
      originalUnitPrice: 50,
      unitPrice: 45,
      promotionId: promotion.body.id,
      lineDiscountType: "promotion",
      lineDiscountAmount: 5,
    });

    const deactivated = await manager.delete(`/api/retail/promotions/${promotion.body.id}`);
    expect(deactivated.status).toBe(200);
    const afterEnd = await cashier.post("/api/pos/retail/sales").send({
      locationId,
      idempotencyKey: "rw2cpt-promo-002",
      items: [{ variantId: variantBId, quantity: 1 }],
    });
    expect(afterEnd.body.sale.items[0].promotionId).toBeNull();
    expect(afterEnd.body.sale.items[0].unitPrice).toBe(50);
  });

  it("adds exclusive tax on top of the discounted price", async () => {
    await updateSettings({ taxEnabled: true, taxRate: 0.18, taxInclusive: false, discountLimitPercent: 50 });
    const sale = await cashier.post("/api/pos/retail/sales").send({
      locationId,
      idempotencyKey: "rw2cpt-tax-exclusive-001",
      items: [
        {
          variantId: variantAId,
          quantity: 2,
          discountType: "percent",
          discountValue: 10,
          discountReason: "Seasonal",
        },
      ],
    });
    expect(sale.status).toBe(201);
    const body = sale.body.sale;
    expect(body.taxEnabled).toBe(true);
    expect(body.taxRate).toBeCloseTo(0.18, 5);
    expect(body.subtotal).toBe(180);
    expect(body.taxAmount).toBe(32.4);
    expect(body.totalAmount).toBe(212.4);
    expect(body.items[0].grossUnitPrice).toBe(106.2);
    expect(body.items[0].taxAmount).toBe(32.4);
    expect(Number((body.subtotal + body.taxAmount).toFixed(6))).toBe(body.totalAmount);

    const returned = await cashier.post(`/api/pos/retail/sales/${body.id}/returns`).send({
      locationId,
      idempotencyKey: "rw2cpt-tax-return-001",
      items: [{ saleItemId: body.items[0].id, quantity: 1 }],
    });
    expect(returned.status).toBe(201);
    expect(returned.body.refundAmount).toBe(106.2);
    expect(returned.body.refundTaxAmount).toBe(16.2);

    // Revenue is booked net of tax; the tax goes to Retail Tax Payable, and a return reverses both.
    expect(body.accountingVoucherId).toBeGreaterThan(0);
    const saleJournal = await retailJournal(body.accountingVoucherId);
    expect(saleJournal["RETAIL-SALES"]).toBe(-180);
    expect(saleJournal["RETAIL-TAX"]).toBe(-32.4);
    const [returnPosting] = await db
      .select({ voucherId: schema.accountingPostingRequests.voucherId })
      .from(schema.accountingPostingRequests)
      .where(
        and(
          eq(schema.accountingPostingRequests.companyId, companyId),
          eq(schema.accountingPostingRequests.sourceType, "retail-pos-return"),
          eq(schema.accountingPostingRequests.sourceId, String(returned.body.returnId))
        )
      )
      .limit(1);
    const returnJournal = await retailJournal(Number(returnPosting?.voucherId));
    expect(returnJournal["RETAIL-SALES"]).toBe(90);
    expect(returnJournal["RETAIL-TAX"]).toBe(16.2);
    expect(await variantQuantity(variantAId)).toBeGreaterThan(0);

    const [storedSale] = await db
      .select({ totalAmount: schema.retailPosSales.totalAmount })
      .from(schema.retailPosSales)
      .where(eq(schema.retailPosSales.id, body.id))
      .limit(1);
    expect(Number(storedSale.totalAmount)).toBe(212.4);
  });

  it("carves inclusive tax out of the price the customer pays", async () => {
    await updateSettings({ taxEnabled: true, taxRate: 0.18, taxInclusive: true });
    const sale = await cashier.post("/api/pos/retail/sales").send({
      locationId,
      idempotencyKey: "rw2cpt-tax-inclusive-001",
      items: [{ variantId: variantBId, quantity: 1 }],
    });
    expect(sale.status).toBe(201);
    // 50 is the shelf price; tax carves out of it instead of being added on top.
    const body = sale.body.sale;
    expect(body.taxInclusive).toBe(true);
    expect(body.totalAmount).toBe(50);
    expect(Number((body.subtotal + body.taxAmount).toFixed(6))).toBe(50);
    expect(body.items[0].grossUnitPrice).toBe(50);
    expect(body.items[0].unitPrice).toBeCloseTo(42.37, 2);

    await updateSettings({ taxEnabled: false });
  });
});
