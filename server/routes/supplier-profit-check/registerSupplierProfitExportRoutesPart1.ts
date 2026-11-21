// Extracted from ./export.ts
import type { Express, Request, Response, RequestHandler } from "express";
import ExcelJS from "exceljs";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import {
  NAVY,
  GOLD,
  LIGHT_GOLD,
  WHITE,
  GREEN,
  RED,
  YELLOW,
  LIGHT_RED,
  LIGHT_GREEN,
  LIGHT_YELLOW,
  numberOrNull,
  applyHeader,
  sendWorkbook,
} from "./exportHelpers";

export function registerSupplierProfitExportRoutesPart1(app: Express, requireAuth: RequestHandler) {
  app.post("/api/supplier-profit-check/export-internal", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { rows, supplierName, fromDate, toDate, proformaRef } = req.body;
      if (!Array.isArray(rows)) return res.status(400).json({ message: "rows required" });
      if (rows.length > 10000) return res.status(400).json({ message: "Too many rows to export" });

      const workbook = new ExcelJS.Workbook();
      workbook.creator = "ERP System";
      const sheet = workbook.addWorksheet("Analysis");
      sheet.columns = [
        { width: 14 },
        { width: 34 },
        { width: 12 },
        { width: 15 },
        { width: 15 },
        { width: 14 },
        { width: 15 },
        { width: 15 },
        { width: 14 },
        { width: 13 },
        { width: 12 },
        { width: 13 },
        { width: 18 },
        { width: 18 },
        { width: 18 },
        { width: 17 },
        { width: 15 },
        { width: 15 },
        { width: 15 },
      ];

      sheet.mergeCells("A1:S1");
      const title = sheet.getCell("A1");
      title.value = `INTERNAL PROFIT ANALYSIS — ${String(supplierName ?? "")}`;
      title.font = { bold: true, size: 14, color: { argb: WHITE } };
      title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
      title.alignment = { horizontal: "center", vertical: "middle" };
      sheet.getRow(1).height = 28;

      sheet.mergeCells("A2:S2");
      const subtitle = sheet.getCell("A2");
      subtitle.value = `Date Range: ${fromDate || "All Time"} → ${toDate || "All Time"}   |   Proforma Ref: ${proformaRef || "N/A"}`;
      subtitle.fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT_GOLD } };
      subtitle.font = { color: { argb: NAVY } };
      subtitle.alignment = { horizontal: "center" };

      const headers = [
        "Item Code",
        "Item Name",
        "Sales Qty",
        "Effective Sell",
        "Dubai Price",
        "Extra / Bale",
        "Landing Cost",
        "Cost Profit",
        "Cost Profit %",
        "Status",
        "Qty to Order",
        "Total Landing Cost",
        "Est. Total Sales",
        "Est. Cost Profit",
        "Inventory Avg Cost",
        "Hassan Price",
        "Hassan Profit",
        "Current Stock",
        "PO Price Source",
      ];
      const header = sheet.addRow(headers);
      header.eachCell(applyHeader);
      header.height = 28;

      let orderedItemCount = 0;
      let totalQtyOrdered = 0;
      let totalLandingCostSum = 0;
      let totalEstimatedSales = 0;
      let totalEstimatedProfit = 0;

      for (const raw of rows) {
        const qty = Math.max(0, numberOrNull(raw.qty) ?? 0);
        const effectiveSell = numberOrNull(raw.effectiveSellPrice ?? raw.avgSellingPrice);
        const effectivePo = numberOrNull(raw.effectivePoPrice ?? raw.poPrice);
        const extraPerBale = Math.max(0, numberOrNull(raw.extraCostPerBale) ?? 0);
        const landingCost = numberOrNull(raw.landingCost) ?? (effectivePo != null ? effectivePo + extraPerBale : null);
        const costProfit =
          numberOrNull(raw.costProfit) ??
          (effectiveSell != null && landingCost != null ? effectiveSell - landingCost : null);
        const costProfitPct =
          numberOrNull(raw.costProfitPct) ??
          (costProfit != null && effectiveSell != null && effectiveSell > 0
            ? (costProfit / effectiveSell) * 100
            : null);
        const status = String(
          raw.computedStatus ??
            (effectiveSell == null || landingCost == null
              ? "no_sales_data"
              : costProfit! > 0
                ? "gaining"
                : costProfit! < 0
                  ? "losing"
                  : "break_even")
        );
        const inventoryAvgCost = numberOrNull(raw.inventoryAvgCost) ?? 0;
        const hassanPrice = numberOrNull(raw.configPrice) ?? 0;
        const hassanProfit = numberOrNull(raw.hassanProfit) ?? hassanPrice - inventoryAvgCost;
        const totalLandingCost = landingCost != null ? qty * landingCost : 0;
        const estimatedSales = effectiveSell != null ? qty * effectiveSell : 0;
        const estimatedProfit = costProfit != null ? qty * costProfit : 0;

        if (qty > 0) orderedItemCount += 1;
        totalQtyOrdered += qty;
        totalLandingCostSum += totalLandingCost;
        totalEstimatedSales += estimatedSales;
        totalEstimatedProfit += estimatedProfit;

        const row = sheet.addRow([
          raw.code,
          raw.name,
          numberOrNull(raw.salesQty) ?? 0,
          effectiveSell ?? "",
          effectivePo ?? "",
          extraPerBale,
          landingCost ?? "",
          costProfit ?? "",
          costProfitPct ?? "",
          status,
          qty,
          totalLandingCost,
          estimatedSales,
          estimatedProfit,
          inventoryAvgCost,
          hassanPrice,
          hassanProfit,
          numberOrNull(raw.currentStock) ?? 0,
          raw.poPriceSource || "missing",
        ]);

        const fill =
          status === "losing"
            ? LIGHT_RED
            : status === "gaining"
              ? LIGHT_GREEN
              : status === "no_sales_data"
                ? LIGHT_YELLOW
                : null;
        if (fill) {
          row.eachCell((cell) => {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
          });
        }
        const statusCell = row.getCell(10);
        if (status === "gaining") statusCell.font = { bold: true, color: { argb: GREEN } };
        else if (status === "losing") statusCell.font = { bold: true, color: { argb: RED } };
        else if (status === "no_sales_data") statusCell.font = { bold: true, color: { argb: YELLOW } };

        for (const column of [4, 5, 6, 7, 8, 12, 13, 14, 15, 16, 17, 18]) {
          row.getCell(column).numFmt = "#,##0.00";
        }
        row.getCell(9).numFmt = '0.00"%"';
        row.getCell(11).numFmt = "#,##0";
      }

      // Reconciliation totals for the ordered quantities, using the same
      // effective landing-cost and sell-price values as the detail rows so the
      // workbook agrees with the totals shown on the analysis page.
      sheet.addRow([]);
      const summary = sheet.addRow([
        "TOTALS",
        `${orderedItemCount} items`,
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        totalQtyOrdered,
        totalLandingCostSum,
        totalEstimatedSales,
        totalEstimatedProfit,
      ]);
      summary.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: WHITE } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
        cell.border = { top: { style: "double", color: { argb: GOLD } } };
      });
      summary.getCell(11).numFmt = "#,##0";
      for (const column of [12, 13, 14]) {
        summary.getCell(column).numFmt = "#,##0.00";
      }

      await sendWorkbook(res, workbook, `profit-analysis-${proformaRef || "export"}.xlsx`);
    } catch (err: unknown) {
      logger.error("[supplier-profit-check/export-internal]", { error: getErrorMessage(err) });
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
