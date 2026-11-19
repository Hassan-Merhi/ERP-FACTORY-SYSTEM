// Extracted from ./generate.ts to keep that module under the source-size cap.
import ExcelJS from "exceljs";
import {
  addDays,
  colLetter,
  E_CLOSING_QTY_COL,
  E_CLOSING_VAL_COL,
  E_COST_BAG_COL,
  E_DATA_START,
  E_DATE_ROW,
  E_DATE_START,
  E_OPENING_QTY_COL,
  E_TEMPLATE_MAX_DAYS,
  isFormula,
  r2,
  r3,
  toUtcDate,
} from "./layout";
import { generateSpSalesFormExcelStep1 } from "./generateSpSalesFormExcelStep1";

export function generateSpSalesFormExcelStep3({
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
  summaryIWs,
  toDate,
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
  | "summaryIWs"
  | "toDate"
>) {
  // ── 3. ENTRY sheet ────────────────────────────────────────────────────────

  // Pre-sweep: nullify sharedFormula SLAVE cells in every item row of the
  // ENTRY sheet, limited to the date-block columns (col E_DATE_START onward).
  //
  // Why: ExcelJS throws "Shared Formula master must exist above and or left of
  // clone" if any slave's master cell is later replaced or cleared (even
  // replacing with another formula written as a plain {formula:...} object
  // counts as "changing" the master for ExcelJS's validator).
  //
  // Earlier versions only swept the profit column (baseCol+2) for the first
  // dayCount days; but templates with shared-formula chains spanning qty/price
  // columns (baseCol+0/+1) and days beyond the export range were still failing.
  //
  // Scope: we restrict to columns >= E_DATE_START to avoid touching static
  // formula columns (A–F: item name, cost/bag, opening stock totals, etc.)
  // that are not part of the per-day data block and should remain intact.
  //
  // IMPORTANT: do NOT use row.eachCell({ includeEmpty: false }) here.
  // That only iterates cells that ExcelJS has already materialised in its
  // in-memory row model.  Slave shared-formula cells that Excel omitted from
  // the XML (because their computed value was empty/zero) are absent from the
  // row's _cells array, so eachCell silently skips them.  ExcelJS's internal
  // shared-formula tracker still knows about those slaves via the master's
  // declared ref range, and writeBuffer() tries to write them — finding the
  // master gone and throwing "Shared Formula master must exist above and or
  // left of clone" (observed: cell AN134, col 40 = day-11 qty, row 134).
  //
  // Fix: iterate column-by-column with row.getCell(c), which FORCES
  // materialisation of every column in the date region regardless of whether
  // the underlying XML had a <c> element for it.
  const entryLastCol = entryWs.columnCount;
  for (let r = E_DATA_START; r <= E_DATA_END; r++) {
    const row = entryWs.getRow(r);
    let rowChanged = false;
    for (let c = E_DATE_START; c <= entryLastCol; c++) {
      const cell = row.getCell(c);
      const v = cell.value;
      if (v && typeof v === "object" && "sharedFormula" in v) {
        cell.value = null;
        rowChanged = true;
      }
    }
    if (rowChanged) row.commit();
  }

  // 3a. Date row (row 3)
  //
  // Template structure (confirmed from inspection):
  //   Day 0: cols G, H, I (7, 8, 9) = plain date cells → we write fromDate
  //   Day 1: cols J, K, L (10,11,12) = {formula:"G3+1"} → auto-compute fromDate+1
  //   Day 2: cols M, N, O (13,14,15) = {formula:"J3+1"} → auto-compute fromDate+2
  //   …each triplet references the previous triplet's first column (+1 day)
  //
  // Within export range (d < dayCount):
  //   Only write to plain cells (d=0 anchor); formula cells auto-chain.
  //
  // Beyond export range (d >= dayCount):
  //   MUST clear ALL cells including formula-chain cells.
  //   Old code had `if (!isFormula(cell)) cell.value = null` which SKIPPED the
  //   formula cells (since d>0 cells are formulas), leaving July 7, 8, 9…
  //   visible in the exported workbook.
  //   Fix: always null the cell regardless of formula status for d >= dayCount.
  const eDateRow = entryWs.getRow(E_DATE_ROW);
  for (let d = 0; d < effectiveDayCount; d++) {
    const dateVal = addDays(startDate, d);
    const baseCol = E_DATE_START + d * 3;
    for (let c = baseCol; c < baseCol + 3; c++) {
      const cell = eDateRow.getCell(c);
      if (!isFormula(cell)) cell.value = dateVal;
    }
  }
  // Clear date cells beyond the export range — stop at E_TEMPLATE_MAX_DAYS.
  // IMPORTANT: do NOT go past E_TEMPLATE_MAX_DAYS (18 days, ending at col 60).
  // The fixed Closing Stock columns (BJ=62, BK=63) immediately follow the
  // date section; the old `dayCount + 40` loop reached col 61-63 and wiped them.
  for (let d = effectiveDayCount; d < E_TEMPLATE_MAX_DAYS; d++) {
    const baseCol = E_DATE_START + d * 3;
    for (let c = baseCol; c < baseCol + 3; c++) {
      eDateRow.getCell(c).value = null;
    }
  }
  eDateRow.commit();

  // 3b. Item data rows
  //
  // Key rule: Qty (baseCol) and Sale Price (baseCol+1) are DATA OUTPUT cells,
  // not template formulas to preserve.  ALWAYS clear all 3 cells unconditionally
  // before writing, then only write if there is an actual posted SP sale for
  // that exact item/date.  The old `if (!isFormula(...)) cell.value = null` guard
  // was wrong — it silently kept stale template formulas alive, producing
  // phantom Qty/Price values and #DIV/0! on days with no sales.
  //
  // Profit/Bag (baseCol+2):
  //   Write as a standalone Excel FORMULA string only when a sale exists.
  //   The pre-sweep above already cleared all sharedFormula slaves.
  //
  // Opening Stock (col E) and Cost/Bag (col F):
  //   Written directly here so ExcelJS output is self-contained.
  //   The ENTRY sheet has SUMIFS formulas pointing at Costing; ExcelJS cannot
  //   recalculate those, so cached results can show blank/dash.  Writing the
  //   plain values ensures the profit formula $F<row> always has a real number.
  //
  // Closing Stock (col BJ=62, BK=63):
  //   Written directly as closingQty = openingQty − totalSoldInRange.
  //   Template formulas at those columns are unreliable for the same reason.
  //   CRITICAL: the "beyond range" clear loop below must stop at E_TEMPLATE_MAX_DAYS
  //   (col 60) — otherwise it overwrites the Closing Stock columns at 62-63.
  for (const [displayName, rowNum] of itemRows) {
    const systemCode = nameToSystemCode.get(displayName) ?? displayName;
    const daySalesMap = getSalesMap(displayName, systemCode);
    const stock = getOpening(displayName, systemCode);
    const row = entryWs.getRow(rowNum);

    // ── Opening Stock: write directly to ENTRY col E and F ──────────────────
    row.getCell(E_OPENING_QTY_COL).value = stock.qty > 0 ? r3(stock.qty) : null;
    // Always write 0 (not null) for avg cost when qty=0 to keep $F<row> numeric
    // and prevent #DIV/0! in the profit formula =IF(qty=0,0,price-$F<row>).
    row.getCell(E_COST_BAG_COL).value = stock.qty > 0 ? r2(stock.avgCost) : 0;

    // ── Date blocks ──────────────────────────────────────────────────────────
    let totalSoldInRange = 0;
    for (let d = 0; d < effectiveDayCount; d++) {
      const baseCol = E_DATE_START + d * 3;
      const qtyCell = row.getCell(baseCol);
      const priceCell = row.getCell(baseCol + 1);
      const profitCell = row.getCell(baseCol + 2);

      // Unconditional clear — data cells must never retain stale template formulas.
      qtyCell.value = null;
      priceCell.value = null;
      profitCell.value = null;

      const ds = daySalesMap?.get(dates[d]);
      if (ds && ds.qty > 0) {
        totalSoldInRange += ds.qty;
        const avgPrice = ds.totalSales / ds.qty;
        const deductionPerBag = ds.totalDeduction / ds.qty;
        const netProfitPB = (ds.totalSales - ds.totalCost - ds.totalDeduction) / ds.qty;

        qtyCell.value = r3(ds.qty);
        priceCell.value = r2(avgPrice);

        const qC = colLetter(baseCol);
        const pC = colLetter(baseCol + 1);
        const deductionPart = deductionPerBag !== 0 ? `-${r2(deductionPerBag)}` : "";
        profitCell.value = {
          formula: `IF(${qC}${rowNum}=0,0,${pC}${rowNum}-$F${rowNum}${deductionPart})`,
          result: r2(netProfitPB),
        } as ExcelJS.CellFormulaValue;
      }
      // No-sale day: all three cells remain null (already cleared above).
    }

    // ── Clear stale data beyond export range (date section only) ─────────────
    // Stop at E_TEMPLATE_MAX_DAYS — fixed Closing Stock columns (62, 63) follow
    // immediately and must NOT be overwritten here.
    for (let d = effectiveDayCount; d < E_TEMPLATE_MAX_DAYS; d++) {
      const baseCol = E_DATE_START + d * 3;
      row.getCell(baseCol).value = null; // qty
      row.getCell(baseCol + 1).value = null; // price
      row.getCell(baseCol + 2).value = null; // profit
    }

    // ── Closing Stock: compute and write directly ─────────────────────────────
    // closingQty = openingQty − total qty sold within the selected date range.
    // Do not rely on the template formula (ExcelJS cannot recalculate it).
    //
    // Zero-semantics: write 0 (not null) when opening stock > 0 and all bags
    // were sold.  This keeps downstream SUM/pivot formulas numeric.
    // When opening stock = 0 there is nothing to report — write null to leave
    // those cells blank (consistent with template expectation for new items).
    const closingQty = Math.max(0, stock.qty - totalSoldInRange);
    const closingValue = r2(closingQty * stock.avgCost);
    if (stock.qty > 0) {
      row.getCell(E_CLOSING_QTY_COL).value = r3(closingQty); // 0 when fully sold
      row.getCell(E_CLOSING_VAL_COL).value = closingValue; // 0.00 when fully sold
    } else {
      row.getCell(E_CLOSING_QTY_COL).value = null;
      row.getCell(E_CLOSING_VAL_COL).value = null;
    }

    row.commit();
  }

  // ── 4. Summary-Itemwise: B1 = toDate (VLOOKUP reference) ─────────────────
  if (summaryIWs) {
    const b1 = summaryIWs.getRow(1).getCell(2);
    if (!isFormula(b1)) b1.value = toUtcDate(toDate);
    summaryIWs.getRow(1).commit();
  }

  // ── 5. Sheet visibility ───────────────────────────────────────────────────
  // Match attached template exactly:
  //   Costing=hidden, Sales=hidden, ENTRY=visible, Summary=visible,
  //   Ageing=VISIBLE (template has it visible — do NOT hide it), Summary-Itemwise=hidden
  // The old code incorrectly set Ageing to "hidden". Removed.
  if (costingWs) costingWs.state = "hidden";
  if (salesWs) salesWs.state = "hidden";
  if (summaryIWs) summaryIWs.state = "hidden";
  return {};
}
