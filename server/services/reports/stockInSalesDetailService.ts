import { punctuationInsensitiveSearch } from "../../lib/searchNormalization";
import Decimal from "decimal.js";
import { and, desc, eq, gte, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";

import { db } from "../../db";
import { creditNoteItems, locations, salesItems, stockGroups, stockItems, vouchers } from "@shared/schema";
import { getStockInSalesReport } from "./stockInSalesReportService";
import {
  EXPORT_LIMIT,
  addItemFilters,
  divideOrZero,
  loadAdjustments,
  loadStockIn,
  toNumber,
  type PaginationResult,
  type StockInSalesDetailFilters,
  type StockInSalesDetailResult,
  type StockOutDetailRow,
} from "./stockInSalesDetailServiceLoadStockIn";
export type {
  StockAdjustmentDetailRow,
  StockInDetailRow,
  StockInSalesDetailFilters,
  StockInSalesDetailResult,
  StockOutDetailRow,
} from "./stockInSalesDetailServiceLoadStockIn";

async function loadStockOut(filters: StockInSalesDetailFilters): Promise<PaginationResult<StockOutDetailRow>> {
  const salesConditions: SQL[] = [
    eq(vouchers.companyId, filters.companyId),
    eq(vouchers.voucherType, "Sales"),
    eq(vouchers.optional, false),
    isNull(vouchers.deletedAt),
    eq(stockItems.companyId, filters.companyId),
    gte(vouchers.voucherDate, filters.startDate),
    lte(vouchers.voucherDate, filters.endDate),
  ];
  addItemFilters(
    salesConditions,
    filters,
    filters.locationIds.length > 0 ? inArray(vouchers.locationId, filters.locationIds) : undefined,
    filters.search
      ? [
          punctuationInsensitiveSearch(vouchers.voucherNumber, filters.search),
          punctuationInsensitiveSearch(vouchers.locationName, filters.search),
        ]
      : []
  );

  const noteConditions: SQL[] = [
    eq(vouchers.companyId, filters.companyId),
    inArray(vouchers.voucherType, ["Credit Note", "Debit Note"]),
    eq(vouchers.optional, false),
    isNull(vouchers.deletedAt),
    eq(stockItems.companyId, filters.companyId),
    eq(locations.companyId, filters.companyId),
    gte(vouchers.voucherDate, filters.startDate),
    lte(vouchers.voucherDate, filters.endDate),
  ];
  addItemFilters(
    noteConditions,
    filters,
    filters.locationIds.length > 0 ? inArray(creditNoteItems.locationId, filters.locationIds) : undefined,
    filters.search ? [punctuationInsensitiveSearch(vouchers.voucherNumber, filters.search)] : []
  );

  const salesWhere = and(...salesConditions);
  const notesWhere = and(...noteConditions);
  const [salesCount, noteCount, rawSalesRows, rawNoteRows] = await Promise.all([
    db
      .select({ total: sql<number>`COUNT(*)::int` })
      .from(salesItems)
      .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
      .innerJoin(stockItems, eq(salesItems.stockItemId, stockItems.id))
      .leftJoin(locations, and(eq(vouchers.locationId, locations.id), eq(locations.companyId, filters.companyId)))
      .leftJoin(stockGroups, eq(stockItems.stockGroupId, stockGroups.id))
      .where(salesWhere),
    db
      .select({ total: sql<number>`COUNT(*)::int` })
      .from(creditNoteItems)
      .innerJoin(vouchers, eq(creditNoteItems.voucherId, vouchers.id))
      .innerJoin(stockItems, eq(creditNoteItems.stockItemId, stockItems.id))
      .innerJoin(locations, eq(creditNoteItems.locationId, locations.id))
      .leftJoin(stockGroups, eq(stockItems.stockGroupId, stockGroups.id))
      .where(notesWhere),
    db
      .select({
        id: salesItems.id,
        activityDate: vouchers.voucherDate,
        voucherId: vouchers.id,
        voucherNumber: vouchers.voucherNumber,
        isCreditSale: vouchers.isCreditSale,
        locationId: vouchers.locationId,
        locationName: sql<string>`COALESCE(${locations.name}, ${vouchers.locationName}, 'Unassigned')`,
        stockGroupId: stockGroups.id,
        stockGroupName: stockGroups.name,
        stockItemId: stockItems.id,
        stockItemCode: stockItems.code,
        stockItemName: stockItems.name,
        quantity: salesItems.quantity,
        sellingRate: salesItems.sellingPrice,
        unitCost: salesItems.costPrice,
        totalSales: salesItems.totalSales,
        totalCost: salesItems.totalCost,
        costProfit: sql<string>`(${salesItems.totalSales}::numeric - ${salesItems.totalCost}::numeric)`,
      })
      .from(salesItems)
      .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
      .innerJoin(stockItems, eq(salesItems.stockItemId, stockItems.id))
      .leftJoin(locations, and(eq(vouchers.locationId, locations.id), eq(locations.companyId, filters.companyId)))
      .leftJoin(stockGroups, eq(stockItems.stockGroupId, stockGroups.id))
      .where(salesWhere)
      .orderBy(desc(vouchers.voucherDate), desc(vouchers.voucherNumber), desc(salesItems.id))
      .limit(EXPORT_LIMIT),
    db
      .select({
        id: creditNoteItems.id,
        sourceType: vouchers.voucherType,
        activityDate: vouchers.voucherDate,
        voucherId: vouchers.id,
        voucherNumber: vouchers.voucherNumber,
        locationId: creditNoteItems.locationId,
        locationName: locations.name,
        stockGroupId: stockGroups.id,
        stockGroupName: stockGroups.name,
        stockItemId: stockItems.id,
        stockItemCode: stockItems.code,
        stockItemName: stockItems.name,
        quantity: creditNoteItems.quantity,
        sellingRate: creditNoteItems.rate,
        unitCost: creditNoteItems.inventoryCost,
        totalSales: creditNoteItems.totalValue,
      })
      .from(creditNoteItems)
      .innerJoin(vouchers, eq(creditNoteItems.voucherId, vouchers.id))
      .innerJoin(stockItems, eq(creditNoteItems.stockItemId, stockItems.id))
      .innerJoin(locations, eq(creditNoteItems.locationId, locations.id))
      .leftJoin(stockGroups, eq(stockItems.stockGroupId, stockGroups.id))
      .where(notesWhere)
      .orderBy(desc(vouchers.voucherDate), desc(vouchers.voucherNumber), desc(creditNoteItems.id))
      .limit(EXPORT_LIMIT),
  ]);

  const saleRows: StockOutDetailRow[] = rawSalesRows.map((row) => {
    const quantity = toNumber(row.quantity, 3);
    const costProfit = toNumber(row.costProfit, 2);
    return {
      id: row.id,
      sourceType: "Sale",
      activityDate: String(row.activityDate),
      voucherId: row.voucherId,
      voucherNumber: row.voucherNumber,
      isCreditSale: row.isCreditSale,
      locationId: row.locationId,
      locationName: row.locationName,
      stockGroupId: row.stockGroupId,
      stockGroupName: row.stockGroupName || "Unassigned",
      stockItemId: row.stockItemId,
      stockItemCode: row.stockItemCode,
      stockItemName: row.stockItemName,
      quantity,
      sellingRate: toNumber(row.sellingRate, 6),
      unitCost: toNumber(row.unitCost, 6),
      totalSales: toNumber(row.totalSales, 2),
      totalCost: toNumber(row.totalCost, 2),
      costProfit,
      avgProfitPerBale: divideOrZero(costProfit, quantity),
    };
  });

  const noteRows: StockOutDetailRow[] = rawNoteRows.map((row) => {
    const sourceType = row.sourceType === "Credit Note" ? "Credit Note" : "Debit Note";
    const sign = sourceType === "Credit Note" ? -1 : 1;
    const quantity = toNumber(new Decimal(row.quantity).times(sign), 3);
    const totalSales = toNumber(new Decimal(row.totalSales).times(sign), 2);
    const totalCost = toNumber(new Decimal(row.quantity).times(row.unitCost).times(sign), 2);
    const costProfit = toNumber(new Decimal(totalSales).minus(totalCost), 2);
    return {
      id: row.id,
      sourceType,
      activityDate: String(row.activityDate),
      voucherId: row.voucherId,
      voucherNumber: row.voucherNumber,
      isCreditSale: null,
      locationId: row.locationId,
      locationName: row.locationName,
      stockGroupId: row.stockGroupId,
      stockGroupName: row.stockGroupName || "Unassigned",
      stockItemId: row.stockItemId,
      stockItemCode: row.stockItemCode,
      stockItemName: row.stockItemName,
      quantity,
      sellingRate: toNumber(row.sellingRate, 6),
      unitCost: toNumber(row.unitCost, 6),
      totalSales,
      totalCost,
      costProfit,
      avgProfitPerBale: divideOrZero(costProfit, quantity),
    };
  });

  const combined = [...saleRows, ...noteRows].sort((a, b) => {
    const dateCompare = b.activityDate.localeCompare(a.activityDate);
    if (dateCompare !== 0) return dateCompare;
    const voucherCompare = b.voucherNumber.localeCompare(a.voucherNumber);
    if (voucherCompare !== 0) return voucherCompare;
    return b.id - a.id;
  });

  const databaseTotal = Number(salesCount[0]?.total || 0) + Number(noteCount[0]?.total || 0);
  const availableRows = combined.slice(0, EXPORT_LIMIT);
  const truncated = databaseTotal > availableRows.length;
  const requestedLimit = filters.exportAll ? EXPORT_LIMIT : filters.limit;
  const requestedPage = filters.exportAll ? 1 : filters.stockOutPage;
  const offset = (requestedPage - 1) * requestedLimit;
  const rows = filters.exportAll ? availableRows : availableRows.slice(offset, offset + requestedLimit);
  const total = truncated ? availableRows.length : databaseTotal;

  return {
    rows,
    total,
    page: requestedPage,
    limit: requestedLimit,
    totalPages: Math.max(1, Math.ceil(total / requestedLimit)),
    truncated,
  };
}

export async function getStockInSalesDetail(filters: StockInSalesDetailFilters): Promise<StockInSalesDetailResult> {
  const [summaryReport, stockIn, stockOut, adjustments] = await Promise.all([
    getStockInSalesReport({
      companyId: filters.companyId,
      startDate: filters.startDate,
      endDate: filters.endDate,
      grouping: "daily",
      profitFilter: "all",
      locationIds: filters.locationIds,
      stockGroupIds: filters.stockGroupIds,
      search: filters.search,
    }),
    loadStockIn(filters),
    loadStockOut(filters),
    loadAdjustments(filters),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    period: { startDate: filters.startDate, endDate: filters.endDate },
    filters: {
      startDate: filters.startDate,
      endDate: filters.endDate,
      locationIds: filters.locationIds,
      stockGroupIds: filters.stockGroupIds,
      search: filters.search,
    },
    summary: summaryReport.summary,
    stockIn,
    stockOut,
    adjustments,
  };
}
