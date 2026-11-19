// Extracted from ./stockTransferImportRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { requireAuth, requireNonPOS } from "../auth";
import { spreadsheetUpload } from "./_helpers";
import { createWorkbook, jsonToSheet, readExcel, sheetToJson, writeWorkbook } from "../excelHelper";
import type { ParsedStockTransferItem, SpreadsheetRow } from "./stockTransferImportTypes";
import { rowQuantity } from "./stockTransferImportQuantity";
import { registerStockTransferImportRoutesPart4 } from "./registerStockTransferImportRoutesPart4";
import { emptyBody, emptyQuery, validateRequest, type RequestSchemas } from "../lib/validateRequest";

// Multipart upload of one spreadsheet (useStockTransferFormModelPart4.ts appends only "file").
const parseMultiSourceInput = { query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

export function registerStockTransferImportRoutesPart2(app: Express) {
  registerStockTransferImportRoutesPart4(app);

  // Download sample Stock Transfer import template
  app.get("/api/stock-transfer-import/template", requireAuth, async (_req, res) => {
    try {
      const sampleData = [
        {
          Barcode: "BC001",
          Quantity: 5,
        },
        {
          Barcode: "BC002",
          Quantity: 10,
        },
        {
          Barcode: "BC003",
          Quantity: 15,
        },
      ];

      const workbook = createWorkbook();
      jsonToSheet(workbook, sampleData, "Stock Transfer");

      const buffer = await writeWorkbook(workbook);

      res.setHeader("Content-Disposition", "attachment; filename=Stock_Transfer_Import_Template.xlsx");
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.send(buffer);
    } catch (error: unknown) {
      logger.error("Template generation error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Multi-source Stock Transfer Import - Template
  app.get("/api/stock-transfer-import/template-multi-source", requireAuth, async (_req, res) => {
    try {
      const sampleData = [
        {
          "Source Location": "Warehouse A",
          Barcode: "BC001",
          Quantity: 5,
        },
        {
          "Source Location": "Warehouse B",
          Barcode: "BC002",
          Quantity: 10,
        },
        {
          "Source Location": "Warehouse A",
          Barcode: "BC003",
          Quantity: 15,
        },
      ];

      const workbook = createWorkbook();
      jsonToSheet(workbook, sampleData, "Stock Transfer");

      const buffer = await writeWorkbook(workbook);

      res.setHeader("Content-Disposition", "attachment; filename=Stock_Transfer_Multi_Source_Template.xlsx");
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.send(buffer);
    } catch (error: unknown) {
      logger.error("Template generation error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Multi-source Stock Transfer Import - Parse Excel
  app.post(
    "/api/stock-transfer-import/parse-multi-source",
    requireAuth,
    requireNonPOS,
    spreadsheetUpload.single("file"),
    validateRequest(parseMultiSourceInput),
    async (req, res) => {
      try {
        if (!req.session.currentCompanyId) {
          return res.status(400).json({ message: "No company selected" });
        }

        if (!req.file) {
          return res.status(400).json({ message: "No file uploaded" });
        }

        const workbook = await readExcel(req.file.buffer);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const rawData = sheetToJson(worksheet);

        if (rawData.length === 0) {
          return res.status(400).json({ message: "Excel file is empty" });
        }

        const rows = rawData as SpreadsheetRow[];
        const items: ParsedStockTransferItem[] = [];

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const rowNum = i + 2;

          // Expected columns: Source Location, Barcode, Quantity
          const sourceLocation = row["Source Location"] || row.SourceLocation || row.sourceLocation || row.source || "";
          const barcode = row.Barcode || row.barcode || row.Code || row.code;
          const quantity = rowQuantity(row);

          if (!barcode) {
            continue; // Skip rows without barcode
          }

          if (quantity <= 0) {
            continue; // Skip invalid quantities
          }

          items.push({
            rowNum,
            sourceLocation: String(sourceLocation).trim(),
            barcode: barcode.toString().trim(),
            quantity,
          });
        }

        if (items.length === 0) {
          return res.status(400).json({
            message: "No valid items found in Excel file. Expected columns: Source Location, Barcode, Quantity",
          });
        }

        res.json({
          success: true,
          items,
        });
      } catch (error: unknown) {
        logger.error("Stock Transfer Parse error:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
