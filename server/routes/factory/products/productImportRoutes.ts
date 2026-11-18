import { spreadsheetImportLimitBytes } from "@shared/fileSizePolicy";
/**
 * factoryProductsRoutes: FactoryProductImport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { getClientDate } from "../../../lib/dateUtils";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { writeAuditEvent } from "../../../services/audit/auditService";
import { assertStockImportAllowedTx, sendStockImportRefusal } from "../../../services/factory/stockImportPolicy";
import { toMoney } from "../../../lib/money";
import { writeDaybookEntry } from "../_helpers";
import { factoryBaleProducts, factoryBales, factoryBaleSequences, factoryBaleImportBatches } from "@shared/schema";
import { eq } from "drizzle-orm";
import { isFactorySessionLocation } from "../../helpers/companyOwnership";
import { adminOrOwner } from "./productImportRoutesAdminOrOwner";
import { registerFactoryProductImportRoutesPart1 } from "./registerFactoryProductImportRoutesPart1";
import { registerFactoryProductImportRoutesPart2 } from "./registerFactoryProductImportRoutesPart2";

export function registerFactoryProductImportRoutes(app: Express) {
  registerFactoryProductImportRoutesPart1(app);
  registerFactoryProductImportRoutesPart2(app);
  registerFactoryProductImportRoutesPart3(app);
}

function registerFactoryProductImportRoutesPart3(app: Express) {
  // Phase 19 C (F7/DI10): the bale Excel import creates stock from a sheet with
  // no journal and no cost. Admin/Owner (Developer passes); one transaction that
  // takes the cut-over lock and is refused once the cut-over is applied (409
  // FACTORY_STOCK_IMPORT_AFTER_CUTOVER); its bales belong to an import batch (the
  // readiness report lists them; with no mix they still block the cut-over as
  // no-mix bales, owner decision); one import audit row in the transaction.
  app.post("/api/factory/bales/import-excel", requireAuth, adminOrOwner, async (req: Request, res: Response) => {
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

          const locationId = req.body.locationId ? (parseId(req.body.locationId) ?? -1) : null;
          if (locationId !== null && !(await isFactorySessionLocation(req.session, locationId))) {
            return res.status(400).json({ message: "Location not found" });
          }

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

          let totalBalesCreated = 0;
          let skippedRows = 0;
          const skippedDetails: string[] = [];

          type ImportedProduct = (typeof allProducts)[number];
          const rowGroups: { product: ImportedProduct; qty: number; weight: number; prodDate: Date }[] = [];
          let totalBalesNeeded = 0;

          logger.info(`Bale import: processing ${rows.length} rows`, {
            firstRowKeys: rows.length > 0 ? Object.keys(rows[0]) : "none",
          });

          for (const row of rows) {
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
              "Barcode"
            );
            const articleCode = rawCode ? String(rawCode).trim().toUpperCase() : "";
            if (!articleCode) {
              skippedRows++;
              skippedDetails.push("Row with empty article code");
              continue;
            }

            const product = productByArticle.get(articleCode);
            if (!product) {
              skippedRows++;
              skippedDetails.push(`Article code "${articleCode}" not found in products`);
              continue;
            }

            const rawQty = parseInt(String(getVal(row, "QUANTITY", "Quantity", "quantity", "qty", "Qty") ?? "1"));
            if (isNaN(rawQty) || rawQty <= 0) {
              skippedRows++;
              skippedDetails.push(`Article "${articleCode}" has invalid quantity`);
              continue;
            }
            const qty = rawQty;
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
              skippedRows++;
              skippedDetails.push(`Article "${articleCode}" has no valid production date`);
              continue;
            }

            rowGroups.push({ product, qty, weight, prodDate });
            totalBalesNeeded += qty;
          }

          if (rowGroups.length === 0) {
            return res.json({ totalBalesCreated: 0, skippedRows, skippedDetails: skippedDetails.slice(0, 20) });
          }

          const importBatchId = await db.transaction(async (tx) => {
            await assertStockImportAllowedTx(tx, companyId);
            const [batch] = await tx
              .insert(factoryBaleImportBatches)
              .values({
                companyId,
                fileName: req.file?.originalname || "bale-import.xlsx",
                baleCount: totalBalesNeeded,
                errorCount: skippedRows,
                totalWeightKg: rowGroups
                  .reduce((sum, group) => sum.plus(toMoney(group.weight).times(group.qty)), toMoney(0))
                  .toFixed(3),
                importedByUserId: String(req.session?.userId || ""),
                importedByName: req.session?.username || null,
                notes: "Bale Excel import (catalogue products, no cost)",
              })
              .returning({ id: factoryBaleImportBatches.id });
            const [seqRecord] = await tx
              .select()
              .from(factoryBaleSequences)
              .where(eq(factoryBaleSequences.companyId, companyId))
              .for("update");

            let nextNumber: number;
            if (seqRecord) {
              nextNumber = seqRecord.nextNumber;
              await tx
                .update(factoryBaleSequences)
                .set({ nextNumber: nextNumber + totalBalesNeeded })
                .where(eq(factoryBaleSequences.id, seqRecord.id));
            } else {
              nextNumber = 200000;
              await tx.insert(factoryBaleSequences).values({
                companyId,
                nextNumber: 200000 + totalBalesNeeded,
              });
            }

            let baleIndex = 0;
            for (const group of rowGroups) {
              for (let i = 0; i < group.qty; i++) {
                const refNum = `REF${String(nextNumber + baleIndex).padStart(6, "0")}`;
                await tx.insert(factoryBales).values({
                  companyId,
                  mixBatchId: null,
                  productId: group.product.id,
                  erpLocationId: locationId,
                  baleCode: group.product.code,
                  referenceNumber: refNum,
                  articleCode: group.product.articleCode,
                  productName: group.product.name,
                  weightKg: String(group.weight),
                  costPerKg: "0",
                  totalCost: "0",
                  status: "IN_STOCK",
                  finalizedAt: group.prodDate,
                  createdAt: group.prodDate,
                  importBatchId: batch.id,
                });
                baleIndex++;
              }
              totalBalesCreated += group.qty;
            }
            await writeAuditEvent(
              {
                userId: req.session.userId ?? "unknown",
                username: req.session.username || "unknown",
                companyId,
                action: "import",
                tableName: "factory_bale_import_batches",
                recordId: batch.id,
                recordIdentifier: `bale Excel import: ${totalBalesCreated} bale(s) at no cost`,
                metadata: {
                  source: "factory_bale_import_excel",
                  fileName: req.file?.originalname ?? null,
                  locationId,
                  bales: totalBalesCreated,
                  firstReference: `REF${String(nextNumber).padStart(6, "0")}`,
                  skippedRows,
                },
              },
              tx
            );
            return batch.id;
          });

          if (totalBalesCreated > 0) {
            const excelImportToday = getClientDate(req);
            await writeDaybookEntry(db, {
              companyId,
              txDate: excelImportToday,
              txType: "BALE_IMPORT",
              description: `Bale Excel import: ${totalBalesCreated} bale${totalBalesCreated !== 1 ? "s" : ""} created${skippedRows > 0 ? ` (${skippedRows} rows skipped)` : ""}`,
            });
          }
          res.json({ totalBalesCreated, skippedRows, skippedDetails: skippedDetails.slice(0, 20), importBatchId });
        } catch (innerError: unknown) {
          if (sendStockImportRefusal(res, innerError)) return;
          logger.error("Error processing bale Excel import:", { error: innerError });
          res.status(500).json({ message: getErrorMessage(innerError) });
        }
      });
    } catch (error: unknown) {
      logger.error("Error in bale Excel import:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
