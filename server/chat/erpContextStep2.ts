// Extracted from ./erpContext.ts: a stage of erpContext.
import { db } from "../db";
import * as schema from "@shared/schema";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { toMoney } from "../lib/money";
import { getPartyBalances } from "../services/accounting/balances/ledgerBalanceEngine";
import type { erpContextStep } from "./erpContextStep";

type ErpContextStepResult = Awaited<ReturnType<typeof erpContextStep>>;

export async function erpContextStep2({ erc1, companyId }: { erc1: ErpContextStepResult; companyId: number }) {
  const {
    todayStr,
    todaysSalesRaw,
    monthStartStr,
    thisMonthSalesRaw,
    itemProfitabilityRaw,
    stockItems,
    stockGroups,
    inventory,
  } = erc1;

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
        totalProfit: sql<string>`SUM((CAST(${schema.salesItems.totalSales} AS NUMERIC) - CAST(${schema.salesItems.totalCost} AS NUMERIC)))`,
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
        totalProfit: sql<string>`SUM((CAST(${schema.salesItems.totalSales} AS NUMERIC) - CAST(${schema.salesItems.totalCost} AS NUMERIC)))`,
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
        totalProfit: sql<string>`SUM((CAST(${schema.salesItems.totalSales} AS NUMERIC) - CAST(${schema.salesItems.totalCost} AS NUMERIC)))`,
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
        reorderLevel,
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

  return {
    todaysSales,
    thisMonthSales,
    itemProfitabilityReport,
    salesByGroup,
    salesByGroupToday,
    salesByGroupThisMonth,
    inventoryMap,
    pricingHealthReport,
    lowStockAlerts,
    supplierEngine,
    customerEngine,
    supplierIds,
  };
}
