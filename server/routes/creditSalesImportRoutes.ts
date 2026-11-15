/**
 * Credit-sales Excel-import routes.
 *
 * Parse / validate / import for credit-sales spreadsheets, plus the template
 * download. Extracted from importRoutes.ts as a sub-registrar; behaviour is
 * unchanged.
 */
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { createWorkbook, jsonToSheet, writeWorkbook } from "../excelHelper";
import { registerCreditSalesImportRoutesPart1 } from "./registerCreditSalesImportRoutesPart1";
import { registerCreditSalesImportRoutesPart2 } from "./registerCreditSalesImportRoutesPart2";

export function registerCreditSalesImportRoutes(app: Express) {
  registerCreditSalesImportRoutesPart1(app);
  registerCreditSalesImportRoutesPart2(app);
  registerCreditSalesImportRoutesPart3(app);
}

function registerCreditSalesImportRoutesPart3(app: Express) {
  // Download sample Credit Sales import template
  app.get("/api/credit-sales-import/template", async (_req, res) => {
    try {
      const sampleData = [
        {
          Barcode: "BC001",
          Quantity: 5,
          Rate: 25.0,
        },
        {
          Barcode: "BC002",
          Quantity: 3,
          Rate: 35.5,
        },
        {
          Barcode: "BC003",
          Quantity: 10,
          Rate: 15.75,
        },
      ];

      const workbook = createWorkbook();
      jsonToSheet(workbook, sampleData, "Credit Sales Import");

      const buffer = await writeWorkbook(workbook);

      res.setHeader("Content-Disposition", "attachment; filename=Credit_Sales_Import_Template.xlsx");
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.send(buffer);
    } catch (error: unknown) {
      logger.error("Template generation error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
