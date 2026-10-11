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
import { and, desc, eq, gt, gte, inArray, isNull, sql } from "drizzle-orm";
import { companyScopedSuppliers } from "@shared/schema/supplierCompanyScope";
import { sumMoney, toMoney } from "../lib/money";
import { getPartyBalances } from "../services/accounting/balances/ledgerBalanceEngine";

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
    revenue: toMoney(todaysSalesRaw[0]?.revenue).toNumber(),
    cost: toMoney(todaysSalesRaw[0]?.cost).toNumber(),
    profit: toMoney(todaysSalesRaw[0]?.profit).toNumber(),
    transactionCount: todaysSalesRaw[0]?.transactionCount || 0,
    unitsSold: toMoney(todaysSalesRaw[0]?.unitsSold).toNumber(),
    margin:
      toMoney(todaysSalesRaw[0]?.revenue).toNumber() > 0
        ? (
            (toMoney(todaysSalesRaw[0]?.profit).toNumber() / toMoney(todaysSalesRaw[0]?.revenue || "1").toNumber()) *
            100
          ).toFixed(1)
        : "0",
  };

  const thisMonthSales = {
    monthStart: monthStartStr,
    revenue: toMoney(thisMonthSalesRaw[0]?.revenue).toNumber(),
    cost: toMoney(thisMonthSalesRaw[0]?.cost).toNumber(),
    profit: toMoney(thisMonthSalesRaw[0]?.profit).toNumber(),
    transactionCount: thisMonthSalesRaw[0]?.transactionCount || 0,
    unitsSold: toMoney(thisMonthSalesRaw[0]?.unitsSold).toNumber(),
    margin:
      toMoney(thisMonthSalesRaw[0]?.revenue).toNumber() > 0
        ? (
            (toMoney(thisMonthSalesRaw[0]?.profit).toNumber() /
              toMoney(thisMonthSalesRaw[0]?.revenue || "1").toNumber()) *
            100
          ).toFixed(1)
        : "0",
  };

  // Enrich per-item data with stock item name and classify as winner/loser
  const itemProfitabilityReport = itemProfitabilityRaw
    .map((row) => {
      const si = stockItems.find((s) => s.id === row.stockItemId);
      const qty = toMoney(row.totalQty).toNumber();
      const revenue = toMoney(row.totalRevenue).toNumber();
      const cost = toMoney(row.totalCost).toNumber();
      const profit = toMoney(row.totalProfit).toNumber();
      const avgCfg = toMoney(row.avgConfiguredPrice).toNumber();
      const avgCost = toMoney(row.avgCostPrice).toNumber();
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
    .sort((a, b) => toMoney(a.totalProfit).minus(toMoney(b.totalProfit)).toNumber()); // most losing first

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
    const rev = toMoney(row.totalRevenue).toNumber();
    const prof = toMoney(row.totalProfit).toNumber();
    return {
      groupId: row.stockGroupId,
      groupName: grp?.name || (row.stockGroupId ? "Unknown Group" : "Uncategorized"),
      groupCode: grp?.code || "",
      totalQty: toMoney(row.totalQty).toFixed(2),
      totalRevenue: rev.toFixed(2),
      totalCost: toMoney(row.totalCost).toFixed(2),
      totalProfit: prof.toFixed(2),
      profitMargin: rev > 0 ? ((prof / rev) * 100).toFixed(1) + "%" : "0%",
      isLosing: prof < 0,
    };
  }

  const salesByGroup = salesByGroupRaw
    .map(enrichGroupRow)
    .sort((a, b) => toMoney(a.totalProfit).minus(toMoney(b.totalProfit)).toNumber());
  const salesByGroupToday = salesByGroupTodayRaw
    .map(enrichGroupRow)
    .sort((a, b) => toMoney(b.totalRevenue).minus(toMoney(a.totalRevenue)).toNumber());
  const salesByGroupThisMonth = salesByGroupThisMonthRaw
    .map(enrichGroupRow)
    .sort((a, b) => toMoney(b.totalRevenue).minus(toMoney(a.totalRevenue)).toNumber());

  // Pricing health: current stock items where selling price < average cost (selling below cost)
  const inventoryMap = new Map(inventory.map((i) => [i.stockItemId, i]));
  const pricingHealthReport = stockItems
    .map((item) => {
      const inv = inventoryMap.get(item.id);
      const avgCost = toMoney(inv?.averageRate).toNumber();
      const sellPrice = toMoney(item.sellingPrice).toNumber();
      const qty = toMoney(inv?.quantity).toNumber();
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
    .filter((item) => toMoney(item.avgCostPrice).toNumber() > 0) // only items with known cost
    .sort((a, b) => toMoney(a.priceGap).minus(toMoney(b.priceGap)).toNumber()); // most losing first

  const lowStockAlerts: Array<{
    itemId: number;
    itemCode: string;
    itemName: string;
    currentQty: number;
    reorderLevel: number;
    status: "OUT_OF_STOCK" | "LOW_STOCK";
  }> = [];
  for (const item of stockItems) {
    const qty = toMoney(inventoryMap.get(item.id)?.quantity).toNumber();
    const reorderLevel = toMoney(item.reorderLevel).toNumber();
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

  // Supplier and customer balances from the one balance engine (wave 13, A4/M3):
  // only this company's suppliers and customers, plus any supplier of another
  // company this company posted to (its payable counts here, owner decision 2);
  // every line counted once in its voucher company. Amounts are exact until the
  // context is built.
  const [supplierEngine, customerEngine] = await Promise.all([
    getPartyBalances(db, { companyId, kind: "supplier" }),
    getPartyBalances(db, { companyId, kind: "customer", memo: true }),
  ]);
  const supplierIds = supplierEngine.parties.map((party) => party.id).filter((id): id is number => id !== null);
  const supplierMasters =
    supplierIds.length === 0
      ? []
      : await db
          .select({
            id: companyScopedSuppliers.id,
            code: companyScopedSuppliers.code,
            legalName: companyScopedSuppliers.legalName,
            companyId: companyScopedSuppliers.companyId,
            active: companyScopedSuppliers.active,
          })
          .from(companyScopedSuppliers)
          .where(inArray(companyScopedSuppliers.id, supplierIds));
  const supplierMasterById = new Map(supplierMasters.map((supplier) => [supplier.id, supplier]));

  const filteredSupplierBalances = supplierEngine.parties
    .filter((party) => party.id !== null && !party.deleted)
    .filter((party) => supplierMasterById.get(party.id!)?.active !== false)
    .map((party) => {
      const master = supplierMasterById.get(party.id!);
      const balance = toMoney(party.closing).negated(); // Cr positive: we owe the supplier
      return {
        supplierId: party.id!,
        supplierCode: master?.code ?? party.code ?? "",
        supplierName: master?.legalName || party.name || "Unknown",
        openingBalance: toMoney(party.masterOpening).negated().toNumber(),
        balance: balance.toNumber(),
        exact: balance,
        status: balance.greaterThan(0) ? "PAYABLE" : balance.isNegative() ? "OVERPAID" : "SETTLED",
      };
    })
    .filter((supplier) => supplier.exact.abs().greaterThan(0.01));

  const customerRows = customerEngine.parties
    .filter((party) => party.id !== null && !party.deleted)
    .map((party) => ({
      customerId: party.id!,
      customerName: customers.find((customer) => customer.id === party.id)?.legalName || party.name || "Unknown",
      exact: toMoney(party.closing),
      memo: toMoney(party.memoTotal),
    }));
  const customerBalancesList = customerRows
    .filter((customer) => customer.exact.abs().greaterThan(0.01))
    .map((customer) => ({
      customerId: customer.customerId,
      customerName: customer.customerName,
      balance: customer.exact.toNumber(),
    }));

  const financialSummary = {
    totalPayables: sumMoney(
      filteredSupplierBalances.filter((supplier) => supplier.exact.greaterThan(0)).map((supplier) => supplier.exact)
    ).toNumber(),
    totalReceivables: sumMoney(
      customerRows.filter((customer) => customer.exact.greaterThan(0)).map((customer) => customer.exact)
    ).toNumber(),
    // Receivables not yet in the ledger (factory invoices before the cut-over,
    // factory POS credit sales, cache-only rows): shown apart, never in the total.
    receivablesNotInLedger: sumMoney(customerRows.map((customer) => customer.memo)).toNumber(),
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
      totalValue: toMoney(inv.totalValue).toNumber(),
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
      toMoney(item.totalRevenue).toNumber() > 0
        ? ((toMoney(item.totalProfit).toNumber() / toMoney(item.totalRevenue).toNumber()) * 100).toFixed(1)
        : "0";
    return {
      itemId: item.stockItemId,
      itemName: stockItem?.name || "Unknown",
      itemCode: stockItem?.code || "N/A",
      totalQuantity: toMoney(item.totalQuantity).toFixed(2),
      totalRevenue: toMoney(item.totalRevenue).toFixed(2),
      totalProfit: toMoney(item.totalProfit).toFixed(2),
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
      const qty = toMoney(inventoryMap.get(item.id)?.quantity).toNumber();
      return qty > 0 && !recentlySoldItemIds.has(item.id);
    })
    .map((item) => {
      const qty = toMoney(inventoryMap.get(item.id)?.quantity).toNumber();
      const invRecord = inventory.find((i) => i.stockItemId === item.id);
      const value = invRecord ? toMoney(invRecord.totalValue).toNumber() : 0;
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
        amount: toMoney(po.itemsTotal).plus(toMoney(po.freight)).toNumber(),
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
        amount: toMoney(po.itemsTotal).plus(toMoney(po.freight)).toNumber(),
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
