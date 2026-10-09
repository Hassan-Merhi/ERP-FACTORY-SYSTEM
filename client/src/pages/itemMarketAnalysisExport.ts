import type { MarketRow, ProfitDirectionFilter } from "./itemMarketAnalysisParts";

type MarketStatus = MarketRow["marketStatus"];
export interface GroupedMarketExportRow {
  itemKey: string;
  code: string;
  name: string;
  stockGroupName: string | null;
  companyRows: MarketRow[];
  importCount: number;
  importedQty: number;
  purchaseValue: number | null;
  weightedPurchaseCost: number | null;
  purchaseValueWithOffloading: number | null;
  weightedPurchaseCostWithOffloading: number | null;
  purchaseCurrencies: string[];
  soldQty: number;
  revenue: number;
  historicalCost: number;
  profit: number;
  avgSellingPrice: number;
  profitPerUnit: number;
  marginPct: number;
  marketStatus: MarketStatus;
}

export interface SalePriceExportRow {
  companyId: number;
  stockItemId: number;
  activityType: "sale" | "return";
  unitPrice: number;
  quantity: number;
  revenue: number;
  profit: number;
  transactionCount: number;
}

export interface ItemMarketExportOptions {
  groups: GroupedMarketExportRow[];
  rows: MarketRow[];
  companySummaries: Array<{
    companyId: number;
    companyCode: string;
    companyName: string;
    itemCount: number;
    importedQty: number;
    soldQty: number;
    revenue: number;
    profit: number;
    marginPct: number;
  }>;
  summary: {
    itemCount: number;
    importedQty: number;
    soldQty: number;
    revenue: number;
    profit: number;
    marginPct: number;
  };
  salePriceRows: SalePriceExportRow[];
  startDate?: string;
  endDate?: string;
  search: string;
  stockGroups: string[];
  companyNames: string[];
  profitDirection: ProfitDirectionFilter;
  includeOffloadingCost: boolean;
  generatedAt?: string;
}

type ExcelValue = number | string | null;
type Column = { header: string; key: string; width: number; numFmt?: string };
const numberFormat = '#,##0.00;[Red](#,##0.00);–';
const quantityFormat = '#,##0.###;[Red](#,##0.###);–';
const percentFormat = '0.00"%"';

function purchaseAmount(value: number | null, currencies: string[]): ExcelValue {
  return currencies.length > 1 ? "Mixed currencies" : value;
}

function printableStatus(status: MarketStatus): string {
  return status === "no_sales" ? "No sales" : status === "strong" ? "Strong" : status === "watch" ? "Watch" : "Losing";
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 36) || "all";
}

