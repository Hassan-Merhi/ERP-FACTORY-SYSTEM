import { parseId } from "../../lib/parseId";
import { getErrorMessage } from "../../lib/httpHandlers";
import type { Express } from "express";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { factorySheets } from "@shared/schema";
import { eq, and, asc } from "drizzle-orm";
import multer from "multer";
import xlsxStyle from "xlsx-js-style";
import type { WorkBook } from "xlsx-js-style";

const { read: readExcel, utils: xlsxUtils, write: writeExcel } = xlsxStyle;

const upload = multer({ storage: multer.memoryStorage() });

// ── STATUS sheet helpers ───────────────────────────────────────────────────────
type CellVal = number | string | null;
/** Raw cell values as produced by xlsx: dates/booleans also occur despite `defval: null`. */
type RawCell = number | string | boolean | Date | null | undefined;
type SRow = { id?: string; label: string; cells: number[] };
type SSheet = { id?: number; name: string; columns: unknown[]; rows: SRow[]; orderIndex?: number };

const STATUS_NAME = "STATUS";

// Support both old format (string) and new format ({ id, label })
function getColLabel(col: unknown): string {
  if (typeof col === "string") return col;
  if (col && typeof col === "object" && "label" in col) {
    const label = (col as { label?: unknown }).label;
    return typeof label === "string" ? label : "";
  }
  return "";
}

// Support both old format (primitive) and new format ({ value, link? })
function getCellRawValue(cell: unknown): CellVal {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === "number" || typeof cell === "string") return cell;
  if (typeof cell === "object" && "value" in cell) {
    const value = (cell as { value?: unknown }).value;
    if (value === null || value === undefined) return null;
    if (typeof value === "number" || typeof value === "string") return value;
    return String(value);
  }
  return null;
}

function toNumber(v: CellVal): number {
  if (typeof v === "number") return isNaN(v) ? 0 : v;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/,/g, ""));
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

function findSheet(sheets: SSheet[], name: string): SSheet | undefined {
  const n = name.trim().toLowerCase();
  return sheets.find((s) => s.name.trim().toLowerCase().includes(n));
}

function findColumnIndex(sheet: SSheet, names: string[]): number {
  for (const name of names) {
    const n = name.trim().toLowerCase();
    const idx = sheet.columns.findIndex((c) => getColLabel(c).trim().toLowerCase() === n);
    if (idx !== -1) return idx;
  }
  return -1;
}

function sumColumn(sheet: SSheet | undefined, names: string[]): number {
  if (!sheet) return 0;
  const idx = findColumnIndex(sheet, names);
  if (idx === -1) return 0;
  return sheet.rows.reduce((sum, row) => sum + toNumber(getCellRawValue(row.cells[idx])), 0);
}

function buildStatusSheet(sheets: SSheet[], existingStatus?: SSheet): { columns: string[]; rows: SRow[] } {
  // Read persisted BEFORE values from the existing STATUS sheet (so edits survive recalc)
  const getExistingBefore = (labelFragment: string, defaultVal: number): number => {
    if (!existingStatus) return defaultVal;
    const beforeIdx = findColumnIndex(existingStatus, ["BEFORE"]);
    if (beforeIdx === -1) return defaultVal;
    const row = existingStatus.rows.find((r) => r.label.trim().toLowerCase().includes(labelFragment.toLowerCase()));
    if (!row) return defaultVal;
    const v = toNumber(getCellRawValue(row.cells[beforeIdx]));
    return v !== 0 ? v : defaultVal;
  };

  // Source sheets
  const prodSheet = findSheet(sheets, "PRODUCTION");
  const stockSheet = findSheet(sheets, "STOCK IN");
  const ioSheet = findSheet(sheets, "IO");

  // DIFF values
  const prodDiff = -Math.abs(sumColumn(prodSheet, ["DIFF", "Diff", "فرق"]));
  const stockDiff = -Math.abs(sumColumn(stockSheet, ["فرق", "DIFF", "Diff"]));
  const ioDiff = sumColumn(ioSheet, ["WEIGHT", "Weight"]);

  // BEFORE values
  const prodBefore = getExistingBefore("PRODUCTION", -183221);
  const stockBefore = getExistingBefore("STOCK IN", -46020);
  const ioBefore = getExistingBefore("IO", -69011);

  // AFTER = BEFORE + DIFF
  const prodAfter = prodBefore + prodDiff;
  const stockAfter = stockBefore + stockDiff;
  const ioAfter = ioBefore + ioDiff;

  // DIFFERENCE totals row
  const totalBefore = prodBefore + stockBefore + ioBefore;
  const totalDiff = prodDiff + stockDiff + ioDiff;
  const totalAfter = prodAfter + stockAfter + ioAfter;

  const columns = ["BEFORE", "DIFF", "AFTER"];
  const rows: SRow[] = [
    { id: "status_row_production", label: "PRODUCTION اجراء اعمال", cells: [prodBefore, prodDiff, prodAfter] },
    { id: "status_row_stockin", label: "STOCK IN", cells: [stockBefore, stockDiff, stockAfter] },
    { id: "status_row_io", label: "IO", cells: [ioBefore, ioDiff, ioAfter] },
    { id: "status_row_difference", label: "DIFFERENCE", cells: [totalBefore, totalDiff, totalAfter] },
  ];

  return { columns, rows };
}

// Upsert the STATUS sheet for a company, always at orderIndex 0.
// Pass in already-fetched source sheets to avoid redundant DB calls.
async function upsertStatusSheet(companyId: number, sourceSheets: SSheet[]): Promise<void> {
  // Exclude STATUS itself from source data
  const nonStatus = sourceSheets.filter((s) => s.name.trim().toUpperCase() !== STATUS_NAME);

  // Find the existing STATUS record so we can preserve BEFORE values
  const existingStatus = sourceSheets.find((s) => s.name.trim().toUpperCase() === STATUS_NAME);

  const { columns, rows } = buildStatusSheet(nonStatus, existingStatus);

  if (existingStatus?.id) {
    // Update in place
    await db
      .update(factorySheets)
      .set({ columns, rows, orderIndex: 0, updatedAt: new Date() })
      .where(and(eq(factorySheets.id, existingStatus.id), eq(factorySheets.companyId, companyId)));
  } else {
    // Push all existing sheets up by 1 to make room
    const allSheets = await db
      .select({ id: factorySheets.id, orderIndex: factorySheets.orderIndex })
      .from(factorySheets)
      .where(eq(factorySheets.companyId, companyId));

    for (const s of allSheets) {
      await db
        .update(factorySheets)
        .set({ orderIndex: s.orderIndex + 1 })
        .where(and(eq(factorySheets.id, s.id), eq(factorySheets.companyId, companyId)));
    }

    // Insert STATUS as first
    await db.insert(factorySheets).values({
      companyId,
      name: STATUS_NAME,
      orderIndex: 0,
      columns,
      rows,
    });
  }
}

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

  // ── Delete a sheet ─────────────────────────────────────────────────────────
  app.delete("/api/factory/sheets/:id", requireAuth, async (req, res) => {
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
  app.post("/api/factory/sheets/import", requireAuth, upload.single("file"), async (req, res) => {
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
  });

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

      const buf: Buffer = writeExcel(wb, { type: "buffer", bookType: "xlsx" });

      res.setHeader("Content-Disposition", 'attachment; filename="factory-sheets.xlsx"');
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.send(buf);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
