// Extracted from ./balesImportRoutes.ts
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { requireAuth } from "../../../auth";

export function registerBalesImportRoutesPart3(app: Express) {
  app.get("/api/factory/import/template/:type", requireAuth, async (req: Request, res: Response) => {
    try {
      const type = req.params.type;
      let csv = "";
      let filename = "";

      switch (type) {
        case "suppliers":
          csv = "name,openingBalance,contactPerson,phone,email";
          filename = "factory_suppliers_template.csv";
          break;
        case "raw-stock":
          csv = "containerNumber,supplierName,receivedKg,usedKg,costPerKg,arrivalDate";
          filename = "factory_raw_stock_template.csv";
          break;
        case "bales":
          csv = "baleCode,articleCode,productName,category,grade,weightKg,costPerKg,status";
          filename = "factory_bales_template.csv";
          break;
        case "opening-raw-stock":
          csv = "supplier,kg,costPerKg,currency,fxRateToUsd,openingDate,notes";
          filename = "factory_opening_raw_stock_template.csv";
          break;
        default:
          return res
            .status(400)
            .json({ message: "Invalid template type. Use: suppliers, raw-stock, bales, or opening-raw-stock" });
      }

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (error: unknown) {
      logger.error("Error generating template:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
