import { parseId } from "../../lib/parseId";
import { getErrorMessage } from "../../lib/httpHandlers";
import type { Express } from "express";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { isRecord } from "@shared/typeGuards";
import { statusBuilderSheets } from "@shared/schema";
import { eq, and, asc } from "drizzle-orm";
import { spreadsheetUpload } from "../helpers/uploadHelpers";
import xlsxStyle from "xlsx-js-style";
import type { WorkBook } from "xlsx-js-style";
import {
  registerFactoryStatusBuilderSheetsRoutesPart1,
  getColLabel,
  type SRow,
} from "./registerFactoryStatusBuilderSheetsRoutesPart1";

const { read: readExcel, utils: xlsxUtils, write: writeExcel } = xlsxStyle;

const upload = spreadsheetUpload;

type CellVal = number | string | null;

function getCellRawValue(cell: unknown): CellVal {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === "number" || typeof cell === "string") return cell;
  if (isRecord(cell) && "value" in cell) {
    const value = cell.value;
    return typeof value === "number" || typeof value === "string" ? value : null;
  }
  return null;
}

export function registerFactoryStatusBuilderSheetsRoutes(app: Express) {
  registerFactoryStatusBuilderSheetsRoutesPart1(app);

  // ── Delete a sheet ─────────────────────────────────────────────────────────
  app.delete("/api/factory/status-builder/sheets/:id", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId!;
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });

      const [deleted] = await db
        .delete(statusBuilderSheets)
        .where(and(eq(statusBuilderSheets.id, id), eq(statusBuilderSheets.companyId, companyId)))
        .returning();

      if (!deleted) return res.status(404).json({ message: "Sheet not found" });
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── Import Excel ───────────────────────────────────────────────────────────
  app.post("/api/factory/status-builder/sheets/import", requireAuth, upload.single("file"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId!;
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });

      const wb: WorkBook = readExcel(req.file.buffer, { type: "buffer", cellDates: true });

      await db.delete(statusBuilderSheets).where(eq(statusBuilderSheets.companyId, companyId));

      const created = [];
      for (let sheetIdx = 0; sheetIdx < wb.SheetNames.length; sheetIdx++) {
        const sheetName = wb.SheetNames[sheetIdx];
        const ws = wb.Sheets[sheetName];
        const rawData = xlsxUtils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null });

        if (!rawData || rawData.length === 0) {
          const [s] = await db
            .insert(statusBuilderSheets)
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

        const headerRow = rawData[0] ?? [];
        const columns: string[] = headerRow.slice(1).map((h) => (h == null ? "" : String(h)));

        const rows: { label: string; cells: (number | string | null)[] }[] = [];
        for (let r = 1; r < rawData.length; r++) {
          const rawRow = rawData[r] ?? [];
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
              const y = v.getFullYear();
              const m = String(v.getMonth() + 1).padStart(2, "0");
              const d = String(v.getDate()).padStart(2, "0");
              return `${y}-${m}-${d}`;
            }
            const n = Number(v);
            return isNaN(n) ? String(v).trim() : n;
          });
          while (cells.length < columns.length) cells.push(null);
          rows.push({ label, cells: cells.slice(0, columns.length) });
        }

        const [s] = await db
          .insert(statusBuilderSheets)
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

      const finalSheets = await db
        .select()
        .from(statusBuilderSheets)
        .where(eq(statusBuilderSheets.companyId, companyId))
        .orderBy(asc(statusBuilderSheets.orderIndex), asc(statusBuilderSheets.id));

      res.json(finalSheets);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── Template download ──────────────────────────────────────────────────────
  app.get("/api/factory/status-builder/sheets/template", requireAuth, async (_req, res) => {
    try {
      const wb = xlsxUtils.book_new();

      const sheet1 = [
        ["Label", "Week 1", "Week 2", "Week 3", "Week 4"],
        ["Target", 150, 150, 150, 150],
        ["Actual", 120, 135, 140, 155],
        ["Variance", -30, -15, -10, 5],
      ];
      const ws1 = xlsxUtils.aoa_to_sheet(sheet1);
      ws1["!cols"] = [{ wch: 20 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
      xlsxUtils.book_append_sheet(wb, ws1, "Status Overview");

      const buf: Buffer = writeExcel(wb, { type: "buffer", bookType: "xlsx" });
      res.setHeader("Content-Disposition", 'attachment; filename="status-builder-template.xlsx"');
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.send(buf);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── Export all sheets as .xlsx ─────────────────────────────────────────────
  app.get("/api/factory/status-builder/sheets/export", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId!;
      const sheets = await db
        .select()
        .from(statusBuilderSheets)
        .where(eq(statusBuilderSheets.companyId, companyId))
        .orderBy(asc(statusBuilderSheets.orderIndex), asc(statusBuilderSheets.id));

      const wb = xlsxUtils.book_new();

      for (const sheet of sheets) {
        const rawColumns: unknown[] = Array.isArray(sheet.columns) ? sheet.columns : [];
        const rows = (sheet.rows as SRow[]) ?? [];
        const colLabels = rawColumns.map(getColLabel);

        const headerRow = ["", ...colLabels];
        const dataRows = rows.map((r) => [r.label, ...r.cells.map((c) => getCellRawValue(c) ?? "")]);

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
        ws["!cols"] = [{ wch: 25 }, ...colLabels.map(() => ({ wch: 16 }))];
        xlsxUtils.book_append_sheet(wb, ws, sheet.name.slice(0, 31));
      }

      // A company with no sheets left the workbook with no worksheets at all,
      // and the writer rejects that with "Workbook is empty" — a 500 for what
      // is simply an empty export. Emit a single "no data" sheet instead, the
      // way the report PDFs do, so the download still succeeds.
      if (sheets.length === 0) {
        const ws = xlsxUtils.aoa_to_sheet([["No status-builder sheets found for this company."]]);
        xlsxUtils.book_append_sheet(wb, ws, "Sheets");
      }

      const buf: Buffer = writeExcel(wb, { type: "buffer", bookType: "xlsx" });
      res.setHeader("Content-Disposition", 'attachment; filename="status-builder.xlsx"');
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.send(buf);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
