/**
 * factoryWorkerRoutes: FactoryWorkerImportExport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import type { AppDb, AuthMiddleware } from "../routeBoundaryTypes";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { eq, and } from "drizzle-orm";
import ExcelJS from "exceljs";
import { factoryWorkers } from "@shared/schema";

import { getFactoryCompanyId } from "./_helpers";
import { registerFactoryWorkerImportExportRoutesPart1 } from "./registerFactoryWorkerImportExportRoutesPart1";

export function registerFactoryWorkerImportExportRoutes(app: Express, requireAuth: AuthMiddleware, db: AppDb) {
  // GET /api/factory/workers/template.xlsx - Download Excel import template
  app.get("/api/factory/workers/template.xlsx", requireAuth, async (req: Request, res: Response) => {
    try {
      const wb = new ExcelJS.Workbook();
      const sheet = wb.addWorksheet("Workers");
      const headers = [
        "Full Name",
        "Employee Code",
        "National ID",
        "Passport Number",
        "Date of Birth",
        "Nationality",
        "Gender",
        "Marital Status",
        "Phone 1",
        "Phone 2",
        "Emergency Contact Name",
        "Emergency Contact Phone",
        "Address",
        "City",
        "Country",
        "Position",
        "Department",
        "Date Joined",
        "Contract Start",
        "Salary Type",
        "Base Salary",
        "Per Bale Rate",
        "Per KG Rate",
        "Pay Frequency",
        "Hourly Rate",
        "Weekly Salary",
        "Bi-Weekly Salary",
        "Visa Number",
        "Visa Expiry",
        "Work Permit Number",
        "Work Permit Expiry",
        "Residential Permit",
        "Residential Permit Expiry",
        "Bank Name",
        "Bank Account Number",
        "Payment Method",
        "Notes",
      ];
      const headerRow = sheet.addRow(headers);
      headerRow.font = { bold: true };
      headerRow.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "1F4E79" } };
        cell.font = { bold: true, color: { argb: "FFFFFF" } };
      });

      // Hint row: valid values for key columns
      const hintValues = [
        "",
        "",
        "",
        "",
        "YYYY-MM-DD",
        "",
        "Male / Female",
        "Single / Married / Divorced",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "YYYY-MM-DD",
        "YYYY-MM-DD",
        "Monthly / Daily / Per Bale / Per KG",
        "number",
        "number",
        "number",
        "Monthly / Hourly / Weekly / Bi-Weekly",
        "number",
        "number",
        "number",
        "",
        "YYYY-MM-DD",
        "",
        "YYYY-MM-DD",
        "",
        "YYYY-MM-DD",
        "",
        "",
        "Cash / Bank / Transfer",
        "",
      ];
      const hintRow = sheet.addRow(hintValues);
      hintRow.eachCell((cell) => {
        if (cell.value) {
          cell.font = { italic: true, color: { argb: "888888" }, size: 9 };
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "F5F5F5" } };
        }
      });

      // Example data row
      const exampleRow = sheet.addRow([
        "Ahmed Hassan",
        "FW-001",
        "A12345678",
        "P9876543",
        "1990-05-15",
        "Moroccan",
        "Male",
        "Married",
        "+212-600-123456",
        "+212-600-000000",
        "Fatima Hassan",
        "+212-600-654321",
        "123 Rue Mohammed V",
        "Casablanca",
        "Morocco",
        "Sorter",
        "Production",
        "2024-01-15",
        "2024-01-15",
        "Monthly",
        "3000",
        "2.50",
        "0.15",
        "Monthly",
        "0",
        "0",
        "0",
        "V2024-001",
        "2026-01-14",
        "WP2024-001",
        "2026-01-14",
        "RP2024-001",
        "2026-01-14",
        "Attijariwafa Bank",
        "007-123456789",
        "Bank",
        "Example row — delete before importing",
      ]);
      exampleRow.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDE7" } };
        cell.font = { italic: true, color: { argb: "5D4037" } };
      });
      // Label in the first cell to make it obvious
      exampleRow.getCell(1).font = { bold: true, italic: true, color: { argb: "5D4037" } };

      headers.forEach((_, i) => {
        sheet.getColumn(i + 1).width = 22;
      });
      const xlsBuffer = Buffer.from(await wb.xlsx.writeBuffer());
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", 'attachment; filename="worker_import_template.xlsx"');
      res.setHeader("Content-Length", xlsBuffer.byteLength);
      res.end(xlsBuffer);
    } catch (error: unknown) {
      logger.error("Error generating template:", { error: error });
      if (!res.headersSent) res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  registerFactoryWorkerImportExportRoutesPart1(app, requireAuth, db);

  // POST /api/factory/workers/reassign-codes - Bulk reassign HMD001, HMD002... codes
  app.post("/api/factory/workers/reassign-codes", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.body.companyId || getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const prefix = (req.body.prefix as string) || "HMD";

      const allWorkers = await db
        .select({ id: factoryWorkers.id, fullName: factoryWorkers.fullName })
        .from(factoryWorkers)
        .where(eq(factoryWorkers.companyId, companyId))
        .orderBy(factoryWorkers.id);

      const results: { id: number; name: string; code: string }[] = [];

      for (let i = 0; i < allWorkers.length; i++) {
        const code = `${prefix}${String(i + 1).padStart(3, "0")}`;
        await db
          .update(factoryWorkers)
          .set({ employeeCode: code, updatedAt: new Date() })
          .where(and(eq(factoryWorkers.id, allWorkers[i].id), eq(factoryWorkers.companyId, companyId)));
        results.push({ id: allWorkers[i].id, name: allWorkers[i].fullName, code });
      }

      res.json({ updated: results.length, codes: results });
    } catch (error: unknown) {
      logger.error("Error reassigning worker codes:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
