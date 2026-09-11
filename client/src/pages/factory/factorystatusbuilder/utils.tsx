/**
 * Pure helpers and lookup tables for the FactoryStatusBuilder page.
 *
 * Extracted from FactoryStatusBuilder.tsx during the Phase 4 god-file split.
 */

import type { ApiSheet, Cell, CellValue, ColumnDef, SheetRow, StatusBuilderSheet } from "./types";

export function makeId(): string {
  return Math.random().toString(36).slice(2, 9);
}

export function fromApiSheet(s: ApiSheet): StatusBuilderSheet {
  const rawCols: unknown[] = Array.isArray(s.columns) ? s.columns : [];
  const rawRows: unknown[] = Array.isArray(s.rows) ? s.rows : [];

  const columns: ColumnDef[] = rawCols.map((c, i: number) => {
    if (typeof c === "string") return { id: `col_${makeId()}`, label: c };
    const col = c as { id?: string; label?: string };
    return { id: col.id ?? `col_${i}`, label: col.label ?? "" };
  });

  const rows: SheetRow[] = rawRows.map((r, ri: number) => {
    const row = r as { id?: string; label?: string; cells?: unknown };
    const rawCells: unknown[] = Array.isArray(row.cells) ? row.cells : [];
    const cells: Cell[] = rawCells.map((c) => {
      if (c === null || c === undefined) return { value: null };
      if (typeof c === "number" || typeof c === "string") return { value: c };
      if (typeof c === "object" && "value" in c) {
        const cell = c as { value?: Cell["value"]; link?: Cell["link"] };
        return { value: cell.value ?? null, link: cell.link ?? null };
      }
      return { value: null };
    });
    while (cells.length < columns.length) cells.push({ value: null });
    return {
      id: row.id ?? `row_${ri}`,
      label: row.label ?? "",
      cells,
    };
  });

  return {
    id: s.id,
    stableId: `sheet_${s.id}`,
    name: s.name,
    columns,
    rows,
    lockedColumns: [],
    dirty: false,
    footerMode: "diff",
  };
}

// ── Cell link resolution ──────────────────────────────────────────────────────

export function resolveCellValue(
  sheets: StatusBuilderSheet[],
  sheetId: string,
  rowId: string,
  colId: string,
  visited: Set<string> = new Set()
): { value: CellValue; broken: boolean; circular: boolean } {
  const key = `${sheetId}|${rowId}|${colId}`;
  if (visited.has(key)) return { value: null, broken: false, circular: true };
  visited.add(key);

  const sheet = sheets.find((s) => s.stableId === sheetId);
  if (!sheet) return { value: null, broken: true, circular: false };

  if (rowId === "__diff__") {
    const colIdx = sheet.columns.findIndex((c) => c.id === colId);
    if (colIdx === -1) return { value: null, broken: true, circular: false };
    const diffVals = calcDiff(sheets, sheet);
    return { value: diffVals[colIdx], broken: false, circular: false };
  }

  const row = sheet.rows.find((r) => r.id === rowId);
  if (!row) return { value: null, broken: true, circular: false };

  const colIdx = sheet.columns.findIndex((c) => c.id === colId);
  if (colIdx === -1) return { value: null, broken: true, circular: false };

  const cell = row.cells[colIdx] ?? { value: null };
  if (cell.link) {
    return resolveCellValue(
      sheets,
      cell.link.sourceSheetId,
      cell.link.sourceRowId,
      cell.link.sourceColumnId,
      new Set(visited)
    );
  }
  return { value: cell.value, broken: false, circular: false };
}

export function getEffectiveValue(sheets: StatusBuilderSheet[], cell: Cell): CellValue {
  if (!cell.link) return cell.value;
  const res = resolveCellValue(sheets, cell.link.sourceSheetId, cell.link.sourceRowId, cell.link.sourceColumnId);
  if (res.broken || res.circular) return null;
  return res.value;
}

export function isDiffColumn(label: string): boolean {
  const l = label.trim().toUpperCase();
  return l === "DIFF" || l === "DIFFERENCE" || l === "فرق";
}

export function isTotalColumn(label: string): boolean {
  const l = label.trim().toUpperCase();
  return l === "TOTAL" || l === "TOTALE" || l === "ИТОГО" || l === "مجموع";
}

export function computeDiffValue(colLabels: string[], resolvedVals: (number | null)[], ci: number): number | null {
  const leftNonDiff: number[] = [];
  for (let i = ci - 1; i >= 0 && leftNonDiff.length < 2; i--) {
    if (!isDiffColumn(colLabels[i])) leftNonDiff.unshift(i);
  }
  if (leftNonDiff.length < 2) return null;
  const a = resolvedVals[leftNonDiff[0]];
  const b = resolvedVals[leftNonDiff[1]];
  if (typeof a !== "number" || typeof b !== "number") return null;
  return a - b;
}

export function computeTotalValue(colLabels: string[], resolvedVals: (number | null)[]): number | null {
  let sum: number | null = null;
  for (let i = 0; i < colLabels.length; i++) {
    if (isDiffColumn(colLabels[i]) || isTotalColumn(colLabels[i])) continue;
    const v = resolvedVals[i];
    if (typeof v === "number") sum = (sum ?? 0) + v;
  }
  return sum;
}

export function calcDiff(sheets: StatusBuilderSheet[], sheet: StatusBuilderSheet): (number | null)[] {
  const colLabels = sheet.columns.map((c) => c.label);
  const colCount = sheet.columns.length;
  const totals: (number | null)[] = Array(colCount).fill(null);

  for (const row of sheet.rows) {
    for (let c = 0; c < colCount; c++) {
      if (isDiffColumn(colLabels[c]) || isTotalColumn(colLabels[c])) continue;
      const cell = row.cells[c] ?? { value: null };
      const eff = getEffectiveValue(sheets, cell);
      if (typeof eff === "number") totals[c] = (totals[c] ?? 0) + eff;
    }
  }
  for (let c = 0; c < colCount; c++) {
    if (isTotalColumn(colLabels[c])) {
      totals[c] = computeTotalValue(colLabels, totals);
    } else if (isDiffColumn(colLabels[c])) {
      totals[c] = computeDiffValue(colLabels, totals, c);
    }
  }
  return totals;
}

export function calcTotal(sheets: StatusBuilderSheet[], sheet: StatusBuilderSheet): (number | null)[] {
  const colLabels = sheet.columns.map((c) => c.label);
  const colCount = sheet.columns.length;
  const totals: (number | null)[] = Array(colCount).fill(null);
  for (const row of sheet.rows) {
    for (let c = 0; c < colCount; c++) {
      if (isDiffColumn(colLabels[c]) || isTotalColumn(colLabels[c])) continue;
      const cell = row.cells[c] ?? { value: null };
      const eff = getEffectiveValue(sheets, cell);
      if (typeof eff === "number") totals[c] = (totals[c] ?? 0) + eff;
    }
  }
  for (let c = 0; c < colCount; c++) {
    if (isTotalColumn(colLabels[c])) {
      totals[c] = computeTotalValue(colLabels, totals);
    }
  }
  return totals;
}

export function fmt(v: CellValue | "#REF!" | "#CYCLE!" | null | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  return v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 4 });
}

export function parseCellValue(s: string): CellValue {
  if (!s?.trim()) return null;
  const trimmed = s.trim();
  if (trimmed === "-") return "-";
  const n = Number(trimmed.replace(/,/g, ""));
  if (!isNaN(n)) return n;
  return s;
}

// ── Tab component ─────────────────────────────────────────────────────────────
