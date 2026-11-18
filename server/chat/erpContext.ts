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
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { toMoney } from "../lib/money";
import { erpContextStep } from "./erpContextStep";
import { erpContextStep2 } from "./erpContextStep2";
import { erpContextStep3 } from "./erpContextStep3";

type GetERPContextResult = Awaited<ReturnType<typeof getERPContext>>;

// ── ERP context in-memory cache (TTL = 60 s per companyId) ───────────────────
const ERP_CACHE_TTL_MS = 60_000;
interface ERPCacheEntry {
  context: ERPContext;
  expiresAt: number;
}
const erpContextCache = new Map<string, ERPCacheEntry>();
const ERP_CACHE_MAX_ENTRIES = Math.max(4, Number.parseInt(process.env.ERP_CONTEXT_CACHE_MAX_ENTRIES || "32", 10) || 32);

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
export type ERPContext = GetERPContextResult;

export async function getERPContext(companyId: number) {
  const erc1 = await erpContextStep({ companyId });
  const {
    stockItems,
    stockGroups,
    inventory,
    locations,
    dataFetchedAt,
    ledgerAccounts,
    suppliers,
    customers,
    recentVouchers,
    salesSummary,
    profitAnalysis,
    purchaseOrders,
    containerSales,
  } = erc1;
  const erc2 = await erpContextStep2({ erc1, companyId });
  const {
    todaysSales,
    thisMonthSales,
    lowStockAlerts,
    itemProfitabilityReport,
    pricingHealthReport,
    salesByGroup,
    salesByGroupToday,
    salesByGroupThisMonth,
  } = erc2;
  const erc3 = await erpContextStep3({ erc2, erc1, companyId });
  const {
    employees,
    filteredSupplierBalances,
    customerBalancesList,
    financialSummary,
    inventoryByLocationWithNames,
    topSellingWithNames,
    recentTransactions,
    slowMovingStock,
    overdueContainers,
    itemsToMarkdown,
    containersInTransit,
  } = erc3;

  const employeeBalancesList = employees
    .map((emp) => ({
      employeeId: emp.id,
      employeeCode: emp.code,
      employeeName: `${emp.firstName} ${emp.lastName}`,
      balance: toMoney(emp.currentBalance).toNumber(),
      openingBalance: toMoney(emp.openingBalance).toNumber(),
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
        quantity: toMoney(inv.quantity).toNumber(),
        averageRate: toMoney(inv.averageRate).toNumber(),
        totalValue: toMoney(inv.totalValue).toNumber(),
      };
    });
    const totalQuantity = inventoryByLocation.reduce((sum, l) => sum + l.quantity, 0);
    const totalValue = inventoryByLocation.reduce((sum, l) => sum + l.totalValue, 0);

    return {
      code: item.code,
      name: item.name,
      groupName: stockGroup?.name || "",
      sellingPrice: toMoney(item.sellingPrice).toNumber(),
      reorderLevel: toMoney(item.reorderLevel).toNumber(),
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
      profit: sql<string>`(${schema.salesItems.totalSales}::numeric - ${schema.salesItems.totalCost}::numeric)`,
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
      quantity: toMoney(sale.quantity).toNumber(),
      sellingPrice: toMoney(sale.sellingPrice).toNumber(),
      totalSales: toMoney(sale.totalSales).toNumber(),
      profit: toMoney(sale.profit).toNumber(),
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
    supplierBalances: filteredSupplierBalances.map(({ exact: _exact, ...supplier }) => supplier),
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
