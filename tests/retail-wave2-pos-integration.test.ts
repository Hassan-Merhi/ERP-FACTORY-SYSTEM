import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { KNOWN_SECURITY_PERMISSIONS } from "../server/services/security/namedPermissionService";
import { getRetailReconciliationReport } from "../server/services/retail/retailReconciliationService";
import { cleanupTestData, closeTestServer, setupTestApp } from "./setup";

const TEST_PREFIX = "retailposwave2";
const describeWithDatabase = process.env.DATABASE_URL ? describe : describe.skip;

let app: Awaited<ReturnType<typeof setupTestApp>>;
let agent: request.SuperAgentTest;
let companyId = 0;
let locationId = 0;
let otherLocationId = 0;
let variantId = 0;
let replacementVariantId = 0;
let userId = "";
let ledgerAccountIds: Partial<Record<(typeof schema.RETAIL_ACCOUNT_KEYS)[number], number>> = {};

async function purgeRetailRowsForFixture(): Promise<void> {
  const companies = await db
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .where(sql`${schema.companies.name} LIKE ${`%${TEST_PREFIX}%`}`);

  for (const company of companies) {
    const params = [company.id];
    await pool.query("DELETE FROM retail_pos_payments WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_cash_movements WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_accounting_postings WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_pos_return_items WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_pos_returns WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_pos_sale_items WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_pos_sales WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_cashier_shifts WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_account_mappings WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_stock_movements WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_stock_operations WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_variant_inventory WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_product_variants WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_products WHERE company_id = $1", params);
    await pool.query("DELETE FROM retail_brands WHERE company_id = $1", params);
  }
}

async function retailQuantityFor(readVariantId: number): Promise<number> {
  const [row] = await db
    .select({ quantity: schema.retailVariantInventory.quantity })
    .from(schema.retailVariantInventory)
    .where(
      and(
        eq(schema.retailVariantInventory.companyId, companyId),
        eq(schema.retailVariantInventory.variantId, readVariantId),
        eq(schema.retailVariantInventory.locationId, locationId)
      )
    )
    .limit(1);
  return Number(row?.quantity ?? 0);
}

