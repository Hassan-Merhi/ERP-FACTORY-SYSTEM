// Extracted from ./productImportRoutes.ts to keep that module under the source-size cap.
import { spreadsheetImportLimitBytes } from "@shared/fileSizePolicy";
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { toMoney } from "../../../lib/money";
import { factoryBaleProducts } from "@shared/schema";
import { eq } from "drizzle-orm";

export function registerFactoryProductImportRoutesPart2(app: Express) {
  app.post("/api/factory/bales/validate-import", requireAuth, async (req: Request, res: Response) => {
    try {
      const multer = (await import("multer")).default;
      const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: spreadsheetImportLimitBytes(req.session?.currentRole), files: 1 },
      });

      upload.single("file")(req, res, async (err) => {
        try {
          if (err)
            return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
              message:
                err.code === "LIMIT_FILE_SIZE"
                  ? "Excel file exceeds the 50 MB standard / 100 MB admin limit."
                  : getErrorMessage(err),
            });

          const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
          if (!companyId) return res.status(400).json({ message: "No company selected" });

          if (!req.file) return res.status(400).json({ message: "No file uploaded" });

          const XLSX = (await import("xlsx-js-style")).default;
          const workbook = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
          const sheetName = workbook.SheetNames[0];
          const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName]);

          const getVal = (row: Record<string, unknown>, ...keys: string[]) => {
            const rowKeys = Object.keys(row);
            for (const k of keys) {
              const found = rowKeys.find((rk) => rk.trim().toLowerCase() === k.toLowerCase());
              if (found && row[found] !== undefined && row[found] !== null && String(row[found]).trim() !== "")
                return row[found];
            }
            return undefined;
          };

          const allProducts = await db
            .select()
            .from(factoryBaleProducts)
            .where(eq(factoryBaleProducts.companyId, companyId));
          const productByArticle = new Map();
          for (const p of allProducts) {
            if (p.articleCode) productByArticle.set(p.articleCode.trim().toUpperCase(), p);
          }

          const validRows: {
            rowIndex: number;
            articleCode: string;
            productName: string;
            productId: number;
            quantity: number;
            weight: number;
            productionDate: string;
          }[] = [];
          const skippedRows: { rowIndex: number; articleCode: string; reason: string }[] = [];

          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const rawCode = getVal(
              row,
              "ITEM BARCODE",
              "Item Barcode",
              "itemBarcode",
              "articleCode",
              "article_code",
              "ArticleCode",
              "Article Code",
              "barcode",
              "Barcode",
              "ITEM NAME",
              "Item Name"
            );
            const articleCode = rawCode ? String(rawCode).trim().toUpperCase() : "";
            if (!articleCode) {
              skippedRows.push({ rowIndex: i + 2, articleCode: "", reason: "Empty article code" });
              continue;
            }

            const product = productByArticle.get(articleCode);
            if (!product) {
              skippedRows.push({ rowIndex: i + 2, articleCode, reason: "Article code not found in products" });
              continue;
            }

            const rawQty = parseInt(String(getVal(row, "QUANTITY", "Quantity", "quantity", "qty", "Qty") ?? "1"));
            if (isNaN(rawQty) || rawQty <= 0) {
              skippedRows.push({ rowIndex: i + 2, articleCode, reason: "Invalid quantity (must be > 0)" });
              continue;
            }
            const weight = toMoney(product.weightPerBaleKg || "25").toNumber();

            let prodDate: Date | null = null;
            const rawDate = getVal(
              row,
              "PRODUCTION DATE",
              "Production Date",
              "productionDate",
              "production_date",
              "date",
              "Date"
            );
            if (rawDate instanceof Date && !isNaN(rawDate.getTime())) {
              prodDate = rawDate;
            } else if (rawDate) {
              const dateStr = String(rawDate).trim();
              const parsed = new Date(dateStr);
              if (!isNaN(parsed.getTime())) {
                prodDate = parsed;
              }
            }
            if (!prodDate) {
              skippedRows.push({ rowIndex: i + 2, articleCode, reason: "No valid production date" });
              continue;
            }

            validRows.push({
              rowIndex: i + 2,
              articleCode,
              productName: product.name,
              productId: product.id,
              quantity: rawQty,
              weight,
              productionDate: prodDate.toISOString().split("T")[0],
            });
          }

          const totalBales = validRows.reduce((sum, r) => sum + r.quantity, 0);
          const totalWeight = validRows.reduce((sum, r) => sum + r.quantity * r.weight, 0);

          return res.json({
            totalRows: rows.length,
            validRows,
            skippedRows,
            totalBales,
            totalWeight,
            totalProducts: allProducts.length,
          });
        } catch (innerErr: unknown) {
          logger.error("Validate import error:", { error: innerErr });
          return res.status(500).json({ message: getErrorMessage(innerErr) });
        }
      });
    } catch (outerErr: unknown) {
      logger.error("Validate import outer error:", { error: outerErr });
      res.status(500).json({ message: getErrorMessage(outerErr) });
    }
  });
}
