// Extracted from ./erpContext.ts: a stage of erpContext.
import { db } from "../db";
import * as schema from "@shared/schema";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { companyScopedSuppliers } from "@shared/schema/supplierCompanyScope";
import { sumMoney, toMoney } from "../lib/money";
import type { erpContextStep } from "./erpContextStep";
import type { erpContextStep2 } from "./erpContextStep2";

type ErpContextStepResult = Awaited<ReturnType<typeof erpContextStep>>;
type ErpContextStep2Result = Awaited<ReturnType<typeof erpContextStep2>>;

export async function erpContextStep3({
  erc2,
  erc1,
  companyId,
}: {
  erc2: ErpContextStep2Result;
  erc1: ErpContextStepResult;
  companyId: number;
}) {
  const { supplierIds, supplierEngine, customerEngine, inventoryMap } = erc2;
  const { customers, purchaseOrders, containerSales, locations, stockItems, recentVouchers, inventory, suppliers } =
    erc1;
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
      totalProfit: sql<string>`SUM((CAST(${schema.salesItems.totalSales} AS NUMERIC) - CAST(${schema.salesItems.totalCost} AS NUMERIC)))`,
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
        value,
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

  return {
    filteredSupplierBalances,
    customerBalancesList,
    financialSummary,
    inventoryByLocationWithNames,
    topSellingWithNames,
    recentTransactions,
    slowMovingStock,
    itemsToMarkdown,
    overdueContainers,
    containersInTransit,
    employees,
  };
}
