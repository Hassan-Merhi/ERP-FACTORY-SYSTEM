/**
 * Excel "Make Your Order" sheet builders for the BaleProducts page.
 *
 * Extracted from useBaleProductsModel.tsx during the god-file split so the
 * model hook stays under the repository size limit. These build the workbook
 * in memory and trigger the download; toasts stay with the calling hook.
 */
import type { Cell as ExcelCell, FillPattern } from "exceljs";
import type { FactoryBaleProduct } from "@shared/schema";
import { hmdLogoPath } from "./utils";

export interface BaleOrderSheetInput {
  products: FactoryBaleProduct[];
  categoryMap: Map<number, string>;
}

export async function downloadPricedBaleOrderSheet(
  options: BaleOrderSheetInput & { priceType: "selling" | "production" }
): Promise<{ priceHeader: string }> {
  const { priceType, products, categoryMap } = options;
  const ExcelJSModule = await import("exceljs");
  const ExcelJS = ExcelJSModule.default ?? ExcelJSModule;

  const priceHeader = priceType === "selling" ? "Selling Price" : "Production Price";
  const today = new Date().toISOString().slice(0, 10);
  const fileName = priceType === "selling" ? "HMD_Order_Selling_Price.xlsx" : "HMD_Order_Production_Price.xlsx";

  const C_NAVY = "FF00205B";
  const C_BLUE = "FF1F3A6B";
  const C_ACCENT = "FF2E75B6";
  const C_ALT_ROW = "FFDCE6F1";
  const C_WHITE = "FFFFFFFF";
  const C_BORDER = "FFBFBFBF";
  const C_MUTED = "FF888888";
  const C_ZERO = "FFBBBBBB";
  const C_TOTAL = "FFE8F0F8";
  const C_TOTAL_LABEL = "FF00205B";

  const wb = new ExcelJS.Workbook();
  wb.creator = "HMD International Group";
  const ws = wb.addWorksheet("Make Your Order");

  ws.columns = [
    { key: "num", width: 6 },
    { key: "article", width: 18, hidden: true },
    { key: "name", width: 42 },
    { key: "category", width: 22 },
    { key: "weight", width: 14 },
    { key: "price", width: 16 },
    { key: "bales", width: 12 },
    { key: "total", width: 18 },
  ];

  try {
    const logoRes = await fetch(hmdLogoPath);
    const logoBuffer = await logoRes.arrayBuffer();
    const imageId = wb.addImage({ buffer: logoBuffer, extension: "png" });
    ws.addImage(imageId, { tl: { col: 0, row: 0 }, ext: { width: 180, height: 72 } });
  } catch {
    /* logo fetch failed — skip */
  }

  const addHeaderRow = (
    text: string,
    height: number,
    font: { bold?: boolean; size?: number; color?: { argb: string } }
  ) => {
    const r = ws.addRow(["", "", text, "", "", "", "", ""]);
    r.height = height;
    const cell = r.getCell(3);
    cell.font = font;
    cell.alignment = { vertical: "middle", horizontal: "left" };
    ws.mergeCells(`C${r.number}:H${r.number}`);
    return r;
  };

  addHeaderRow("HMD International Group", 24, { bold: true, size: 16, color: { argb: C_NAVY } });
  addHeaderRow(`Make Your Order – ${priceHeader}`, 20, { bold: true, size: 12, color: { argb: C_ACCENT } });
  addHeaderRow(`Enter quantities in the "Bales" column`, 16, { size: 10, color: { argb: C_MUTED } });
  addHeaderRow(`Generated: ${today}`, 16, { size: 10, color: { argb: C_MUTED } });

  const spacer = ws.addRow(["", "", "", "", "", "", "", ""]);
  spacer.height = 6;
  ws.mergeCells(`A${spacer.number}:H${spacer.number}`);
  spacer.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: C_NAVY } };

  // ── Table header row 6 ───────────────────────────────────────────
  const hdrRow = ws.addRow([
    "#",
    "Article Code",
    "Name of Item",
    "Category",
    "Weight (kg)",
    priceHeader,
    "Bales",
    "Total",
  ]);
  hdrRow.height = 22;
  hdrRow.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C_BLUE } };
    cell.font = { bold: true, color: { argb: C_WHITE }, size: 11 };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = {
      top: { style: "thin", color: { argb: C_BLUE } },
      bottom: { style: "medium", color: { argb: C_NAVY } },
      left: { style: "thin", color: { argb: C_BLUE } },
      right: { style: "thin", color: { argb: C_BLUE } },
    };
  });

  // ── Data rows (start at row 7) ───────────────────────────────────
  const DATA_START = 7;
  products.forEach((p, i) => {
    const rawPrice = priceType === "selling" ? p.sellingPrice : p.productionPrice;
    const numPrice = rawPrice ? parseFloat(rawPrice) : 0;
    const categoryName = p.categoryId ? categoryMap.get(p.categoryId) || "" : "";
    const weight = p.weightPerBaleKg != null ? parseFloat(String(p.weightPerBaleKg)) : "";
    const rowNum = DATA_START + i;

    const row = ws.addRow([
      `#${i + 1}`,
      p.articleCode || "",
      p.name || "",
      categoryName,
      weight,
      numPrice,
      "", // Bales — blank for user input
      { formula: `=F${rowNum}*G${rowNum}`, result: 0 }, // Total = Price × Bales
    ]);
    row.height = 18;

    const isAlt = i % 2 === 1;
    const rowFill: FillPattern | undefined = isAlt
      ? { type: "pattern", pattern: "solid", fgColor: { argb: C_ALT_ROW } }
      : undefined;

    row.eachCell((cell: ExcelCell, colNum: number) => {
      if (rowFill) cell.fill = rowFill;
      cell.font = { size: 10 };
      cell.border = { bottom: { style: "hair", color: { argb: C_BORDER } } };
      if (colNum === 1) cell.alignment = { horizontal: "center" };
      if (colNum === 5 || colNum === 6) cell.alignment = { horizontal: "right" };
      if (colNum === 7) cell.alignment = { horizontal: "center" };
      if (colNum === 8) cell.alignment = { horizontal: "right" };
    });

    const priceCell = row.getCell(6);
    priceCell.numFmt = "#,##0.00";
    if (numPrice === 0) priceCell.font = { size: 10, color: { argb: C_ZERO } };
    if (weight !== "") row.getCell(5).numFmt = "#,##0.##";

    // Total column format
    row.getCell(8).numFmt = "#,##0.00";
  });

  // ── Total row ────────────────────────────────────────────────────
  const lastDataRow = DATA_START + products.length - 1;
  const totalRow = ws.addRow([
    "",
    "",
    "TOTAL ORDER",
    "",
    "",
    "",
    { formula: `=SUM(G${DATA_START}:G${lastDataRow})`, result: 0 },
    { formula: `=SUM(H${DATA_START}:H${lastDataRow})`, result: 0 },
  ]);
  totalRow.height = 22;
  const totalFill: FillPattern = { type: "pattern", pattern: "solid", fgColor: { argb: C_TOTAL } };
  totalRow.eachCell((cell: ExcelCell, _colNum: number) => {
    cell.fill = totalFill;
    cell.border = {
      top: { style: "medium", color: { argb: C_NAVY } },
      bottom: { style: "medium", color: { argb: C_NAVY } },
    };
  });
  const labelCell = totalRow.getCell(3);
  labelCell.font = { bold: true, size: 11, color: { argb: C_TOTAL_LABEL } };
  labelCell.alignment = { horizontal: "left", vertical: "middle" };
  ws.mergeCells(`C${totalRow.number}:F${totalRow.number}`);

  const balesTotal = totalRow.getCell(7);
  balesTotal.font = { bold: true, size: 12, color: { argb: C_NAVY } };
  balesTotal.numFmt = "#,##0";
  balesTotal.alignment = { horizontal: "center", vertical: "middle" };

  const grandTotal = totalRow.getCell(8);
  grandTotal.font = { bold: true, size: 12, color: { argb: C_NAVY } };
  grandTotal.numFmt = "#,##0.00";
  grandTotal.alignment = { horizontal: "right", vertical: "middle" };

  // ── Freeze & auto-filter ─────────────────────────────────────────
  ws.views = [{ state: "frozen", xSplit: 0, ySplit: 6 }];
  ws.autoFilter = { from: "A6", to: `H${lastDataRow}` };

  // ── Download ─────────────────────────────────────────────────────
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);

  return { priceHeader };
}

