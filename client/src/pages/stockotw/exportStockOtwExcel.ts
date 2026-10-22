/**
 * Stock On The Way Excel export, extracted from StockOTW.tsx.
 */
import { ExcelJS, writeFile } from "@/lib/excelHelper";
import type { GroupedStockItem } from "@/lib/stockOtwWirePayload";

export interface StockOtwExcelExportInput {
  filteredItems: GroupedStockItem[];
  otwContainerCount: number;
  totalQuantity: number;
  displayTotal: number;
  formatAmount: (amount: number) => string;
  searchTerm: string;
  selectedGrade: string;
  selectedCategory: string[];
  selectedSupplier: string[];
}

export async function exportStockOtwExcel({
  filteredItems,
  otwContainerCount,
  totalQuantity,
  displayTotal,
  formatAmount,
  searchTerm,
  selectedGrade,
  selectedCategory,
  selectedSupplier,
}: StockOtwExcelExportInput): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Stock OTW");

  const COLS = 8;
  const BLUE_DARK = "1D4ED8";
  const BLUE_MID = "DBEAFE";
  const BLUE_LIGHT = "EFF6FF";
  const GRAY_LIGHT = "F9FAFB";
  const WHITE = "FFFFFF";

  const hFill = (argb: string): ExcelJS.Fill => ({
    type: "pattern",
    pattern: "solid",
    fgColor: { argb },
  });
  const bold = (size = 11): Partial<ExcelJS.Font> => ({ bold: true, size });
  const right: Partial<ExcelJS.Alignment> = { horizontal: "right", vertical: "middle" };
  const mid: Partial<ExcelJS.Alignment> = { horizontal: "left", vertical: "middle" };
  const numFmt = "#,##0.##";

  // ── Title ──────────────────────────────────────────────────────────────
  ws.mergeCells(1, 1, 1, COLS);
  const titleCell = ws.getCell("A1");
  titleCell.value = "Stock On The Way";
  titleCell.font = { bold: true, size: 16, color: { argb: "1E3A5F" } };
  titleCell.alignment = { horizontal: "left", vertical: "middle" };
  ws.getRow(1).height = 28;

  ws.mergeCells(2, 1, 2, COLS);
  const subCell = ws.getCell("A2");
  subCell.value = `Exported: ${new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}`;
  subCell.font = { italic: true, size: 10, color: { argb: "6B7280" } };
  subCell.alignment = mid;
  ws.getRow(2).height = 18;

  // ── Stats row ──────────────────────────────────────────────────────────
  ws.getRow(3).height = 8;

  const statsRow = ws.getRow(4);
  statsRow.height = 20;
  const statsText = [
    `${otwContainerCount} container${otwContainerCount !== 1 ? "s" : ""} OTW`,
    `${filteredItems.length} unique item${filteredItems.length !== 1 ? "s" : ""}`,
    `Total qty: ${Math.round(totalQuantity).toLocaleString()}`,
    `Total value: ${formatAmount(displayTotal)}`,
  ].join("     |     ");
  ws.mergeCells(4, 1, 4, COLS);
  const statsCell = ws.getCell("A4");
  statsCell.value = statsText;
  statsCell.font = { size: 10, color: { argb: "374151" } };
  statsCell.alignment = mid;

  if (searchTerm || selectedGrade !== "all" || selectedCategory.length > 0 || selectedSupplier.length > 0) {
    const filters: string[] = [];
    if (searchTerm) filters.push(`Search: "${searchTerm}"`);
    if (selectedGrade !== "all") filters.push(`Grade: ${selectedGrade}`);
    if (selectedCategory.length > 0) filters.push(`Categories: ${selectedCategory.join(", ")}`);
    if (selectedSupplier.length > 0) filters.push(`Suppliers: ${selectedSupplier.join(", ")}`);
    ws.getRow(5).height = 16;
    ws.mergeCells(5, 1, 5, COLS);
    const fCell = ws.getCell("A5");
    fCell.value = `Active filters: ${filters.join(" | ")}`;
    fCell.font = { italic: true, size: 9, color: { argb: "9CA3AF" } };
    fCell.alignment = mid;
  }

  ws.getRow(6).height = 8;

  // ── Column headers ─────────────────────────────────────────────────────
  const HDR_ROW = 7;
  const headers = ["Item Name", "Grade", "Category", "Container #", "Supplier", "Quantity", "Rate", "Total Cost"];
  const hRow = ws.getRow(HDR_ROW);
  hRow.height = 22;
  headers.forEach((h, i) => {
    const cell = hRow.getCell(i + 1);
    cell.value = h;
    cell.font = { ...bold(11), color: { argb: WHITE } };
    cell.fill = hFill(BLUE_DARK);
    cell.alignment = i >= 5 ? right : mid;
    cell.border = {
      bottom: { style: "thin", color: { argb: "FFFFFF" } },
    };
  });

  // ── Data rows ──────────────────────────────────────────────────────────
  let rowIdx = HDR_ROW + 1;

  for (const item of filteredItems) {
    const uniqueSuppliers = Array.from(new Set(item.containers.map((c) => c.supplierName)));

    // Summary row
    const sRow = ws.getRow(rowIdx++);
    sRow.height = 20;
    const sCells = [
      item.stockItemName,
      item.gradeName ?? "",
      item.categoryName ?? "",
      `${item.containerCount} container${item.containerCount !== 1 ? "s" : ""}`,
      uniqueSuppliers.join(", "),
      item.totalQuantity,
      null,
      item.totalCost,
    ];
    sCells.forEach((v, i) => {
      const cell = sRow.getCell(i + 1);
      cell.value = v;
      cell.fill = hFill(BLUE_LIGHT);
      cell.font = bold(10);
      cell.alignment = i >= 5 ? right : mid;
      if (i === 5 || i === 7) cell.numFmt = numFmt;
    });

    // Container sub-rows
    for (const con of item.containers) {
      const cRow = ws.getRow(rowIdx++);
      cRow.height = 18;
      const cCells = [
        `    ${con.containerNumber}`,
        "",
        "",
        con.containerNumber,
        con.supplierName,
        con.quantity,
        con.rate,
        con.cost,
      ];
      cCells.forEach((v, i) => {
        const cell = cRow.getCell(i + 1);
        cell.value = v;
        cell.fill = hFill(i % 2 === 0 ? WHITE : GRAY_LIGHT);
        cell.font = { size: 9, color: { argb: "374151" } };
        cell.alignment = i >= 5 ? right : mid;
        if (i >= 5) cell.numFmt = numFmt;
      });
      // Unified subtle fill
      for (let i = 1; i <= COLS; i++) {
        cRow.getCell(i).fill = hFill(GRAY_LIGHT);
      }
    }
  }

  // ── Totals footer ──────────────────────────────────────────────────────
  const totRow = ws.getRow(rowIdx);
  totRow.height = 22;
  const totCells: (string | number | null)[] = [
    `Total — ${filteredItems.length} items`,
    "",
    "",
    "",
    "",
    totalQuantity,
    null,
    displayTotal,
  ];
  totCells.forEach((v, i) => {
    const cell = totRow.getCell(i + 1);
    cell.value = v;
    cell.fill = hFill(BLUE_MID);
    cell.font = bold(11);
    cell.alignment = i >= 5 ? right : mid;
    if (i === 5 || i === 7) cell.numFmt = numFmt;
  });

  // ── Column widths ──────────────────────────────────────────────────────
  ws.getColumn(1).width = 36;
  ws.getColumn(2).width = 14;
  ws.getColumn(3).width = 16;
  ws.getColumn(4).width = 18;
  ws.getColumn(5).width = 24;
  ws.getColumn(6).width = 12;
  ws.getColumn(7).width = 12;
  ws.getColumn(8).width = 14;

  // Freeze rows above the header
  ws.views = [{ state: "frozen", xSplit: 0, ySplit: HDR_ROW }];

  const date = new Date().toISOString().slice(0, 10);
  await writeFile(wb, `Stock-OTW-${date}.xlsx`);
}
