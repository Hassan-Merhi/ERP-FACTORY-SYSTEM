import { spreadsheetImportLimitBytes } from "@shared/fileSizePolicy";
import type { Express, Request, Response } from "express";
import { logAudit } from "../../helpers/auditHelpers";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { factoryBaleProducts, factoryBales } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { registerBalesReimportRoutesPart1 } from "./registerBalesReimportRoutesPart1";

export function registerBalesReimportRoutes(app: Express) {
  registerBalesReimportRoutesPart1(app);
  registerBalesReimportRoutesPart2(app);
}

function registerBalesReimportRoutesPart2(app: Express) {
  // GET /api/factory/bales/export-names.xlsx — Export all bales for bulk product-name editing
  app.get("/api/factory/bales/export-names.xlsx", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const bales = await db
        .select()
        .from(factoryBales)
        .where(eq(factoryBales.companyId, companyId))
        .orderBy(factoryBales.id);

      const ExcelJS = (await import("exceljs")).default;
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Bales");

      sheet.columns = [
        { header: "ID (do not edit)", key: "id", width: 18 },
        { header: "Bale Code", key: "baleCode", width: 18 },
        { header: "Reference Number", key: "referenceNumber", width: 22 },
        { header: "Category", key: "category", width: 16 },
        { header: "Grade", key: "grade", width: 12 },
        { header: "Product Name", key: "productName", width: 30 },
      ];

      const headerRow = sheet.getRow(1);
      headerRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF374151" } };
      });
      const idHeaderCell = sheet.getCell("A1");
      idHeaderCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF6B7280" } };

      for (const bale of bales) {
        const row = sheet.addRow({
          id: bale.id,
          baleCode: bale.baleCode,
          referenceNumber: bale.referenceNumber,
          category: bale.category ?? "",
          grade: bale.grade ?? "",
          productName: bale.productName ?? "",
        });
        const idCell = row.getCell("id");
        idCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F6" } };
        idCell.font = { color: { argb: "FF6B7280" } };
      }

      sheet.protect("", { selectLockedCells: true, selectUnlockedCells: true });

      const xlsBuffer = Buffer.from(await workbook.xlsx.writeBuffer());
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="bale_names_${companyId}.xlsx"`);
      res.setHeader("Content-Length", xlsBuffer.byteLength);
      res.end(xlsBuffer);
    } catch (error: unknown) {
      logger.error("Error exporting bale names:", { error: error });
      if (!res.headersSent) res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // POST /api/factory/bales/bulk-update-names — Upload Excel and update product_name in bulk
  app.post("/api/factory/bales/bulk-update-names", requireAuth, async (req: Request, res: Response) => {
    const multer = (await import("multer")).default;
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: spreadsheetImportLimitBytes(req.session?.currentRole), files: 1 },
    });
    upload.single("file")(req, res, async (err: unknown) => {
      if (err) {
        const tooLarge = typeof err === "object" && "code" in err && err.code === "LIMIT_FILE_SIZE";
        return res.status(tooLarge ? 413 : 400).json({
          code: tooLarge ? "UPLOAD_FILE_TOO_LARGE" : "UPLOAD_ERROR",
          message: tooLarge ? "Excel file exceeds the 50 MB standard / 100 MB admin limit." : "File upload error",
        });
      }
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });

      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const { read: readXlsx, utils } = (await import("xlsx-js-style")).default;
        const wb = readXlsx(req.file.buffer, { type: "buffer" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });

        let updated = 0;
        let skipped = 0;
        const errors: string[] = [];

        // Phase 21 (B): the renames and their audit row commit together.
        await db.transaction(async (tx) => {
          for (const row of rows) {
            const id = parseInt(String(row["ID (do not edit)"] ?? row["id"] ?? row["ID"] ?? ""), 10);
            const productName = String(row["Product Name"] ?? row["productName"] ?? "").trim();

            if (!id || isNaN(id)) {
              skipped++;
              continue;
            }
            if (!productName) {
              skipped++;
              continue;
            }

            const [bale] = await tx
              .select()
              .from(factoryBales)
              .where(and(eq(factoryBales.id, id), eq(factoryBales.companyId, companyId)));

            if (!bale) {
              errors.push(`Bale ID ${id} not found`);
              skipped++;
              continue;
            }

            if (bale.productId) {
              await tx
                .update(factoryBaleProducts)
                .set({ name: productName, updatedAt: new Date() })
                .where(and(eq(factoryBaleProducts.id, bale.productId), eq(factoryBaleProducts.companyId, companyId)));
            }

            await tx.update(factoryBales).set({ productName, updatedAt: new Date() }).where(eq(factoryBales.id, id));

            updated++;
          }

          await logAudit(
            {
              userId: req.session.userId!,
              username: req.session.username || req.session.userId!,
              companyId,
              action: "update",
              tableName: "factory_bales",
              recordId: null,
              recordIdentifier: `bulk-rename: ${updated} bale(s) updated, ${skipped} skipped`,
              changes: null,
            },
            tx
          );
        });

        res.json({ updated, skipped, errors });
      } catch (error: unknown) {
        logger.error("Error bulk-updating bale names:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    });
  });
}
