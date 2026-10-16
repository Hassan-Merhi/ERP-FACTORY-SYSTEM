/**
 * Bulk tracking imports for Supplier Partner containers.
 * Parses the same ERP GIT Excel template and edits only logistics metadata.
 * No SP invoice, stock, voucher or financial lifecycle data is written here.
 */
import type { Express, Request } from "express";
import XLSX from "xlsx-js-style";
import { db } from "../../db";
import { sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { requireAuth, requireRole } from "../../auth";
import { requireSpCompany } from "../sp/spHelpers";
import { resultRows, firstRow } from "../../lib/queryResult";
import { logger } from "../../lib/logger";
import { ensureSpGitTracking, SP_GIT_STATUSES } from "../../lib/spGitTracking";
import { gitUpload, importUndoStore, pruneImportUndoStore } from "./_helpers";
import { updateContainerTrackingSchema } from "@shared/schema";

export const SP_IMPORT_COLUMNS = {
  status: "status", shopName: "shop_name", eta: "eta", transporter: "transporter",
  transportFee: "transport_fee", numberPlate: "number_plate", trackingLocation: "tracking_location",
  borderDate: "border_date", agent: "agent", dutyFee: "duty_fee",
  docReceived: "doc_received", trackingDescription: "tracking_description", blDocs: "bl_docs",
  docsSentDate: "docs_sent_date", trackingLink: "tracking_link", freightStatus: "freight_status",
} as const;

const aliases: Record<string, keyof typeof SP_IMPORT_COLUMNS | "containerNumber"> = {
  container: "containerNumber", containerno: "containerNumber", containernumber: "containerNumber",
  status: "status", platetruckno: "numberPlate", platetruck: "numberPlate", numberplate: "numberPlate", trucknumber: "numberPlate",
  eta: "eta", etayyyymmdd: "eta", neweta: "eta",
  borderdate: "borderDate", borderdateyyyymmdd: "borderDate",
  transporter: "transporter", location: "trackingLocation", trackinglocation: "trackingLocation",
  agent: "agent", dutyfee: "dutyFee", transportfee: "transportFee",
  docsreceived: "docReceived", docreceived: "docReceived", docssentdate: "docsSentDate",
  docssentdateyyyymmdd: "docsSentDate", trackinglink: "trackingLink",
  trackingdescription: "trackingDescription", description: "trackingDescription", freightstatus: "freightStatus",
  shopname: "shopName", shop: "shopName", bldocs: "blDocs",
};
const normalizeHeader = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const str = (value: unknown): string => value == null ? "" : value instanceof Date
  ? value.toISOString().slice(0, 10) : String(value).trim();
const isoDate = (value: unknown): string | null => {
  if (value == null || value === "" || value === 0) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const raw = str(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const dmy = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  const serial = Number(raw);
  if (Number.isInteger(serial) && serial > 1000 && serial < 200000) {
    const parsed = XLSX.SSF.parse_date_code(serial);
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
  }
  throw new Error("Invalid date");
};

export function registerSpGitTrackingImportRoutes(app: Express): void {
  app.post(
    "/api/git/sp-containers/import-excel",
    requireAuth,
    requireRole("Admin", "Owner", "Developer"),
    (req, res, next) => gitUpload.single("file")(req, res, next),
    async (req, res) => {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;
      if (!req.file) return res.status(400).json({ message: "No Excel file uploaded" });
      try {
        await ensureSpGitTracking();
        const workbook = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
        const sheet = workbook.Sheets[workbook.SheetNames.find((s) => s.toLowerCase() === "containers") || workbook.SheetNames[0]];
        if (!sheet) return res.status(400).json({ message: "No worksheet found" });
        const source = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
        const result = await db.execute(sql`SELECT id, container_number FROM sp_containers
          WHERE company_id = ${companyId} AND status = 'open'`);
        const mapped = new Map(resultRows<{ id: number; container_number: string | null }>(result)
          .filter((row) => row.container_number).map((row) => [row.container_number!.trim().toUpperCase(), row.id]));
        let updated = 0, skipped = 0, notFound = 0;
        const errors: string[] = [];
        const undoChanges: Array<{ id: number; containerNumber: string; prevData: Record<string, unknown> }> = [];

        for (let index = 0; index < source.length; index++) {
          const normalized: Record<string, unknown> = {};
          for (const [header, value] of Object.entries(source[index])) {
            const field = aliases[normalizeHeader(header)];
            if (field) normalized[field] = value;
          }
          const number = str(normalized.containerNumber).toUpperCase();
          if (!number || number.includes("REQUIRED") || number === "MSKU1234567" || number === "TCNU9876543") {
            skipped++;
            continue;
          }
          const id = mapped.get(number);
          if (!id) {
            notFound++; errors.push(`Row ${index + 2}: container ${number} not found in active Supplier Partner records`);
            continue;
          }
          try {
            const patch: Record<string, unknown> = {};
            for (const name of Object.keys(SP_IMPORT_COLUMNS) as Array<keyof typeof SP_IMPORT_COLUMNS>) {
              const v = normalized[name];
              if (v == null || v === "") continue;
              if (name === "eta" || name === "borderDate" || name === "docsSentDate") {
                patch[name] = isoDate(v);
              } else if (name === "dutyFee" || name === "transportFee") {
                const amt = Number(str(v).replace(/,/g, ""));
                if (!Number.isFinite(amt) || amt < 0 || amt > 1_000_000_000) throw new Error("Invalid logistics amount");
                patch[name] = String(amt);
              } else if (name === "freightStatus") {
                const canonical = ["Yes", "No", "Pending"].find((v) => v.toLowerCase() === str(normalized[name]).toLowerCase());
                if (!canonical) throw new Error("Freight status must be Yes, No or Pending");
                patch.freightStatus = canonical;
              } else if (name === "docReceived") {
                patch[name] = ["yes", "y", "true", "1"].includes(str(v).toLowerCase());
              } else if (name === "status") {
                const canonical = SP_GIT_STATUSES.find((status) => status.toLowerCase() === str(v).toLowerCase());
                if (!canonical) throw new Error("Invalid active GIT status (offload through the proper workflow)");
                patch.status = canonical;
              } else patch[name] = str(v);
            }
            if (Object.keys(patch).length === 0) {
              skipped++; continue;
            }
            const validated = updateContainerTrackingSchema.safeParse(patch);
            if (!validated.success) throw new Error("Invalid tracking data");
            const fields = Object.keys(patch) as Array<keyof typeof SP_IMPORT_COLUMNS>;
            const prior = firstRow<Record<string, unknown>>(await db.execute(sql`
              SELECT * FROM sp_container_git_tracking WHERE container_id = ${id} AND company_id = ${companyId} LIMIT 1
            `));
            const before: Record<string, unknown> = prior
              ? Object.fromEntries(fields.map((field) => [SP_IMPORT_COLUMNS[field], prior[SP_IMPORT_COLUMNS[field]] ?? null]))
              : { __spTrackingNotExisting: true };
            const assignments = fields.map((field) => sql`${sql.raw(SP_IMPORT_COLUMNS[field])} = ${patch[field] as string | boolean | null}`);
            await db.transaction(async (tx) => {
              await tx.execute(sql`INSERT INTO sp_container_git_tracking (container_id, company_id)
                VALUES (${id}, ${companyId}) ON CONFLICT (container_id) DO NOTHING`);
              await tx.execute(sql`UPDATE sp_container_git_tracking SET ${sql.join(assignments, sql`, `)},
                updated_at = now() WHERE container_id = ${id} AND company_id = ${companyId}`);
            });
            undoChanges.push({ id: -id, containerNumber: number, prevData: before });
            updated++;
          } catch (error) {
            skipped++; errors.push(`Row ${index + 2} (${number}): ${error instanceof Error ? error.message : "Invalid tracking data"}`);
          }
        }
        const importId = undoChanges.length ? randomUUID() : null;
        if (importId) {
          pruneImportUndoStore();
          importUndoStore.set(importId, { companyId, createdAt: Date.now(), changes: undoChanges });
        }
        return res.json({ updated, skipped, notFound, errors, importId });
      } catch (error) {
        logger.error("SP tracking Excel import failed", { companyId, error });
        return res.status(500).json({ message: "Unable to import Supplier Partner tracking Excel" });
      }
    },
  );

  app.post(
    "/api/git/sp-containers/import-excel/undo",
    requireAuth,
    requireRole("Admin", "Owner", "Developer"),
    async (req, res) => {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;
      const importId = String(req.body?.importId || "");
      const snapshot = importUndoStore.get(importId);
      if (!snapshot || snapshot.companyId !== companyId || snapshot.changes.some((entry) => entry.id >= 0)) {
        return res.status(404).json({ message: "Matching Supplier Partner import undo data not found or expired" });
      }
      try {
        let reverted = 0;
        for (const change of [...snapshot.changes].reverse()) {
          const id = -change.id;
          if (change.prevData.__spTrackingNotExisting === true) {
            await db.execute(sql`DELETE FROM sp_container_git_tracking WHERE container_id = ${id} AND company_id = ${companyId}`);
          } else {
            const assignments = Object.entries(change.prevData)
              .filter(([key]) => Object.values(SP_IMPORT_COLUMNS).includes(key as (typeof SP_IMPORT_COLUMNS)[keyof typeof SP_IMPORT_COLUMNS]))
              .map(([key, value]) => sql`${sql.raw(key)} = ${value as string | boolean | null}`);
            if (assignments.length > 0) await db.execute(sql`UPDATE sp_container_git_tracking SET
              ${sql.join(assignments, sql`, `)}, updated_at = now()
              WHERE container_id = ${id} AND company_id = ${companyId}`);
          }
          reverted++;
        }
        importUndoStore.delete(importId);
        return res.json({ reverted });
      } catch (error) {
        logger.error("SP tracking Excel undo failed", { companyId, error });
        return res.status(500).json({ message: "Unable to undo Supplier Partner tracking import" });
      }
    },
  );
}
