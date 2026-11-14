import { writeFile, ExcelJS } from "@/lib/excelHelper";
import { exportFileName } from "@/lib/exportFile";
import type { SalesReportItem } from "./types";

export async function exportSalesReportExcel(salesData: SalesReportItem[]) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Detailed Sales Report");

  const currencyCols = [5, 6, 7, 8, 9, 10, 11, 13];
  const percentCols = [12, 14];
  const profitCols = [8, 11, 12, 13, 14];

  worksheet.columns = [
    { header: "Location", key: "location", width: 15 },
    { header: "Item Code", key: "itemCode", width: 15 },
    { header: "Item Name", key: "itemName", width: 30 },
    { header: "Quantity", key: "quantity", width: 10 },
    { header: "Sold Price", key: "soldPrice", width: 12 },
    { header: "Cost Price", key: "costPrice", width: 12 },
    { header: "Hassan's Price", key: "hassansPrice", width: 14 },
    { header: "Unit Profit", key: "unitProfit", width: 12 },
    { header: "Total Sales", key: "totalSales", width: 12 },
    { header: "Total Cost", key: "totalCost", width: 12 },
    { header: "Cost Profit", key: "costProfit", width: 12 },
    { header: "Cost %", key: "costPercent", width: 10 },
    { header: "Hassan's Profit", key: "hassansProfit", width: 14 },
    { header: "Hassan's %", key: "hassansPercent", width: 12 },
  ];

  const headerRow = worksheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5F5F5" } };
  headerRow.eachCell((cell) => {
    cell.border = {
      top: { style: "medium", color: { argb: "FF999999" } },
      bottom: { style: "medium", color: { argb: "FF999999" } },
      left: { style: "medium", color: { argb: "FF999999" } },
      right: { style: "medium", color: { argb: "FF999999" } },
    };
  });

  salesData.forEach((item) => {
    const unitProfit = parseFloat(item.actualSellingPrice) - parseFloat(item.costPrice);
    const row = worksheet.addRow({
      location: item.locationName || "N/A",
      itemCode: item.stockItemCode || "",
      itemName: item.stockItemName,
      quantity: parseFloat(item.quantity),
      soldPrice: parseFloat(item.actualSellingPrice),
      costPrice: parseFloat(item.costPrice),
      hassansPrice: parseFloat(item.configuredSellingPrice),
      unitProfit: unitProfit,
      totalSales: parseFloat(item.totalSales),
      totalCost: parseFloat(item.totalCost),
      costProfit: parseFloat(item.costProfit),
      costPercent: item.costProfitPercentage,
      hassansProfit: item.configuredProfit,
      hassansPercent: item.configuredProfitPercentage,
    });

    row.eachCell((cell, colNumber) => {
      cell.border = {
        top: { style: "medium", color: { argb: "FF999999" } },
        bottom: { style: "medium", color: { argb: "FF999999" } },
        left: { style: "medium", color: { argb: "FF999999" } },
        right: { style: "medium", color: { argb: "FF999999" } },
      };

      if (currencyCols.includes(colNumber)) cell.numFmt = '"$"#,##0.00';
      if (percentCols.includes(colNumber)) cell.numFmt = '0.0"%"';

      const val = typeof cell.value === "number" ? cell.value : parseFloat(String(cell.value || 0));
      if (profitCols.includes(colNumber) && !isNaN(val)) {
        if (val < 0) cell.font = { color: { argb: "FFE57373" } };
        else if (val > 0) cell.font = { color: { argb: "FF4CAF50" } };
      }
    });
  });

  const fileName = exportFileName("detailed sales report", "xlsx");
  await writeFile(workbook, fileName);
}
