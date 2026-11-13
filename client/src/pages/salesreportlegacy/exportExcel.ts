import { writeFile } from "@/lib/excelHelper";
import { buildUniversalExcelWorkbook, type UniversalExcelColumn } from "@shared/universal-excel/engine";
import { format } from "date-fns";
import type { SalesReportItem } from "./types";

/**
 * Detailed ERP sales report. The shared engine owns its layout while original
 * financial calculations, percentage representation and profit/loss colors
 * remain exactly controlled by this report.
 */
export async function exportSalesReportExcel(salesData: SalesReportItem[]) {
  const money = '"$"#,##0.00';
  const columns: UniversalExcelColumn[] = [
    { key: "location", header: "Location", width: 15 },
    { key: "itemCode", header: "Item Code", width: 15 },
    { key: "itemName", header: "Item Name", width: 30 },
    { key: "quantity", header: "Quantity", type: "decimal", width: 10 },
    { key: "soldPrice", header: "Sold Price", type: "money", numFmt: money, width: 12 },
    { key: "costPrice", header: "Cost Price", type: "money", numFmt: money, width: 12 },
    { key: "hassansPrice", header: "Hassan's Price", type: "money", numFmt: money, width: 14 },
    { key: "unitProfit", header: "Unit Profit", type: "money", numFmt: money, width: 12 },
    { key: "totalSales", header: "Total Sales", type: "money", numFmt: money, width: 12 },
    { key: "totalCost", header: "Total Cost", type: "money", numFmt: money, width: 12 },
    { key: "costProfit", header: "Cost Profit", type: "money", numFmt: money, width: 12 },
    // Source percentages are already in units 0–100. Do not multiply by 100.
    { key: "costPercent", header: "Cost %", type: "decimal", numFmt: '0.0"%"', width: 10 },
    { key: "hassansProfit", header: "Hassan's Profit", type: "money", numFmt: money, width: 14 },
    { key: "hassansPercent", header: "Hassan's %", type: "decimal", numFmt: '0.0"%"', width: 12 },
  ];
  const rows = salesData.map(item => ({
    location: item.locationName || "N/A",
    itemCode: item.stockItemCode || "",
    itemName: item.stockItemName,
    quantity: Number(item.quantity || 0),
    soldPrice: Number(item.actualSellingPrice || 0),
    costPrice: Number(item.costPrice || 0),
    hassansPrice: Number(item.configuredSellingPrice || 0),
    unitProfit: Number(item.actualSellingPrice || 0) - Number(item.costPrice || 0),
    totalSales: Number(item.totalSales || 0),
    totalCost: Number(item.totalCost || 0),
    costProfit: Number(item.costProfit || 0),
    costPercent: item.costProfitPercentage,
    hassansProfit: item.configuredProfit,
    hassansPercent: item.configuredProfitPercentage,
  }));
  const { workbook } = buildUniversalExcelWorkbook({
    schemaVersion: 1,
    mode: "report",
    title: "Detailed Sales Report",
    currencyCode: "USD",
    sheets: [{
      kind: "table",
      name: "Detailed Sales Report",
      columns,
      rows,
    }],
  });

  // Preserve the existing red-loss/green-profit signal without changing
  // accounting figures or creating extra columns.
  const worksheet = workbook.getWorksheet("Detailed Sales Report")!;
  const profitColumns = [8, 11, 12, 13, 14];
  for (let i = 0; i < rows.length; i += 1) {
    const row = worksheet.getRow(i + 6);
    for (const col of profitColumns) {
      const cell = row.getCell(col);
      const value = typeof cell.value === "number" ? cell.value : 0;
      if (value < 0) cell.font = { name: "Aptos", color: { argb: "FFE57373" } };
      else if (value > 0) cell.font = { name: "Aptos", color: { argb: "FF4CAF50" } };
    }
  }

  const fileName = "detailed-sales-report-" + format(new Date(), "yyyy-MM-dd") + ".xlsx";
  await writeFile(workbook, fileName);
}
