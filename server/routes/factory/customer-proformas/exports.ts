import { styleSpecializedWorkbook } from "@shared/universal-excel/specializedWorkbookStyle";
import { toArrayBuffer } from "../../../lib/bufferCompatibility";
/**
 * factoryCustomerProformaRoutes: FactoryCustomerProformaExport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { getExportPriceVisibility } from "../../../helpers/exportVisibility";
import { buildSafeFilename, contentDisposition } from "../../../lib/contentDisposition";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { factoryBaleProducts, customerProformas, customerProformaLines, customers, companies } from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import path from "path";
import fs from "fs";
import { toMoney } from "../../../lib/money";
import { registerFactoryCustomerProformaExportRoutesPart1 } from "./registerFactoryCustomerProformaExportRoutesPart1";

export function registerFactoryCustomerProformaExportRoutes(app: Express) {
  app.get("/api/factory/customer-proformas/:id/export/excel", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const [proforma] = await db
        .select()
        .from(customerProformas)
        .where(and(eq(customerProformas.id, id), eq(customerProformas.companyId, companyId)));
      if (!proforma) return res.status(404).json({ message: "Proforma not found" });

      const rawLines = await db.select().from(customerProformaLines).where(eq(customerProformaLines.proformaId, id));

      const [customer] = await db.select().from(customers).where(eq(customers.id, proforma.customerId));
      const [company] = await db.select().from(companies).where(eq(companies.id, companyId));

      // Fetch weight per bale + canonical name from factoryBaleProducts by articleCode
      const articleCodes = [...new Set(rawLines.map((l) => l.articleCode).filter(Boolean))];
      const wMap = new Map<string, number>();
      const nameMap = new Map<string, string>();
      if (articleCodes.length > 0) {
        const prods = await db
          .select({
            articleCode: factoryBaleProducts.articleCode,
            weightPerBaleKg: factoryBaleProducts.weightPerBaleKg,
            name: factoryBaleProducts.name,
          })
          .from(factoryBaleProducts)
          .where(
            and(
              eq(factoryBaleProducts.companyId, companyId),
              inArray(factoryBaleProducts.articleCode, articleCodes as string[])
            )
          );
        prods.forEach((p) => {
          if (p.articleCode) {
            wMap.set(p.articleCode, toMoney(p.weightPerBaleKg).toNumber());
            nameMap.set(p.articleCode, p.name || "");
          }
        });
      }

      const { hideProformaPrice: hideSellingExcel } = await getExportPriceVisibility(req);

      const baseCurrency = company?.baseCurrency || "USD";
      const currencySymbolMap: Record<string, string> = {
        USD: "$ ",
        GBP: "£",
        EUR: "€",
        CFA: "CFA ",
        XOF: "CFA ",
        XAF: "CFA ",
        CAD: "CA$ ",
        AUD: "A$ ",
        CHF: "CHF ",
        JPY: "¥",
        INR: "₹",
        AED: "AED ",
        MXN: "MX$ ",
        BRL: "R$ ",
        ZAR: "R",
        SGD: "S$ ",
        HKD: "HK$ ",
        NOK: "kr ",
        SEK: "kr ",
        DKK: "kr ",
      };
      const currSym = currencySymbolMap[baseCurrency.toUpperCase()] ?? baseCurrency + " ";
      const fmtPrice = (n: number) => currSym + (n % 1 === 0 ? n.toLocaleString() : n.toFixed(2));
      const fmtKg = (n: number) => (n % 1 === 0 ? String(n) : n.toFixed(2));

      const ExcelJS = (await import("exceljs")).default;
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Proforma Invoice");

      const COL_COUNT = hideSellingExcel ? 6 : 8;
      const baseCols = [
        { key: "num", width: 6 },
        { key: "articleCode", width: 18 },
        { key: "productName", width: 32 },
        { key: "qty", width: 12 },
        { key: "kgPerBale", width: 13 },
      ];
      if (!hideSellingExcel) baseCols.push({ key: "pricePerBale", width: 14 });
      baseCols.push({ key: "totalKg", width: 13 });
      if (!hideSellingExcel) baseCols.push({ key: "totalPrice", width: 15 });
      sheet.columns = baseCols;

      try {
        const pxLogo = path.join(process.cwd(), "server", "hmd-logo.png");
        if (fs.existsSync(pxLogo)) {
          const pxBuf = fs.readFileSync(pxLogo);
          const pxId = workbook.addImage({ buffer: toArrayBuffer(pxBuf), extension: "jpeg" });
          const pxLogoRow = sheet.addRow([]);
          pxLogoRow.height = 90;
          sheet.addImage(pxId, { tl: { col: 2.5, row: 0 }, ext: { width: 300, height: 90 } });
        }
      } catch {
        // Failure here is non-fatal and the surrounding flow continues deliberately.
      }
      const r1 = sheet.addRow(["HMD INTERNATIONAL GROUP"]);
      r1.getCell(1).font = { bold: true, size: 16, color: { argb: "FF1F3864" } };
      r1.getCell(1).alignment = { horizontal: "center" };
      sheet.mergeCells(r1.number, 1, r1.number, COL_COUNT);

      const r2 = sheet.addRow([`Customer: ${customer?.legalName || "N/A"}`]);
      r2.getCell(1).font = { size: 11 };
      sheet.mergeCells(r2.number, 1, r2.number, COL_COUNT);

      const dateStr = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });
      const r3 = sheet.addRow([`Date: ${dateStr}`]);
      r3.getCell(1).font = { size: 10, color: { argb: "FF555555" } };
      sheet.mergeCells(r3.number, 1, r3.number, COL_COUNT);

      const r4 = sheet.addRow([`Proforma: ${proforma.name}`]);
      r4.getCell(1).font = { size: 10, color: { argb: "FF555555" } };
      sheet.mergeCells(r4.number, 1, r4.number, COL_COUNT);

      sheet.addRow([]);

      const hdrCells = ["#", "Article Code", "Product Name", "Qty (Bales)", "Kg / Bale"];
      if (!hideSellingExcel) hdrCells.push("Price / Bale");
      hdrCells.push("Total KG");
      if (!hideSellingExcel) hdrCells.push("Total Price");
      const hdrRow = sheet.addRow(hdrCells);
      hdrRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3864" } };
        cell.alignment = { horizontal: "center" };
      });

      let totalQty = 0,
        totalKgAll = 0,
        totalPriceAll = 0;
      rawLines.forEach((line, idx: number) => {
        const qty = parseInt(String(line.quantity));
        const kgPerBale = wMap.get(line.articleCode) || 0;
        const price = toMoney(line.pricePerBale).toNumber();
        const totalKg = qty * kgPerBale;
        const totalPrice = qty * price;
        totalQty += qty;
        totalKgAll += totalKg;
        totalPriceAll += totalPrice;

        const rowArr = [
          idx + 1,
          line.articleCode,
          nameMap.get(line.articleCode) || line.productName || "",
          qty,
          fmtKg(kgPerBale),
        ];
        if (!hideSellingExcel) rowArr.push(fmtPrice(price));
        rowArr.push(fmtKg(totalKg));
        if (!hideSellingExcel) rowArr.push(fmtPrice(totalPrice));
        const dr = sheet.addRow(rowArr);
        dr.getCell(4).alignment = { horizontal: "right" };
        dr.getCell(5).alignment = { horizontal: "right" };
        dr.getCell(6).alignment = { horizontal: "right" };
        if (!hideSellingExcel) {
          dr.getCell(7).alignment = { horizontal: "right" };
          dr.getCell(8).alignment = { horizontal: "right" };
        }
        if (idx % 2 === 1) {
          dr.eachCell((cell) => {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5F5F5" } };
          });
        }
      });

      sheet.addRow([]);
      const totArr = ["", "", "GRAND TOTAL", totalQty, ""];
      if (!hideSellingExcel) totArr.push("");
      totArr.push(fmtKg(totalKgAll));
      if (!hideSellingExcel) totArr.push(fmtPrice(totalPriceAll));
      const totRow = sheet.addRow(totArr);
      totRow.eachCell((cell) => {
        cell.font = { bold: true };
      });
      totRow.getCell(4).alignment = { horizontal: "right" };
      totRow.getCell(hideSellingExcel ? 6 : 7).alignment = { horizontal: "right" };
      if (!hideSellingExcel) totRow.getCell(8).alignment = { horizontal: "right" };

      // Build buffer BEFORE setting headers so ExcelJS errors can still return a clean JSON 500.
      styleSpecializedWorkbook(workbook, {
        expectedSheetNames: ["Proforma Invoice"],
        sheets: [{ name: "Proforma Invoice", purpose: "report" }],
      });
      const xlsBuffer = Buffer.from(await workbook.xlsx.writeBuffer());
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", contentDisposition(buildSafeFilename(["proforma", proforma.name], "xlsx")));
      res.setHeader("Content-Length", xlsBuffer.byteLength);
      res.end(xlsBuffer);
    } catch (error: unknown) {
      logger.error("Error exporting proforma to Excel:", { error: error });
      if (!res.headersSent) res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  registerFactoryCustomerProformaExportRoutesPart1(app);
}
