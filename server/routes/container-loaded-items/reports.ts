/**
 * containerLoadedItemsRoutes: ContainerLoadedItemReport endpoints.
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

export function registerContainerLoadedItemReportRoutes(app: Express, requireAuth: RequestHandler) {
  app.get(
    "/api/suppliers/:supplierId/containers/:containerId/verification-summary",
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
        if (!proformaId) return res.status(400).json({ message: "proformaId query param required" });

        if (!(await verifyContainerOwnership(containerId, companyId)))
          return res.status(403).json({ message: "Access denied" });

        const [proforma] = await db
          .select()
          .from(supplierProformas)
          .where(and(eq(supplierProformas.id, proformaId), eq(supplierProformas.companyId, companyId)));
        if (!proforma) return res.status(404).json({ message: "Proforma not found" });

        const proformaLines = await db
          .select()
          .from(supplierProformaLines)
          .where(eq(supplierProformaLines.proformaId, proformaId));

        const loadedItems = await db
          .select()
          .from(supplierContainerLoadedItems)
          .where(eq(supplierContainerLoadedItems.containerId, containerId));

        const { map: aliasMap, conflicts: allAliasConflicts } = await buildAliasMap(companyId);

        // Only surface conflicts relevant to barcodes actually present in this
        // proforma/container pair, so unrelated stale conflicts elsewhere in
        // the company don't spam every verification screen.
        const relevantRawCodes = new Set([
          ...proformaLines.map((l) => (l.barcode || "").trim().toLowerCase()),
          ...loadedItems.map((i) => (i.barcode || "").trim().toLowerCase()),
        ]);
        const aliasConflicts = allAliasConflicts.filter((c) => relevantRawCodes.has(c.aliasCode.trim().toLowerCase()));

        const proformaByBarcode = new Map();
        for (const line of proformaLines) {
          const bc = resolveBarcode((line.barcode || "").trim(), aliasMap);
          if (proformaByBarcode.has(bc)) {
            const existing = proformaByBarcode.get(bc);
            existing.qty += line.qty;
          } else {
            proformaByBarcode.set(bc, {
              barcode: bc,
              itemName: line.itemName,
              qty: line.qty,
              weightPerBale: parseFloat(line.weightPerBale || "0"),
              pricePerBale: parseFloat(line.pricePerBale || "0"),
            });
          }
        }

        const loadedByBarcode = new Map();
        for (const item of loadedItems) {
          const bc = resolveBarcode((item.barcode || "").trim(), aliasMap);
          if (loadedByBarcode.has(bc)) {
            const existing = loadedByBarcode.get(bc);
            existing.qty += item.qty;
          } else {
            loadedByBarcode.set(bc, {
              barcode: bc,
              itemName: item.itemName || "",
              qty: item.qty,
              weightPerBale: parseFloat(item.weightPerBale || "0"),
              pricePerBale: parseFloat(item.pricePerBale || "0"),
            });
          }
        }

        const allBarcodes = new Set([...proformaByBarcode.keys(), ...loadedByBarcode.keys()]);
        const comparison = [];

        for (const barcode of allBarcodes) {
          const exp = proformaByBarcode.get(barcode);
          const loaded = loadedByBarcode.get(barcode);

          const expectedQty = exp?.qty || 0;
          const loadedQty = loaded?.qty || 0;
          const expectedWeightPerBale = exp?.weightPerBale || 0;
          const loadedWeightPerBale = loaded?.weightPerBale || 0;
          const expectedPricePerBale = exp?.pricePerBale || 0;
          const loadedPricePerBale = loaded?.pricePerBale || 0;

          const expectedWeightTotal = expectedQty * expectedWeightPerBale;
          const loadedWeightTotal = loadedQty * (loadedWeightPerBale || expectedWeightPerBale);

          const expectedTotalValue = expectedQty * expectedPricePerBale;
          const loadedTotalValue = loadedQty * (loadedPricePerBale || expectedPricePerBale);

          let statusQty: string;
          if (expectedQty === 0 && loadedQty > 0) statusQty = "LOADED_NOT_IN_PROFORMA";
          else if (expectedQty > 0 && loadedQty === 0) statusQty = "MISSING_FROM_LOADED";
          else if (loadedQty > expectedQty) statusQty = "OVER_LOADED";
          else if (loadedQty < expectedQty && loadedQty > 0) statusQty = "UNDER_LOADED";
          else statusQty = "MATCH";

          let priceStatus: string;
          const priceDiffPerBale = loadedPricePerBale - expectedPricePerBale;
          if (!expectedPricePerBale || !loadedPricePerBale) priceStatus = "PRICE_UNKNOWN";
          else if (Math.abs(priceDiffPerBale) < 0.01) priceStatus = "PRICE_MATCH";
          else priceStatus = "PRICE_DIFF";

          const totalPriceDiff = priceDiffPerBale * loadedQty;

          comparison.push({
            barcode,
            itemName: exp?.itemName || loaded?.itemName || barcode,
            expectedQty,
            loadedQty,
            expectedWeightPerBale,
            loadedWeightPerBale,
            expectedWeightTotal,
            loadedWeightTotal,
            expectedPricePerBale,
            loadedPricePerBale,
            expectedTotalValue,
            loadedTotalValue,
            statusQty,
            priceStatus,
            priceDiffPerBale,
            totalPriceDiff,
          });
        }

        res.json({
          proforma: { id: proforma.id, reference: proforma.reference },
          containerId,
          supplierId,
          comparison,
          proformaLines,
          loadedItems,
          aliasConflicts,
        });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.get(
    "/api/suppliers/:supplierId/containers/:containerId/verification-export.xlsx",
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
            notRequested.push({
              barcode,
              itemName,
              qty: loadedQty,
              totalWeight: loadedWeightTotal,
              totalValue: loadedValueTotal,
            });
          } else if (loadedQty > expectedQty) {
            overloaded.push({
              barcode,
              itemName,
              qty: loadedQty,
              expectedQty,
              excess: loadedQty - expectedQty,
              totalWeight: loadedWeightTotal,
              totalValue: loadedValueTotal,
            });
          } else if (loadedQty < expectedQty) {
            lessLoaded.push({
              barcode,
              itemName,
              qty: loadedQty,
              expectedQty,
              short: expectedQty - loadedQty,
              totalWeight: loadedWeightTotal,
              totalValue: loadedValueTotal,
            });
          }
          if (expPrice && loadPrice && Math.abs(loadPrice - expPrice) >= 0.01) {
            priceDiffs.push({
              barcode,
              itemName,
              proformaPrice: expPrice,
              loadedPrice: loadPrice,
              diff: loadPrice - expPrice,
              qty: loadedQty,
              totalDiff: (loadPrice - expPrice) * loadedQty,
            });
          }
        }

        const workbook = new ExcelJS.Workbook();
        workbook.creator = "ERP POS System";
        workbook.created = new Date();

        const colors = {
          headerBg: "1F4E79",
          headerFont: "FFFFFF",
          overloadedBg: "FCE4EC",
          overloadedBorder: "C62828",
          shortBg: "FFF3E0",
          shortBorder: "E65100",
          notRequestedBg: "FFF9C4",
          notRequestedBorder: "F57F17",
          priceDiffBg: "E3F2FD",
          priceDiffBorder: "1565C0",
          okBg: "E8F5E9",
          summaryBg: "F5F5F5",
          titleBg: "263238",
          titleFont: "FFFFFF",
        };

        const thinBorder: Partial<import("exceljs").Borders> = {
          top: { style: "thin", color: { argb: "BDBDBD" } },
          left: { style: "thin", color: { argb: "BDBDBD" } },
          bottom: { style: "thin", color: { argb: "BDBDBD" } },
          right: { style: "thin", color: { argb: "BDBDBD" } },
        };

        type SheetRow = Record<string, string | number | boolean | null | undefined>;

        const addStyledSheet = (
          name: string,
          sectionTitle: string,
          sectionColor: string,
          columns: { header: string; key: string; width: number; numFmt?: string }[],
          data: SheetRow[],
          statusColorFn?: (row: SheetRow) => string | null
        ) => {
          const sheet = workbook.addWorksheet(name);

          const titleRow = sheet.addRow([`${sectionTitle}`]);
          titleRow.font = { bold: true, size: 14, color: { argb: colors.titleFont } };
          titleRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: colors.titleBg } };
          titleRow.height = 30;
          titleRow.alignment = { vertical: "middle", horizontal: "left" };
          sheet.mergeCells(1, 1, 1, columns.length);

          const infoData = [
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
          headerRow.eachCell((cell) => {
            cell.font = { bold: true, size: 10, color: { argb: colors.headerFont } };
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: sectionColor } };
            cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
            cell.border = thinBorder;
          });

          columns.forEach((col, i) => {
            sheet.getColumn(i + 1).width = col.width;
            if (col.numFmt) sheet.getColumn(i + 1).numFmt = col.numFmt;
          });

          if (data.length === 0) {
            const emptyRow = sheet.addRow(["No items"]);
            sheet.mergeCells(sheet.rowCount, 1, sheet.rowCount, columns.length);
            emptyRow.getCell(1).alignment = { horizontal: "center" };
            emptyRow.getCell(1).font = { italic: true, color: { argb: "9E9E9E" } };
          } else {
            for (let i = 0; i < data.length; i++) {
              const item = data[i];
              const values = columns.map((c) => item[c.key]);
              const dataRow = sheet.addRow(values);
              const rowBg = statusColorFn ? statusColorFn(item) : i % 2 === 0 ? null : "F5F5F5";
              dataRow.eachCell((cell) => {
                cell.border = thinBorder;
                cell.alignment = { vertical: "middle" };
                if (rowBg) {
                  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: rowBg } };
                }
              });
            }

            sheet.addRow([]);
            const totalRow = sheet.addRow([
              "TOTAL",
              "",
              ...columns.slice(2).map((c) => {
                const sum = data.reduce((s: number, item) => {
                  const value = item[c.key];
                  return s + (typeof value === "number" ? value : 0);
                }, 0);
                return sum;
              }),
            ]);
            totalRow.font = { bold: true, size: 10 };
            totalRow.eachCell((cell) => {
              cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: colors.summaryBg } };
              cell.border = {
                top: { style: "double", color: { argb: "424242" } },
                bottom: { style: "double", color: { argb: "424242" } },
                left: thinBorder.left,
                right: thinBorder.right,
              };
            });
          }

          sheet.autoFilter = {
            from: { row: headerRowNum, column: 1 },
            to: { row: headerRowNum, column: columns.length },
          };
          return sheet;
        };

        addStyledSheet(
          "Full Comparison",
          "Container Verification - Full Comparison",
          colors.headerBg,
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
            if (item.status === "OVERLOADED") return colors.overloadedBg;
            if (item.status === "SHORT" || item.status === "MISSING") return colors.shortBg;
            if (item.status === "NOT REQUESTED") return colors.notRequestedBg;
            return null;
          }
        );

        addStyledSheet(
          "Overloaded",
          `Overloaded Items (${overloaded.length})`,
          colors.overloadedBorder,
          [
            { header: "Barcode", key: "barcode", width: 18 },
            { header: "Item Name", key: "itemName", width: 28 },
            { header: "Expected Qty", key: "expectedQty", width: 14, numFmt: "#,##0" },
            { header: "Loaded Qty", key: "qty", width: 14, numFmt: "#,##0" },
            { header: "Excess", key: "excess", width: 12, numFmt: "#,##0" },
            { header: "Total Weight", key: "totalWeight", width: 14, numFmt: "#,##0.000" },
            { header: "Total Value", key: "totalValue", width: 14, numFmt: "#,##0.00" },
          ],
          overloaded
        );

        addStyledSheet(
          "Less Loaded",
          `Less Loaded / Missing (${lessLoaded.length})`,
          colors.shortBorder,
          [
            { header: "Barcode", key: "barcode", width: 18 },
            { header: "Item Name", key: "itemName", width: 28 },
            { header: "Expected Qty", key: "expectedQty", width: 14, numFmt: "#,##0" },
            { header: "Loaded Qty", key: "qty", width: 14, numFmt: "#,##0" },
            { header: "Short", key: "short", width: 12, numFmt: "#,##0" },
            { header: "Total Weight", key: "totalWeight", width: 14, numFmt: "#,##0.000" },
            { header: "Total Value", key: "totalValue", width: 14, numFmt: "#,##0.00" },
          ],
          lessLoaded
        );

        addStyledSheet(
          "Not Requested",
          `Loaded But Not Requested (${notRequested.length})`,
          colors.notRequestedBorder,
          [
            { header: "Barcode", key: "barcode", width: 18 },
            { header: "Item Name", key: "itemName", width: 28 },
            { header: "Qty", key: "qty", width: 14, numFmt: "#,##0" },
            { header: "Total Weight", key: "totalWeight", width: 14, numFmt: "#,##0.000" },
            { header: "Total Value", key: "totalValue", width: 14, numFmt: "#,##0.00" },
          ],
          notRequested
        );

        addStyledSheet(
          "Price Differences",
          `Price Differences (${priceDiffs.length})`,
          colors.priceDiffBorder,
          [
            { header: "Barcode", key: "barcode", width: 18 },
            { header: "Item Name", key: "itemName", width: 28 },
            { header: "Proforma Price", key: "proformaPrice", width: 14, numFmt: "#,##0.00" },
            { header: "Loaded Price", key: "loadedPrice", width: 14, numFmt: "#,##0.00" },
            { header: "Diff/Bale", key: "diff", width: 12, numFmt: "+#,##0.00;-#,##0.00;0" },
            { header: "Qty", key: "qty", width: 10, numFmt: "#,##0" },
            { header: "Total Diff", key: "totalDiff", width: 14, numFmt: "+#,##0.00;-#,##0.00;0" },
          ],
          priceDiffs
        );

        const summarySheet = workbook.addWorksheet("Summary");
        const sumTitleRow = summarySheet.addRow(["Verification Summary"]);
        sumTitleRow.font = { bold: true, size: 16, color: { argb: colors.titleFont } };
        sumTitleRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: colors.titleBg } };
        sumTitleRow.height = 36;
        sumTitleRow.alignment = { vertical: "middle", horizontal: "center" };
        summarySheet.mergeCells(1, 1, 1, 3);

        summarySheet.addRow([]);
        const infoRows = [
          ["Supplier", supplier?.legalName || ""],
          ["Container", container?.containerNumber || ""],
          ["Proforma", proforma.reference],
          ["Date", new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })],
        ];
        for (const [label, value] of infoRows) {
          const r = summarySheet.addRow([label, value]);
          r.getCell(1).font = { bold: true, size: 11 };
          r.getCell(2).font = { size: 11 };
        }
        summarySheet.addRow([]);

        const summaryData = [
          ["Category", "Count", "Color"],
          ["Total Items Compared", fullComparison.length, colors.headerBg],
          ["Overloaded", overloaded.length, colors.overloadedBorder],
          ["Less Loaded / Missing", lessLoaded.length, colors.shortBorder],
          ["Not Requested", notRequested.length, colors.notRequestedBorder],
          ["Price Differences", priceDiffs.length, colors.priceDiffBorder],
          ["OK (Matched)", fullComparison.filter((c) => c.status === "OK").length, "2E7D32"],
        ];

        const sumHeaderRow = summarySheet.addRow([summaryData[0][0], summaryData[0][1]]);
        sumHeaderRow.eachCell((cell) => {
          cell.font = { bold: true, size: 11, color: { argb: colors.headerFont } };
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: colors.headerBg } };
          cell.border = thinBorder;
          cell.alignment = { horizontal: "center" };
        });

        for (let i = 1; i < summaryData.length; i++) {
          const [label, count, color] = summaryData[i];
          const r = summarySheet.addRow([label, count]);
          r.getCell(1).font = { bold: true, size: 11 };
          r.getCell(1).border = thinBorder;
          r.getCell(2).font = { bold: true, size: 14, color: { argb: color as string } };
          r.getCell(2).alignment = { horizontal: "center" };
          r.getCell(2).border = thinBorder;
          r.height = 22;
        }

        summarySheet.getColumn(1).width = 28;
        summarySheet.getColumn(2).width = 18;

        workbook.worksheets.forEach((ws, idx: number) => {
          if (idx > 0) return;
        });

        const safeSupplier = (supplier?.legalName || "").replace(/[^a-zA-Z0-9 ]/g, "").trim();
        const safeContainer = (container?.containerNumber || String(containerId)).replace(/[^a-zA-Z0-9]/g, "");
        const fileName = `Verification ${safeSupplier} ${safeContainer}.xlsx`;
        const xlsBuffer = Buffer.from(await workbook.xlsx.writeBuffer());
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
        res.setHeader("Content-Length", xlsBuffer.byteLength);
        res.end(xlsBuffer);
      } catch (error: unknown) {
        logger.error("Export error:", { error: error });
        if (!res.headersSent) res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
