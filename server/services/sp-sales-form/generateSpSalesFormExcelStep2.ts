// Extracted from ./generate.ts to keep that module under the source-size cap.
import { cellText } from "../../lib/excelCellValue";
import ExcelJS from "exceljs";
import {
  addDays,
  C_AVG_COL,
  C_NAME_COL,
  C_QTY_COL,
  C_VAL_COL,
  E_CODE_COL,
  E_DATA_START,
  E_NAME_COL,
  isFormula,
  nk,
  r2,
  r3,
  S_DATA_START,
  S_DATE_ROW,
  S_DATE_START,
  S_NAME_COL,
} from "./layout";
import { generateSpSalesFormExcelStep1 } from "./generateSpSalesFormExcelStep1";

export function generateSpSalesFormExcelStep2({
  E_DATA_END,
  costingWs,
  dates,
  effectiveDayCount,
  entryWs,
  getOpening,
  getSalesMap,
  itemRows,
  nameToSystemCode,
  salesWs,
  startDate,
}: Pick<
  Awaited<ReturnType<typeof generateSpSalesFormExcelStep1>>,
  | "E_DATA_END"
  | "costingWs"
  | "dates"
  | "effectiveDayCount"
  | "entryWs"
  | "getOpening"
  | "getSalesMap"
  | "itemRows"
  | "nameToSystemCode"
  | "salesWs"
  | "startDate"
>) {
  for (let r = E_DATA_START; r <= E_DATA_END; r++) {
    const row = entryWs.getRow(r);
    const nameCell = row.getCell(E_NAME_COL).value;
    const codeCell = row.getCell(E_CODE_COL).value;

    const rawName = cellText(nameCell);
    if (!rawName || rawName.startsWith("Total ")) continue;

    const systemCode = typeof codeCell === "string" && codeCell.trim() ? codeCell.trim() : rawName;

    nameToSystemCode.set(rawName, systemCode);
    // Also store under normalized key for case-insensitive Costing/Sales lookups
    if (nk(rawName) !== rawName) nameToSystemCode.set(nk(rawName), systemCode);
    itemRows.set(rawName, r);
  }

  // ── 1. Costing sheet: write opening stock ─────────────────────────────────
  // FIX: When qty = 0, also write 0 to the Avg Cost cell (G = C_AVG_COL).
  // The template formula there is =H/E. If both H and E are null/0, Excel
  // computes 0/0 = #DIV/0!, which then propagates to ENTRY col F (Cost/Bag)
  // and from there into the Closing Stock Value formula — causing the #DIV/0!
  // errors visible in the exported sheet. Overwriting with the plain value 0
  // replaces the formula entirely so Excel shows 0 instead of the error.
  const costingLastRow = costingWs.rowCount;
  for (let r = 2; r <= costingLastRow; r++) {
    const row = costingWs.getRow(r);
    const nameRaw = row.getCell(C_NAME_COL).value;
    const displayName = cellText(nameRaw);

    // For rows with no readable name (formula-name with null result), still
    // guard the avgCostCell to prevent #DIV/0! from an untouched =H/E formula.
    if (!displayName) {
      const avgCell = row.getCell(C_AVG_COL);
      if (isFormula(avgCell)) {
        avgCell.value = 0;
        row.commit();
      }
      continue;
    }

    if (displayName.startsWith("Total ") || displayName === "Inventory") continue;

    const systemCode = nameToSystemCode.get(displayName) ?? nameToSystemCode.get(nk(displayName)) ?? displayName;
    const stock = getOpening(displayName, systemCode);

    const qtyCell = row.getCell(C_QTY_COL);
    const avgCostCell = row.getCell(C_AVG_COL);
    const valCell = row.getCell(C_VAL_COL);

    if (!isFormula(qtyCell)) {
      qtyCell.value = stock.qty > 0 ? r3(stock.qty) : null;
    }
    if (!isFormula(valCell)) {
      const assetVal = stock.qty * stock.avgCost;
      valCell.value = assetVal > 0 ? r2(assetVal) : null;
    }

    // Avg Cost cell:
    //   • qty > 0 → write formula =H<r>/E<r> with the computed result as cached value.
    //               This stays formula-based (matches template) and is recalculated by Excel.
    //   • qty = 0 → write plain 0 to replace the =H/E formula; otherwise Excel shows #DIV/0!
    if (stock.qty > 0) {
      avgCostCell.value = { formula: `H${r}/E${r}`, result: r2(stock.avgCost) } as ExcelJS.CellFormulaValue;
    } else {
      avgCostCell.value = 0;
    }

    row.commit();
  }

  // ── 2. Sales sheet: write date row and item qty ───────────────────────────
  //
  // Sales date row structure (from template inspection):
  //   Col F (6)  = plain date (day 0) — we write fromDate here
  //   Cols G–L (7–12) = formula chain =F1+1, =G1+1, … — auto-compute dates 1–6
  //   Col M (13) onward = plain stale dates (2024-01-xx leftover from template)
  //
  // For days WITHIN the export range: only F1 needs to be written; formula
  // cells auto-chain from there.
  //
  // For days BEYOND the export range: ALL cells must be cleared, including the
  // formula chain cells (col 12 onward for a 6-day export).
  // The old code had `if (!isFormula(cell)) cell.value = null` which SKIPPED
  // the formula cells, leaving the chain alive and showing July 7, 8, 9…
  // Fix: always set value = null regardless of formula status.
  //
  // Sales data rows:
  //   No-sale days must be null (blank), not 0.  Writing 0 causes ambiguity
  //   when ENTRY SUMIFS formulas read the hidden Sales sheet — a 0-qty day
  //   is indistinguishable from a truly missing day.
  if (salesWs) {
    // Pre-sweep: nullify ALL sharedFormula slave cells in the Sales sheet before
    // making any other modifications.
    //
    // Why: the Sales sheet (like ENTRY) contains shared-formula chains.  When we
    // later write null to cells in "Total" rows (beyond the export range) we may
    // be clearing slave cells whose masters still reference them in ExcelJS's
    // internal shared-formula registry.  ExcelJS then throws "Shared Formula
    // master must exist above and or left of clone" during writeBuffer().
    //
    // Scope: ALL rows (date row + item rows + total rows), columns >= S_DATE_START.
    // Use row.getCell(c) column-by-column to force materialisation of every cell,
    // for the same reason as the ENTRY pre-sweep above.
    const salesLastCol = salesWs.columnCount;
    for (let r = S_DATE_ROW; r <= salesWs.rowCount; r++) {
      const row = salesWs.getRow(r);
      let rowChanged = false;
      for (let c = S_DATE_START; c <= salesLastCol; c++) {
        const cell = row.getCell(c);
        const v = cell.value;
        if (v && typeof v === "object" && "sharedFormula" in v) {
          cell.value = null;
          rowChanged = true;
        }
      }
      if (rowChanged) row.commit();
    }

    const sDateRow = salesWs.getRow(S_DATE_ROW);
    // Write fromDate to the plain anchor cell (F1 = col S_DATE_START).
    // Formula cells for d=1… auto-chain from F1 — do not overwrite them.
    for (let d = 0; d < effectiveDayCount; d++) {
      const cell = sDateRow.getCell(S_DATE_START + d);
      if (!isFormula(cell)) cell.value = addDays(startDate, d);
    }
    // Clear ALL cells beyond the export range — including formula-chain cells.
    // Using +40 to safely cover any template day-column extent.
    for (let d = effectiveDayCount; d < effectiveDayCount + 40; d++) {
      sDateRow.getCell(S_DATE_START + d).value = null;
    }
    sDateRow.commit();

    // Named rows (items + totals): write qty and clear beyond range.
    //
    // Loop design — two concerns kept separate:
    //   a) Data writing (within range): item rows only; "Total …" rows are
    //      aggregation rows whose in-range cells are formula-driven and must not
    //      be overwritten with raw qty values.
    //   b) Beyond-range clearing: ALL named rows, including "Total …" rows.
    //      "Total" rows contain formula cells (e.g. SUM chains) that, if left
    //      intact beyond toDate, survive in the hidden Sales sheet and can be
    //      picked up by ENTRY SUMIFS, producing phantom quantities.
    //      The clearing MUST NOT use the isFormula guard — formula cells must be
    //      nulled just like plain-value cells.
    //
    // Blank/unnamed rows are skipped entirely; they carry no formula data.
    const salesWsLast = salesWs.rowCount;
    for (let r = S_DATA_START; r <= salesWsLast; r++) {
      const row = salesWs.getRow(r);
      const nameRaw = row.getCell(S_NAME_COL).value;
      const displayName = cellText(nameRaw);

      // Completely skip blank/unnamed rows.
      if (!displayName) continue;

      // (a) Data writing — item rows only (not "Total …").
      if (!displayName.startsWith("Total ")) {
        const systemCode = nameToSystemCode.get(displayName) ?? nameToSystemCode.get(nk(displayName)) ?? displayName;
        const daySalesMap = getSalesMap(displayName, systemCode);

        for (let d = 0; d < effectiveDayCount; d++) {
          const cell = row.getCell(S_DATE_START + d);
          // Always overwrite — template formulas in item rows are stale data
          // that must be replaced with the actual sale qty (or null).
          // The old `if (isFormula(cell)) continue` guard was wrong here.
          const ds = daySalesMap?.get(dates[d]);
          cell.value = ds && ds.qty > 0 ? r3(ds.qty) : null;
        }
      }

      // (b) Beyond-range clearing — ALL named rows (items AND totals).
      for (let d = effectiveDayCount; d < effectiveDayCount + 40; d++) {
        row.getCell(S_DATE_START + d).value = null;
      }
      row.commit();
    }
  }
  return {};
}
