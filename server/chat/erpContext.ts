/**
 * ERP context assembly for the chat assistant.
 *
 * Builds the real-time snapshot of a company's ERP state (inventory,
 * ledgers, sales, balances, etc.) that grounds the assistant's answers,
 * plus a short-lived per-company cache. Extracted from chatService.ts;
 * behaviour is unchanged.
 */
import { db } from "../db";
import { logger } from "../lib/logger";
import * as schema from "@shared/schema";
import { and, desc, eq, gt, gte, isNull, sql } from "drizzle-orm";

// ── ERP context in-memory cache (TTL = 60 s per companyId) ───────────────────
const ERP_CACHE_TTL_MS = 60_000;
interface ERPCacheEntry {
  context: ERPContext;
  expiresAt: number;
}
const erpContextCache = new Map<string, ERPCacheEntry>();
const ERP_CACHE_MAX_ENTRIES = Math.max(
  4,
  Number.parseInt(process.env.ERP_CONTEXT_CACHE_MAX_ENTRIES || "32", 10) || 32
);

function pruneERPContextCache(now = Date.now()): void {
  for (const [key, entry] of erpContextCache) {
    if (entry.expiresAt <= now) erpContextCache.delete(key);
  }
  while (erpContextCache.size > ERP_CACHE_MAX_ENTRIES) {
    const oldestKey = erpContextCache.keys().next().value;
    if (oldestKey === undefined) break;
    erpContextCache.delete(oldestKey);
  }
}

export function clearERPContextCache(companyId?: number): void {
  if (companyId !== undefined) {
    const key = `erp-context:${companyId}`;
    erpContextCache.delete(key);
    logger.info(`[ChatService] Cache cleared for company ${companyId}`);
  } else {
    erpContextCache.clear();
    logger.info("[ChatService] Cache cleared for all companies");
  }
}

export async function getCachedERPContext(companyId: number): Promise<ERPContext> {
  const key = `erp-context:${companyId}`;
  const now = Date.now();
  pruneERPContextCache(now);
  const cached = erpContextCache.get(key);
  if (cached && now < cached.expiresAt) {
    const ageMs = now - (cached.expiresAt - ERP_CACHE_TTL_MS);
    logger.info(`[ChatService] Cache HIT for company ${companyId} (age ${Math.round(ageMs / 1000)}s)`);
    return cached.context;
  }
  logger.info(`[ChatService] Cache MISS for company ${companyId} — fetching`);
  const t0 = Date.now();
  const context = await getERPContext(companyId);
  logger.info(`[ChatService] Context loaded in ${Date.now() - t0}ms`);
  erpContextCache.delete(key);
  erpContextCache.set(key, { context, expiresAt: Date.now() + ERP_CACHE_TTL_MS });
  pruneERPContextCache();
  return context;
}

export interface UserPreferences {
  currency?: string;
  language?: string;
  dateFormat?: string;
  reportsTimeframe?: string;
}

/** The context shape is derived from the query assembly below so it cannot drift. */
export type ERPContext = Awaited<ReturnType<typeof getERPContext>>;

