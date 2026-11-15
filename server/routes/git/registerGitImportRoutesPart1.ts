// Extracted from ./gitImportRoutes.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import ExcelJS from "exceljs";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { containers } from "../../../shared/schema";
import { and, eq, sql } from "drizzle-orm";

export function registerGitImportRoutesPart1(app: Express) {
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
          "XYZ STORE",
        ]);
        ex2.eachCell((cell) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDE7" } };
          cell.font = { italic: true, color: { argb: "5D4037" } };
        });

        // Add a note in the first example cell
        ex1.getCell(1).font = { bold: true, italic: true, color: { argb: "5D4037" } };
        ex1.getCell(1).note = "Example row — delete before importing";

        // Column widths (16 columns)
        const colWidths = [20, 28, 18, 20, 20, 18, 16, 18, 12, 14, 14, 14, 24, 30, 35, 20];
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
}
