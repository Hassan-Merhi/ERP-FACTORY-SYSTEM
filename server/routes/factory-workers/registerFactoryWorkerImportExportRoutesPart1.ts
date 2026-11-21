// Extracted from ./import-export.ts
import type { Express, Request, Response } from "express";
import type { AppDb, AuthMiddleware } from "../routeBoundaryTypes";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { getClientDate } from "../../lib/dateUtils";
import { eq, and } from "drizzle-orm";
import fs from "fs";
import XLSX from "xlsx-js-style";
import { factoryWorkers } from "@shared/schema";
import { getFactoryCompanyId, resolveWorkerUploadPath, workerSpreadsheetUpload, writeDaybookEntry } from "./_helpers";
import { toMoney } from "../../lib/money";

export function registerFactoryWorkerImportExportRoutesPart1(app: Express, requireAuth: AuthMiddleware, db: AppDb) {
  // POST /api/factory/workers/import-excel - Bulk import/update workers from Excel
  app.post(
    "/api/factory/workers/import-excel",
    requireAuth,
    workerSpreadsheetUpload.single("file"),
    async (req: Request, res: Response) => {
      try {
        // Always use the session's current company; never trust client-provided companyId
        const companyId = getFactoryCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "companyId required" });
        if (!req.file) return res.status(400).json({ message: "No file uploaded" });

        // Parse xlsx
        const uploadPath = resolveWorkerUploadPath(req.file.path);
        const workbook = XLSX.readFile(uploadPath);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
        fs.unlinkSync(uploadPath);

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
              if (mapped[f] !== undefined && mapped[f] !== "")
                mapped[f] = String(toMoney(String(mapped[f] ?? "")).toNumber());
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
}
