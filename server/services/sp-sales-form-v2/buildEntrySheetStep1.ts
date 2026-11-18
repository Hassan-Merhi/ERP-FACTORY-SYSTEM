// Extracted from ./buildEntrySheet.ts to keep that module under the source-size cap.
import ExcelJS from "exceljs";
import { ItemRow, SpSalesFormV2Params } from "./types";
import { colLetter, fmtDate } from "./dateHelpers";
import { applyCell, r2, r4, setCellNum, setCellVal } from "./styleHelpers";
import {
  AFTER_DATES,
  ALT_ROW,
  boldSm,
  BRIGHT_YLW,
  CLOSE_GRN,
  COL_COSTBAG,
  COL_GROUP,
  COL_ITEMCODE,
  COL_ITEMNAME,
  COL_OPENQTY,
  COL_ROWNUM,
  COLS_PER_DAY,
  ctr,
  DARK_BLUE,
  fill,
  FIXED_LEFT,
  GREEN_HDR,
  leftAl,
  MONEY_FMT,
  normSm,
  OPEN_BLUE,
  ORANGE_HDR,
  PURPLE_QTY,
  QTY_FMT,
  right,
  thin,
  TOTALS_ORG,
  wFont,
  WHITE,
  YELLOW_GRP,
} from "./constants";

