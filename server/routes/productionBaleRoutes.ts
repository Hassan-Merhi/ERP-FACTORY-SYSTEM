/**
 * Production-bale routes.
 *
 * Production bales, pressing batches, barcode generation/lookup, and the
 * production-bale Excel import. Extracted from baleRoutes.ts as a
 * sub-registrar; behaviour is unchanged.
 */
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth } from "../auth";
import { spreadsheetUpload } from "./_helpers";
import { readExcel, sheetToJson } from "../excelHelper";
import { productionBales, insertProductionBaleSchema } from "@shared/schema";
import { registerProductionBaleRoutesPart1 } from "./registerProductionBaleRoutesPart1";
import { registerProductionBaleRoutesPart2 } from "./registerProductionBaleRoutesPart2";
import { z } from "zod";
import { emptyQuery, validateRequest, type RequestSchemas } from "../lib/validateRequest";

const bulkStatusInput = {
  query: emptyQuery,
  body: z.strictObject({
    ids: z.array(z.union([z.number(), z.string()])).optional(),
    status: z.string().optional(),
  }),
} satisfies RequestSchemas;

/** Multipart: multer has parsed the form fields into req.body (strings). */
const importExcelInput = {
  query: emptyQuery,
  body: z.union([z.undefined(), z.strictObject({ mixBatchId: z.string().optional() })]),
} satisfies RequestSchemas;

export function registerProductionBaleRoutes(app: Express) {
  registerProductionBaleRoutesPart1(app);
  registerProductionBaleRoutesPart2(app);
  registerProductionBaleRoutesPart3(app);
}

function registerProductionBaleRoutesPart3(app: Express) {
  app.patch("/api/production-bales/bulk-status", requireAuth, validateRequest(bulkStatusInput), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { ids, status } = req.body;
      const validStatuses = ["PENDING", "LABEL_PRINTED", "PRESSED", "IN_STOCK", "RESERVED", "SOLD"];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ message: `Invalid status. Must be one of: ${validStatuses.join(", ")}` });
      }
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ message: "No bale IDs provided" });
      }
      const { eq, and, inArray } = await import("drizzle-orm");

      const updated = await db
        .update(productionBales)
        .set({ status, updatedAt: new Date() })
        .where(
          and(
            inArray(
              productionBales.id,
              ids.map((id) => parseInt(id))
            ),
            eq(productionBales.companyId, companyId)
          )
        )
        .returning();

      res.json({ updated: updated.length });
    } catch (error: unknown) {
      logger.error("Error bulk updating bale status:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post(
    "/api/production-bales/import-excel",
    requireAuth,
    spreadsheetUpload.single("file"),
    validateRequest(importExcelInput),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) {
          return res.status(400).json({ message: "No company selected" });
        }

        if (!req.file) {
          return res.status(400).json({ message: "No file uploaded" });
        }

        // Parse Excel file
        const workbook = await readExcel(req.file.buffer);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const rows = sheetToJson(worksheet);
        const mixBatchId = req.body.mixBatchId ? parseInt(req.body.mixBatchId) : undefined;

        // Map Excel rows to bale data
        const balesData = rows.map((row) => {
          return insertProductionBaleSchema.parse({
            companyId,
            mixBatchId,
            baleCode: row.bale_code || row.baleCode || "",
            barcodeValue: row.barcode_value || row.barcodeValue || row.barcode || row.bale_code || row.baleCode || "",
            category: row.category || "",
            grade: row.grade || "",
            weightKg: row.weight_kg?.toString() || row.weightKg?.toString() || row.weight?.toString() || "0",
            costPerKg: row.cost_per_kg?.toString() || row.costPerKg?.toString() || "0",
            totalCost: row.total_cost?.toString() || row.totalCost?.toString() || "0",
            warehouseLocation: row.warehouse_location || row.warehouseLocation || "",
            status: row.status || "LABEL_PRINTED",
          });
        });

        const created = await storage.bulkCreateProductionBales(balesData);
        res.json({ success: true, count: created.length, bales: created });
      } catch (error: unknown) {
        logger.error("Error importing Excel:", { error: error });
        res.status(400).json({ message: getErrorMessage(error) });
      }
    }
  );
}
