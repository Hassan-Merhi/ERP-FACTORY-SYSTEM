import { styleUniversalFinancialWorkbook } from "@shared/universal-excel/financialWorkbookStyle";
/**
 * Supplier Profit Check Excel exports.
 *
 * Supplier export consolidates legacy duplicate proforma lines before writing.
 * Internal export consumes the exact effective sell/Dubai/landing values shown
 * by the client so the workbook cannot disagree with the on-screen analysis.
 */
import type { Express, Request, Response, RequestHandler } from "express";
import ExcelJS from "exceljs";
import { pool } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";

const NAVY = "1A2C5B";
const GOLD = "C9A84C";
const LIGHT_GOLD = "F7EFD8";
const WHITE = "FFFFFF";
const GREEN = "1A7A3E";
const RED = "C0392B";
const YELLOW = "856404";
const LIGHT_RED = "FDECEA";
const LIGHT_GREEN = "E9F7EF";
const LIGHT_YELLOW = "FFF9E6";

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function applyHeader(cell: ExcelJS.Cell) {
  cell.font = { bold: true, color: { argb: WHITE } };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GOLD } };
  cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
}

function sendWorkbook(res: Response, workbook: ExcelJS.Workbook, filename: string) {
  styleUniversalFinancialWorkbook(
    workbook,
    workbook.worksheets.map((ws) => ({ name: ws.name }))
  );
  return workbook.xlsx.writeBuffer().then((raw) => {
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(Buffer.from(raw));
  });
}

export function registerSupplierProfitExportRoutes(app: Express, requireAuth: RequestHandler) {
  app.get(
    "/api/supplier-profit-check/proforma/:proformaId/export-supplier",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const proformaId = Number(req.params.proformaId);
        if (!Number.isInteger(proformaId) || proformaId <= 0) {
          return res.status(400).json({ message: "Invalid proformaId" });
        }

        const proformaResult = await pool.query(
          `
          SELECT sp.id, sp.reference, sp.notes, s.legal_name AS supplier_name
          FROM supplier_proformas sp
          JOIN suppliers s ON s.id = sp.supplier_id
          WHERE sp.id = $1
            AND sp.company_id = $2
            AND s.company_id = $2
            AND s.deleted_at IS NULL
        `,
          [proformaId, companyId]
        );
        if (proformaResult.rows.length === 0) return res.status(404).json({ message: "Proforma not found" });
        const proforma = proformaResult.rows[0];

        const linesResult = await pool.query(
          `
          WITH resolved AS (
            SELECT
              si.id AS stock_item_id,
              COALESCE(si.code, spl.barcode) AS barcode,
              COALESCE(si.name, spl.item_name) AS item_name,
              spl.qty::numeric AS qty,
              spl.price_per_bale::numeric AS price_per_bale
            FROM supplier_proforma_lines spl
            JOIN supplier_proformas sp ON sp.id = spl.proforma_id
            LEFT JOIN LATERAL (
              SELECT candidate.id, candidate.code, candidate.name
              FROM stock_items candidate
              WHERE candidate.company_id = $2
                AND candidate.deleted_at IS NULL
                AND (
                  lower(candidate.code) = lower(spl.barcode)
                  OR EXISTS (
                    SELECT 1
                    FROM stock_item_code_aliases alias
                    WHERE alias.stock_item_id = candidate.id
                      AND alias.company_id = $2
                      AND lower(alias.alias_code) = lower(spl.barcode)
                  )
                )
              ORDER BY CASE WHEN lower(candidate.code) = lower(spl.barcode) THEN 0 ELSE 1 END, candidate.id
              LIMIT 1
            ) si ON TRUE
            WHERE sp.id = $1 AND sp.company_id = $2
          )
          SELECT
            stock_item_id,
            barcode,
            item_name,
            SUM(qty)::numeric AS qty,
            COALESCE(
              SUM(qty * price_per_bale) / NULLIF(SUM(qty) FILTER (WHERE price_per_bale IS NOT NULL), 0),
              0
            )::numeric AS price_per_bale
          FROM resolved
          GROUP BY stock_item_id, barcode, item_name
          ORDER BY barcode, stock_item_id
        `,
          [proformaId, companyId]
        );

        const workbook = new ExcelJS.Workbook();
        workbook.creator = "ERP System";
        const sheet = workbook.addWorksheet("Proforma");
        sheet.columns = [
          { key: "item_code", width: 18 },
          { key: "item_name", width: 38 },
          { key: "qty", width: 12 },
          { key: "unit_price", width: 16 },
          { key: "total_price", width: 18 },
        ];

        sheet.mergeCells("A1:E1");
        const title = sheet.getCell("A1");
        title.value = "SUPPLIER PROFORMA";
        title.font = { bold: true, size: 16, color: { argb: WHITE } };
        title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
        title.alignment = { horizontal: "center", vertical: "middle" };
        sheet.getRow(1).height = 30;

        sheet.mergeCells("A2:C2");
        sheet.getCell("A2").value = `Supplier: ${proforma.supplier_name}`;
        sheet.mergeCells("D2:E2");
        sheet.getCell("D2").value = `Ref: ${proforma.reference}`;
        sheet.getCell("D2").alignment = { horizontal: "right" };
        sheet.mergeCells("A3:C3");
        sheet.getCell("A3").value = `Date: ${new Date().toLocaleDateString()}`;
        sheet.mergeCells("D3:E3");
        sheet.getCell("D3").value = proforma.notes || "";
        for (const address of ["A2", "D2", "A3", "D3"]) {
          const cell = sheet.getCell(address);
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT_GOLD } };
          cell.font = { color: { argb: NAVY }, bold: address === "A2" || address === "D2" };
        }

        const header = sheet.addRow(["Item Code", "Item Name", "Qty", "Unit Price (USD)", "Total (USD)"]);
        header.eachCell(applyHeader);

        let totalQty = 0;
        let grandTotal = 0;
        for (const [index, line] of linesResult.rows.entries()) {
          const qty = Number(line.qty) || 0;
          const unitPrice = Number(line.price_per_bale) || 0;
          const total = qty * unitPrice;
          totalQty += qty;
          grandTotal += total;
          const row = sheet.addRow([line.barcode, line.item_name, qty, unitPrice, total]);
          if (index % 2 === 0) {
            row.eachCell((cell) => {
              cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "F4F6FA" } };
            });
          }
          row.getCell(3).numFmt = "#,##0";
          row.getCell(4).numFmt = "#,##0.00";
          row.getCell(5).numFmt = "#,##0.00";
        }

        const totalRow = sheet.addRow(["", "GRAND TOTAL", totalQty, "", grandTotal]);
        totalRow.eachCell((cell) => {
          cell.font = { bold: true, color: { argb: WHITE } };
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
        });
        totalRow.getCell(3).numFmt = "#,##0";
        totalRow.getCell(5).numFmt = "#,##0.00";

        await sendWorkbook(res, workbook, `proforma-${proforma.reference}.xlsx`);
      } catch (err: unknown) {
        logger.error("[supplier-profit-check/export-supplier]", { error: getErrorMessage(err) });
        res.status(500).json({ message: getErrorMessage(err) });
      }
    }
  );

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