export function buildEntrySheetStep1(
  wb: ExcelJS.Workbook,
  items: ItemRow[],
  dates: string[],
  dayCount: number,
  params: SpSalesFormV2Params
) {
  const ws = wb.addWorksheet("ENTRY");
  // FIXED_LEFT = 6: A=RowNum, B=Group, C=ItemName, D=Code, E=OpenQty, F=Cost/Bag
  const dayBase = FIXED_LEFT + 1; // = 7 — first Qty column for day 0
  const totalCols = FIXED_LEFT + dayCount * COLS_PER_DAY + AFTER_DATES;
  const closeQtyCol = dayBase + dayCount * COLS_PER_DAY;

  // ── Print / freeze / filter ──────────────────────────────────────────────────
  ws.pageSetup.orientation = "landscape";
  ws.pageSetup.fitToPage = true;
  ws.pageSetup.fitToWidth = 1;
  ws.pageSetup.fitToHeight = 0;
  ws.pageSetup.printTitlesRow = "1:3";
  ws.pageSetup.margins = { left: 0.25, right: 0.25, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 };
  ws.views = [{ state: "frozen", xSplit: COL_ITEMCODE, ySplit: 3, activeCell: colLetter(dayBase) + "4" }];
  ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: totalCols } };

  // ── Column widths ────────────────────────────────────────────────────────────
  ws.getColumn(COL_ROWNUM).width = 6; // A: Row#
  ws.getColumn(COL_GROUP).width = 16; // B: Group / category
  ws.getColumn(COL_ITEMNAME).width = 28; // C: Item Name
  ws.getColumn(COL_ITEMCODE).width = 14; // D: Item Code
  ws.getColumn(COL_OPENQTY).width = 10; // E: Opening Stock Qty
  ws.getColumn(COL_COSTBAG).width = 10; // F: Cost/Bag
  for (let d = 0; d < dayCount; d++) {
    const b = dayBase + d * COLS_PER_DAY;
    ws.getColumn(b).width = 8; // Qty
    ws.getColumn(b + 1).width = 9; // Sale Price
    ws.getColumn(b + 2).width = 9; // Profit/Bag
  }
  ws.getColumn(closeQtyCol).width = 11;
  ws.getColumn(closeQtyCol + 1).width = 12;
  ws.getColumn(closeQtyCol + 2).width = 14;

  // ── Group items (preserve sort order from buildItemRegistry) ─────────────────
  const groupOrderedNames: string[] = [];
  const groupedItems = new Map<string, ItemRow[]>();
  for (const item of items) {
    const g = item.groupName || "(Ungrouped)";
    if (!groupedItems.has(g)) {
      groupedItems.set(g, []);
      groupOrderedNames.push(g);
    }
    groupedItems.get(g)!.push(item);
  }

  // ── Pre-compute row layout ───────────────────────────────────────────────────
  interface GroupBound {
    groupName: string;
    items: ItemRow[];
    firstRow: number;
    lastRow: number;
    subtotalRow: number;
  }
  const groupBounds: GroupBound[] = [];
  const subtotalRowNums: number[] = [];
  let nextRow = 4;

  for (const gName of groupOrderedNames) {
    const gItems = groupedItems.get(gName)!;
    const firstRow = nextRow;
    nextRow += gItems.length;
    const lastRow = nextRow - 1;
    const subtotalRow = nextRow;
    subtotalRowNums.push(subtotalRow);
    groupBounds.push({ groupName: gName, items: gItems, firstRow, lastRow, subtotalRow });
    nextRow++;
  }
  const totalRowNum = nextRow;

  // Cash / payments layout (2 blank gap after TOTAL)
  const cashHdrRow = totalRowNum + 2;
  const cashSubHdrRow = cashHdrRow + 1;
  const openCashRow = cashSubHdrRow + 1;
  const depositRow = openCashRow + 1;
  const receiptRow = depositRow + 1;
  const paymentsHdrRow = receiptRow + 2;

  // ════════ Row 1 — Title ════════════════════════════════════════════════════
  ws.mergeCells(1, 1, 1, Math.min(totalCols, 30));
  const titleCell = ws.getCell(1, 1);
  const loc = params.locationName || "All Locations";
  const sup = params.supplierName || "";
  titleCell.value = `${sup}${sup ? " — " : ""}Sales Form  |  ${loc}  |  ${params.fromDate} to ${params.toDate}`;
  titleCell.fill = fill(DARK_BLUE);
  titleCell.font = wFont(12);
  titleCell.alignment = ctr;
  ws.getRow(1).height = 24;

  // ════════ Row 2 — Group headers ════════════════════════════════════════════
  ws.getRow(2).height = 15;
  ws.mergeCells(2, COL_ROWNUM, 2, COL_ITEMCODE); // A-D: Item (incl. Group column)
  applyCell(ws, 2, COL_ROWNUM, "Item", fill(DARK_BLUE), wFont(), ctr);
  ws.mergeCells(2, COL_OPENQTY, 2, COL_COSTBAG); // E-F: Opening Stock
  applyCell(ws, 2, COL_OPENQTY, "Opening Stock", fill(OPEN_BLUE), boldSm, ctr);
  for (let d = 0; d < dayCount; d++) {
    const b = dayBase + d * COLS_PER_DAY;
    ws.mergeCells(2, b, 2, b + 2);
    applyCell(ws, 2, b, fmtDate(dates[d]), d % 2 === 0 ? fill(GREEN_HDR) : fill(ORANGE_HDR), wFont(9), ctr);
  }
  ws.mergeCells(2, closeQtyCol, 2, closeQtyCol + 1);
  applyCell(ws, 2, closeQtyCol, "Closing Stock", fill(CLOSE_GRN), boldSm, ctr);
  applyCell(ws, 2, closeQtyCol + 2, "Avg/Mo", fill(TOTALS_ORG), boldSm, ctr);

  // ════════ Row 3 — Sub-headers ═══════════════════════════════════════════════
  ws.getRow(3).height = 14;
  const hdr3: Array<{ col: number; label: string; f?: ExcelJS.Fill }> = [
    { col: COL_ROWNUM, label: "#", f: fill(DARK_BLUE) },
    { col: COL_GROUP, label: "Group", f: fill(YELLOW_GRP) }, // Group/category column — yellow
    { col: COL_ITEMNAME, label: "Item Name", f: fill(DARK_BLUE) },
    { col: COL_ITEMCODE, label: "Item Code", f: fill(DARK_BLUE) },
    { col: COL_OPENQTY, label: "Open Qty", f: fill(OPEN_BLUE) },
    { col: COL_COSTBAG, label: "Cost / Bag", f: fill(OPEN_BLUE) },
  ];
  for (let d = 0; d < dayCount; d++) {
    const b = dayBase + d * COLS_PER_DAY;
    const df = d % 2 === 0 ? fill(GREEN_HDR) : fill(ORANGE_HDR);
    hdr3.push({ col: b, label: "Qty", f: fill(PURPLE_QTY) });
    hdr3.push({ col: b + 1, label: "Sale Price", f: fill(BRIGHT_YLW) });
    hdr3.push({ col: b + 2, label: "Profit/Bag", f: df });
  }
  hdr3.push({ col: closeQtyCol, label: "Close Qty", f: fill(CLOSE_GRN) });
  hdr3.push({ col: closeQtyCol + 1, label: "Close Value", f: fill(CLOSE_GRN) });
  hdr3.push({ col: closeQtyCol + 2, label: "Avg Mo. Sales", f: fill(TOTALS_ORG) });
  for (const h of hdr3) {
    const c = ws.getCell(3, h.col);
    c.value = h.label;
    c.font = [1, 2, 3].includes(h.col) ? wFont(9) : boldSm;
    c.alignment = ctr;
    c.border = thin;
    if (h.f) c.fill = h.f;
  }

  // ════════ Item rows + group subtotals ═══════════════════════════════════════
  let itemCounter = 0;

  for (const gb of groupBounds) {
    // ── Item rows ──────────────────────────────────────────────────────────────
    gb.items.forEach((item, gIdx) => {
      const r = gb.firstRow + gIdx;
      const altFl = itemCounter % 2 === 1 ? fill(ALT_ROW) : undefined;
      itemCounter++;
      ws.getRow(r).height = 14;

      // A: Row number (locked)
      setCellVal(ws, r, COL_ROWNUM, itemCounter, boldSm, altFl ?? fill(WHITE), right);
      ws.getCell(r, COL_ROWNUM).protection = { locked: true };

      // B: Group / category (locked) — yellow fill
      setCellVal(ws, r, COL_GROUP, item.groupName || "(Ungrouped)", boldSm, fill(YELLOW_GRP), leftAl);
      ws.getCell(r, COL_GROUP).protection = { locked: true };

      // C: Item Name (locked)
      setCellVal(ws, r, COL_ITEMNAME, item.itemName, normSm, altFl, leftAl);
      ws.getCell(r, COL_ITEMNAME).protection = { locked: true };

      // D: Item Code (locked)
      setCellVal(ws, r, COL_ITEMCODE, item.itemCode, normSm, altFl, leftAl);
      ws.getCell(r, COL_ITEMCODE).protection = { locked: true };

      // E: Opening Stock Qty (locked, no dollar sign)
      setCellNum(ws, r, COL_OPENQTY, item.openQty ? Math.round(item.openQty) : null, altFl ?? fill(OPEN_BLUE), QTY_FMT);
      ws.getCell(r, COL_OPENQTY).protection = { locked: true };

      // F: Cost/Bag (locked, dollar sign, whole dollars)
      setCellNum(ws, r, COL_COSTBAG, r4(item.openRate) || null, altFl ?? fill(OPEN_BLUE), MONEY_FMT);
      ws.getCell(r, COL_COSTBAG).protection = { locked: true };

      // Build list of qty cell addresses for closing-qty and avg formulas
      // Day base = 7, so day-0 Qty = G, day-1 Qty = J, day-2 Qty = M, …
      const qtyCellRefs = Array.from({ length: dayCount }, (_, d) => `${colLetter(dayBase + d * COLS_PER_DAY)}${r}`);

      // Daily blocks
      for (let d = 0; d < dayCount; d++) {
        const b = dayBase + d * COLS_PER_DAY;
        const ds = item.salesByDate.get(dates[d]);
        const qtyVal = ds && ds.qty > 0 ? Math.round(ds.qty) : null;
        // The shop's configured per-unit deduction reduces the amount
        // attributable to the supplier. Keep the visible sale price and
        // profit consistent with the net total shown in the sheet.
        const netSales = ds ? ds.totalSales - (ds.totalDeduction ?? 0) : 0;
        const priceVal = ds && ds.qty > 0 ? r4(netSales / ds.qty) : null;
        const profitVal = ds && ds.qty > 0 ? r4((netSales - ds.totalCost) / ds.qty) : null;
        const qL = colLetter(b),
          pL = colLetter(b + 1);

        // Qty — UNLOCKED, no $ sign
        const qC = ws.getCell(r, b);
        qC.value = qtyVal;
        qC.numFmt = QTY_FMT;
        qC.font = normSm;
        qC.alignment = right;
        qC.border = thin;
        qC.fill = fill(PURPLE_QTY);
        qC.protection = { locked: false };

        // Sale Price — UNLOCKED, $ sign, whole dollars
        const pC = ws.getCell(r, b + 1);
        pC.value = priceVal;
        pC.numFmt = MONEY_FMT;
        pC.font = normSm;
        pC.alignment = right;
        pC.border = thin;
        pC.fill = fill(BRIGHT_YLW);
        pC.protection = { locked: false };

        // Profit/Bag — formula, locked, $ sign, whole dollars
        // =IF(OR(QtyCell="",PriceCell=""),0,PriceCell-$F{r})  ← returns 0 (not "") so SUMPRODUCT works
        const prC = ws.getCell(r, b + 2);
        prC.value = {
          formula: `IF(OR(${qL}${r}="",${pL}${r}=""),0,${pL}${r}-${colLetter(COL_COSTBAG)}${r})`,
          result: profitVal ?? 0,
        } as ExcelJS.CellValue;
        prC.numFmt = MONEY_FMT;
        prC.font = normSm;
        prC.alignment = right;
        prC.border = thin;
        prC.protection = { locked: true };
      }

      // Closing Qty — formula =IF(E{r}="",0,E{r})-SUM(qty refs) ← E = Opening Qty (IF-guarded); can go negative
      const openQtyL = colLetter(COL_OPENQTY);
      const cqC = ws.getCell(r, closeQtyCol);
      cqC.value = {
        formula: `IF(${openQtyL}${r}="",0,${openQtyL}${r})-SUM(${qtyCellRefs.join(",")})`,
        result: Math.round(item.closeQty),
      } as ExcelJS.CellValue;
      cqC.numFmt = QTY_FMT;
      cqC.font = normSm;
      cqC.alignment = right;
      cqC.border = thin;
      cqC.fill = fill(CLOSE_GRN);
      cqC.protection = { locked: true };

      // Closing Value — formula =CloseQtyCell * $F{r}  ← $F = Cost/Bag (col 6)
      const cvC = ws.getCell(r, closeQtyCol + 1);
      cvC.value = {
        formula: `${colLetter(closeQtyCol)}${r}*${colLetter(COL_COSTBAG)}${r}`,
        result: r2(item.closeValue) || 0,
      } as ExcelJS.CellValue;
      cvC.numFmt = MONEY_FMT;
      cvC.font = normSm;
      cvC.alignment = right;
      cvC.border = thin;
      cvC.fill = fill(CLOSE_GRN);
      cvC.protection = { locked: true };

      // Avg Monthly — live formula so it recalculates when user types daily Qty
      // =ROUND(SUM(all daily Qty cells)*30/dayCount,0) → whole units, auto-recalcs
      const avgC = ws.getCell(r, closeQtyCol + 2);
      avgC.value = {
        formula: `ROUND(SUM(${qtyCellRefs.join(",")})*30/${dayCount},0)`,
        result: Math.round(item.avgMonthlyQty),
      } as ExcelJS.CellValue;
      avgC.numFmt = QTY_FMT;
      avgC.font = normSm;
      avgC.alignment = right;
      avgC.border = thin;
      avgC.fill = fill(TOTALS_ORG);
      avgC.protection = { locked: true };
    });

    // ── Group subtotal row ─────────────────────────────────────────────────────
    const stRow = gb.subtotalRow;
    ws.getRow(stRow).height = 14;

    // Style every cell in the subtotal row first, then merge A-D
    for (let col = 1; col <= totalCols; col++) {
      const c = ws.getCell(stRow, col);
      c.fill = fill(YELLOW_GRP);
      c.font = boldSm;
      c.border = thin;
      c.alignment = right;
      c.protection = { locked: true };
    }
    ws.mergeCells(stRow, COL_ROWNUM, stRow, COL_ITEMCODE); // A-D (incl. Group column)
    const stLabel = ws.getCell(stRow, COL_ROWNUM);
    stLabel.value = gb.groupName;
    stLabel.fill = fill(YELLOW_GRP);
    stLabel.font = { ...boldSm, color: { argb: "FF333333" } };
    stLabel.alignment = leftAl;

    // Opening Qty sum (col E)
    const dL = colLetter(COL_OPENQTY);
    ws.getCell(stRow, COL_OPENQTY).value = {
      formula: `SUM(${dL}${gb.firstRow}:${dL}${gb.lastRow})`,
      result: Math.round(gb.items.reduce((s, i) => s + i.openQty, 0)),
    } as ExcelJS.CellValue;
    ws.getCell(stRow, COL_OPENQTY).numFmt = QTY_FMT;
    ws.getCell(stRow, COL_OPENQTY).alignment = right;

    // Per-day group totals:
    //   Qty   = SUM formula (live)
    //   Sales = SUMPRODUCT(qty, salePrice) — no IF(ISNUMBER); blank qty cells treated as 0 by Excel
    //   Profit = SUMPRODUCT(qty, profitBag) — profitBag col returns 0 (not "") for no-sale days
    for (let d = 0; d < dayCount; d++) {
      const b = dayBase + d * COLS_PER_DAY;
      const qL = colLetter(b),
        pL = colLetter(b + 1),
        prL = colLetter(b + 2);
      const qtyTot = Math.round(gb.items.reduce((s, i) => s + (i.salesByDate.get(dates[d])?.qty ?? 0), 0));
      const salTot = r2(
        gb.items.reduce((s, i) => {
          const ds = i.salesByDate.get(dates[d]);
          return s + (ds?.totalSales ?? 0) - (ds?.totalDeduction ?? 0);
        }, 0)
      );
      const cstTot = r2(gb.items.reduce((s, i) => s + (i.salesByDate.get(dates[d])?.totalCost ?? 0), 0));
      const profTot = r2(salTot - cstTot);

      // Qty — SUM formula (whole units)
      ws.getCell(stRow, b).value = {
        formula: `SUM(${qL}${gb.firstRow}:${qL}${gb.lastRow})`,
        result: qtyTot,
      } as ExcelJS.CellValue;
      ws.getCell(stRow, b).numFmt = QTY_FMT;
      ws.getCell(stRow, b).alignment = right;

      // Total Sales — SUMPRODUCT(qtyRange, salePriceRange); blank cells = 0 in Excel
      ws.getCell(stRow, b + 1).value = {
        formula: `SUMPRODUCT(${qL}${gb.firstRow}:${qL}${gb.lastRow},${pL}${gb.firstRow}:${pL}${gb.lastRow})`,
        result: salTot || 0,
      } as ExcelJS.CellValue;
      ws.getCell(stRow, b + 1).numFmt = MONEY_FMT;
      ws.getCell(stRow, b + 1).alignment = right;

      // Total Profit — SUMPRODUCT(qtyRange, profitBagRange); profitBag returns 0 for no-sale days
      ws.getCell(stRow, b + 2).value = {
        formula: `SUMPRODUCT(${qL}${gb.firstRow}:${qL}${gb.lastRow},${prL}${gb.firstRow}:${prL}${gb.lastRow})`,
        result: profTot || 0,
      } as ExcelJS.CellValue;
      ws.getCell(stRow, b + 2).numFmt = MONEY_FMT;
      ws.getCell(stRow, b + 2).alignment = right;
    }

    // Closing Qty/Value sums (close qty can be negative — no clamping)
    const cqL = colLetter(closeQtyCol),
      cvL = colLetter(closeQtyCol + 1);
    ws.getCell(stRow, closeQtyCol).value = {
      formula: `SUM(${cqL}${gb.firstRow}:${cqL}${gb.lastRow})`,
      result: Math.round(gb.items.reduce((s, i) => s + i.closeQty, 0)),
    } as ExcelJS.CellValue;
    ws.getCell(stRow, closeQtyCol).numFmt = QTY_FMT;
    ws.getCell(stRow, closeQtyCol).alignment = right;

    ws.getCell(stRow, closeQtyCol + 1).value = {
      formula: `SUM(${cvL}${gb.firstRow}:${cvL}${gb.lastRow})`,
      result: r2(gb.items.reduce((s, i) => s + i.closeValue, 0)),
    } as ExcelJS.CellValue;
    ws.getCell(stRow, closeQtyCol + 1).numFmt = MONEY_FMT;
    ws.getCell(stRow, closeQtyCol + 1).alignment = right;
  }
  return {
    cashHdrRow,
    cashSubHdrRow,
    closeQtyCol,
    dayBase,
    depositRow,
    openCashRow,
    paymentsHdrRow,
    receiptRow,
    subtotalRowNums,
    totalCols,
    totalRowNum,
    ws,
  };
}