export async function downloadNoPriceBaleOrderSheet(options: BaleOrderSheetInput): Promise<void> {
  const { products, categoryMap } = options;
  const ExcelJSModule = await import("exceljs");
  const ExcelJS = ExcelJSModule.default ?? ExcelJSModule;

  const today = new Date().toISOString().slice(0, 10);

  const C_NAVY = "FF00205B";
  const C_BLUE = "FF1F3A6B";
  const C_ACCENT = "FF2E75B6";
  const C_ALT_ROW = "FFDCE6F1";
  const C_WHITE = "FFFFFFFF";
  const C_BORDER = "FFBFBFBF";
  const C_MUTED = "FF888888";
  const C_TOTAL = "FFE8F0F8";

  const wb = new ExcelJS.Workbook();
  wb.creator = "HMD International Group";
  const ws = wb.addWorksheet("Make Your Order");

  // A=#, B=Article(hidden), C=Name, D=Category, E=Weight, F=Bales
  ws.columns = [
    { key: "num", width: 6 },
    { key: "article", width: 18, hidden: true },
    { key: "name", width: 48 },
    { key: "category", width: 22 },
    { key: "weight", width: 14 },
    { key: "bales", width: 14 },
  ];

  // ── Logo ─────────────────────────────────────────────────────────
  try {
    const logoRes = await fetch(hmdLogoPath);
    const logoBuffer = await logoRes.arrayBuffer();
    const imageId = wb.addImage({ buffer: logoBuffer, extension: "png" });
    ws.addImage(imageId, { tl: { col: 0, row: 0 }, ext: { width: 180, height: 72 } });
  } catch {
    /* logo fetch failed — skip */
  }

  const addHeaderRow = (
    text: string,
    height: number,
    font: { bold?: boolean; size?: number; color?: { argb: string } }
  ) => {
    const r = ws.addRow(["", "", text, "", "", ""]);
    r.height = height;
    const cell = r.getCell(3);
    cell.font = font;
    cell.alignment = { vertical: "middle", horizontal: "left" };
    ws.mergeCells(`C${r.number}:F${r.number}`);
    return r;
  };

  addHeaderRow("HMD International Group", 24, { bold: true, size: 16, color: { argb: C_NAVY } });
  addHeaderRow("Make Your Order", 20, { bold: true, size: 12, color: { argb: C_ACCENT } });
  addHeaderRow(`Enter quantities in the "Bales" column`, 16, { size: 10, color: { argb: C_MUTED } });
  addHeaderRow(`Generated: ${today}`, 16, { size: 10, color: { argb: C_MUTED } });

  const spacer = ws.addRow(["", "", "", "", "", ""]);
  spacer.height = 6;
  ws.mergeCells(`A${spacer.number}:F${spacer.number}`);
  spacer.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: C_NAVY } };

  const hdrRow = ws.addRow(["#", "Article Code", "Name of Item", "Category", "Weight (kg)", "Bales"]);
  hdrRow.height = 22;
  hdrRow.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C_BLUE } };
    cell.font = { bold: true, color: { argb: C_WHITE }, size: 11 };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = {
      top: { style: "thin", color: { argb: C_BLUE } },
      bottom: { style: "medium", color: { argb: C_NAVY } },
      left: { style: "thin", color: { argb: C_BLUE } },
      right: { style: "thin", color: { argb: C_BLUE } },
    };
  });

  const DATA_START = 7;
  products.forEach((p, i) => {
    const categoryName = p.categoryId ? categoryMap.get(p.categoryId) || "" : "";
    const weight = p.weightPerBaleKg != null ? parseFloat(String(p.weightPerBaleKg)) : "";

    const row = ws.addRow([
      `#${i + 1}`,
      p.articleCode || "",
      p.name || "",
      categoryName,
      weight,
      "", // Bales — blank for user input
    ]);
    row.height = 18;

    const isAlt = i % 2 === 1;
    const rowFill: FillPattern | undefined = isAlt
      ? { type: "pattern", pattern: "solid", fgColor: { argb: C_ALT_ROW } }
      : undefined;

    row.eachCell((cell: ExcelCell, colNum: number) => {
      if (rowFill) cell.fill = rowFill;
      cell.font = { size: 10 };
      cell.border = { bottom: { style: "hair", color: { argb: C_BORDER } } };
      if (colNum === 1) cell.alignment = { horizontal: "center" };
      if (colNum === 5) cell.alignment = { horizontal: "right" };
      if (colNum === 6) cell.alignment = { horizontal: "center" };
    });
    if (weight !== "") row.getCell(5).numFmt = "#,##0.##";
  });

  // ── Total row ────────────────────────────────────────────────────
  const lastDataRow = DATA_START + products.length - 1;
  const totalRow = ws.addRow([
    "",
    "",
    "TOTAL ORDER",
    "",
    "",
    { formula: `=SUM(F${DATA_START}:F${lastDataRow})`, result: 0 },
  ]);
  totalRow.height = 22;
  const totalFill: FillPattern = { type: "pattern", pattern: "solid", fgColor: { argb: C_TOTAL } };
  totalRow.eachCell((cell: ExcelCell) => {
    cell.fill = totalFill;
    cell.border = {
      top: { style: "medium", color: { argb: C_NAVY } },
      bottom: { style: "medium", color: { argb: C_NAVY } },
    };
  });
  ws.mergeCells(`C${totalRow.number}:E${totalRow.number}`);
  const labelCell = totalRow.getCell(3);
  labelCell.font = { bold: true, size: 11, color: { argb: C_NAVY } };
  labelCell.alignment = { horizontal: "left", vertical: "middle" };

  const balesTotal = totalRow.getCell(6);
  balesTotal.font = { bold: true, size: 12, color: { argb: C_NAVY } };
  balesTotal.numFmt = "#,##0";
  balesTotal.alignment = { horizontal: "center", vertical: "middle" };

  ws.views = [{ state: "frozen", xSplit: 0, ySplit: 6 }];
  ws.autoFilter = { from: "A6", to: `F${lastDataRow}` };

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "HMD_Order_No_Prices.xlsx";
  a.click();
  URL.revokeObjectURL(url);
}
