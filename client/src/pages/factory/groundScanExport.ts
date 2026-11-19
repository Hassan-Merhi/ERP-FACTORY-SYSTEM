// Extracted from ./GroundScanModel.ts: the ground-verification Excel export (system stock vs scanned bales).
import { styleFactoryOperationalWorkbook } from "@shared/universal-excel/factoryOperationalStyle";
import * as XLSX from "@/lib/excelHelper";
import type { Cell, Row } from "exceljs";
import type { useGroundScanState } from "./useGroundScanState";

export async function exportGroundScanWorkbook({
  selectedLocationId,
  scannedBales,
  stockLocations,
  totalWeight,
}: {
  selectedLocationId: ReturnType<typeof useGroundScanState>["selectedLocationId"];
  scannedBales: ReturnType<typeof useGroundScanState>["scannedBales"];
  stockLocations: ReturnType<typeof useGroundScanState>["stockLocations"];
  totalWeight: ReturnType<typeof useGroundScanState>["totalWeight"];
}) {
  const locParam = selectedLocationId && selectedLocationId !== "all" ? `?locationId=${selectedLocationId}` : "";
  const res = await fetch(`/api/factory/stock-entry/in-stock${locParam}`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch system stock");
  const allFetched: {
    referenceNumber: string;
    articleCode: string;
    productName?: string;
    weightKg: string;
    isInLoadingOrder?: boolean;
    stockEntryDate?: string | null;
    workerName?: string | null;
  }[] = await res.json();
  const systemBales = allFetched.filter((b) => !b.isInLoadingOrder);

  const scannedRefs = new Set(scannedBales.map((b) => b.refCode.toUpperCase()));
  const systemRefs = new Set(systemBales.map((b) => (b.referenceNumber || "").toUpperCase()));

  type ArticleRow = {
    articleCode: string;
    productName: string;
    systemQty: number;
    systemWt: number;
    scannedQty: number;
    scannedWt: number;
  };
  const articleMap = new Map<string, ArticleRow>();
  const ensure = (key: string, name: string) => {
    if (!articleMap.has(key))
      articleMap.set(key, {
        articleCode: key,
        productName: name,
        systemQty: 0,
        systemWt: 0,
        scannedQty: 0,
        scannedWt: 0,
      });
    return articleMap.get(key)!;
  };
  for (const b of systemBales) {
    const r = ensure(b.articleCode || "UNKNOWN", b.productName || "");
    r.systemQty++;
    r.systemWt += parseFloat(b.weightKg || "0");
  }
  for (const b of scannedBales) {
    const r = ensure(b.articleCode || "UNKNOWN", b.productName || "");
    r.scannedQty++;
    r.scannedWt += b.weightKg;
  }

  const missingBales = systemBales.filter((b) => !scannedRefs.has((b.referenceNumber || "").toUpperCase()));
  const extraBales = scannedBales.filter((b) => !systemRefs.has(b.refCode.toUpperCase()));
  const totalSystemWt = systemBales.reduce((s, b) => s + parseFloat(b.weightKg || "0"), 0);
  const totalMissingWt = missingBales.reduce((s, b) => s + parseFloat(b.weightKg || "0"), 0);
  const summaryArticles = [...articleMap.values()].sort((a, b) => a.articleCode.localeCompare(b.articleCode));

  const dateStr = new Date().toISOString().slice(0, 10);
  const timeStr = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  const { ExcelJS } = XLSX;
  const wb = new ExcelJS.Workbook();
  wb.creator = "HMD ERP";
  wb.created = new Date();

  const NAVY = "FF1B2A4A";
  const BLUE = "FF2D5A8E";
  const GREEN = "FF1A7A3C";
  const LGREEN = "FFD4EDDA";
  const RED = "FFC0392B";
  const LRED = "FFFCE8E8";
  const AMBER = "FFB7860B";
  const LAMBER = "FFFEF3CD";
  const GRAY = "FF6C757D";
  const LGRAY = "FFF5F7FA";
  const WHITE = "FFFFFFFF";
  const BLACK = "FF1A1A1A";
  const TOTALBG = "FFE8F0F8";

  const solidFill = (argb: string) => ({ type: "pattern" as const, pattern: "solid" as const, fgColor: { argb } });
  const thinBorder = { style: "thin" as const, color: { argb: "FFD0D7E0" } };
  const allBorders = { top: thinBorder, left: thinBorder, bottom: thinBorder, right: thinBorder };

  const styleHeader = (row: Row, bgArgb: string) => {
    row.font = { bold: true, color: { argb: WHITE }, size: 10, name: "Calibri" };
    row.fill = solidFill(bgArgb);
    row.alignment = { vertical: "middle" as const, horizontal: "center" as const, wrapText: false };
    row.height = 22;
    row.eachCell((cell: Cell) => {
      cell.border = allBorders;
    });
  };

  const styleDataRow = (row: Row, even: boolean, highlight?: { argb: string }) => {
    const bg = highlight ? highlight.argb : even ? LGRAY : WHITE;
    row.fill = solidFill(bg);
    row.font = { size: 10, name: "Calibri", color: { argb: BLACK } };
    row.height = 18;
    row.eachCell({ includeEmpty: true }, (cell: Cell) => {
      cell.border = allBorders;
    });
  };

  const styleTotals = (row: Row) => {
    row.fill = solidFill(TOTALBG);
    row.font = { bold: true, size: 10, name: "Calibri", color: { argb: NAVY } };
    row.height = 20;
    row.eachCell({ includeEmpty: true }, (cell: Cell) => {
      cell.border = {
        ...allBorders,
        top: { style: "medium" as const, color: { argb: NAVY } },
        bottom: { style: "medium" as const, color: { argb: NAVY } },
      };
    });
  };

  // ══ Sheet 1 — Summary ══════════════════════════════════════════════════
  const ws1 = wb.addWorksheet("Summary");
  ws1.columns = [
    { key: "a", width: 18 },
    { key: "b", width: 34 },
    { key: "c", width: 14 },
    { key: "d", width: 17 },
    { key: "e", width: 14 },
    { key: "f", width: 17 },
    { key: "g", width: 14 },
    { key: "h", width: 17 },
  ];

  const locationLabel =
    selectedLocationId !== "all"
      ? (stockLocations?.find((l) => String(l.id) === selectedLocationId)?.name ?? `Location ${selectedLocationId}`)
      : "All Locations";

  ws1.addRow([`Ground Stock Verification Report — ${locationLabel}`]);
  const titleRow = ws1.lastRow!;
  titleRow.height = 30;
  titleRow.getCell(1).font = { bold: true, size: 16, name: "Calibri", color: { argb: NAVY } };
  titleRow.getCell(1).alignment = { vertical: "middle" };
  ws1.mergeCells("A1:H1");

  ws1.addRow([`Date: ${dateStr}   Time: ${timeStr}   |   Location: ${locationLabel}`]);
  const subRow = ws1.lastRow!;
  subRow.height = 16;
  subRow.getCell(1).font = { size: 10, name: "Calibri", color: { argb: GRAY } };
  subRow.getCell(1).alignment = { vertical: "middle" };
  ws1.mergeCells("A2:H2");

  ws1.addRow([]);

  const stats = [
    { label: "System (IN STOCK)", value: systemBales.length, color: BLUE },
    { label: "Scanned on Ground", value: scannedBales.length, color: GREEN },
    { label: "Missing Bales", value: missingBales.length, color: missingBales.length > 0 ? RED : GRAY },
    { label: "Extra Bales", value: extraBales.length, color: extraBales.length > 0 ? AMBER : GRAY },
  ];
  const statLabelRow = ws1.addRow(stats.map((s) => s.label));
  statLabelRow.height = 18;
  stats.forEach((s, i) => {
    const cell = statLabelRow.getCell(i * 2 + 1);
    cell.font = { bold: true, size: 9, color: { argb: WHITE }, name: "Calibri" };
    cell.fill = solidFill(s.color);
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = allBorders;
    if (i < 3) ws1.mergeCells(statLabelRow.number, i * 2 + 1, statLabelRow.number, i * 2 + 2);
    else ws1.mergeCells(statLabelRow.number, 7, statLabelRow.number, 8);
  });
  const statValueRow = ws1.addRow(stats.map((s) => s.value));
  statValueRow.height = 26;
  stats.forEach((s, i) => {
    const cell = statValueRow.getCell(i * 2 + 1);
    cell.font = { bold: true, size: 18, color: { argb: s.color }, name: "Calibri" };
    cell.fill = solidFill(WHITE);
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = allBorders;
    if (i < 3) ws1.mergeCells(statValueRow.number, i * 2 + 1, statValueRow.number, i * 2 + 2);
    else ws1.mergeCells(statValueRow.number, 7, statValueRow.number, 8);
  });

  ws1.addRow([]);

  const artHdrRow = ws1.addRow([
    "Article Code",
    "Product Name",
    "System Qty",
    "System Wt (kg)",
    "Scanned Qty",
    "Scanned Wt (kg)",
    "Missing Qty",
    "Missing Wt (kg)",
  ]);
  styleHeader(artHdrRow, NAVY);
  artHdrRow.eachCell((cell, col) => {
    if (col >= 3) cell.alignment = { horizontal: "center", vertical: "middle" };
  });

  summaryArticles.forEach((r, idx) => {
    const missingQty = Math.max(0, r.systemQty - r.scannedQty);
    const missingWt = missingBales
      .filter((b) => (b.articleCode || "UNKNOWN") === r.articleCode)
      .reduce((s, b) => s + parseFloat(b.weightKg || "0"), 0);
    const hasMissing = missingQty > 0;
    const dataRow = ws1.addRow([
      r.articleCode,
      r.productName,
      r.systemQty,
      +r.systemWt.toFixed(3),
      r.scannedQty,
      +r.scannedWt.toFixed(3),
      missingQty,
      +missingWt.toFixed(3),
    ]);
    styleDataRow(dataRow, idx % 2 === 0, hasMissing ? { argb: LRED } : undefined);
    [3, 4, 5, 6, 7, 8].forEach((col) => {
      const cell = dataRow.getCell(col);
      cell.alignment = { horizontal: "right", vertical: "middle" };
      if (col % 2 === 0) cell.numFmt = "#,##0.000";
    });
    if (hasMissing) {
      dataRow.getCell(7).font = { bold: true, color: { argb: RED }, size: 10, name: "Calibri" };
      dataRow.getCell(8).font = { bold: true, color: { argb: RED }, size: 10, name: "Calibri" };
    }
  });

  const totalsRow = ws1.addRow([
    "TOTAL",
    "",
    systemBales.length,
    +totalSystemWt.toFixed(3),
    scannedBales.length,
    +totalWeight.toFixed(3),
    missingBales.length,
    +totalMissingWt.toFixed(3),
  ]);
  styleTotals(totalsRow);
  [3, 4, 5, 6, 7, 8].forEach((col) => {
    const cell = totalsRow.getCell(col);
    cell.alignment = { horizontal: "right", vertical: "middle" };
    if (col % 2 === 0) cell.numFmt = "#,##0.000";
  });
  if (missingBales.length > 0) {
    totalsRow.getCell(7).font = { bold: true, color: { argb: RED }, size: 10, name: "Calibri" };
    totalsRow.getCell(8).font = { bold: true, color: { argb: RED }, size: 10, name: "Calibri" };
  }
  ws1.views = [{ state: "frozen", xSplit: 0, ySplit: 7 }];

  // ══ Sheet 2 — Missing Bales ════════════════════════════════════════════
  const ws2 = wb.addWorksheet("Missing Bales");
  ws2.columns = [
    { key: "a", width: 20 },
    { key: "b", width: 18 },
    { key: "c", width: 36 },
    { key: "d", width: 15 },
    { key: "e", width: 16 },
    { key: "f", width: 22 },
  ];
  ws2.addRow(["Missing Bales"]);
  const m_titleRow = ws2.lastRow!;
  m_titleRow.height = 28;
  m_titleRow.getCell(1).font = { bold: true, size: 15, name: "Calibri", color: { argb: RED } };
  m_titleRow.getCell(1).alignment = { vertical: "middle" };
  ws2.mergeCells("A1:F1");

  ws2.addRow([`Bales recorded IN_STOCK in the system but not found during ground scan  —  ${dateStr}`]);
  const m_sub = ws2.lastRow!;
  m_sub.height = 16;
  m_sub.getCell(1).font = { size: 9, name: "Calibri", color: { argb: GRAY } };
  ws2.mergeCells("A2:F2");
  ws2.addRow([]);

  const m_hdrRow = ws2.addRow([
    "Reference Number",
    "Article Code",
    "Product Name",
    "Weight (kg)",
    "Date Produced",
    "Worker",
  ]);
  styleHeader(m_hdrRow, RED);
  m_hdrRow.getCell(4).alignment = { horizontal: "right", vertical: "middle" };

  if (missingBales.length === 0) {
    const emptyRow = ws2.addRow(["No missing bales — all system bales were found on the ground."]);
    emptyRow.getCell(1).font = { italic: true, color: { argb: GREEN }, name: "Calibri", size: 10 };
    emptyRow.getCell(1).fill = solidFill(LGREEN);
    ws2.mergeCells(`A${emptyRow.number}:F${emptyRow.number}`);
  } else {
    missingBales.forEach((b, idx) => {
      const dr = ws2.addRow([
        b.referenceNumber,
        b.articleCode || "—",
        b.productName || "—",
        +parseFloat(b.weightKg || "0").toFixed(3),
        b.stockEntryDate || "—",
        b.workerName || "—",
      ]);
      styleDataRow(dr, idx % 2 === 0, { argb: idx % 2 === 0 ? LRED : "FFFDF0F0" });
      dr.getCell(1).font = { name: "Courier New", size: 10, color: { argb: BLACK } };
      dr.getCell(4).alignment = { horizontal: "right", vertical: "middle" };
      dr.getCell(4).numFmt = "#,##0.000";
    });
  }

  ws2.addRow([]);
  const m_totRow = ws2.addRow([
    `Total missing: ${missingBales.length} bales`,
    "",
    "",
    +totalMissingWt.toFixed(3),
    "",
    "",
  ]);
  styleTotals(m_totRow);
  m_totRow.getCell(4).alignment = { horizontal: "right", vertical: "middle" };
  m_totRow.getCell(4).numFmt = "#,##0.000";
  ws2.mergeCells(`A${m_totRow.number}:C${m_totRow.number}`);
  ws2.views = [{ state: "frozen", xSplit: 0, ySplit: 4 }];

  // ══ Sheet 3 — Extra Bales (if any) ════════════════════════════════════
  if (extraBales.length > 0) {
    const ws3 = wb.addWorksheet("Extra Bales");
    ws3.columns = [
      { key: "a", width: 20 },
      { key: "b", width: 18 },
      { key: "c", width: 36 },
      { key: "d", width: 15 },
      { key: "e", width: 18 },
      { key: "f", width: 16 },
      { key: "g", width: 22 },
    ];
    ws3.addRow(["Extra Bales"]);
    const e_titleRow = ws3.lastRow!;
    e_titleRow.height = 28;
    e_titleRow.getCell(1).font = { bold: true, size: 15, name: "Calibri", color: { argb: AMBER } };
    ws3.mergeCells("A1:G1");

    ws3.addRow([`Bales scanned on ground that are NOT recorded as IN_STOCK in the system  —  ${dateStr}`]);
    const e_sub = ws3.lastRow!;
    e_sub.height = 16;
    e_sub.getCell(1).font = { size: 9, name: "Calibri", color: { argb: GRAY } };
    ws3.mergeCells("A2:G2");
    ws3.addRow([]);

    const e_hdrRow = ws3.addRow([
      "Ref Code",
      "Article Code",
      "Product Name",
      "Weight (kg)",
      "Status",
      "Date Produced",
      "Worker",
    ]);
    styleHeader(e_hdrRow, BLUE);
    e_hdrRow.getCell(4).alignment = { horizontal: "right", vertical: "middle" };

    extraBales.forEach((b, idx) => {
      const dr = ws3.addRow([
        b.refCode,
        b.articleCode || "—",
        b.productName || "—",
        +b.weightKg.toFixed(3),
        b.status,
        b.dateBaleProduced || "—",
        b.workerName || "—",
      ]);
      styleDataRow(dr, idx % 2 === 0, { argb: idx % 2 === 0 ? LAMBER : "FFFDF8E1" });
      dr.getCell(1).font = { name: "Courier New", size: 10, color: { argb: BLACK } };
      dr.getCell(4).alignment = { horizontal: "right", vertical: "middle" };
      dr.getCell(4).numFmt = "#,##0.000";
    });
    ws3.views = [{ state: "frozen", xSplit: 0, ySplit: 4 }];
  }

  styleFactoryOperationalWorkbook(wb, [
    { name: "Summary", titleRow: 1, headerRow: 7 },
    { name: "Missing Bales", titleRow: 1, headerRow: 4, preserveHeaderFill: true },
    ...(extraBales.length > 0 ? [{ name: "Extra Bales", titleRow: 1, headerRow: 4, preserveHeaderFill: true }] : []),
  ]);
  await XLSX.writeFile(wb, `ground-verification-${dateStr}.xlsx`);
}
