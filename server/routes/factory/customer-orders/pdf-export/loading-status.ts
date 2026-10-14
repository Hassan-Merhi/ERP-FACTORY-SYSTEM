import ExcelJS from "exceljs";
import { toArrayBuffer } from "../../../../lib/bufferCompatibility";
/**
 * orderPdfExportRoutes: OrderLoadingStatusExport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { contentDisposition } from "../../../../lib/contentDisposition";
import { parseId } from "../../../../lib/parseId";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import {
  factoryBaleProducts,
  factoryBales,
  customerProformaLines,
  customerOrders,
  customerOrderBales,
  customers,
} from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import path from "path";
import fs from "fs";

import { buildExportFilename } from "../orderHelpers";

export function registerOrderLoadingStatusExportRoutes(app: Express) {
  app.get(
    "/api/factory/customer-orders/:id/loading-status-export",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const orderId = parseId(req.params.id);

        if (orderId === null) return res.status(400).json({ message: "Invalid id" });
        const [order] = await db
          .select({
            id: customerOrders.id,
            invoiceNumber: customerOrders.invoiceNumber,
            orderDate: customerOrders.orderDate,
            proformaIdUsed: customerOrders.proformaIdUsed,
            containerNumber: customerOrders.containerNumber,
            destination: customerOrders.destination,
            totalQtyBales: customerOrders.totalQtyBales,
            customerName: customers.legalName,
          })
          .from(customerOrders)
          .leftJoin(customers, eq(customerOrders.customerId, customers.id))
          .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)));

        if (!order) return res.status(404).json({ message: "Order not found" });

        // Fetch proforma lines (requested quantities per article)
        const proformaMap = new Map<string, { qty: number; productName: string }>();
        if (order.proformaIdUsed) {
          const proformaLines = await db
            .select()
            .from(customerProformaLines)
            .where(eq(customerProformaLines.proformaId, order.proformaIdUsed));
          for (const pl of proformaLines) {
            proformaMap.set(pl.articleCode, { qty: pl.quantity, productName: pl.productName });
          }
        }

        // Fetch all bales linked to this order, joining to factoryBales + factoryBaleProducts
        // to get the canonical articleCode (in case the denormalised field on orderBales is null)
        const baleLinks = await db
          .select({
            id: customerOrderBales.id,
            baleId: customerOrderBales.baleId,
            orderBaleArticleCode: customerOrderBales.articleCode,
            baleName: customerOrderBales.baleName,
            baleArticleCode: factoryBales.articleCode,
            baleProductId: factoryBales.productId,
            baleProductName: factoryBales.productName,
            baleReferenceNumber: factoryBales.referenceNumber,
            baleCode: factoryBales.baleCode,
            productArticleCode: factoryBaleProducts.articleCode,
            productName: factoryBaleProducts.name,
          })
          .from(customerOrderBales)
          .leftJoin(factoryBales, eq(customerOrderBales.baleId, factoryBales.id))
          .leftJoin(factoryBaleProducts, eq(factoryBales.productId, factoryBaleProducts.id))
          .where(eq(customerOrderBales.orderId, orderId));

        // Resolve canonical article code: productArticleCode > baleArticleCode > orderBaleArticleCode
        // Use canonical product name from factoryBaleProducts when available
        const loadedMap = new Map<string, { count: number; name: string }>();
        for (const link of baleLinks) {
          const code = link.productArticleCode || link.baleArticleCode || link.orderBaleArticleCode || "";
          if (!code) continue; // skip completely unidentified bales
          const name = link.productName || link.baleProductName || link.baleName || code;
          const entry = loadedMap.get(code) || { count: 0, name };
          entry.count += 1;
          loadedMap.set(code, entry);
        }

        // Build canonical product name map (already resolved above via join, but also from proforma)
        const allCodes = [...new Set([...proformaMap.keys(), ...loadedMap.keys()])];
        const productNameMap = new Map<string, string>();
        // Seed from the join results
        for (const link of baleLinks) {
          const code = link.productArticleCode || link.baleArticleCode || link.orderBaleArticleCode || "";
          if (code && link.productName) productNameMap.set(code, link.productName);
        }
        // Fill any remaining from DB (e.g. proforma codes that have no loaded bales)
        const missingCodes = allCodes.filter((c) => !productNameMap.has(c));
        if (missingCodes.length > 0) {
          const prods = await db
            .select({ articleCode: factoryBaleProducts.articleCode, name: factoryBaleProducts.name })
            .from(factoryBaleProducts)
            .where(
              and(eq(factoryBaleProducts.companyId, companyId), inArray(factoryBaleProducts.articleCode, missingCodes))
            );
          for (const p of prods) {
            if (p.articleCode) productNameMap.set(p.articleCode, p.name);
          }
        }

        // Build rows: proforma items first, then extra (NOT REQUESTED) items
        type LoadRow = {
          articleCode: string;
          productName: string;
          requested: number;
          loaded: number;
          diff: number;
          status: string;
        };
        const rows: LoadRow[] = [];

        // Process proforma items
        for (const [code, pf] of proformaMap) {
          const loaded = loadedMap.get(code)?.count ?? 0;
          const diff = loaded - pf.qty;
          let status = "LOADED";
          if (loaded === 0) status = "NOT LOADED";
          else if (diff > 0) status = "OVERLOADED";
          else if (diff < 0) status = "LESS LOADED";
          rows.push({
            articleCode: code,
            productName: productNameMap.get(code) || pf.productName || code,
            requested: pf.qty,
            loaded,
            diff,
            status,
          });
        }

        // NOT REQUESTED items (loaded but not in proforma)
        for (const [code, ld] of loadedMap) {
          if (!proformaMap.has(code)) {
            rows.push({
              articleCode: code,
              productName: productNameMap.get(code) || ld.name || code,
              requested: 0,
              loaded: ld.count,
              diff: ld.count,
              status: order.proformaIdUsed ? "NOT REQUESTED" : "LOADED",
            });
          }
        }

        // Sort: article code
        rows.sort((a, b) => a.articleCode.localeCompare(b.articleCode));

        // ── ExcelJS ──
        const ExcelJS = (await import("exceljs")).default;
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet("Loading Status");
        const COL = 7; // now 7 columns (#, ArticleCode, Product, Requested, Loaded, Diff, Status)

        sheet.columns = [
          { key: "c1", width: 6 }, // #
          { key: "c2", width: 16 }, // Article Code
          { key: "c3", width: 32 }, // Product
          { key: "c4", width: 13 }, // Requested
          { key: "c5", width: 13 }, // Loaded
          { key: "c6", width: 11 }, // Diff
          { key: "c7", width: 20 }, // Status
        ];

        const DARK_BLUE = "FF1F3864";
        const WHITE = "FFFFFFFF";
        const LIGHT_GRAY = "FFF5F5F5";
        const GREEN_BG = "FFE8F5E9";
        const RED_BG = "FFFDECEA";
        const ORANGE_BG = "FFFFF3E0";
        const YELLOW_BG = "FFFFFDE7";

        const statusStyle: Record<string, { bg: string; fg: string }> = {
          LOADED: { bg: GREEN_BG, fg: "FF2E7D32" },
          OVERLOADED: { bg: RED_BG, fg: "FFC62828" },
          "LESS LOADED": { bg: ORANGE_BG, fg: "FFE65100" },
          "NOT REQUESTED": { bg: YELLOW_BG, fg: "FFF57F17" },
          "NOT LOADED": { bg: "FFEEEEEE", fg: "FF555555" },
        };

        const setFill = (cell: ExcelJS.Cell, argb: string) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
        };
        const merge = (r: number, c1: number, c2: number) => sheet.mergeCells(r, c1, r, c2);

        // Logo
        const logoRow = sheet.addRow([]);
        logoRow.height = 110;
        try {
          const lp = path.join(process.cwd(), "server", "hmd-logo.png");
          if (fs.existsSync(lp)) {
            const lid = workbook.addImage({ buffer: toArrayBuffer(fs.readFileSync(lp)), extension: "jpeg" });
            sheet.addImage(lid, { tl: { col: 0, row: 0 }, ext: { width: 180, height: 110 } });
          }
        } catch {
          // Failure here is non-fatal and the surrounding flow continues deliberately.
        }

        const r1 = sheet.addRow(["HMD INTERNATIONAL GROUP"]);
        r1.height = 26;
        r1.getCell(1).font = { bold: true, size: 16, color: { argb: DARK_BLUE } };
        r1.getCell(1).alignment = { horizontal: "center", vertical: "middle" };
        merge(r1.number, 1, COL);

        const r2 = sheet.addRow(["Loading Status Report"]);
        r2.height = 22;
        r2.getCell(1).font = { bold: true, size: 14, color: { argb: DARK_BLUE } };
        r2.getCell(1).alignment = { horizontal: "center", vertical: "middle" };
        merge(r2.number, 1, COL);

        sheet.addRow([]);

        const invoiceNum = order.invoiceNumber || `INV-${String(orderId).padStart(6, "0")}`;
        const dateStr = order.orderDate
          ? new Date(order.orderDate).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "2-digit" })
          : "-";

        const details = [
          ["Invoice No.", invoiceNum],
          ["Customer", order.customerName || "-"],
          ["Date", dateStr],
          ["Container", order.containerNumber || "-"],
        ];
        for (const [label, value] of details) {
          const dr = sheet.addRow(["", "", "", "", label, "", value]);
          dr.height = 20;
          dr.getCell(5).font = { bold: true, size: 11 };
          dr.getCell(5).alignment = { horizontal: "right" };
          dr.getCell(7).font = { size: 11 };
          merge(dr.number, 5, 6);
        }

        sheet.addRow([]);

        // Table header
        const hdr = sheet.addRow(["#", "Article Code", "Product", "Requested", "Loaded", "Diff", "Status"]);
        hdr.height = 24;
        hdr.eachCell((cell) => {
          cell.font = { bold: true, color: { argb: WHITE }, size: 11 };
          setFill(cell, DARK_BLUE);
          cell.alignment = { horizontal: "center", vertical: "middle" };
          cell.border = {
            top: { style: "thin", color: { argb: WHITE } },
            bottom: { style: "thin", color: { argb: WHITE } },
            left: { style: "thin", color: { argb: WHITE } },
            right: { style: "thin", color: { argb: WHITE } },
          };
        });

        // Data rows
        rows.forEach((row, idx) => {
          const style = statusStyle[row.status] || { bg: LIGHT_GRAY, fg: "FF000000" };
          const diffLabel = row.diff === 0 ? "0" : row.diff > 0 ? `+${row.diff}` : `${row.diff}`;
          const dr = sheet.addRow([
            idx + 1,
            row.articleCode,
            row.productName,
            row.requested,
            row.loaded,
            diffLabel,
            row.status,
          ]);
          dr.height = 20;
          dr.eachCell((cell) => {
            cell.font = { size: 11 };
          });
          if (idx % 2 === 1) dr.eachCell((cell) => setFill(cell, LIGHT_GRAY));
          // Status cell: always coloured
          const statusCell = dr.getCell(7);
          setFill(statusCell, style.bg);
          statusCell.font = { bold: true, size: 11, color: { argb: style.fg } };
          statusCell.alignment = { horizontal: "center" };
          // Diff cell: colour by positive/negative/zero
          const diffCell = dr.getCell(6);
          diffCell.alignment = { horizontal: "center" };
          if (row.diff > 0) diffCell.font = { bold: true, size: 11, color: { argb: "FFC62828" } };
          else if (row.diff < 0) diffCell.font = { bold: true, size: 11, color: { argb: "FFE65100" } };
          else diffCell.font = { bold: true, size: 11, color: { argb: "FF2E7D32" } };
          dr.getCell(1).alignment = { horizontal: "center" };
          dr.getCell(4).alignment = { horizontal: "right" };
          dr.getCell(5).alignment = { horizontal: "right" };
          dr.eachCell((cell) => {
            cell.border = {
              top: { style: "thin", color: { argb: "FFDDDDDD" } },
              bottom: { style: "thin", color: { argb: "FFDDDDDD" } },
              left: { style: "thin", color: { argb: "FFDDDDDD" } },
              right: { style: "thin", color: { argb: "FFDDDDDD" } },
            };
          });
        });

        // Totals row
        const totalLoaded = rows.reduce((s, r) => s + r.loaded, 0);
        const totalRequested = rows.reduce((s, r) => s + r.requested, 0);
        const totalDiff = totalLoaded - totalRequested;
        const totRow = sheet.addRow([
          "",
          "",
          "Totals",
          totalRequested,
          totalLoaded,
          totalDiff === 0 ? "0" : totalDiff > 0 ? `+${totalDiff}` : `${totalDiff}`,
          "",
        ]);
        totRow.height = 22;
        totRow.eachCell((cell) => {
          cell.font = { bold: true, size: 11, color: { argb: WHITE } };
          setFill(cell, DARK_BLUE);
          cell.alignment = { horizontal: "right" };
        });
        totRow.getCell(3).alignment = { horizontal: "center" };
        totRow.getCell(6).alignment = { horizontal: "center" };

        // Legend
        sheet.addRow([]);
        const legendHdr = sheet.addRow(["Legend"]);
        legendHdr.getCell(1).font = { bold: true, size: 11 };
        const legend: [string, (typeof statusStyle)[string]][] = [
          ["LOADED — exact quantity matched", statusStyle["LOADED"]],
          ["OVERLOADED — more than requested", statusStyle["OVERLOADED"]],
          ["LESS LOADED — fewer than requested", statusStyle["LESS LOADED"]],
          ["NOT REQUESTED — not in proforma", statusStyle["NOT REQUESTED"]],
          ["NOT LOADED — requested but none loaded", statusStyle["NOT LOADED"]],
        ];
        for (const [label, st] of legend) {
          const lr = sheet.addRow(["", label]);
          setFill(lr.getCell(2), st.bg);
          lr.getCell(2).font = { size: 10, color: { argb: st.fg }, bold: true };
          lr.getCell(2).alignment = { horizontal: "left" };
          merge(lr.number, 2, COL);
        }

        // ── Second sheet: individual Bale References ──
        const refSheet = workbook.addWorksheet("Bale References");
        refSheet.columns = [
          { key: "num", width: 6 }, // #
          { key: "ref", width: 22 }, // Reference Number
          { key: "code", width: 16 }, // Article Code
          { key: "prod", width: 32 }, // Product Name
        ];

        const refHdr = refSheet.addRow(["#", "Reference Number", "Article Code", "Product"]);
        refHdr.height = 24;
        refHdr.eachCell((cell) => {
          cell.font = { bold: true, color: { argb: WHITE }, size: 11 };
          setFill(cell, DARK_BLUE);
          cell.alignment = { horizontal: "center", vertical: "middle" };
          cell.border = {
            top: { style: "thin", color: { argb: WHITE } },
            bottom: { style: "thin", color: { argb: WHITE } },
            left: { style: "thin", color: { argb: WHITE } },
            right: { style: "thin", color: { argb: WHITE } },
          };
        });

        // Build per-bale rows sorted by article code then reference number
        const baleRefRows = baleLinks
          .map((link) => {
            const code = link.productArticleCode || link.baleArticleCode || link.orderBaleArticleCode || "";
            const refNum = link.baleReferenceNumber || link.baleCode || `BALE-${link.baleId}`;
            const prodName =
              productNameMap.get(code) || link.productName || link.baleProductName || link.baleName || code;
            return { code, refNum, prodName };
          })
          .filter((r) => r.refNum)
          .sort((a, b) => a.code.localeCompare(b.code) || a.refNum.localeCompare(b.refNum));

        baleRefRows.forEach((r, idx) => {
          const dr = refSheet.addRow([idx + 1, r.refNum, r.code, r.prodName]);
          dr.height = 20;
          dr.eachCell((cell) => {
            cell.font = { size: 11 };
          });
          if (idx % 2 === 1) dr.eachCell((cell) => setFill(cell, LIGHT_GRAY));
          dr.getCell(1).alignment = { horizontal: "center" };
          dr.eachCell((cell) => {
            cell.border = {
              top: { style: "thin", color: { argb: "FFDDDDDD" } },
              bottom: { style: "thin", color: { argb: "FFDDDDDD" } },
              left: { style: "thin", color: { argb: "FFDDDDDD" } },
              right: { style: "thin", color: { argb: "FFDDDDDD" } },
            };
          });
        });

        const xlsBuffer = Buffer.from(await workbook.xlsx.writeBuffer());
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader(
          "Content-Disposition",
          contentDisposition(
            buildExportFilename([order.containerNumber, order.customerName, order.destination], "xlsx")
          )
        );
        res.setHeader("Content-Length", xlsBuffer.byteLength);
        res.end(xlsBuffer);
      } catch (error: unknown) {
        logger.error("Error exporting loading status:", { error: error });
        if (!res.headersSent) res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // ─────── INVOICE CONTAINER TRACKING ─────────────────────────────────────
  // GET /api/factory/invoice-container-tracking
  // Returns all VERIFIED / FINALIZED factory invoices that have a container
  // number, enriched with ETA + tracking status from the ERP containers table
  // (the Maersk / CMA auto-tracking system).
}
