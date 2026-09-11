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
import { getClientDate } from "../../lib/dateUtils";
import { eq, and } from "drizzle-orm";
import fs from "fs";
import XLSX from "xlsx-js-style";
import ExcelJS from "exceljs";
import { factoryWorkers } from "@shared/schema";

import { getFactoryCompanyId, workerUpload, writeDaybookEntry } from "./_helpers";

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

  // POST /api/factory/workers/import-excel - Bulk import/update workers from Excel
  app.post(
    "/api/factory/workers/import-excel",
    requireAuth,
    workerUpload.single("file"),
    async (req: Request, res: Response) => {
      try {
        // Always use the session's current company; never trust client-provided companyId
        const companyId = getFactoryCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "companyId required" });
        if (!req.file) return res.status(400).json({ message: "No file uploaded" });

        // Parse xlsx
        const workbook = XLSX.readFile(req.file.path);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
        fs.unlinkSync(req.file.path);

        // Case-insensitive column mapping
        const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
        const colMap: Record<string, string> = {
          fullname: "fullName",
          employeecode: "employeeCode",
          nationalid: "nationalId",
          passportnumber: "passportNumber",
          dateofbirth: "dateOfBirth",
          nationality: "nationality",
          gender: "gender",
          maritalstatus: "maritalStatus",
          phone1: "phone1",
          phone2: "phone2",
          emergencycontactname: "emergencyContactName",
          emergencycontactphone: "emergencyContactPhone",
          address: "address",
          city: "city",
          country: "country",
          position: "position",
          department: "department",
          datejoined: "dateJoined",
          contractstart: "contractStartDate",
          salarytype: "salaryType",
          basesalary: "baseSalary",
          perbalerate: "perBaleRate",
          perkgrate: "perKgRate",
          payfrequency: "payFrequency",
          hourlyrate: "hourlyRate",
          weeklysalary: "weeklySalary",
          biweeklysalary: "biWeeklySalary",
          visanumber: "visaNumber",
          visaexpiry: "visaExpiry",
          workpermitnumber: "workPermitNumber",
          workpermitexpiry: "workPermitExpiry",
          residentialpermit: "residentialPermit",
          residentialpermitexpiry: "residentialPermitExpiry",
          bankname: "bankName",
          bankaccountnumber: "bankAccountNumber",
          paymentmethod: "paymentMethod",
          notes: "notes",
        };

        let created = 0,
          updated = 0,
          skipped = 0;
        const errors: string[] = [];

        // Load existing workers for fast lookup
        const existingWorkers = await db.select().from(factoryWorkers).where(eq(factoryWorkers.companyId, companyId));

        // Determine next HMD code number for auto-assignment during import
        const importPrefix = "HMD";
        let nextHmdNum = existingWorkers.reduce((max: number, w) => {
          if (!w.employeeCode) return max;
          const m = w.employeeCode.match(new RegExp(`^${importPrefix}(\\d+)$`));
          return m ? Math.max(max, parseInt(m[1], 10)) : max;
        }, 0);

        type ExistingWorker = (typeof existingWorkers)[number];
        const indexBy = (key: keyof ExistingWorker): Map<string, ExistingWorker> => {
          const index = new Map<string, ExistingWorker>();
          for (const worker of existingWorkers) {
            const value = worker[key];
            if (typeof value === "string" && value) index.set(value, worker);
          }
          return index;
        };
        const byCode = indexBy("employeeCode");
        const byPassport = indexBy("passportNumber");
        const byNationalId = indexBy("nationalId");

        const parseDate = (v: unknown): string | null => {
          if (!v) return null;
          if (typeof v === "number") {
            // Excel serial date
            const d = new Date(Math.round((v - 25569) * 86400 * 1000));
            return d.toISOString().split("T")[0];
          }
          const s = String(v).trim();
          if (!s) return null;
          const d = new Date(s);
          return isNaN(d.getTime()) ? null : d.toISOString().split("T")[0];
        };

        for (let i = 0; i < rows.length; i++) {
          const raw = rows[i];
          try {
            // Map raw keys to field names
            const mapped: Record<string, unknown> = {};
            for (const [rawKey, rawVal] of Object.entries(raw)) {
              const key = colMap[normalize(rawKey)];
              if (key) mapped[key] = rawVal;
            }
            if (!mapped.fullName) {
              skipped++;
              errors.push(`Row ${i + 2}: missing Full Name`);
              continue;
            }

            // Date fields
            for (const f of [
              "dateOfBirth",
              "dateJoined",
              "contractStartDate",
              "visaExpiry",
              "workPermitExpiry",
              "residentialPermitExpiry",
            ]) {
              if (mapped[f] !== undefined) mapped[f] = parseDate(mapped[f]);
            }
            // Numeric fields
            for (const f of [
              "baseSalary",
              "perBaleRate",
              "perKgRate",
              "hourlyRate",
              "weeklySalary",
              "biWeeklySalary",
            ]) {
              if (mapped[f] !== undefined && mapped[f] !== "") mapped[f] = String(parseFloat(String(mapped[f])) || 0);
            }

            // Find existing worker
            const existing =
              (typeof mapped.employeeCode === "string" ? byCode.get(mapped.employeeCode) : undefined) ||
              (typeof mapped.passportNumber === "string" ? byPassport.get(mapped.passportNumber) : undefined) ||
              (typeof mapped.nationalId === "string" ? byNationalId.get(mapped.nationalId) : undefined);
            if (existing) {
              await db
                .update(factoryWorkers)
                .set({ ...(mapped as Partial<typeof factoryWorkers.$inferInsert>), updatedAt: new Date() })
                .where(and(eq(factoryWorkers.id, existing.id), eq(factoryWorkers.companyId, companyId)));
              updated++;
            } else {
              const [newWorker] = await db
                .insert(factoryWorkers)
                .values({
                  ...(mapped as Partial<typeof factoryWorkers.$inferInsert>),
                  companyId,
                } as typeof factoryWorkers.$inferInsert)
                .returning();
              if (!newWorker.employeeCode) {
                nextHmdNum++;
                const autoCode = `${importPrefix}${String(nextHmdNum).padStart(3, "0")}`;
                await db
                  .update(factoryWorkers)
                  .set({ employeeCode: autoCode })
                  .where(eq(factoryWorkers.id, newWorker.id));
              }
              created++;
            }
          } catch (e: unknown) {
            skipped++;
            errors.push(`Row ${i + 2}: ${getErrorMessage(e)}`);
          }
        }

        const today = getClientDate(req);
        await writeDaybookEntry(db, {
          companyId,
          txDate: today,
          txType: "WORKER_IMPORT",
          description: `Worker import: ${created} created, ${updated} updated, ${skipped} skipped`,
          createdBy: req.session.userId ?? undefined,
        });

        res.json({ created, updated, skipped, errors });
      } catch (error: unknown) {
        logger.error("Error importing workers:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

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