async function retailQuantity(): Promise<number> {
  return retailQuantityFor(variantId);
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
    const retailAccountTypeByKey: Record<(typeof schema.RETAIL_ACCOUNT_KEYS)[number], string> = {
      cash: "Cash",
      card_clearing: "Asset",
      bank: "Bank",
      sales_revenue: "Income",
      inventory_asset: "Asset",
      cogs: "Direct Expense",
      discounts: "Direct Expense",
      tax_payable: "Liability",
      store_credit_liability: "Liability",
    };
    const retailLedgerAccounts = await db
      .insert(schema.ledgerAccounts)
      .values(
        schema.RETAIL_ACCOUNT_KEYS.map((accountKey) => ({
          companyId,
          code: `RWP2-${accountKey}`,
          name: `Retail ${accountKey}`,
          accountType: retailAccountTypeByKey[accountKey],
        }))
      )
      .returning({ id: schema.ledgerAccounts.id });
    ledgerAccountIds = Object.fromEntries(
      schema.RETAIL_ACCOUNT_KEYS.map((accountKey, index) => [accountKey, retailLedgerAccounts[index].id])
    );
    await db.insert(schema.retailAccountMappings).values(
      schema.RETAIL_ACCOUNT_KEYS.map((accountKey, index) => ({
        companyId,
        accountKey,
        ledgerAccountId: retailLedgerAccounts[index].id,
        updatedBy: userId,
      }))
    );
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
    const [otherLocation] = await db
      .insert(schema.locations)
      .values({ companyId, code: "RWP2-OTHER", name: "Retail Wave 2 Other" })
      .returning({ id: schema.locations.id });
    otherLocationId = otherLocation.id;

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

    const [replacementVariant] = await db
      .insert(schema.retailProductVariants)
      .values({
        companyId,
        productId: product.id,
        color: "Blue",
        size: "L",
        barcode: "RWP2-BARCODE-002",
        sku: "RWP2-TEE-L",
        imageUrls: ["https://example.com/retail-wave2-tee-blue.jpg"],
        cost: "5.000000",
        sellingPrice: "12.000000",
      })
      .returning({ id: schema.retailProductVariants.id });
    replacementVariantId = replacementVariant.id;

    await db.insert(schema.retailVariantInventory).values([
      { companyId, variantId, locationId, quantity: "5.000000", averageCost: "4.000000" },
      { companyId, variantId, locationId: otherLocationId, quantity: "7.000000", averageCost: "4.000000" },
      { companyId, variantId: replacementVariantId, locationId, quantity: "5.000000", averageCost: "5.000000" },
    ]);

    agent = request.agent(app);
    const login = await agent.post("/api/auth/login").send({
      username: `${TEST_PREFIX}_testuser`,
      password: "testpassword123",
    });
    expect(login.status).toBe(200);

    const companySwitch = await agent.post("/api/auth/set-company").send({ companyId });
    expect(companySwitch.status).toBe(200);
    const openedShift = await agent.post("/api/pos/retail/shifts/open").send({
      locationId,
      openingCash: 0,
      idempotencyKey: "retail-wave2-integration-shift-001",
    });
    expect(openedShift.status).toBe(201);
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
      otherLocations: [],
    });
    const otherLocationItems = await agent.get(`/api/pos/retail/items?locationId=${otherLocationId}`);
    expect(otherLocationItems.status).not.toBe(200);
    const otherLocationBarcode = await agent.get(
      `/api/pos/retail/barcodes/RWP2-BARCODE-001?locationId=${otherLocationId}`
    );
    expect(otherLocationBarcode.status).not.toBe(200);
    const otherLocationMovements = await agent.get(`/api/pos/retail/movements?locationId=${otherLocationId}`);
    expect(otherLocationMovements.status).not.toBe(200);

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

    const saleBody = {
      locationId,
      idempotencyKey: "retail-wave2-integration-sale-001",
      items: [{ variantId: scan.body.variantId, quantity: 2 }],
      discountAmount: 1,
      taxAmount: 1,
      payments: [
        { method: "cash", amount: 7, amountTendered: 10, reference: "drawer-0001" },
        { method: "card", amount: 13, reference: "auth-0001" },
      ],
    };

    const sale = await agent.post("/api/pos/retail/sales").send(saleBody);
    expect(sale.status).toBe(201);
    expect(sale.body.replayed).toBe(false);
    expect(sale.body.sale.locationId).toBe(locationId);
    expect(sale.body.checkout.id).toBe(sale.body.sale.id);
    expect(sale.body.checkout).toEqual(sale.body.sale);
    expect(sale.body.sale.subtotalAmount).toBe(20);
    expect(sale.body.sale.discountAmount).toBe(1);
    expect(sale.body.sale.taxAmount).toBe(1);
    expect(sale.body.sale.totalAmount).toBe(20);
    expect(sale.body.sale.payments).toEqual([
      expect.objectContaining({
        method: "cash",
        amount: 7,
        amountTendered: 10,
        changeDue: 3,
        reference: "drawer-0001",
        locationId,
        shiftId: expect.any(Number),
        cashierId: userId,
      }),
      expect.objectContaining({ method: "card", amount: 13, reference: "auth-0001", locationId, cashierId: userId }),
    ]);
    expect(sale.body.sale.changeDue).toBe(3);
    expect(sale.body.sale.accountingVoucherId).toEqual(expect.any(Number));
    const saleEntries = await db
      .select({
        ledgerAccountId: schema.voucherEntries.ledgerAccountId,
        debitAmount: schema.voucherEntries.debitAmount,
        creditAmount: schema.voucherEntries.creditAmount,
      })
      .from(schema.voucherEntries)
      .where(eq(schema.voucherEntries.voucherId, sale.body.sale.accountingVoucherId));
    const entryAmount = (
      accountKey: (typeof schema.RETAIL_ACCOUNT_KEYS)[number],
      side: "debitAmount" | "creditAmount"
    ) => Number(saleEntries.find((entry) => entry.ledgerAccountId === ledgerAccountIds[accountKey])?.[side] ?? 0);
    expect(entryAmount("cash", "debitAmount")).toBe(7);
    expect(entryAmount("card_clearing", "debitAmount")).toBe(13);
    expect(entryAmount("sales_revenue", "creditAmount")).toBe(20);
    expect(entryAmount("discounts", "debitAmount")).toBe(1);
    expect(entryAmount("tax_payable", "creditAmount")).toBe(1);
    expect(entryAmount("cogs", "debitAmount")).toBe(8);
    expect(entryAmount("inventory_asset", "creditAmount")).toBe(8);
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

    const saleReplay = await agent.post("/api/pos/retail/sales").send(saleBody);
    expect(saleReplay.status).toBe(200);
    expect(saleReplay.body.replayed).toBe(true);
    expect(saleReplay.body.sale.id).toBe(sale.body.sale.id);
    expect(await retailQuantity()).toBe(3);
    const changedTenderRetry = await agent.post("/api/pos/retail/sales").send({
      ...saleBody,
      payments: [
        { method: "cash", amount: 8, amountTendered: 8 },
        { method: "card", amount: 12 },
      ],
    });
    expect(changedTenderRetry.status).toBe(400);
    expect(changedTenderRetry.body.message).toContain("RETAIL_IDEMPOTENCY_CONFLICT");
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
    expect(returned.body.refundAmount).toBe("20.00");
    expect(returned.body.sale.payments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operationType: "refund", method: "cash", amount: -7, reference: "drawer-0001" }),
        expect.objectContaining({ operationType: "refund", method: "card", amount: -13, reference: "auth-0001" }),
      ])
    );
    expect(await retailQuantity()).toBe(5);

    const returnReplay = await agent.post(`/api/pos/retail/sales/${sale.body.sale.id}/returns`).send(returnBody);
    expect(returnReplay.status).toBe(200);
    expect(returnReplay.body.replayed).toBe(true);
    expect(await retailQuantity()).toBe(5);

    const cashInBody = {
      direction: "cash_in",
      amount: 5,
      reason: "Change float top-up",
      idempotencyKey: "retail-wave2-integration-cashin-001",
    };
    const cashIn = await agent.post(`/api/pos/retail/shifts/${sale.body.sale.shiftId}/cash-movements`).send(cashInBody);
    expect(cashIn.status).toBe(201);
    const cashInReplay = await agent
      .post(`/api/pos/retail/shifts/${sale.body.sale.shiftId}/cash-movements`)
      .send(cashInBody);
    expect(cashInReplay.status).toBe(200);
    expect(cashInReplay.body.replayed).toBe(true);

    const cashOut = await agent.post(`/api/pos/retail/shifts/${sale.body.sale.shiftId}/cash-movements`).send({
      direction: "cash_out",
      amount: 5,
      reason: "Return unused float",
      idempotencyKey: "retail-wave2-integration-cashout-001",
    });
    expect(cashOut.status).toBe(201);

    const cancellationSale = await agent.post("/api/pos/retail/sales").send({
      locationId,
      idempotencyKey: "retail-wave2-integration-cancel-sale-001",
      items: [{ variantId, quantity: 1 }],
      payments: [{ method: "cash", amount: 10, amountTendered: 10 }],
    });
    expect(cancellationSale.status).toBe(201);
    const cancellationBody = {
      locationId,
      idempotencyKey: "retail-wave2-integration-cancel-001",
      reason: "Customer changed mind",
      refundMethod: "cash",
    };
    const canceled = await agent
      .post(`/api/pos/retail/sales/${cancellationSale.body.sale.id}/cancel`)
      .send(cancellationBody);
    expect(canceled.status).toBe(201);
    expect(canceled.body.sale.status).toBe("canceled");
    expect(canceled.body.sale.payments).toEqual(
      expect.arrayContaining([expect.objectContaining({ operationType: "cancellation", method: "cash", amount: -10 })])
    );
    expect(await retailQuantity()).toBe(5);
    const cancellationReplay = await agent
      .post(`/api/pos/retail/sales/${cancellationSale.body.sale.id}/cancel`)
      .send(cancellationBody);
    expect(cancellationReplay.status).toBe(200);
    expect(cancellationReplay.body.replayed).toBe(true);

    const exchangeBaseSale = await agent.post("/api/pos/retail/sales").send({
      locationId,
      idempotencyKey: "retail-wave2-integration-exchange-base-001",
      items: [{ variantId, quantity: 1 }],
      payments: [{ method: "cash", amount: 10 }],
    });
    expect(exchangeBaseSale.status).toBe(201);
    const exchangeBody = {
      locationId,
      saleId: exchangeBaseSale.body.sale.id,
      idempotencyKey: "retail-wave2-integration-exchange-001",
      returnItems: [{ saleItemId: exchangeBaseSale.body.sale.items[0].id, quantity: 1 }],
      newItems: [{ variantId: replacementVariantId, quantity: 1 }],
    };
    const exchange = await agent.post("/api/pos/retail/exchanges").send(exchangeBody);
    expect(exchange.status).toBe(201);
    expect(exchange.body.refundValue).toBe("10.00");
    expect(exchange.body.balanceDue).toBe("2.00");
    expect(exchange.body.checkout.payments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "store_credit", amount: 10 }),
        expect.objectContaining({ method: "cash", amount: 2 }),
      ])
    );
    expect(await retailQuantity()).toBe(5);
    expect(await retailQuantityFor(replacementVariantId)).toBe(4);
    const exchangeRetry = await agent.post("/api/pos/retail/exchanges").send(exchangeBody);
    expect(exchangeRetry.status).toBe(200);
    expect(exchangeRetry.body.replayed).toBe(true);
    const changedExchangeRetry = await agent.post("/api/pos/retail/exchanges").send({
      ...exchangeBody,
      newItems: [{ variantId: replacementVariantId, quantity: 2 }],
    });
    expect(changedExchangeRetry.status).toBe(400);
    expect(changedExchangeRetry.body.message).toContain("RETAIL_IDEMPOTENCY_CONFLICT");
    expect(await retailQuantity()).toBe(5);

    const postings = await db
      .select({
        saleId: schema.retailAccountingPostings.saleId,
        referenceKey: schema.retailAccountingPostings.referenceKey,
        postingType: schema.retailAccountingPostings.postingType,
      })
      .from(schema.retailAccountingPostings)
      .where(eq(schema.retailAccountingPostings.companyId, companyId));
    expect(postings.map((posting) => posting.postingType)).toEqual(
      expect.arrayContaining(["sale", "return", "cancellation"])
    );
    expect(postings.every((posting) => posting.referenceKey.includes(String(posting.saleId)))).toBe(true);
    const reconciliation = await getRetailReconciliationReport({ companyId, locationId });
    expect(reconciliation.hasMismatch).toBe(false);
    expect(reconciliation.status).toBe("RECONCILED");

    const shiftReport = await agent.get(`/api/pos/retail/shifts/${sale.body.sale.shiftId}/report`);
    expect(shiftReport.status).toBe(200);
    expect(shiftReport.body.cashSalesTotal).toBe(29);
    expect(shiftReport.body.refundTotal).toBe(17);
    expect(shiftReport.body.cashInTotal).toBe(5);
    expect(shiftReport.body.cashOutTotal).toBe(5);
    const methodTotals = Object.fromEntries(
      shiftReport.body.paymentMethodTotals.map((total: { method: string; sales: number; refunds: number }) => [
        total.method,
        total,
      ])
    );
    expect(methodTotals.cash).toMatchObject({ sales: 29, refunds: 17, net: 12 });
    expect(methodTotals.card).toMatchObject({ sales: 13, refunds: 13, net: 0 });
    expect(methodTotals.store_credit).toMatchObject({ sales: 10, refunds: 10, net: 0 });

    const closedShift = await agent
      .post(`/api/pos/retail/shifts/${sale.body.sale.shiftId}/close`)
      .send({ actualCountedCash: 12 });
    expect(closedShift.status).toBe(200);
    expect(closedShift.body.expectedClosingCash).toBe("12.00");
    expect(closedShift.body.variance).toBe("0.00");
    const saleReplayAfterClose = await agent.post("/api/pos/retail/sales").send(saleBody);
    expect(saleReplayAfterClose.status).toBe(200);
    expect(saleReplayAfterClose.body.replayed).toBe(true);
    expect(await retailQuantity()).toBe(5);

    const movements = await db
      .select({
        type: schema.retailStockMovements.movementType,
        delta: schema.retailStockMovements.quantityDelta,
        before: schema.retailStockMovements.quantityBefore,
        after: schema.retailStockMovements.quantityAfter,
        referenceId: schema.retailStockMovements.referenceId,
        metadata: schema.retailStockMovements.metadata,
      })
      .from(schema.retailStockMovements)
      .where(
        and(
          eq(schema.retailStockMovements.companyId, companyId),
          eq(schema.retailStockMovements.variantId, variantId),
          eq(schema.retailStockMovements.locationId, locationId)
        )
      );

    const originalSaleMovements = movements.filter(
      (movement) =>
        movement.referenceId === sale.body.sale.id || Number(movement.metadata?.saleId ?? 0) === sale.body.sale.id
    );
    expect(originalSaleMovements).toHaveLength(2);
    expect(originalSaleMovements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "sale", delta: "-2.000000", before: "5.000000", after: "3.000000" }),
        expect.objectContaining({ type: "return", delta: "2.000000", before: "3.000000", after: "5.000000" }),
      ])
    );
    const posMovements = await agent.get("/api/pos/retail/movements");
    expect(posMovements.status).toBe(200);
    expect(posMovements.body.every((movement: { locationId: number }) => movement.locationId === locationId)).toBe(
      true
    );

    const nextShift = await agent.post("/api/pos/retail/shifts/open").send({
      locationId,
      openingCash: 0,
      idempotencyKey: "retail-wave2-integration-shift-002",
    });
    expect(nextShift.status).toBe(201);
    const [legacySale] = await db
      .insert(schema.retailPosSales)
      .values({
        companyId,
        locationId,
        idempotencyKey: "retail-wave2-legacy-sale-001",
        status: "completed",
        totalAmount: "10.000000",
        createdBy: userId,
      })
      .returning({ id: schema.retailPosSales.id });
    const [legacySaleItem] = await db
      .insert(schema.retailPosSaleItems)
      .values({
        companyId,
        saleId: legacySale.id,
        variantId,
        quantity: "1.000000",
        returnedQuantity: "0.000000",
        unitPrice: "10.000000",
        unitCost: "4.000000",
      })
      .returning({ id: schema.retailPosSaleItems.id });
    await db
      .update(schema.retailVariantInventory)
      .set({ quantity: "4.000000" })
      .where(
        and(
          eq(schema.retailVariantInventory.companyId, companyId),
          eq(schema.retailVariantInventory.variantId, variantId),
          eq(schema.retailVariantInventory.locationId, locationId)
        )
      );
    const legacyExchange = await agent.post("/api/pos/retail/exchanges").send({
      locationId,
      saleId: legacySale.id,
      idempotencyKey: "retail-wave2-legacy-exchange-001",
      returnItems: [{ saleItemId: legacySaleItem.id, quantity: 1 }],
      newItems: [{ variantId: replacementVariantId, quantity: 1 }],
    });
    expect(legacyExchange.status).toBe(201);
    expect(legacyExchange.body.refundValue).toBe("10.00");
    expect(legacyExchange.body.checkout.payments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "store_credit", amount: 10 }),
        expect.objectContaining({ method: "cash", amount: 2 }),
      ])
    );
    expect(await retailQuantity()).toBe(5);
    expect(await retailQuantityFor(replacementVariantId)).toBe(3);
    const legacyPostings = await db
      .select({ postingType: schema.retailAccountingPostings.postingType })
      .from(schema.retailAccountingPostings)
      .where(eq(schema.retailAccountingPostings.saleId, legacySale.id));
    expect(legacyPostings).toEqual([expect.objectContaining({ postingType: "return" })]);
    const nextShiftReport = await agent.get(`/api/pos/retail/shifts/${nextShift.body.shift.id}/report`);
    expect(nextShiftReport.status).toBe(200);
    expect(nextShiftReport.body.cashSalesTotal).toBe(2);
    expect(nextShiftReport.body.refundTotal).toBe(0);
    const finalReconciliation = await getRetailReconciliationReport({ companyId, locationId });
    expect(finalReconciliation.status).toBe("RECONCILED");
  }, 30_000);
});
