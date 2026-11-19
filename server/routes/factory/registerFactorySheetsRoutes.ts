// Extracted from ./factorySheetsRoutes.ts to keep that module under the source-size cap.
import { parseId } from "../../lib/parseId";
import { getErrorMessage } from "../../lib/httpHandlers";
import type { Express } from "express";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { factorySheets } from "@shared/schema";
import { and, asc, eq } from "drizzle-orm";
import {
  STATUS_NAME,
  getCellRawValue,
  getColLabel,
  upsertStatusSheet,
  writeExcel,
  xlsxUtils,
  type SRow,
} from "./factorySheetsRoutesBuildStatusSheet";
import { registerFactorySheetsRoutesPart1 } from "./registerFactorySheetsRoutesPart1";

export function registerFactorySheetsRoutes(app: Express) {
  // ── List all sheets for current company ───────────────────────────────────
  app.get("/api/factory/sheets", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId!;
      const sheets = await db
        .select()
        .from(factorySheets)
        .where(eq(factorySheets.companyId, companyId))
        .orderBy(asc(factorySheets.orderIndex), asc(factorySheets.id));
      res.json(sheets);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── Create a new blank sheet ───────────────────────────────────────────────
  app.post("/api/factory/sheets", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId!;
      const { name } = req.body;
      if (!name?.trim()) return res.status(400).json({ message: "Sheet name is required" });

      const existing = await db
        .select({ orderIndex: factorySheets.orderIndex })
        .from(factorySheets)
        .where(eq(factorySheets.companyId, companyId))
        .orderBy(asc(factorySheets.orderIndex));

      const maxOrder = existing.length > 0 ? Math.max(...existing.map((r) => r.orderIndex)) : -1;

      const [created] = await db
        .insert(factorySheets)
        .values({
          companyId,
          name: name.trim(),
          orderIndex: maxOrder + 1,
          columns: [],
          rows: [],
        })
        .returning();

      res.status(201).json(created);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── Update a sheet (rename or save grid) ──────────────────────────────────
  app.put("/api/factory/sheets/:id", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId!;
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });

      const { name, columns, rows } = req.body;

      const updateData: Partial<typeof factorySheets.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (name !== undefined) updateData.name = name;
      if (columns !== undefined) updateData.columns = columns;
      if (rows !== undefined) updateData.rows = rows;

      const [updated] = await db
        .update(factorySheets)
        .set(updateData)
        .where(and(eq(factorySheets.id, id), eq(factorySheets.companyId, companyId)))
        .returning();

      if (!updated) return res.status(404).json({ message: "Sheet not found" });

      // If the saved sheet is a source sheet (not STATUS), recalculate STATUS
      if (updated.name.trim().toUpperCase() !== STATUS_NAME) {
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
      }

      res.json(updated);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  registerFactorySheetsRoutesPart1(app);

  // ── Export all sheets as styled .xlsx ─────────────────────────────────────
  app.get("/api/factory/sheets/export", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId!;
      const sheets = await db
        .select()
        .from(factorySheets)
        .where(eq(factorySheets.companyId, companyId))
        .orderBy(asc(factorySheets.orderIndex), asc(factorySheets.id));

      const wb = xlsxUtils.book_new();

      for (const sheet of sheets) {
        const rawColumns: unknown[] = Array.isArray(sheet.columns) ? sheet.columns : [];
        const rows = (sheet.rows as SRow[]) ?? [];
        const colLabels = rawColumns.map(getColLabel);

        // Build the 2D array: header row + data rows + difference row
        const headerRow = ["", ...colLabels];
        const dataRows = rows.map((r) => [r.label, ...r.cells.map((c) => getCellRawValue(c) ?? "")]);

        // Difference row = sum of all cells per column (using raw values)
        const diffCells = colLabels.map((_, colIdx) => {
          const sum = rows.reduce((acc, r) => {
            const v = getCellRawValue(r.cells[colIdx]);
            return acc + (typeof v === "number" ? v : 0);
          }, 0);
          return sum;
        });
        const diffRow = ["DIFFERENCE", ...diffCells];

        const aoa = [headerRow, ...dataRows, diffRow];
        const ws = xlsxUtils.aoa_to_sheet(aoa);

        // Column widths
        ws["!cols"] = [{ wch: 25 }, ...rawColumns.map(() => ({ wch: 16 }))];

        xlsxUtils.book_append_sheet(wb, ws, sheet.name.slice(0, 31));
      }

      // A company with no sheets left the workbook with no worksheets at all,
      // and the writer rejects that with "Workbook is empty" — a 500 for what
      // is simply an empty export. Emit a single "no data" sheet instead, the
      // way the report PDFs do, so the download still succeeds.
      if (sheets.length === 0) {
        const ws = xlsxUtils.aoa_to_sheet([["No sheets found for this company."]]);
        xlsxUtils.book_append_sheet(wb, ws, "Sheets");
      }

      const buf: Buffer = writeExcel(wb, { type: "buffer", bookType: "xlsx" });

      res.setHeader("Content-Disposition", 'attachment; filename="factory-sheets.xlsx"');
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.send(buf);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
