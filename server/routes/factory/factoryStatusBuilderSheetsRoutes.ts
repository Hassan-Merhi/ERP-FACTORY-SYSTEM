import { parseId, parseOptionalId } from "../../lib/parseId";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import type { Express } from "express";
import { db, pool } from "../../db";
import { requireAuth } from "../../auth";
import { isRecord } from "@shared/typeGuards";
import { statusBuilderSheets } from "@shared/schema";
import { eq, and, asc } from "drizzle-orm";
import multer from "multer";
import xlsxStyle from "xlsx-js-style";
import type { WorkBook } from "xlsx-js-style";

const { read: readExcel, utils: xlsxUtils, write: writeExcel } = xlsxStyle;

const upload = multer({ storage: multer.memoryStorage() });

type CellVal = number | string | null;
type SRow = { id?: string; label: string; cells: unknown[] };

function getColLabel(col: unknown): string {
  if (typeof col === "string") return col;
  if (!isRecord(col)) return "";
  const label = col.label;
  return label === null || label === undefined ? "" : String(label);
}

function getCellRawValue(cell: unknown): CellVal {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === "number" || typeof cell === "string") return cell;
  if (isRecord(cell) && "value" in cell) {
    const value = cell.value;
    return typeof value === "number" || typeof value === "string" ? value : null;
  }
  return null;
}

// Human-readable representation of a cell for the history log: manual values
// are shown as-is, linked cells are shown as "→ linked" since the resolved
// number lives on another sheet and isn't meaningful to diff here.
function describeCellForLog(cell: unknown): string {
  if (isRecord(cell) && "value" in cell) {
    if (cell.link) return "→ linked";
    return cell.value === null || cell.value === undefined ? "" : String(cell.value);
  }
  return cell === null || cell === undefined ? "" : String(cell);
}

