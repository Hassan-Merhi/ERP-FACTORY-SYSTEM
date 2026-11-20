// Extracted from ./registerFactorySheetsRoutes.ts
import { parseId } from "../../lib/parseId";
import { getErrorMessage } from "../../lib/httpHandlers";
import type { Express } from "express";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { factorySheets } from "@shared/schema";
import { and, asc, eq } from "drizzle-orm";
import type { WorkBook } from "xlsx-js-style";
import {
  readExcel,
  upload,
  upsertStatusSheet,
  writeExcel,
  xlsxUtils,
  type RawCell,
  type SRow,
} from "./factorySheetsRoutesBuildStatusSheet";
import { emptyBody, emptyQuery, stringIdParams, validateRequest, type RequestSchemas } from "../../lib/validateRequest";

const deleteSheetInput = { params: stringIdParams, query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

// Multipart upload of one .xlsx file; no form fields are read.
const importSheetsInput = { query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

export function registerFactorySheetsRoutesPart1(app: Express) {
  // ── Delete a sheet ─────────────────────────────────────────────────────────
  app.delete("/api/factory/sheets/:id", requireAuth, validateRequest(deleteSheetInput), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId!;
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });

      const [deleted] = await db
        .delete(factorySheets)
        .where(and(eq(factorySheets.id, id), eq(factorySheets.companyId, companyId)))
        .returning();

      if (!deleted) return res.status(404).json({ message: "Sheet not found" });
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── Import Excel — creates/replaces sheets from uploaded .xlsx ─────────────
  app.post(
    "/api/factory/sheets/import",
    requireAuth,
    upload.single("file"),
    validateRequest(importSheetsInput),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId!;
        if (!req.file) return res.status(400).json({ message: "No file uploaded" });

        const wb: WorkBook = readExcel(req.file.buffer, { type: "buffer", cellDates: true });

        // Delete all existing sheets for this company, then re-create
        await db.delete(factorySheets).where(eq(factorySheets.companyId, companyId));

        const created = [];
        for (let sheetIdx = 0; sheetIdx < wb.SheetNames.length; sheetIdx++) {
          const sheetName = wb.SheetNames[sheetIdx];
          const ws = wb.Sheets[sheetName];
          const rawData = xlsxUtils.sheet_to_json<RawCell[]>(ws, { header: 1, defval: null });

          if (!rawData || rawData.length === 0) {
            // Empty sheet — just create blank
            const [s] = await db
              .insert(factorySheets)
              .values({
                companyId,
                name: sheetName,
                orderIndex: sheetIdx,
                columns: [],
                rows: [],
              })
              .returning();
            created.push(s);
            continue;
          }

          // First row = column headers (skip empty leading cells in first col)
          const headerRow = rawData[0] ?? [];
          // Col 0 is the row-label column; cols 1..N are data columns
          const columns: string[] = headerRow.slice(1).map((h) => (h == null ? "" : String(h)));

          const rows: { label: string; cells: (number | string | null)[] }[] = [];
          for (let r = 1; r < rawData.length; r++) {
            const rawRow = rawData[r] ?? [];
            // Skip entirely empty rows
            const hasData = rawRow.some((v) => v !== null && v !== undefined && v !== "");
            if (!hasData) continue;

            const rawLabel = rawRow[0];
            let label: string;
            if (rawLabel == null) {
              label = "";
            } else if (rawLabel instanceof Date) {
              const y = rawLabel.getFullYear();
              const m = String(rawLabel.getMonth() + 1).padStart(2, "0");
              const d = String(rawLabel.getDate()).padStart(2, "0");
              label = `${y}-${m}-${d}`;
            } else {
              label = String(rawLabel).trim();
            }

            const cells: (number | string | null)[] = rawRow.slice(1).map((v) => {
              if (v === null || v === undefined || v === "") return null;
              if (v instanceof Date) {
                // Date in a data cell — format as ISO
                const y = v.getFullYear();
                const m = String(v.getMonth() + 1).padStart(2, "0");
                const d = String(v.getDate()).padStart(2, "0");
                return `${y}-${m}-${d}`;
              }
              const n = Number(v);
              // If it parses as a clean number, store as number; otherwise keep as string
              return isNaN(n) ? String(v).trim() : n;
            });
            // Pad or trim cells to match column count
            while (cells.length < columns.length) cells.push(null);
            rows.push({ label, cells: cells.slice(0, columns.length) });
          }

          const [s] = await db
            .insert(factorySheets)
            .values({
              companyId,
              name: sheetName,
              orderIndex: sheetIdx,
              columns,
              rows,
            })
            .returning();
          created.push(s);
        }

        // Build / rebuild STATUS sheet from the imported data
        const allSheets = await db
          .select()
          .from(factorySheets)
          .where(eq(factorySheets.companyId, companyId))
          .orderBy(asc(factorySheets.orderIndex), asc(factorySheets.id));

        await upsertStatusSheet(
          companyId,
          allSheets.map((s) => ({
            id: s.id,
            name: s.name,
            columns: (s.columns as string[]) ?? [],
            rows: (s.rows as SRow[]) ?? [],
            orderIndex: s.orderIndex,
          }))
        );

        // Return the final list including STATUS
        const finalSheets = await db
          .select()
          .from(factorySheets)
          .where(eq(factorySheets.companyId, companyId))
          .orderBy(asc(factorySheets.orderIndex), asc(factorySheets.id));

        res.json(finalSheets);
      } catch (err: unknown) {
        res.status(500).json({ message: getErrorMessage(err) });
      }
    }
  );

  // ── Template download ─────────────────────────────────────────────────────
  app.get("/api/factory/sheets/template", requireAuth, async (_req, res) => {
    try {
      const wb = xlsxUtils.book_new();

      // Sheet 1 — Production Tracking example
      const sheet1 = [
        ["Label", "Week 1", "Week 2", "Week 3", "Week 4"],
        ["Target", 150, 150, 150, 150],
        ["Actual", 120, 135, 140, 155],
        ["Variance", -30, -15, -10, 5],
      ];
      const ws1 = xlsxUtils.aoa_to_sheet(sheet1);
      ws1["!cols"] = [{ wch: 20 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
      xlsxUtils.book_append_sheet(wb, ws1, "Production Tracking");

      // Sheet 2 — Inventory example
      const sheet2 = [
        ["Label", "Mon", "Tue", "Wed", "Thu", "Fri"],
        ["Opening Stock", 500, 470, 490, 460, 480],
        ["Received", 100, 150, 80, 120, 90],
        ["Dispatched", 130, 130, 110, 100, 140],
        ["Closing Stock", 470, 490, 460, 480, 430],
      ];
      const ws2 = xlsxUtils.aoa_to_sheet(sheet2);
      ws2["!cols"] = [{ wch: 20 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
      xlsxUtils.book_append_sheet(wb, ws2, "Inventory");

      const buf: Buffer = writeExcel(wb, { type: "buffer", bookType: "xlsx" });
      res.setHeader("Content-Disposition", 'attachment; filename="factory-sheets-template.xlsx"');
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.send(buf);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