/** Export the complete filtered data returned by the report; never use the UI's 250-row page slice. */
export async function exportItemMarketAnalysisExcel(options: ItemMarketExportOptions): Promise<void> {
  // Load the large Excel library only when the user clicks Export.
  const { ExcelJS, writeFile } = await import("@/lib/excelHelper");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Business OS";
  workbook.subject = "Filtered Item Market Analysis";
  workbook.created = new Date();

  const navy = "17324D";
  const cyan = "D9F0F4";
  const pale = "F4F7FA";
  const moneyFields = new Set(["purchaseValue", "purchaseAverage", "purchaseWithOffloading", "averageWithOffloading", "historicalCost", "avgSell", "revenue", "profit", "profitPerUnit", "unitPrice"]);
  const pctFields = new Set(["marginPct"]);

  function addDataSheet(name: string, columns: Column[], values: Record<string, ExcelValue>[]) {
    const sheet = workbook.addWorksheet(name, {
      views: [{ state: "frozen", ySplit: 1, xSplit: 2 }],
    });
    sheet.columns = columns;
    const header = sheet.getRow(1);
    header.height = 30;
    header.font = { name: "Aptos", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + navy } };
    header.alignment = { vertical: "middle", wrapText: true };

    values.forEach((entry, i) => {
      const row = sheet.addRow(entry);
      row.height = 20;
      if (i % 2 === 1) {
        row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + pale } };
      }
      for (let column = 1; column <= columns.length; column++) {
        const cell = row.getCell(column);
        const key = columns[column - 1].key;
        cell.alignment = { vertical: "middle" };
        if (typeof cell.value === "number") {
          cell.numFmt = columns[column - 1].numFmt ??
            (pctFields.has(key) ? percentFormat : moneyFields.has(key) ? numberFormat : quantityFormat);
        }
        if (key === "profit" && typeof cell.value === "number") {
          cell.font = { color: { argb: cell.value < 0 ? "FFB4232B" : "FF167A55" }, bold: true };
        }
      }
    });
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    sheet.getRow(1).eachCell((cell) => {
      cell.border = { bottom: { style: "medium", color: { argb: "FF" + cyan } } };
    });
    return sheet;
  }

  const overview = workbook.addWorksheet("Overview", {
    views: [{ state: "frozen", ySplit: 3 }],
  });
  overview.columns = [{ width: 27 }, { width: 54 }, { width: 22 }, { width: 22 }];
  overview.mergeCells("A1:D2");
  const title = overview.getCell("A1");
  title.value = "ITEM MARKET ANALYSIS";
  title.font = { name: "Aptos Display", size: 18, bold: true, color: { argb: "FFFFFFFF" } };
  title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + navy } };
  title.alignment = { vertical: "middle", indent: 1 };
  overview.getRow(1).height = 27;
  overview.getRow(2).height = 18;

  const metadata: Array<[string, string | number]> = [
    ["From date", options.startDate || "All time"],
    ["To date", options.endDate || "All time"],
    ["Companies", options.companyNames.join(", ")],
    ["Stock groups", options.stockGroups.length ? options.stockGroups.join(", ") : "All"],
    ["Search", options.search || "None"],
    ["Profit filter", options.profitDirection === "all" ? "All" : options.profitDirection],
    ["Purchase cost view", options.includeOffloadingCost ? "Cost + offloading" : "Cost only"],
    ["Report generated (UTC)", options.generatedAt || ""],
    ["Workbook exported (UTC)", new Date().toISOString()],
    ["Visible item codes", options.summary.itemCount],
    ["Company-item records", options.rows.length],
  ];
  metadata.forEach(([key, value], i) => {
    const line = i + 4;
    overview.getCell(line, 1).value = key;
    overview.getCell(line, 1).font = { bold: true };
    overview.getCell(line, 2).value = value;
    if (i % 2) {
      overview.getRow(line).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + pale } };
    }
  });
  const metricStart = 17;
  overview.getCell(metricStart, 1).value = "FILTERED TOTALS";
  overview.getCell(metricStart, 1).font = { bold: true, color: { argb: "FF" + navy }, size: 13 };
  const metrics: Array<[string, number]> = [
    ["Items", options.summary.itemCount],
    ["Imported Qty", options.summary.importedQty],
    ["Sold Qty", options.summary.soldQty],
    ["Revenue (USD)", options.summary.revenue],
    ["Historical Profit (USD)", options.summary.profit],
    ["Margin (%)", options.summary.marginPct],
  ];
  metrics.forEach(([name, value], i) => {
    overview.getCell(metricStart + 1 + i, 1).value = name;
    const cell = overview.getCell(metricStart + 1 + i, 2);
    cell.value = value;
    cell.numFmt = i === 5 ? percentFormat : i >= 3 ? numberFormat : quantityFormat;
    cell.font = { bold: true };
  });
  overview.getCell(26, 1).value = "Source: historic report results under authorized company and location access. Purchase figures are native currency; mixed currencies are not summed. Revenue, cost of sales, and historical profit use report values.";
  overview.mergeCells("A26:D27");
  overview.getCell("A26").alignment = { wrapText: true, vertical: "top" };
  overview.getCell("A26").font = { italic: true, color: { argb: "FF555F6B" }, size: 10 };

  addDataSheet("Item Summary", [
    { header: "Code", key: "code", width: 18 },
    { header: "Item", key: "name", width: 36 },
    { header: "Stock Group", key: "stockGroup", width: 24 },
    { header: "Companies", key: "companyCount", width: 13 },
    { header: "Company Names", key: "companyNames", width: 45 },
    { header: "Imports", key: "importCount", width: 12 },
    { header: "Imported Qty", key: "importedQty", width: 15 },
    { header: "Purchase Currencies", key: "currencies", width: 22 },
    { header: "Purchase Value", key: "purchaseValue", width: 18 },
    { header: "Average Purchase", key: "purchaseAverage", width: 19 },
    { header: "Purchase + Offloading", key: "purchaseWithOffloading", width: 22 },
    { header: "Avg Cost + Offloading", key: "averageWithOffloading", width: 22 },
    { header: "Sold Qty", key: "soldQty", width: 15 },
    { header: "Avg Sell (USD)", key: "avgSell", width: 18 },
    { header: "Revenue (USD)", key: "revenue", width: 19 },
    { header: "Historical Cost (USD)", key: "historicalCost", width: 21 },
    { header: "Profit (USD)", key: "profit", width: 19 },
    { header: "Profit / Sold Unit", key: "profitPerUnit", width: 20 },
    { header: "Margin %", key: "marginPct", width: 14 },
    { header: "Status", key: "status", width: 14 },
    { header: "Top Profit Company", key: "topProfitCompany", width: 30 },
  ], options.groups.map((group) => {
    // Multiple stock IDs can share a normalized code inside a company.
    // Match the on-screen comparison: aggregate by company before ranking.
    const byCompany = new Map<number, { name: string; revenue: number; profit: number }>();
    for (const row of group.companyRows) {
      const total = byCompany.get(row.companyId) ?? { name: row.companyName, revenue: 0, profit: 0 };
      total.revenue += row.revenue;
      total.profit += row.profit;
      byCompany.set(row.companyId, total);
    }
    const mostProfitable = [...byCompany.values()]
      .filter((company) => company.revenue > 0 && company.profit > 0)
      .sort((a, b) => b.profit - a.profit);
    const winner = mostProfitable.length === 0 ? "None"
      : mostProfitable.length > 1 && Math.abs(mostProfitable[0].profit - mostProfitable[1].profit) < 0.005
        ? "Equal" : mostProfitable[0].name;
    return {
      code: group.code,
      name: group.name,
      stockGroup: group.stockGroupName || "",
      companyCount: group.companyRows.length,
      companyNames: group.companyRows.map((row) => row.companyName).join(", "),
      importCount: group.importCount,
      importedQty: group.importedQty,
      currencies: group.purchaseCurrencies.join(", "),
      purchaseValue: purchaseAmount(group.purchaseValue, group.purchaseCurrencies),
      purchaseAverage: purchaseAmount(group.weightedPurchaseCost, group.purchaseCurrencies),
      purchaseWithOffloading: purchaseAmount(group.purchaseValueWithOffloading, group.purchaseCurrencies),
      averageWithOffloading: purchaseAmount(group.weightedPurchaseCostWithOffloading, group.purchaseCurrencies),
      soldQty: group.soldQty,
      avgSell: group.avgSellingPrice,
      revenue: group.revenue,
      historicalCost: group.historicalCost,
      profit: group.profit,
      profitPerUnit: group.profitPerUnit,
      marginPct: group.marginPct,
      status: printableStatus(group.marketStatus),
      topProfitCompany: winner,
    };
  }));

  addDataSheet("Company Item Details", [
    { header: "Company", key: "companyName", width: 30 },
    { header: "Company Code", key: "companyCode", width: 16 },
    { header: "Company ID", key: "companyId", width: 13 },
    { header: "Item Code", key: "code", width: 18 },
    { header: "Item Name", key: "name", width: 36 },
    { header: "Stock Item ID", key: "stockItemId", width: 16 },
    { header: "Stock Group", key: "stockGroup", width: 24 },
    { header: "Stock Group ID", key: "stockGroupId", width: 16 },
    { header: "Imports", key: "importCount", width: 13 },
    { header: "Imported Qty", key: "importedQty", width: 15 },
    { header: "Purchase Currencies", key: "currencies", width: 21 },
    { header: "Purchase Value", key: "purchaseValue", width: 19 },
    { header: "Average Purchase", key: "purchaseAverage", width: 20 },
    { header: "Purchase + Offloading", key: "purchaseWithOffloading", width: 22 },
    { header: "Avg Cost + Offloading", key: "averageWithOffloading", width: 22 },
    { header: "Sold Qty", key: "soldQty", width: 15 },
    { header: "Avg Sell (USD)", key: "avgSell", width: 18 },
    { header: "Revenue (USD)", key: "revenue", width: 18 },
    { header: "Historical Cost (USD)", key: "historicalCost", width: 22 },
    { header: "Profit (USD)", key: "profit", width: 20 },
    { header: "Profit / Sold Unit", key: "profitPerUnit", width: 21 },
    { header: "Margin %", key: "marginPct", width: 14 },
    { header: "Status", key: "status", width: 14 },
  ], options.rows.map((row) => ({
    companyName: row.companyName,
    companyCode: row.companyCode,
    companyId: row.companyId,
    code: row.code,
    name: row.name,
    stockItemId: row.stockItemId,
    stockGroup: row.stockGroupName || "",
    stockGroupId: row.stockGroupId,
    importCount: row.importCount,
    importedQty: row.importedQty,
    currencies: row.purchaseCurrencies.join(", "),
    purchaseValue: purchaseAmount(row.purchaseValue, row.purchaseCurrencies),
    purchaseAverage: purchaseAmount(row.weightedPurchaseCost, row.purchaseCurrencies),
    purchaseWithOffloading: purchaseAmount(row.purchaseValueWithOffloading, row.purchaseCurrencies),
    averageWithOffloading: purchaseAmount(row.weightedPurchaseCostWithOffloading, row.purchaseCurrencies),
    soldQty: row.soldQty,
    avgSell: row.avgSellingPrice,
    revenue: row.revenue,
    historicalCost: row.historicalCost,
    profit: row.profit,
    profitPerUnit: row.profitPerUnit,
    marginPct: row.marginPct,
    status: printableStatus(row.marketStatus),
  })));

  addDataSheet("Company Totals", [
    { header: "Company", key: "companyName", width: 36 },
    { header: "Company Code", key: "companyCode", width: 16 },
    { header: "Company ID", key: "companyId", width: 14 },
    { header: "Items", key: "itemCount", width: 14 },
    { header: "Imported Qty", key: "importedQty", width: 20 },
    { header: "Sold Qty", key: "soldQty", width: 17 },
    { header: "Revenue (USD)", key: "revenue", width: 22 },
    { header: "Profit (USD)", key: "profit", width: 22 },
    { header: "Margin %", key: "marginPct", width: 15 },
  ], options.companySummaries);

  const byId = new Map(options.rows.map((row) => [row.companyId + ":" + row.stockItemId, row]));
  addDataSheet("Sale Price Breakdown", [
    { header: "Company", key: "companyName", width: 31 },
    { header: "Item Code", key: "code", width: 19 },
    { header: "Item Name", key: "name", width: 38 },
    { header: "Stock Item ID", key: "stockItemId", width: 17 },
    { header: "Type", key: "activityType", width: 15 },
    { header: "Sold Price (USD)", key: "unitPrice", width: 20 },
    { header: "Qty", key: "quantity", width: 17 },
    { header: "Revenue (USD)", key: "revenue", width: 20 },
    { header: "Profit (USD)", key: "profit", width: 20 },
    { header: "Transactions", key: "transactionCount", width: 18 },
  ], options.salePriceRows.map((row) => {
    const item = byId.get(row.companyId + ":" + row.stockItemId);
    return {
      companyName: item?.companyName ?? "",
      code: item?.code ?? "",
      name: item?.name ?? "",
      stockItemId: row.stockItemId,
      activityType: row.activityType === "return" ? "Return" : "Sale",
      unitPrice: row.unitPrice,
      quantity: row.quantity,
      revenue: row.revenue,
      profit: row.profit,
      transactionCount: row.transactionCount,
    };
  }));

  const filename = "item_market_analysis_" + safeFilePart(options.companyNames.length === 1 ? options.companyNames[0] : options.companyNames.length + "_companies") +
    "_" + (options.startDate || "all") + "_to_" + (options.endDate || "all") + ".xlsx";
  await writeFile(workbook, filename);
}