async function logStatusBuilderChanges(
  companyId: number,
  sheetId: number,
  sheetName: string,
  oldRows: SRow[],
  oldColumns: unknown[],
  newRows: SRow[],
  newColumns: unknown[],
  changedBy: string | undefined
) {
  const colLabels = newColumns.map(getColLabel);
  const oldById = new Map((oldRows || []).map((r) => [r.id, r]));
  const entries: { rowLabel: string; columnLabel: string; oldValue: string; newValue: string }[] = [];

  for (const newRow of newRows || []) {
    const oldRow = newRow.id ? oldById.get(newRow.id) : undefined;
    if (!oldRow) {
      // Brand new row — log it once as a whole, not per cell.
      entries.push({ rowLabel: newRow.label || "(row)", columnLabel: "(new row)", oldValue: "", newValue: "added" });
      continue;
    }
    if ((oldRow.label || "") !== (newRow.label || "")) {
      entries.push({
        rowLabel: newRow.label || "(row)",
        columnLabel: "(label)",
        oldValue: oldRow.label || "",
        newValue: newRow.label || "",
      });
    }
    const cellCount = Math.max(newRow.cells?.length ?? 0, oldRow.cells?.length ?? 0);
    for (let ci = 0; ci < cellCount; ci++) {
      const oldDesc = describeCellForLog(oldRow.cells?.[ci]);
      const newDesc = describeCellForLog(newRow.cells?.[ci]);
      if (oldDesc !== newDesc) {
        entries.push({
          rowLabel: newRow.label || "(row)",
          columnLabel: colLabels[ci] || `Column ${ci + 1}`,
          oldValue: oldDesc,
          newValue: newDesc,
        });
      }
    }
  }
  for (const oldRow of oldRows || []) {
    if (!newRows?.some((r) => r.id === oldRow.id)) {
      entries.push({
        rowLabel: oldRow.label || "(row)",
        columnLabel: "(row)",
        oldValue: "present",
        newValue: "deleted",
      });
    }
  }

  if (entries.length === 0) return;

  for (const e of entries) {
    await pool.query(
      `INSERT INTO factory_status_builder_log
         (company_id, sheet_id, sheet_name, row_label, column_label, old_value, new_value, changed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [companyId, sheetId, sheetName, e.rowLabel, e.columnLabel, e.oldValue, e.newValue, changedBy ?? null]
    );
  }
}

export function registerFactoryStatusBuilderSheetsRoutes(app: Express) {
  // ── List all sheets ────────────────────────────────────────────────────────
  app.get("/api/factory/status-builder/sheets", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId!;
      const sheets = await db
        .select()
        .from(statusBuilderSheets)
        .where(eq(statusBuilderSheets.companyId, companyId))
        .orderBy(asc(statusBuilderSheets.orderIndex), asc(statusBuilderSheets.id));
      res.json(sheets);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── Create a new blank sheet ───────────────────────────────────────────────
  app.post("/api/factory/status-builder/sheets", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId!;
      const { name } = req.body;
      if (!name?.trim()) return res.status(400).json({ message: "Sheet name is required" });

      const existing = await db
        .select({ orderIndex: statusBuilderSheets.orderIndex })
        .from(statusBuilderSheets)
        .where(eq(statusBuilderSheets.companyId, companyId))
        .orderBy(asc(statusBuilderSheets.orderIndex));

      const maxOrder = existing.length > 0 ? Math.max(...existing.map((r) => r.orderIndex)) : -1;

      const [created] = await db
        .insert(statusBuilderSheets)
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

  // ── Update a sheet ─────────────────────────────────────────────────────────
  app.put("/api/factory/status-builder/sheets/:id", requireAuth, async (req: import("express").Request, res) => {
    try {
      const companyId = req.session.currentCompanyId!;
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });

      const { name, columns, rows } = req.body;

      const [existing] = await db
        .select()
        .from(statusBuilderSheets)
        .where(and(eq(statusBuilderSheets.id, id), eq(statusBuilderSheets.companyId, companyId)));
      if (!existing) return res.status(404).json({ message: "Sheet not found" });

      const updateData: Partial<typeof statusBuilderSheets.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (name !== undefined) updateData.name = name;
      if (columns !== undefined) updateData.columns = columns;
      if (rows !== undefined) updateData.rows = rows;

      const [updated] = await db
        .update(statusBuilderSheets)
        .set(updateData)
        .where(and(eq(statusBuilderSheets.id, id), eq(statusBuilderSheets.companyId, companyId)))
        .returning();

      if (!updated) return res.status(404).json({ message: "Sheet not found" });

      if (rows !== undefined) {
        logStatusBuilderChanges(
          companyId,
          id,
          updated.name,
          (existing.rows as SRow[]) ?? [],
          Array.isArray(existing.columns) ? (existing.columns as unknown[]) : [],
          rows as SRow[],
          columns ?? existing.columns,
          req.user?.username
        ).catch((e) => logger.error("[StatusBuilder] history log failed:", { error: e.message }));
      }

      res.json(updated);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── Change history log ─────────────────────────────────────────────────────
  app.get("/api/factory/status-builder/log", requireAuth, async (req: import("express").Request, res) => {
    try {
      const companyId = req.session.currentCompanyId!;
      const sheetId = parseOptionalId(req.query.sheetId as string | undefined);
      const limit = Math.min(parseInt((req.query.limit as string) || "200") || 200, 1000);

      const params = [companyId];
      const conditions = ["company_id = $1"];
      if (sheetId != null) {
        params.push(sheetId);
        conditions.push(`sheet_id = $${params.length}`);
      }
      params.push(limit);

      const { rows } = await pool.query(
        `SELECT id, sheet_id AS "sheetId", sheet_name AS "sheetName", row_label AS "rowLabel",
                column_label AS "columnLabel", old_value AS "oldValue", new_value AS "newValue",
                changed_by AS "changedBy", created_at AS "createdAt"
         FROM factory_status_builder_log
         WHERE ${conditions.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT $${params.length}`,
        params
      );
      res.json(rows);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

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

      const buf: Buffer = writeExcel(wb, { type: "buffer", bookType: "xlsx" });
      res.setHeader("Content-Disposition", 'attachment; filename="status-builder.xlsx"');
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.send(buf);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
