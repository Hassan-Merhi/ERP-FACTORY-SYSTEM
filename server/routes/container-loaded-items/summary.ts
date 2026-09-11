/**
 * containerLoadedItemsRoutes: ContainerLoadedItemSummary endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response, RequestHandler } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { eq, and } from "drizzle-orm";
import ExcelJS from "exceljs";
import { db } from "../../db";
import { parseId, parseOptionalId } from "../../lib/parseId";
import { buildAliasMap, resolveBarcode } from "../helpers/proformaBarcodeHelpers";
import {
  containers,
  suppliers,
  supplierContainerLoadedItems,
  supplierProformaLines,
  supplierProformas,
} from "@shared/schema";

import { verifyContainerOwnership } from "./_helpers";

export function registerContainerLoadedItemSummaryRoutes(app: Express, requireAuth: RequestHandler) {
  app.get(
    "/api/suppliers/:supplierId/containers/:containerId/verification-summary-export.xlsx",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const supplierId = parseId(req.params.supplierId);
        if (supplierId === null) return res.status(400).json({ message: "Invalid id" });
        const containerId = parseId(req.params.containerId);
        if (containerId === null) return res.status(400).json({ message: "Invalid id" });
        const proformaId = parseOptionalId(req.query.proformaId);
        if (!proformaId) return res.status(400).json({ message: "proformaId required" });

        if (!(await verifyContainerOwnership(containerId, companyId)))
          return res.status(403).json({ message: "Access denied" });

        const [proforma] = await db
          .select()
          .from(supplierProformas)
          .where(and(eq(supplierProformas.id, proformaId), eq(supplierProformas.companyId, companyId)));
        if (!proforma) return res.status(404).json({ message: "Proforma not found" });

        const [container] = await db.select().from(containers).where(eq(containers.id, containerId));
        const [supplier] = await db.select().from(suppliers).where(eq(suppliers.id, supplierId));

        const proformaLinesList = await db
          .select()
          .from(supplierProformaLines)
          .where(eq(supplierProformaLines.proformaId, proformaId));
        const loadedItemsList = await db
          .select()
          .from(supplierContainerLoadedItems)
          .where(eq(supplierContainerLoadedItems.containerId, containerId));

        const { map: aliasMap } = await buildAliasMap(companyId);

        const proformaByBarcode = new Map();
        for (const line of proformaLinesList) {
          const bc = resolveBarcode((line.barcode || "").trim(), aliasMap);
          if (proformaByBarcode.has(bc)) {
            proformaByBarcode.get(bc).qty += line.qty;
          } else {
            proformaByBarcode.set(bc, {
              ...line,
              qty: line.qty,
              weightPerBale: parseFloat(line.weightPerBale || "0"),
              pricePerBale: parseFloat(line.pricePerBale || "0"),
            });
          }
        }
        const loadedByBarcode = new Map();
        for (const item of loadedItemsList) {
          const bc = resolveBarcode((item.barcode || "").trim(), aliasMap);
          if (loadedByBarcode.has(bc)) {
            loadedByBarcode.get(bc).qty += item.qty;
          } else {
            loadedByBarcode.set(bc, {
              ...item,
              qty: item.qty,
              weightPerBale: parseFloat(item.weightPerBale || "0"),
              pricePerBale: parseFloat(item.pricePerBale || "0"),
            });
          }
        }

        const allBarcodes = new Set([...proformaByBarcode.keys(), ...loadedByBarcode.keys()]);
        const overloaded = [];
        const lessLoaded = [];
        const notRequested = [];
        const priceDiffs = [];
        const fullComparison = [];

        for (const barcode of allBarcodes) {
          const exp = proformaByBarcode.get(barcode);
          const loaded = loadedByBarcode.get(barcode);
          const expectedQty = exp?.qty || 0;
          const loadedQty = loaded?.qty || 0;
          const expPrice = exp?.pricePerBale || 0;
          const loadPrice = loaded?.pricePerBale || 0;
          const expWeight = exp?.weightPerBale || 0;
          const loadWeight = loaded?.weightPerBale || expWeight;
          const itemName = exp?.itemName || loaded?.itemName || barcode;
          const loadedWeightTotal = loadedQty * loadWeight;
          const expectedWeightTotal = expectedQty * expWeight;
          const loadedValueTotal = loadedQty * (loadPrice || expPrice);
          const expectedValueTotal = expectedQty * expPrice;
          const qtyDiff = loadedQty - expectedQty;

          let status = "OK";
          if (expectedQty === 0 && loadedQty > 0) status = "NOT REQUESTED";
          else if (expectedQty > 0 && loadedQty === 0) status = "MISSING";
          else if (loadedQty > expectedQty) status = "OVERLOADED";
          else if (loadedQty < expectedQty) status = "SHORT";

          fullComparison.push({
            barcode,
            itemName,
            expectedQty,
            loadedQty,
            qtyDiff,
            expPrice,
            loadPrice,
            priceDiff: loadPrice - expPrice,
            expWeight,
            loadWeight,
            expectedWeightTotal,
            loadedWeightTotal,
            expectedValueTotal,
            loadedValueTotal,
            status,
          });

          if (expectedQty === 0 && loadedQty > 0) {
            notRequested.push({ itemName, qty: loadedQty });
          } else if (loadedQty > expectedQty) {
            overloaded.push({ itemName, qty: loadedQty });
          } else if (loadedQty < expectedQty) {
            lessLoaded.push({ itemName, qty: -(expectedQty - loadedQty) });
          }
          if (expPrice && loadPrice && Math.abs(loadPrice - expPrice) >= 0.01) {
            const kgDiff =
              expWeight && loadWeight && Math.abs(loadWeight - expWeight) >= 0.001 ? loadWeight - expWeight : null;
            priceDiffs.push({ itemName, kgDiff, itemPriceDiff: loadPrice - expPrice });
          }
        }

        const wb = new ExcelJS.Workbook();
        wb.creator = "ERP POS System";
        wb.created = new Date();
        const sheet = wb.addWorksheet("Comparison");

        const sc = {
          headerBg: "1F4E79",
          headerFont: "FFFFFF",
          overloadedBg: "FCE4EC",
          shortBg: "FFF3E0",
          notRequestedBg: "FFF9C4",
          overloadedBorder: "C62828",
          shortBorder: "E65100",
          notRequestedBorder: "F57F17",
          priceDiffBorder: "1565C0",
          titleBg: "263238",
          titleFont: "FFFFFF",
          summaryBg: "F5F5F5",
        };
        const sThin: Partial<import("exceljs").Borders> = {
          top: { style: "thin", color: { argb: "BDBDBD" } },
          left: { style: "thin", color: { argb: "BDBDBD" } },
          bottom: { style: "thin", color: { argb: "BDBDBD" } },
          right: { style: "thin", color: { argb: "BDBDBD" } },
        };
        const dblBorder: Partial<import("exceljs").Borders> = {
          top: { style: "double", color: { argb: "424242" } },
          bottom: { style: "double", color: { argb: "424242" } },
          left: sThin.left,
          right: sThin.right,
        };

        type ColDef = { header: string; key: string; width: number; numFmt?: string };

        const addBlock = (
          title: string,
          sectionColor: string,
          columns: ColDef[],
          data: any[],
          statusColorFn?: (row: any) => string | null,
          includeAutoFilter = false
        ) => {
          const numCols = columns.length;

          const titleRow = sheet.addRow([title]);
          titleRow.height = 30;
          titleRow.getCell(1).font = { bold: true, size: 14, color: { argb: sc.titleFont } };
          titleRow.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: sc.titleBg } };
          titleRow.getCell(1).alignment = { vertical: "middle", horizontal: "left" };
          if (numCols > 1) sheet.mergeCells(sheet.rowCount, 1, sheet.rowCount, numCols);

          const infoData: [string, string][] = [
            ["Supplier", supplier?.legalName || `ID ${supplierId}`],
            ["Container", container?.containerNumber || `ID ${containerId}`],
            ["Proforma", proforma.reference],
            ["Date", new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })],
            ["Total Items", String(data.length)],
          ];
          for (const [label, value] of infoData) {
            const r = sheet.addRow([label, value]);
            r.getCell(1).font = { bold: true, size: 10, color: { argb: "616161" } };
            r.getCell(2).font = { size: 10 };
          }
          sheet.addRow([]);

          const headerRowNum = sheet.rowCount + 1;
          const headerRow = sheet.addRow(columns.map((c) => c.header));
          headerRow.height = 24;
          headerRow.eachCell((cell: ExcelJS.Cell) => {
            cell.font = { bold: true, size: 10, color: { argb: sc.headerFont } };
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: sectionColor } };
            cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
            cell.border = sThin;
          });

          columns.forEach((col, i) => {
            const c = sheet.getColumn(i + 1);
            if (!c.width || (c.width as number) < col.width) c.width = col.width;
            if (col.numFmt) c.numFmt = col.numFmt;
          });

          if (data.length === 0) {
            const emptyRow = sheet.addRow(["No items"]);
            if (numCols > 1) sheet.mergeCells(sheet.rowCount, 1, sheet.rowCount, numCols);
            emptyRow.getCell(1).alignment = { horizontal: "center" };
            emptyRow.getCell(1).font = { italic: true, color: { argb: "9E9E9E" } };
          } else {
            for (let i = 0; i < data.length; i++) {
              const item = data[i];
              const values = columns.map((c) => item[c.key]);
              const dataRow = sheet.addRow(values);
              const rowBg = statusColorFn ? statusColorFn(item) : i % 2 !== 0 ? sc.summaryBg : null;
              dataRow.eachCell((cell: ExcelJS.Cell) => {
                cell.border = sThin;
                cell.alignment = { vertical: "middle" };
                if (rowBg) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: rowBg } };
              });
            }

            sheet.addRow([]);
            const totalValues = columns.map((c, i) => {
              if (i === 0) return "TOTAL";
              const sum = data.reduce((s: number, item) => s + (typeof item[c.key] === "number" ? item[c.key] : 0), 0);
              return typeof data[0]?.[c.key] === "number" ? sum : "";
            });
            const totalRow = sheet.addRow(totalValues);
            totalRow.font = { bold: true, size: 10 };
            totalRow.eachCell((cell: ExcelJS.Cell, colN: number) => {
              cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: sc.summaryBg } };
              cell.border = dblBorder;
              const col = columns[colN - 1];
              if (col?.numFmt) cell.numFmt = col.numFmt;
            });
          }

          if (includeAutoFilter) {
            sheet.autoFilter = { from: { row: headerRowNum, column: 1 }, to: { row: headerRowNum, column: numCols } };
          }
          sheet.addRow([]);
        };

        addBlock(
          "Container Verification - Full Comparison",
          sc.headerBg,
          [
            { header: "Barcode", key: "barcode", width: 18 },
            { header: "Item Name", key: "itemName", width: 28 },
            { header: "Expected Qty", key: "expectedQty", width: 14, numFmt: "#,##0" },
            { header: "Loaded Qty", key: "loadedQty", width: 14, numFmt: "#,##0" },
            { header: "Qty Diff", key: "qtyDiff", width: 12, numFmt: "+#,##0;-#,##0;0" },
            { header: "Proforma Price", key: "expPrice", width: 14, numFmt: "#,##0.00" },
            { header: "Loaded Price", key: "loadPrice", width: 14, numFmt: "#,##0.00" },
            { header: "Price Diff", key: "priceDiff", width: 12, numFmt: "+#,##0.00;-#,##0.00;0" },
            { header: "Status", key: "status", width: 16 },
          ],
          fullComparison,
          (item) => {
            if (item.status === "OVERLOADED") return sc.overloadedBg;
            if (item.status === "SHORT" || item.status === "MISSING") return sc.shortBg;
            if (item.status === "NOT REQUESTED") return sc.notRequestedBg;
            return null;
          },
          true
        );

        addBlock(
          "Less Loaded",
          sc.shortBorder,
          [
            { header: "Item Name", key: "itemName", width: 28 },
            { header: "Qty", key: "qty", width: 14, numFmt: "#,##0" },
          ],
          lessLoaded
        );

        addBlock(
          "Over Loaded",
          sc.overloadedBorder,
          [
            { header: "Item Name", key: "itemName", width: 28 },
            { header: "Qty", key: "qty", width: 14, numFmt: "#,##0" },
          ],
          overloaded
        );

        addBlock(
          "Loaded Not Requested",
          sc.notRequestedBorder,
          [
            { header: "Item Name", key: "itemName", width: 28 },
            { header: "Qty", key: "qty", width: 14, numFmt: "#,##0" },
          ],
          notRequested
        );

        const hasKgDiff = priceDiffs.some((r) => r.kgDiff != null);
        const priceDiffCols: ColDef[] = hasKgDiff
          ? [
              { header: "Item Name", key: "itemName", width: 28 },
              { header: "KG Diff", key: "kgDiff", width: 14, numFmt: "#,##0.00" },
              { header: "Item Price Diff", key: "itemPriceDiff", width: 16, numFmt: "#,##0.00" },
            ]
          : [
              { header: "Item Name", key: "itemName", width: 28 },
              { header: "Item Price Diff", key: "itemPriceDiff", width: 16, numFmt: "#,##0.00" },
            ];
        addBlock("Price Diff", sc.priceDiffBorder, priceDiffCols, priceDiffs);

        const safeSupplierS = (supplier?.legalName || "").replace(/[^a-zA-Z0-9 ]/g, "").trim();
        const safeContainerS = (container?.containerNumber || String(containerId)).replace(/[^a-zA-Z0-9]/g, "");
        const summaryFileName = `Verification Summary ${safeSupplierS} ${safeContainerS}.xlsx`;
        const xlsBuffer2 = Buffer.from(await wb.xlsx.writeBuffer());
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="${summaryFileName}"`);
        res.setHeader("Content-Length", xlsBuffer2.byteLength);
        res.end(xlsBuffer2);
      } catch (error: unknown) {
        logger.error("Summary export error:", { error: error });
        if (!res.headersSent) res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