export async function getERPContext(companyId: number) {
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
      totalProfit: sql<string>`COALESCE(SUM(CAST(${schema.salesItems.profit} AS NUMERIC)), 0)`,
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
        profit: sql<string>`COALESCE(SUM(CAST(${schema.salesItems.profit} AS NUMERIC)), 0)`,
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
        profit: sql<string>`COALESCE(SUM(CAST(${schema.salesItems.profit} AS NUMERIC)), 0)`,
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
        totalProfit: sql<string>`SUM(CAST(${schema.salesItems.profit} AS NUMERIC))`,
        avgSellingPrice: sql<string>`AVG(CAST(${schema.salesItems.sellingPrice} AS NUMERIC))`,
        avgConfiguredPrice: sql<string>`AVG(CAST(COALESCE(${schema.salesItems.configuredPrice}, ${schema.salesItems.sellingPrice}) AS NUMERIC))`,
        avgCostPrice: sql<string>`AVG(CAST(${schema.salesItems.costPrice} AS NUMERIC))`,
      })
      .from(schema.salesItems)
      .innerJoin(schema.vouchers, eq(schema.salesItems.voucherId, schema.vouchers.id))
      .where(and(eq(schema.vouchers.companyId, companyId), isNull(schema.vouchers.deletedAt)))
      .groupBy(schema.salesItems.stockItemId),
  ]);

  const todaysSales = {
    date: todayStr,
    revenue: parseFloat(todaysSalesRaw[0]?.revenue || "0"),
    cost: parseFloat(todaysSalesRaw[0]?.cost || "0"),
    profit: parseFloat(todaysSalesRaw[0]?.profit || "0"),
    transactionCount: todaysSalesRaw[0]?.transactionCount || 0,
    unitsSold: parseFloat(todaysSalesRaw[0]?.unitsSold || "0"),
    margin:
      parseFloat(todaysSalesRaw[0]?.revenue || "0") > 0
        ? (
            (parseFloat(todaysSalesRaw[0]?.profit || "0") / parseFloat(todaysSalesRaw[0]?.revenue || "1")) *
            100
          ).toFixed(1)
        : "0",
  };

  const thisMonthSales = {
    monthStart: monthStartStr,
    revenue: parseFloat(thisMonthSalesRaw[0]?.revenue || "0"),
    cost: parseFloat(thisMonthSalesRaw[0]?.cost || "0"),
    profit: parseFloat(thisMonthSalesRaw[0]?.profit || "0"),
    transactionCount: thisMonthSalesRaw[0]?.transactionCount || 0,
    unitsSold: parseFloat(thisMonthSalesRaw[0]?.unitsSold || "0"),
    margin:
      parseFloat(thisMonthSalesRaw[0]?.revenue || "0") > 0
        ? (
            (parseFloat(thisMonthSalesRaw[0]?.profit || "0") / parseFloat(thisMonthSalesRaw[0]?.revenue || "1")) *
            100
          ).toFixed(1)
        : "0",
  };

  // Enrich per-item data with stock item name and classify as winner/loser
  const itemProfitabilityReport = itemProfitabilityRaw
    .map((row) => {
      const si = stockItems.find((s) => s.id === row.stockItemId);
      const qty = parseFloat(row.totalQty || "0");
      const revenue = parseFloat(row.totalRevenue || "0");
      const cost = parseFloat(row.totalCost || "0");
      const profit = parseFloat(row.totalProfit || "0");
      const avgCfg = parseFloat(row.avgConfiguredPrice || "0");
      const avgCost = parseFloat(row.avgCostPrice || "0");
      const margin = revenue > 0 ? ((profit / revenue) * 100).toFixed(1) : "0";
      const profitPerUnit = qty > 0 ? (profit / qty).toFixed(2) : "0";
      return {
        itemId: row.stockItemId,
        itemName: si?.name || "Unknown",
        itemCode: si?.code || "",
        totalQty: qty.toFixed(2),
        totalRevenue: revenue.toFixed(2),
        totalCost: cost.toFixed(2),
        totalProfit: profit.toFixed(2),
        profitPerUnit,
        profitMargin: margin + "%",
        avgConfiguredPrice: avgCfg.toFixed(2),
        avgCostPrice: avgCost.toFixed(2),
        // If configured price < cost price OR total profit < 0 → losing money
        isLosing: profit < 0 || avgCfg < avgCost,
        lossAmount: profit < 0 ? Math.abs(profit).toFixed(2) : "0",
      };
    })
    .sort((a, b) => parseFloat(a.totalProfit) - parseFloat(b.totalProfit)); // most losing first

  // ── Sales by stock group ────────────────────────────────────────────
  const [salesByGroupRaw, salesByGroupTodayRaw, salesByGroupThisMonthRaw] = await Promise.all([
    // All-time by group
    db
      .select({
        stockGroupId: schema.stockItems.stockGroupId,
        totalQty: sql<string>`SUM(CAST(${schema.salesItems.quantity} AS NUMERIC))`,
        totalRevenue: sql<string>`SUM(CAST(${schema.salesItems.totalSales} AS NUMERIC))`,
        totalCost: sql<string>`SUM(CAST(${schema.salesItems.totalCost} AS NUMERIC))`,
        totalProfit: sql<string>`SUM(CAST(${schema.salesItems.profit} AS NUMERIC))`,
      })
      .from(schema.salesItems)
      .innerJoin(schema.vouchers, eq(schema.salesItems.voucherId, schema.vouchers.id))
      .innerJoin(schema.stockItems, eq(schema.salesItems.stockItemId, schema.stockItems.id))
      .where(and(eq(schema.vouchers.companyId, companyId), isNull(schema.vouchers.deletedAt)))
      .groupBy(schema.stockItems.stockGroupId),

    // Today by group
    db
      .select({
        stockGroupId: schema.stockItems.stockGroupId,
        totalQty: sql<string>`SUM(CAST(${schema.salesItems.quantity} AS NUMERIC))`,
        totalRevenue: sql<string>`SUM(CAST(${schema.salesItems.totalSales} AS NUMERIC))`,
        totalCost: sql<string>`SUM(CAST(${schema.salesItems.totalCost} AS NUMERIC))`,
        totalProfit: sql<string>`SUM(CAST(${schema.salesItems.profit} AS NUMERIC))`,
      })
      .from(schema.salesItems)
      .innerJoin(schema.vouchers, eq(schema.salesItems.voucherId, schema.vouchers.id))
      .innerJoin(schema.stockItems, eq(schema.salesItems.stockItemId, schema.stockItems.id))
      .where(
        and(
          eq(schema.vouchers.companyId, companyId),
          eq(schema.vouchers.voucherDate, todayStr),
          isNull(schema.vouchers.deletedAt)
        )
      )
      .groupBy(schema.stockItems.stockGroupId),

    // This month by group
    db
      .select({
        stockGroupId: schema.stockItems.stockGroupId,
        totalQty: sql<string>`SUM(CAST(${schema.salesItems.quantity} AS NUMERIC))`,
        totalRevenue: sql<string>`SUM(CAST(${schema.salesItems.totalSales} AS NUMERIC))`,
        totalCost: sql<string>`SUM(CAST(${schema.salesItems.totalCost} AS NUMERIC))`,
        totalProfit: sql<string>`SUM(CAST(${schema.salesItems.profit} AS NUMERIC))`,
      })
      .from(schema.salesItems)
      .innerJoin(schema.vouchers, eq(schema.salesItems.voucherId, schema.vouchers.id))
      .innerJoin(schema.stockItems, eq(schema.salesItems.stockItemId, schema.stockItems.id))
      .where(
        and(
          eq(schema.vouchers.companyId, companyId),
          gte(schema.vouchers.voucherDate, monthStartStr),
          isNull(schema.vouchers.deletedAt)
        )
      )
      .groupBy(schema.stockItems.stockGroupId),
  ]);

  // Helper: enrich group row with name
  function enrichGroupRow(row: {
    stockGroupId: number | null;
    totalQty: string;
    totalRevenue: string;
    totalCost: string;
    totalProfit: string;
  }) {
    const grp = stockGroups.find((g) => g.id === row.stockGroupId);
    const rev = parseFloat(row.totalRevenue || "0");
    const prof = parseFloat(row.totalProfit || "0");
    return {
      groupId: row.stockGroupId,
      groupName: grp?.name || (row.stockGroupId ? "Unknown Group" : "Uncategorized"),
      groupCode: grp?.code || "",
      totalQty: parseFloat(row.totalQty || "0").toFixed(2),
      totalRevenue: rev.toFixed(2),
      totalCost: parseFloat(row.totalCost || "0").toFixed(2),
      totalProfit: prof.toFixed(2),
      profitMargin: rev > 0 ? ((prof / rev) * 100).toFixed(1) + "%" : "0%",
      isLosing: prof < 0,
    };
  }

  const salesByGroup = salesByGroupRaw
    .map(enrichGroupRow)
    .sort((a, b) => parseFloat(a.totalProfit) - parseFloat(b.totalProfit));
  const salesByGroupToday = salesByGroupTodayRaw
    .map(enrichGroupRow)
    .sort((a, b) => parseFloat(b.totalRevenue) - parseFloat(a.totalRevenue));
  const salesByGroupThisMonth = salesByGroupThisMonthRaw
    .map(enrichGroupRow)
    .sort((a, b) => parseFloat(b.totalRevenue) - parseFloat(a.totalRevenue));

  // Pricing health: current stock items where selling price < average cost (selling below cost)
  const inventoryMap = new Map(inventory.map((i) => [i.stockItemId, i]));
  const pricingHealthReport = stockItems
    .map((item) => {
      const inv = inventoryMap.get(item.id);
      const avgCost = parseFloat(inv?.averageRate || "0");
      const sellPrice = parseFloat(item.sellingPrice || "0");
      const qty = parseFloat(inv?.quantity || "0");
      const gap = sellPrice - avgCost;
      return {
        itemId: item.id,
        itemName: item.name,
        itemCode: item.code || "",
        sellingPrice: sellPrice.toFixed(2),
        avgCostPrice: avgCost.toFixed(2),
        priceGap: gap.toFixed(2),
        stockQty: qty.toFixed(2),
        status: gap < 0 ? "LOSING" : gap === 0 ? "BREAK_EVEN" : "PROFITABLE",
        potentialLoss: qty > 0 && gap < 0 ? (Math.abs(gap) * qty).toFixed(2) : "0",
      };
    })
    .filter((item) => parseFloat(item.avgCostPrice) > 0) // only items with known cost
    .sort((a, b) => parseFloat(a.priceGap) - parseFloat(b.priceGap)); // most losing first

  const lowStockAlerts: Array<{
    itemId: number;
    itemCode: string;
    itemName: string;
    currentQty: number;
    reorderLevel: number;
    status: "OUT_OF_STOCK" | "LOW_STOCK";
  }> = [];
  for (const item of stockItems) {
    const qty = parseFloat(inventoryMap.get(item.id)?.quantity || "0");
    const reorderLevel = parseFloat(item.reorderLevel || "0");
    if (reorderLevel > 0 && qty <= reorderLevel) {
      lowStockAlerts.push({
        itemId: item.id,
        itemCode: item.code,
        itemName: item.name,
        currentQty: qty,
        reorderLevel: reorderLevel,
        status: qty === 0 ? "OUT_OF_STOCK" : "LOW_STOCK",
      });
    }
  }

  // Fetch full supplier data including opening balances
  const suppliersWithBalances = await db
    .select({
      id: schema.suppliers.id,
      code: schema.suppliers.code,
      legalName: schema.suppliers.legalName,
      openingBalance: schema.suppliers.openingBalance,
    })
    .from(schema.suppliers)
    .where(eq(schema.suppliers.active, true));

  // Get voucher entries for each supplier (matching supplier page calculation)
  const supplierBalances = await Promise.all(
    suppliersWithBalances.map(async (supplier) => {
      const entries = await db
        .select({
          debitAmount: schema.voucherEntries.debitAmount,
          creditAmount: schema.voucherEntries.creditAmount,
        })
        .from(schema.voucherEntries)
        .innerJoin(schema.vouchers, eq(schema.voucherEntries.voucherId, schema.vouchers.id))
        .where(
          and(
            eq(schema.voucherEntries.supplierId, supplier.id),
            eq(schema.vouchers.companyId, companyId),
            eq(schema.vouchers.optional, false),
            isNull(schema.vouchers.deletedAt)
          )
        );

      // Calculate balance same as supplier page: Opening Balance + Credits - Debits
      const openingBalance = parseFloat(supplier.openingBalance || "0");
      const balance = entries.reduce((sum, entry) => {
        const credit = parseFloat(entry.creditAmount || "0");
        const debit = parseFloat(entry.debitAmount || "0");
        return sum + (credit - debit);
      }, openingBalance);

      return {
        supplierId: supplier.id,
        supplierCode: supplier.code,
        supplierName: supplier.legalName || "Unknown",
        openingBalance: openingBalance,
        balance: balance,
        status: balance > 0 ? "PAYABLE" : balance < 0 ? "OVERPAID" : "SETTLED",
      };
    })
  );

  // Filter to only show suppliers with non-zero balances
  const filteredSupplierBalances = supplierBalances.filter((sb) => Math.abs(sb.balance) > 0.01);

  let customerBalancesList: Array<{
    customerId: number;
    customerName: string;
    balance: number;
  }> = [];
  try {
    const customerBalancesRaw = await db
      .select({
        customerId: schema.customerBalances.customerId,
        totalDebit: sql<string>`COALESCE(SUM(CAST(${schema.customerBalances.debitAmount} AS NUMERIC)), 0)`,
        totalCredit: sql<string>`COALESCE(SUM(CAST(${schema.customerBalances.creditAmount} AS NUMERIC)), 0)`,
      })
      .from(schema.customerBalances)
      .where(eq(schema.customerBalances.companyId, companyId))
      .groupBy(schema.customerBalances.customerId);

    customerBalancesList = customerBalancesRaw
      .map((cb) => {
        const customer = customers.find((c) => c.id === cb.customerId);
        const balance = parseFloat(cb.totalDebit) - parseFloat(cb.totalCredit);
        return {
          customerId: cb.customerId,
          customerName: customer?.legalName || "Unknown",
          balance: balance,
        };
      })
      .filter((cb) => Math.abs(cb.balance) > 0.01);
  } catch (error) {
    logger.error("Error fetching customer balances:", { error: error });
  }

  const financialSummary = {
    totalPayables: filteredSupplierBalances.filter((s) => s.balance > 0).reduce((sum, s) => sum + s.balance, 0),
    totalReceivables: customerBalancesList.filter((c) => c.balance > 0).reduce((sum, c) => sum + c.balance, 0),
    openPurchaseOrders: purchaseOrders.filter((po) => po.status === "Open").length,
    pendingContainerSales: containerSales.filter((cs) => cs.paymentStatus !== "PAID").length,
  };

  const inventoryValueByLocation = await db
    .select({
      locationId: schema.inventory.locationId,
      totalValue: sql<string>`COALESCE(SUM(CAST(${schema.inventory.totalValue} AS NUMERIC)), 0)`,
      itemCount: sql<number>`COUNT(DISTINCT ${schema.inventory.stockItemId})`,
    })
    .from(schema.inventory)
    .where(eq(schema.inventory.companyId, companyId))
    .groupBy(schema.inventory.locationId);

  const inventoryByLocationWithNames = inventoryValueByLocation.map((inv) => {
    const location = locations.find((l) => l.id === inv.locationId);
    return {
      locationId: inv.locationId,
      locationName: location?.name || "Unknown",
      totalValue: parseFloat(inv.totalValue),
      itemCount: inv.itemCount,
    };
  });

  const topSellingItems = await db
    .select({
      stockItemId: schema.salesItems.stockItemId,
      totalQuantity: sql<string>`SUM(CAST(${schema.salesItems.quantity} AS NUMERIC))`,
      totalRevenue: sql<string>`SUM(CAST(${schema.salesItems.totalSales} AS NUMERIC))`,
      totalProfit: sql<string>`SUM(CAST(${schema.salesItems.profit} AS NUMERIC))`,
    })
    .from(schema.salesItems)
    .innerJoin(schema.vouchers, eq(schema.salesItems.voucherId, schema.vouchers.id))
    .where(and(eq(schema.vouchers.companyId, companyId), isNull(schema.vouchers.deletedAt)))
    .groupBy(schema.salesItems.stockItemId)
    .orderBy(desc(sql`SUM(CAST(${schema.salesItems.totalSales} AS NUMERIC))`))
    .limit(10);

  const topSellingWithNames = topSellingItems.map((item) => {
    const stockItem = stockItems.find((s) => s.id === item.stockItemId);
    const profitMargin =
      parseFloat(item.totalRevenue) > 0
        ? ((parseFloat(item.totalProfit) / parseFloat(item.totalRevenue)) * 100).toFixed(1)
        : "0";
    return {
      itemId: item.stockItemId,
      itemName: stockItem?.name || "Unknown",
      itemCode: stockItem?.code || "N/A",
      totalQuantity: parseFloat(item.totalQuantity).toFixed(2),
      totalRevenue: parseFloat(item.totalRevenue).toFixed(2),
      totalProfit: parseFloat(item.totalProfit).toFixed(2),
      profitMargin: profitMargin + "%",
    };
  });

  const recentTransactions = recentVouchers.slice(0, 20).map((v) => ({
    id: v.id,
    number: v.voucherNumber,
    type: v.voucherType,
    date: v.voucherDate,
    amount: v.totalAmount,
    description: v.description,
  }));

  // Slow-moving stock: items that exist in inventory but haven't been sold in 60+ days
  const sixtyDaysAgo = new Date();
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

  const recentlySoldItemIds = new Set(
    (
      await db
        .select({ stockItemId: schema.salesItems.stockItemId })
        .from(schema.salesItems)
        .innerJoin(schema.vouchers, eq(schema.salesItems.voucherId, schema.vouchers.id))
        .where(
          and(
            eq(schema.vouchers.companyId, companyId),
            gt(schema.vouchers.voucherDate, sixtyDaysAgo.toISOString().split("T")[0]),
            isNull(schema.vouchers.deletedAt)
          )
        )
    ).map((r) => r.stockItemId)
  );

  const slowMovingStock = stockItems
    .filter((item) => {
      const qty = parseFloat(inventoryMap.get(item.id)?.quantity || "0");
      return qty > 0 && !recentlySoldItemIds.has(item.id);
    })
    .map((item) => {
      const qty = parseFloat(inventoryMap.get(item.id)?.quantity || "0");
      const invRecord = inventory.find((i) => i.stockItemId === item.id);
      const value = invRecord ? parseFloat(invRecord.totalValue || "0") : 0;
      return {
        itemId: item.id,
        itemCode: item.code,
        itemName: item.name,
        quantity: qty,
        value: value,
        daysSinceLastSale: "60+",
        recommendation: value > 500 ? "Consider markdown/promotion" : "Monitor",
      };
    })
    .slice(0, 20);

  // Items to markdown: slow-moving with high value
  const itemsToMarkdown = slowMovingStock
    .filter((item) => item.value > 100)
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);

  // Overdue containers: OTW status for more than 90 days
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  const overdueContainers = purchaseOrders
    .filter((po) => po.status === "OTW")
    .filter((po) => {
      const createdDate = new Date(po.createdAt);
      return createdDate < ninetyDaysAgo;
    })
    .map((po) => {
      const supplier = suppliers.find((s) => s.id === po.supplierId);
      const daysInTransit = Math.floor((Date.now() - new Date(po.createdAt).getTime()) / (1000 * 60 * 60 * 24));
      return {
        poNumber: po.poNumber,
        supplierName: supplier?.legalName || "Unknown",
        amount: parseFloat(po.itemsTotal || "0") + parseFloat(po.freight || "0"),
        daysInTransit,
        status: "OVERDUE",
      };
    });

  // Containers in transit (all OTW)
  const containersInTransit = purchaseOrders
    .filter((po) => po.status === "OTW")
    .map((po) => {
      const supplier = suppliers.find((s) => s.id === po.supplierId);
      const daysInTransit = Math.floor((Date.now() - new Date(po.createdAt).getTime()) / (1000 * 60 * 60 * 24));
      return {
        poNumber: po.poNumber,
        supplierName: supplier?.legalName || "Unknown",
        amount: parseFloat(po.itemsTotal || "0") + parseFloat(po.freight || "0"),
        daysInTransit,
        isOverdue: daysInTransit > 90,
      };
    });

  // Employee balances
  const employees = await db
    .select({
      id: schema.employees.id,
      code: schema.employees.code,
      firstName: schema.employees.firstName,
      lastName: schema.employees.lastName,
      currentBalance: schema.employees.currentBalance,
      openingBalance: schema.employees.openingBalance,
    })
    .from(schema.employees)
    .where(and(eq(schema.employees.companyId, companyId), eq(schema.employees.active, true)));

  const employeeBalancesList = employees
    .map((emp) => ({
      employeeId: emp.id,
      employeeCode: emp.code,
      employeeName: `${emp.firstName} ${emp.lastName}`,
      balance: parseFloat(emp.currentBalance || "0"),
      openingBalance: parseFloat(emp.openingBalance || "0"),
    }))
    .filter((e) => Math.abs(e.balance) > 0.01);

  // Build comprehensive stock items with inventory by location (for full search)
  const stockItemsWithInventory = stockItems.map((item) => {
    const stockGroup = stockGroups.find((g) => g.id === item.stockGroupId);
    const itemInventory = inventory.filter((inv) => inv.stockItemId === item.id);
    const inventoryByLocation = itemInventory.map((inv) => {
      const location = locations.find((l) => l.id === inv.locationId);
      return {
        locationName: location?.name || "Unknown",
        locationCode: location?.code || "",
        quantity: parseFloat(inv.quantity || "0"),
        averageRate: parseFloat(inv.averageRate || "0"),
        totalValue: parseFloat(inv.totalValue || "0"),
      };
    });
    const totalQuantity = inventoryByLocation.reduce((sum, l) => sum + l.quantity, 0);
    const totalValue = inventoryByLocation.reduce((sum, l) => sum + l.totalValue, 0);

    return {
      code: item.code,
      name: item.name,
      groupName: stockGroup?.name || "",
      sellingPrice: parseFloat(item.sellingPrice || "0"),
      reorderLevel: parseFloat(item.reorderLevel || "0"),
      totalQuantity,
      totalValue,
      locations: inventoryByLocation.filter((l) => l.quantity > 0),
    };
  });

  // Fetch ALL sales history with prices (no date limit)
  const allSalesData = await db
    .select({
      stockItemId: schema.salesItems.stockItemId,
      locationId: schema.vouchers.locationId,
      quantity: schema.salesItems.quantity,
      sellingPrice: schema.salesItems.sellingPrice,
      totalSales: schema.salesItems.totalSales,
      totalCost: schema.salesItems.totalCost,
      profit: schema.salesItems.profit,
      voucherDate: schema.vouchers.voucherDate,
      voucherNumber: schema.vouchers.voucherNumber,
    })
    .from(schema.salesItems)
    .innerJoin(schema.vouchers, eq(schema.salesItems.voucherId, schema.vouchers.id))
    .where(and(eq(schema.vouchers.companyId, companyId), isNull(schema.vouchers.deletedAt)))
    .orderBy(desc(schema.vouchers.voucherDate))
    .limit(500);

  const recentSalesHistory = allSalesData.map((sale) => {
    const item = stockItems.find((i) => i.id === sale.stockItemId);
    const location = locations.find((l) => l.id === sale.locationId);
    return {
      itemCode: item?.code || "Unknown",
      itemName: item?.name || "Unknown",
      locationName: location?.name || "Unknown",
      quantity: parseFloat(sale.quantity || "0"),
      sellingPrice: parseFloat(sale.sellingPrice || "0"),
      totalSales: parseFloat(sale.totalSales || "0"),
      profit: parseFloat(sale.profit || "0"),
      date: sale.voucherDate,
      voucherNumber: sale.voucherNumber,
    };
  });

  return {
    dataFetchedAt, // Real-time timestamp
    inventory,
    stockItems,
    stockGroups,
    ledgerAccounts,
    suppliers,
    customers,
    locations,
    recentVouchers,
    salesSummary: salesSummary[0] || { totalSales: "0", count: 0 },
    profitAnalysis: profitAnalysis[0] || { totalSales: "0", totalCost: "0", totalProfit: "0", itemsSold: 0 },
    todaysSales,
    thisMonthSales,
    lowStockAlerts,
    supplierBalances: filteredSupplierBalances,
    customerBalances: customerBalancesList,
    purchaseOrders,
    containerSales,
    financialSummary,
    inventoryValueByLocation: inventoryByLocationWithNames,
    topSellingItems: topSellingWithNames,
    recentTransactions,
    // New smart data
    slowMovingStock,
    overdueContainers,
    employeeBalances: employeeBalancesList,
    itemsToMarkdown,
    containersInTransit,
    // Full searchable data
    stockItemsWithInventory,
    recentSalesHistory,
    // Profit/loss per item
    itemProfitabilityReport,
    pricingHealthReport,
    // Sales by stock group
    salesByGroup,
    salesByGroupToday,
    salesByGroupThisMonth,
  };
}
