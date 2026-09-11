/**
 * GIT routes - Excel templates, the bulk container import, and its undo.
 *
 * Registered by ./index.ts in the same order as the original single file;
 * Express resolves first-match, so that order is behaviour.
 */
import type { Express, Request, Response, NextFunction } from "express";
import XLSX from "xlsx-js-style";
import ExcelJS from "exceljs";
import { randomUUID } from "crypto";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { containers } from "../../../shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { importUndoStore, UNDO_TTL_MS, gitUpload } from "./_helpers";

export function registerGitImportRoutes(app: Express) {
  // ─── ETA-only template — 2 columns: Container # + New ETA ───────────────

  app.get(
    "/api/git/containers/eta-template.xlsx",
    requireAuth,
    requireRole("Admin", "Owner", "Developer"),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        // Fetch all active containers for this company
        const rows = await db
          .select({
            containerNumber: containers.containerNumber,
            eta: containers.eta,
          })
          .from(containers)
          .where(
            and(
              eq(containers.companyId, companyId),
              sql`LOWER(${containers.status}) NOT IN ('offloaded','closed','completed')`
            )
          )
          .orderBy(containers.containerNumber);

        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet("ETA Update");

        // ── Header row ──────────────────────────────────────────────────────
        const headerRow = ws.addRow(["Container #", "New ETA"]);
        headerRow.eachCell((cell) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "1F4E79" } };
          cell.font = { bold: true, color: { argb: "FFFFFF" }, size: 12 };
          cell.alignment = { vertical: "middle", horizontal: "center" };
        });
        headerRow.height = 30;

        // ── Hint row ────────────────────────────────────────────────────────
        const hintRow = ws.addRow([
          "Do not edit — used to match",
          "Enter any date format: 13/06/2026  or  2026-06-13  or  13-06-2026",
        ]);
        hintRow.getCell(1).font = { italic: true, color: { argb: "888888" }, size: 9 };
        hintRow.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "F5F5F5" } };
        hintRow.getCell(2).font = { italic: true, color: { argb: "888888" }, size: 9 };
        hintRow.getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDE7" } };

        // ── Data rows — one per active container ────────────────────────────
        rows.forEach((r, i) => {
          const row = ws.addRow([r.containerNumber, ""]);
          const bg = i % 2 === 0 ? "FFFFFF" : "F0F4FA";
          // Container # cell — grey, locked-looking
          row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: bg } };
          row.getCell(1).font = { color: { argb: "333333" } };
          // New ETA cell — yellow highlight so user knows to fill it
          row.getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDE7" } };
          row.getCell(2).font = { bold: true };
        });

        // ── Column widths ───────────────────────────────────────────────────
        ws.getColumn(1).width = 24;
        ws.getColumn(2).width = 36;

        // ── Freeze header rows ──────────────────────────────────────────────
        ws.views = [{ state: "frozen", ySplit: 2 }];

        const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="eta_update_${today}.xlsx"`);
        const buf = Buffer.from(await wb.xlsx.writeBuffer());
        res.send(buf);
      } catch (err: unknown) {
        logger.error("[ETA template]", { error: err });
        res.status(500).json({ message: getErrorMessage(err) });
      }
    }
  );

  // ─── Excel import template ────────────────────────────────────────────────

  app.get(
    "/api/git/containers/import-template.xlsx",
    requireAuth,
    requireRole("Admin", "Owner", "Developer"),
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet("Containers");

        const headers = [
          "Container #",
          "Status",
          "Plate / Truck #",
          "ETA (YYYY-MM-DD)",
          "Border Date (YYYY-MM-DD)",
          "Transporter",
          "Location",
          "Agent",
          "Duty Fee",
          "Transport Fee",
          "Freight Status",
          "Docs Received",
          "Docs Sent Date (YYYY-MM-DD)",
          "Tracking Link",
          "Tracking Description",
          "Tracking Enabled",
          "Tracking Carrier Hint",
          "Shop Name",
        ];

        // Header row — dark blue
        const headerRow = ws.addRow(headers);
        headerRow.eachCell((cell) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "1F4E79" } };
          cell.font = { bold: true, color: { argb: "FFFFFF" }, size: 11 };
          cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
          cell.border = {
            bottom: { style: "thin", color: { argb: "FFFFFF" } },
          };
        });
        headerRow.height = 28;

        // Hint row — light grey, italic
        const hints = [
          "Required — used to match",
          "OTW / Sea / At Port / Left Dar / At Border / In Transit / Arrived",
          "e.g. T840 EFX",
          "YYYY-MM-DD",
          "YYYY-MM-DD",
          "",
          "e.g. NAKONDE",
          "",
          "number",
          "number",
          "Yes / No / Pending",
          "Yes / No",
          "YYYY-MM-DD",
          "https://…",
          "",
          "Yes / No — enable ParcelsApp auto-tracking",
          "e.g. MAERSK, MSC, COSCO — leave blank to auto-detect",
          "e.g. ABC SHOP",
        ];
        const hintRow = ws.addRow(hints);
        hintRow.eachCell((cell) => {
          if (cell.value) {
            cell.font = { italic: true, color: { argb: "888888" }, size: 9 };
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "F5F5F5" } };
          }
        });

        // Example row 1
        const ex1 = ws.addRow([
          "MSKU1234567",
          "In Transit",
          "T840 EFX",
          "2026-05-20",
          "2026-05-15",
          "FARHAT",
          "NAKONDE",
          "NCA",
          "8500",
          "1200",
          "Yes",
          "Yes",
          "2026-05-10",
          "",
          "Cleared border — heading inland",
          "Yes",
          "MAERSK",
          "ABC SHOP",
        ]);
        ex1.eachCell((cell) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDE7" } };
          cell.font = { italic: true, color: { argb: "5D4037" } };
        });

        // Example row 2
        const ex2 = ws.addRow([
          "TCNU9876543",
          "At Port",
          "",
          "2026-05-25",
          "",
          "CONTINENTAL",
          "LEFT DAR",
          "FARHAT AGENCY",
          "8500",
          "",
          "Pending",
          "No",
          "",
          "",
          "Awaiting customs clearance",
          "No",
          "",
          "XYZ STORE",
        ]);
        ex2.eachCell((cell) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDE7" } };
          cell.font = { italic: true, color: { argb: "5D4037" } };
        });

        // Add a note in the first example cell
        ex1.getCell(1).font = { bold: true, italic: true, color: { argb: "5D4037" } };
        ex1.getCell(1).note = "Example row — delete before importing";

        // Column widths (18 columns)
        const colWidths = [20, 28, 18, 20, 20, 18, 16, 18, 12, 14, 14, 14, 24, 30, 35, 14, 22, 20];
        colWidths.forEach((w, i) => {
          ws.getColumn(i + 1).width = w;
        });

        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", 'attachment; filename="container_import_template.xlsx"');
        const buf = Buffer.from(await wb.xlsx.writeBuffer());
        res.send(buf);
      } catch (err: unknown) {
        logger.error("[GIT import template]", { error: err });
        res.status(500).json({ message: getErrorMessage(err) });
      }
    }
  );

  // ─── Excel bulk import / update ───────────────────────────────────────────

  app.post(
    "/api/git/containers/import-excel",
    requireAuth,
    requireRole("Admin", "Owner", "Developer"),
    (req: Request, res: Response, next: NextFunction) => {
      gitUpload.single("file")(req, res, (err) => {
        if (!err) return next();
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({ message: "File too large. Maximum allowed size is 10 MB." });
        }
        return res.status(400).json({ message: err.message || "Invalid file upload." });
      });
    },
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        if (!req.file) return res.status(400).json({ message: "No file uploaded" });
        if (!req.session.currentCompanyId) {
          return res.status(400).json({ message: "No company selected" });
        }

        const workbook = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
        // Prefer a sheet named "Containers" (case-insensitive), fallback to first sheet
        const sheetName = workbook.SheetNames.find((n) => n.toLowerCase() === "containers") ?? workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        // No range override — let sheet_to_json use the first row (the real header row) as
        // column names. The hint row (row 2) and the two example rows are caught later by
        // the knownExamples set and the "required / used to match" text check below.
        const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });

        /** Convert any value to a plain string — handles JS Date objects from Excel */
        function toStr(v: unknown): string {
          if (v === null || v === undefined) return "";
          if (v instanceof Date) {
            // Format as YYYY-MM-DD in UTC to avoid timezone shifts
            const y = v.getUTCFullYear();
            const m = String(v.getUTCMonth() + 1).padStart(2, "0");
            const d = String(v.getUTCDate()).padStart(2, "0");
            return `${y}-${m}-${d}`;
          }
          return String(v).trim();
        }

        /**
         * For optional text fields: treats numeric 0 (Excel blank) as empty string.
         */
        function toOptStr(v: unknown): string {
          if (v === null || v === undefined || v === 0 || v === "") return "";
          const s = String(v).trim();
          return s === "0" ? "" : s;
        }

        /**
         * Convert a value to a YYYY-MM-DD date string.
         * Handles JS Date objects, properly-formatted strings, AND Excel serial numbers
         * (which appear as plain integers like 46043 when the cell has no date format).
         * Treats 0 / "0" / blank as empty (Excel stores empty date cells as 0).
         */
        function toDateStr(v: unknown): string {
          // Numeric 0 = blank date cell in Excel
          if (v === null || v === undefined || v === "" || v === 0) return "";
          if (v instanceof Date) {
            const y = v.getUTCFullYear();
            const m = String(v.getUTCMonth() + 1).padStart(2, "0");
            const d = String(v.getUTCDate()).padStart(2, "0");
            return `${y}-${m}-${d}`;
          }
          const s = String(v).trim();
          if (!s || s === "0") return "";
          // Already a valid ISO date (YYYY-MM-DD)
          if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
          // DD/MM/YYYY or D/M/YYYY (most common non-ISO format for this region)
          const dmySlash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
          if (dmySlash) {
            const dd = String(dmySlash[1]).padStart(2, "0");
            const mm = String(dmySlash[2]).padStart(2, "0");
            const yyyy = dmySlash[3];
            const d2 = new Date(`${yyyy}-${mm}-${dd}`);
            if (!isNaN(d2.getTime())) return `${yyyy}-${mm}-${dd}`;
          }
          // DD-MM-YYYY or D-M-YYYY
          const dmyDash = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
          if (dmyDash) {
            const dd = String(dmyDash[1]).padStart(2, "0");
            const mm = String(dmyDash[2]).padStart(2, "0");
            const yyyy = dmyDash[3];
            const d2 = new Date(`${yyyy}-${mm}-${dd}`);
            if (!isNaN(d2.getTime())) return `${yyyy}-${mm}-${dd}`;
          }
          // DD.MM.YYYY
          const dmyDot = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
          if (dmyDot) {
            const dd = String(dmyDot[1]).padStart(2, "0");
            const mm = String(dmyDot[2]).padStart(2, "0");
            const yyyy = dmyDot[3];
            const d2 = new Date(`${yyyy}-${mm}-${dd}`);
            if (!isNaN(d2.getTime())) return `${yyyy}-${mm}-${dd}`;
          }
          // Excel serial number (e.g. 46043 → 2026-02-07)
          const n = Number(s);
          if (!isNaN(n) && Number.isInteger(n) && n > 1000 && n < 200000) {
            try {
              const parsed = XLSX.SSF.parse_date_code(n);
              if (parsed && parsed.y > 1900 && parsed.y < 2100) {
                const mm = String(parsed.m).padStart(2, "0");
                const dd = String(parsed.d).padStart(2, "0");
                return `${parsed.y}-${mm}-${dd}`;
              }
            } catch {
              /* fall through */
            }
          }
          return s;
        }

        // Normalise column header → internal key
        const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
        const COL: Record<string, string> = {
          container: "containerNumber",
          containerno: "containerNumber",
          containernum: "containerNumber",
          containernumber: "containerNumber",
          status: "status",
          platetruckno: "numberPlate",
          platetruck: "numberPlate",
          plate: "numberPlate",
          numberplate: "numberPlate",
          truck: "numberPlate",
          trucknumber: "numberPlate",
          plateno: "numberPlate",
          eta: "eta",
          etayyyymmdd: "eta",
          neweta: "eta",
          newetayyyymmdd: "eta",
          newarrivaldate: "eta",
          arrivaldate: "eta",
          borderdate: "borderDate",
          borderdateyyyymmdd: "borderDate",
          transporter: "transporter",
          location: "trackingLocation",
          trackinglocation: "trackingLocation",
          agent: "agent",
          dutyfee: "dutyFee",
          duty: "dutyFee",
          transportfee: "transportFee",
          trackingdescription: "trackingDescription",
          description: "trackingDescription",
          freightstatus: "freightStatus",
          freight: "freightStatus",
          docsreceived: "docReceived",
          docs: "docReceived",
          docreceived: "docReceived",
          documentsreceived: "docReceived",
          docssentdate: "docsSentDate",
          docssentdateyyyymmdd: "docsSentDate",
          docssent: "docsSentDate",
          sentdate: "docsSentDate",
          trackinglink: "trackingLink",
          link: "trackingLink",
          tracklink: "trackingLink",
          trackingenabled: "trackingEnabled",
          autotrackingenabled: "trackingEnabled",
          autotracking: "trackingEnabled",
          tracking: "trackingEnabled",
          trackingon: "trackingEnabled",
          trackon: "trackingEnabled",
          trackingcarrierhint: "trackingCarrierHint",
          carrierhint: "trackingCarrierHint",
          carrier: "trackingCarrierHint",
          shippingline: "trackingCarrierHint",
          shippingcarrier: "trackingCarrierHint",
          shopname: "shopName",
          shop: "shopName",
          store: "shopName",
          storename: "shopName",
          clientshop: "shopName",
        };

        // Status values — stored with exact casing; compare case-insensitively so
        // user input like "otw" or "AT PORT" still works.
        const STATUS_CANONICAL: Record<string, string> = {};
        for (const s of [
          "OTW",
          "Sea",
          "At Port",
          "Left Dar",
          "At Border",
          "In Transit",
          "Arrived",
          "Offloaded",
          "Closed",
          "Completed",
        ]) {
          STATUS_CANONICAL[s.toLowerCase()] = s;
        }
        const VALID_FREIGHT = new Set(["Yes", "No", "Pending"]);

        // Fetch all containers accessible to this session company
        const allContainers = await db
          .select({ id: containers.id, containerNumber: containers.containerNumber, companyId: containers.companyId })
          .from(containers)
          .where(eq(containers.companyId, req.session.currentCompanyId));

        const byNumber = new Map(allContainers.map((c) => [c.containerNumber.trim().toUpperCase(), c]));

        let updated = 0;
        let skipped = 0;
        let notFound = 0;
        const errors: string[] = [];
        const undoChanges: Array<{ id: number; containerNumber: string; prevData: Record<string, unknown> }> = [];

        for (let i = 0; i < rawRows.length; i++) {
          const raw = rawRows[i];
          // Sheet row number = 1 (header) + 1 (hint row) + i + 1 (1-based) = i + 3
          const rowNum = i + 3;

          // Build two maps from each raw column:
          //   rawMap  — raw cell value (for date/number fields that need special parsing)
          //   row     — string representation of each mapped field (for text/status fields)
          const rawMap: Record<string, unknown> = {};
          const row: Record<string, string> = {};
          for (const [rawKey, rawVal] of Object.entries(raw)) {
            const mapped = COL[norm(rawKey)];
            if (mapped) {
              rawMap[mapped] = rawVal;
              row[mapped] = toStr(rawVal);
            }
          }

          // ── Container number is the only required field ──────────────────────
          const ctrNum = row.containerNumber?.trim().toUpperCase() ?? "";

          // Skip blank rows
          if (!ctrNum) {
            skipped++;
            continue;
          }

          // Skip example/hint rows: the template ships with a hint row (row 2) that
          // says "Required — used to match" and two example data rows (MSKU…/TCNU…).
          // Detect any row whose container-number cell is obviously descriptive text.
          const knownExamples = new Set(["MSKU1234567", "TCNU9876543"]);
          if (knownExamples.has(ctrNum)) {
            skipped++;
            continue;
          }
          const lowerCtr = ctrNum.toLowerCase();
          if (
            lowerCtr.includes("required") ||
            lowerCtr.includes("used to match") ||
            lowerCtr.includes("container #") ||
            lowerCtr.includes("yyyy-mm-dd") ||
            lowerCtr.startsWith("e.g")
          ) {
            skipped++;
            continue;
          }

          const match = byNumber.get(ctrNum);
          if (!match) {
            notFound++;
            errors.push(`Row ${rowNum}: "${ctrNum}" not found in system`);
            continue;
          }

          const updateData: Record<string, unknown> = {};

          // ── Status (optional, case-insensitive) ─────────────────────────────
          const statusVal = toOptStr(rawMap.status);
          if (statusVal) {
            const canonical = STATUS_CANONICAL[statusVal.toLowerCase()];
            if (!canonical) {
              errors.push(
                `Row ${rowNum} (${ctrNum}): invalid status "${statusVal}" — valid values: ${Object.values(STATUS_CANONICAL).join(", ")}`
              );
              skipped++;
              continue;
            }
            updateData.status = canonical;
          }

          // ── Optional text fields: 0 / "0" treated as blank ──────────────────
          const numberPlate = toOptStr(rawMap.numberPlate);
          if (numberPlate) updateData.numberPlate = numberPlate;

          const transporter = toOptStr(rawMap.transporter);
          if (transporter) updateData.transporter = transporter;

          const trackingLocation = toOptStr(rawMap.trackingLocation);
          if (trackingLocation) updateData.trackingLocation = trackingLocation;

          const agent = toOptStr(rawMap.agent);
          if (agent) updateData.agent = agent;

          const trackingDescription = toOptStr(rawMap.trackingDescription);
          if (trackingDescription) updateData.trackingDescription = trackingDescription;

          const trackingLink = toOptStr(rawMap.trackingLink);
          if (trackingLink) updateData.trackingLink = trackingLink;

          const trackingCarrierHint = toOptStr(rawMap.trackingCarrierHint);
          if (trackingCarrierHint) updateData.trackingCarrierHint = trackingCarrierHint;

          const shopName = toOptStr(rawMap.shopName);
          if (shopName) updateData.shopName = shopName;

          // ── Date fields: serial numbers + blanks safely handled ──────────────
          const etaDate = toDateStr(rawMap.eta);
          if (etaDate) updateData.eta = etaDate;

          const borderDate = toDateStr(rawMap.borderDate);
          if (borderDate) updateData.borderDate = borderDate;

          const docsSentDate = toDateStr(rawMap.docsSentDate);
          if (docsSentDate) updateData.docsSentDate = docsSentDate;

          // ── Numeric money fields: 0 is a valid value ─────────────────────────
          if (rawMap.dutyFee !== undefined && rawMap.dutyFee !== "") {
            const n = parseFloat(String(rawMap.dutyFee));
            if (!isNaN(n)) updateData.dutyFee = n.toString();
          }
          if (rawMap.transportFee !== undefined && rawMap.transportFee !== "") {
            const n = parseFloat(String(rawMap.transportFee));
            if (!isNaN(n)) updateData.transportFee = n.toString();
          }

          // ── Freight status (optional) ─────────────────────────────────────────
          const freightStatus = toOptStr(rawMap.freightStatus);
          if (freightStatus && VALID_FREIGHT.has(freightStatus)) {
            updateData.freightStatus = freightStatus;
          }

          // ── Docs Received: YES/Y/1/true → true, NO/N/0/false/blank → false ───
          if (rawMap.docReceived !== undefined) {
            const v = String(rawMap.docReceived).trim().toLowerCase();
            if (v === "yes" || v === "y" || v === "true" || v === "1") {
              updateData.docReceived = true;
            } else if (v === "no" || v === "n" || v === "false" || v === "0" || v === "") {
              updateData.docReceived = false;
            }
          }

          // ── Tracking enabled ─────────────────────────────────────────────────
          if (rawMap.trackingEnabled !== undefined && rawMap.trackingEnabled !== "") {
            const v = String(rawMap.trackingEnabled).trim().toLowerCase();
            if (v === "yes" || v === "y" || v === "true" || v === "1" || v === "on") {
              updateData.trackingEnabled = true;
            } else if (v === "no" || v === "n" || v === "false" || v === "0" || v === "off") {
              updateData.trackingEnabled = false;
            }
          }

          // When ETA is set via import, mark it as manual so ParcelsApp doesn't overwrite it immediately
          if (updateData.eta) updateData.etaSource = "manual";

          if (Object.keys(updateData).length === 0) {
            errors.push(
              `Row ${rowNum} (${ctrNum}): no fields to update — fill in at least one column besides Container # (Status, ETA, Location, etc.)`
            );
            skipped++;
            continue;
          }

          // Capture "before" snapshot for undo (only keys we're about to overwrite)
          const prevData: Record<string, unknown> = {};
          const [current] = await db.select().from(containers).where(eq(containers.id, match.id)).limit(1);
          if (current) {
            for (const key of Object.keys(updateData)) {
              prevData[key] = (current as { [key: string]: unknown })[key] ?? null;
            }
          }

          await db.update(containers).set(updateData).where(eq(containers.id, match.id));
          undoChanges.push({ id: match.id, containerNumber: ctrNum, prevData });
          updated++;
        }

        // Store undo snapshot
        const importId = randomUUID();
        // Expire old entries (> 2h)
        for (const [k, v] of importUndoStore) {
          if (Date.now() - v.createdAt > UNDO_TTL_MS) importUndoStore.delete(k);
        }
        if (undoChanges.length > 0) {
          importUndoStore.set(importId, {
            companyId: req.session.currentCompanyId,
            createdAt: Date.now(),
            changes: undoChanges,
          });
        }

        res.json({ updated, skipped, notFound, errors, importId: undoChanges.length > 0 ? importId : null });
      } catch (err: unknown) {
        logger.error("[GIT import excel]", { error: err });
        res.status(500).json({ message: getErrorMessage(err) });
      }
    }
  );

  // ─── Undo last Excel import ───────────────────────────────────────────────
  app.post(
    "/api/git/containers/import-excel/undo",
    requireAuth,
    requireRole("Admin", "Owner", "Developer"),
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const { importId } = req.body ?? {};
        if (!importId || typeof importId !== "string") {
          return res.status(400).json({ message: "importId required" });
        }
        const snap = importUndoStore.get(importId);
        if (!snap) {
          return res
            .status(404)
            .json({ message: "Undo data not found — it may have expired (2 hr limit) or already been used." });
        }
        if (snap.companyId !== req.session.currentCompanyId) {
          return res.status(403).json({ message: "Forbidden" });
        }

        let reverted = 0;
        for (const change of snap.changes) {
          if (Object.keys(change.prevData).length === 0) continue;
          await db.update(containers).set(change.prevData).where(eq(containers.id, change.id));
          reverted++;
        }

        // Remove the undo snapshot so it can't be used twice
        importUndoStore.delete(importId);

        res.json({ reverted });
      } catch (err: unknown) {
        logger.error("[GIT import undo]", { error: err });
        res.status(500).json({ message: getErrorMessage(err) });
      }
    }
  );
}
