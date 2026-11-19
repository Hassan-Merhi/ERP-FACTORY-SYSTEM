// Extracted from ./erpContext.ts: a stage of erpContext.
import { db } from "../db";
import * as schema from "@shared/schema";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";

export async function erpContextStep({ companyId }: { companyId: number }) {
  // Capture exact timestamp when data fetch begins - this is REAL-TIME data
  const dataFetchedAt = new Date().toISOString();

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const [
    inventory,
    stockItems,
    stockGroups,
    ledgerAccounts,
    suppliers,
    customers,
    locations,
    recentVouchers,
    purchaseOrders,
    containerSales,
  ] = await Promise.all([
    db
      .select({
        stockItemId: schema.inventory.stockItemId,
        locationId: schema.inventory.locationId,
        quantity: schema.inventory.quantity,
        averageRate: schema.inventory.averageRate,
        totalValue: schema.inventory.totalValue,
      })
      .from(schema.inventory)
      .where(eq(schema.inventory.companyId, companyId)),

    db
      .select({
        id: schema.stockItems.id,
        code: schema.stockItems.code,
        name: schema.stockItems.name,
        stockGroupId: schema.stockItems.stockGroupId,
        sellingPrice: schema.stockItems.sellingPrice,
        reorderLevel: schema.stockItems.reorderLevel,
      })
      .from(schema.stockItems)
      .where(and(eq(schema.stockItems.companyId, companyId), eq(schema.stockItems.active, true))),

    db
      .select({
        id: schema.stockGroups.id,
        code: schema.stockGroups.code,
        name: schema.stockGroups.name,
      })
      .from(schema.stockGroups)
      .where(eq(schema.stockGroups.companyId, companyId)),

    db
      .select({
        id: schema.ledgerAccounts.id,
        code: schema.ledgerAccounts.code,
        name: schema.ledgerAccounts.name,
        accountType: schema.ledgerAccounts.accountType,
        openingBalance: schema.ledgerAccounts.openingBalance,
      })
      .from(schema.ledgerAccounts)
      .where(and(eq(schema.ledgerAccounts.companyId, companyId), eq(schema.ledgerAccounts.active, true))),

    db
      .select({
        id: schema.suppliers.id,
        code: schema.suppliers.code,
        legalName: schema.suppliers.legalName,
        phone: schema.suppliers.phone,
        email: schema.suppliers.email,
      })
      .from(schema.suppliers)
      .where(eq(schema.suppliers.active, true)),

    db
      .select({
        id: schema.customers.id,
        code: schema.customers.code,
        legalName: schema.customers.legalName,
        phone: schema.customers.phone,
      })
      .from(schema.customers)
      .where(and(eq(schema.customers.companyId, companyId), eq(schema.customers.active, true))),

    db
      .select({
        id: schema.locations.id,
        code: schema.locations.code,
        name: schema.locations.name,
        city: schema.locations.city,
      })
      .from(schema.locations)
      .where(and(eq(schema.locations.companyId, companyId), eq(schema.locations.active, true))),

    db
      .select({
        id: schema.vouchers.id,
        voucherNumber: schema.vouchers.voucherNumber,
        voucherType: schema.vouchers.voucherType,
        voucherDate: schema.vouchers.voucherDate,
        totalAmount: schema.vouchers.totalAmount,
        description: schema.vouchers.description,
      })
      .from(schema.vouchers)
      .where(and(eq(schema.vouchers.companyId, companyId), isNull(schema.vouchers.deletedAt)))
      .orderBy(desc(schema.vouchers.createdAt))
      .limit(200),

    db
      .select({
        id: schema.purchaseOrders.id,
        poNumber: schema.purchaseOrders.poNumber,
        supplierId: schema.purchaseOrders.supplierId,
        status: schema.purchaseOrders.status,
        itemsTotal: schema.purchaseOrders.itemsTotal,
        freight: schema.purchaseOrders.freight,
        currency: schema.purchaseOrders.currency,
        createdAt: schema.purchaseOrders.createdAt,
      })
      .from(schema.purchaseOrders)
      .where(eq(schema.purchaseOrders.companyId, companyId))
      .orderBy(desc(schema.purchaseOrders.createdAt)),

    db
      .select({
        id: schema.containerSales.id,
        containerId: schema.containerSales.containerId,
        customerId: schema.containerSales.customerId,
        containerCost: schema.containerSales.containerCost,
        commission: schema.containerSales.commission,
        totalAmount: schema.containerSales.totalAmount,
        paymentStatus: schema.containerSales.paymentStatus,
        paidAmount: schema.containerSales.paidAmount,
        saleDate: schema.containerSales.saleDate,
      })
      .from(schema.containerSales)
      .where(eq(schema.containerSales.companyId, companyId))
      .orderBy(desc(schema.containerSales.saleDate)),
  ]);

  const salesSummary = await db
    .select({
      totalSales: sql<string>`COALESCE(SUM(CAST(${schema.vouchers.totalAmount} AS NUMERIC)), 0)`,
      count: sql<number>`COUNT(*)`,
    })
    .from(schema.vouchers)
    .where(
      and(
        eq(schema.vouchers.companyId, companyId),
        eq(schema.vouchers.voucherType, "Receipt"),
        isNull(schema.vouchers.deletedAt)
      )
    );

  const profitAnalysis = await db
    .select({
      totalSales: sql<string>`COALESCE(SUM(CAST(${schema.salesItems.totalSales} AS NUMERIC)), 0)`,
      totalCost: sql<string>`COALESCE(SUM(CAST(${schema.salesItems.totalCost} AS NUMERIC)), 0)`,
      totalProfit: sql<string>`COALESCE(SUM((CAST(${schema.salesItems.totalSales} AS NUMERIC) - CAST(${schema.salesItems.totalCost} AS NUMERIC))), 0)`,
      itemsSold: sql<number>`COUNT(*)`,
    })
    .from(schema.salesItems)
    .innerJoin(schema.vouchers, eq(schema.salesItems.voucherId, schema.vouchers.id))
    .where(and(eq(schema.vouchers.companyId, companyId), isNull(schema.vouchers.deletedAt)));

  // ── Today's sales ──────────────────────────────────────────────────
  const todayStr = new Date().toISOString().split("T")[0];
  const monthStartStr = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split("T")[0];

  const [todaysSalesRaw, thisMonthSalesRaw, itemProfitabilityRaw] = await Promise.all([
    db
      .select({
        revenue: sql<string>`COALESCE(SUM(CAST(${schema.salesItems.totalSales} AS NUMERIC)), 0)`,
        cost: sql<string>`COALESCE(SUM(CAST(${schema.salesItems.totalCost} AS NUMERIC)), 0)`,
        profit: sql<string>`COALESCE(SUM((CAST(${schema.salesItems.totalSales} AS NUMERIC) - CAST(${schema.salesItems.totalCost} AS NUMERIC))), 0)`,
        transactionCount: sql<number>`COUNT(DISTINCT ${schema.salesItems.voucherId})`,
        unitsSold: sql<string>`COALESCE(SUM(CAST(${schema.salesItems.quantity} AS NUMERIC)), 0)`,
      })
      .from(schema.salesItems)
      .innerJoin(schema.vouchers, eq(schema.salesItems.voucherId, schema.vouchers.id))
      .where(
        and(
          eq(schema.vouchers.companyId, companyId),
          eq(schema.vouchers.voucherDate, todayStr),
          isNull(schema.vouchers.deletedAt)
        )
      ),

    db
      .select({
        revenue: sql<string>`COALESCE(SUM(CAST(${schema.salesItems.totalSales} AS NUMERIC)), 0)`,
        cost: sql<string>`COALESCE(SUM(CAST(${schema.salesItems.totalCost} AS NUMERIC)), 0)`,
        profit: sql<string>`COALESCE(SUM((CAST(${schema.salesItems.totalSales} AS NUMERIC) - CAST(${schema.salesItems.totalCost} AS NUMERIC))), 0)`,
        transactionCount: sql<number>`COUNT(DISTINCT ${schema.salesItems.voucherId})`,
        unitsSold: sql<string>`COALESCE(SUM(CAST(${schema.salesItems.quantity} AS NUMERIC)), 0)`,
      })
      .from(schema.salesItems)
      .innerJoin(schema.vouchers, eq(schema.salesItems.voucherId, schema.vouchers.id))
      .where(
        and(
          eq(schema.vouchers.companyId, companyId),
          gte(schema.vouchers.voucherDate, monthStartStr),
          isNull(schema.vouchers.deletedAt)
        )
      ),

    // Per-item profitability: every stock item that has ever been sold
    db
      .select({
        stockItemId: schema.salesItems.stockItemId,
        totalQty: sql<string>`SUM(CAST(${schema.salesItems.quantity} AS NUMERIC))`,
        totalRevenue: sql<string>`SUM(CAST(${schema.salesItems.totalSales} AS NUMERIC))`,
        totalCost: sql<string>`SUM(CAST(${schema.salesItems.totalCost} AS NUMERIC))`,
        totalProfit: sql<string>`SUM((CAST(${schema.salesItems.totalSales} AS NUMERIC) - CAST(${schema.salesItems.totalCost} AS NUMERIC)))`,
        avgSellingPrice: sql<string>`AVG(CAST(${schema.salesItems.sellingPrice} AS NUMERIC))`,
        avgConfiguredPrice: sql<string>`AVG(CAST(COALESCE(${schema.salesItems.configuredPrice}, ${schema.salesItems.sellingPrice}) AS NUMERIC))`,
        avgCostPrice: sql<string>`AVG(CAST(${schema.salesItems.costPrice} AS NUMERIC))`,
      })
      .from(schema.salesItems)
      .innerJoin(schema.vouchers, eq(schema.salesItems.voucherId, schema.vouchers.id))
      .where(and(eq(schema.vouchers.companyId, companyId), isNull(schema.vouchers.deletedAt)))
      .groupBy(schema.salesItems.stockItemId),
  ]);

  return {
    dataFetchedAt,
    inventory,
    stockItems,
    stockGroups,
    ledgerAccounts,
    suppliers,
    customers,
    locations,
    recentVouchers,
    purchaseOrders,
    containerSales,
    salesSummary,
    profitAnalysis,
    todayStr,
    monthStartStr,
    todaysSalesRaw,
    thisMonthSalesRaw,
    itemProfitabilityRaw,
  };
}
