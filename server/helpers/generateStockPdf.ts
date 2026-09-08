/**
 * Stock PDF — branded Godown Summary report.
 *
 * Layout : A4, 2 columns (POS) — Particulars | Qty  [UOM]
 *          A4, 4 columns (cost) — Particulars | Qty  [UOM] | Avg Rate | Total Value
 *
 * IMPORTANT: In PDFKit ≥0.17, doc.page.maxY is a FUNCTION, not a number.
 * ensureSpace() always calls it as a function.
 */

import { pool } from "../db";

// ── Geometry ──────────────────────────────────────────────────────────────────
const X_LEFT = 40;
const X_RIGHT = 555;
const CONTENT_W = X_RIGHT - X_LEFT; // 515 pt

// ── Brand colours ─────────────────────────────────────────────────────────────
const CLR_BRAND = "#0f172a"; // dark navy  — header bar + group rows
const CLR_ACCENT = "#059669"; // emerald    — grand total bar
const CLR_WHITE = "#ffffff";
const CLR_MUTED = "#94a3b8"; // slate-400  — subtitle / meta text
const CLR_BODY = "#1e293b"; // slate-800  — item text
const CLR_ROW_ALT = "#f8fafc"; // slate-50   — alternating row stripe
const CLR_ROW_NEG = "#fff0f0"; // red tint   — negative qty
const CLR_SEP = "#b0bec8"; // slate-300+ — row divider (visible)
const CLR_NEG_TEXT = "#c2272d"; // red        — negative qty text

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtQty(n: number): string {
  return (n < 0 ? "-" : "") + Math.floor(Math.abs(n)).toLocaleString("en-US");
}
function fmtAmt(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" }).replace(/ /g, "-");
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface StockRow {
  itemName: string;
  groupName: string;
  uom: string;
  qty: number;
  rate: number;
  totalValue: number;
}

export interface StockPdfResult {
  buffer: Buffer;
  pageCount: number;
  rowCount: number;
}

export interface StockPdfOptions {
  includeZeroStock?: boolean;
  includeNegativeStock?: boolean;
  categoryId?: number | null;
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function generateStockPdf(
  companyId: number,
  companyName: string,
  locationId?: number,
  locationName?: string,
  includeCost: boolean = false,
  stockGroupId?: number | null,
  options: StockPdfOptions = {}
): Promise<StockPdfResult> {
  // ── Fetch inventory ──────────────────────────────────────────────────────────
  const params: number[] = [companyId];
  let locationFilter = "";
  if (locationId) {
    params.push(locationId);
    locationFilter = "AND l.id = $" + params.length;
  }

  let groupFilter = "";
  if (stockGroupId === null) {
    // Explicitly requested the "Unassigned" pseudo-group (items with no stock group).
    groupFilter = "AND sg.id IS NULL";
  } else if (stockGroupId !== undefined) {
    params.push(stockGroupId);
    groupFilter = "AND sg.id = $" + params.length;
  }

  let categoryFilter = "";
  if (options.categoryId !== undefined && options.categoryId !== null) {
    params.push(options.categoryId);
    categoryFilter = "AND si.category_id = $" + params.length;
  }

  const result = await pool.query<{
    item_name: string;
    group_name: string | null;
    uom: string;
    quantity: string;
    average_rate: string | null;
    total_value: string | null;
  }>(
    `SELECT si.name AS item_name,
            sg.name AS group_name,
            si.uom,
            i.quantity,
            i.average_rate,
            i.total_value
     FROM inventory i
     JOIN stock_items si ON si.id = i.stock_item_id
     LEFT JOIN stock_groups sg ON sg.id = si.stock_group_id
     JOIN locations l ON l.id = i.location_id
     WHERE l.company_id = $1
       ${locationFilter}
       ${groupFilter}
       ${categoryFilter}
     ORDER BY LOWER(COALESCE(sg.name, 'zzzzz')), LOWER(si.name)`,
    params
  );

  const includeZeroStock = options.includeZeroStock === true;
  const includeNegativeStock = options.includeNegativeStock !== false;
  const rows: StockRow[] = result.rows
    .map((r) => ({
      itemName: r.item_name,
      groupName: r.group_name || "Unassigned",
      uom: r.uom || "BL",
      qty: parseFloat(r.quantity || "0"),
      rate: parseFloat(r.average_rate || "0"),
      totalValue: parseFloat(r.total_value || "0"),
    }))
    .filter((r) => {
      if (!includeNegativeStock && r.qty < 0) return false;
      if (!includeZeroStock && r.qty === 0) return false;
      return true;
    });

  const grouped: { groupName: string; items: StockRow[] }[] = [];
  for (const row of rows) {
    const last = grouped[grouped.length - 1];
    if (last && last.groupName === row.groupName) last.items.push(row);
    else grouped.push({ groupName: row.groupName, items: [row] });
  }

  const grandTotalQty = rows.reduce((s, r) => s + r.qty, 0);
  const grandTotalValue = rows.reduce((s, r) => s + r.totalValue, 0);
  const uomFirst = rows[0]?.uom || "BL";

  const now = new Date();
  const dateStr = fmtDate(now);
  const printedStr = `${dateStr} ${now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })}`;

  // Title lines
  const mainTitle = locationName ?? companyName;
  const groupNameForTitle = stockGroupId === null ? "Unassigned" : rows[0]?.groupName;
  const subTitle =
    stockGroupId !== undefined && groupNameForTitle ? `Godown Summary — ${groupNameForTitle}` : "Godown Summary";

  // ── Column geometry ──────────────────────────────────────────────────────────
  // Qty column split: number + UOM label
  const COL_UOM_W = 28; // UOM label (right-most)
  const COL_NUM_W = 58; // quantity number
  const X_UOM = X_RIGHT; // right edge of UOM
  const X_NUM = X_UOM - COL_UOM_W - 4; // right edge of qty number

  const COL_RATE_W = includeCost ? 80 : 0;
  const COL_VAL_W = includeCost ? 95 : 0;
  const X_VAL = includeCost ? X_NUM - COL_NUM_W - 8 : 0;
  const X_RATE = includeCost ? X_VAL - COL_VAL_W : 0;

  // ── PDFKit setup ─────────────────────────────────────────────────────────────
  const HEADER_BAR_H = 58; // height of the coloured top bar (covers top margin)
  const META_H = 20; // printed / page line below bar
  const COL_HDR_H = 22; // table column header row

  const PDFDocument = (await import("pdfkit")).default;
  const doc = new PDFDocument({ size: "A4", margin: 40, autoFirstPage: true });

  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const pdfReady = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  let pageNum = 1;
  let rowIndex = 0; // used for alternating rows

  // ── Page-bottom helper ───────────────────────────────────────────────────────
  // PDFKit exposes maxY() as a method on the current page (height minus the
  // bottom margin), so the previous runtime fallbacks were unreachable.
  function pageBottom(): number {
    return doc.page.maxY();
  }

  function ensureSpace(need: number): void {
    if (doc.y + need > pageBottom()) doc.addPage();
  }

  // ── Page header ──────────────────────────────────────────────────────────────
  function drawPageHeader(): void {
    const PW = doc.page.width; // 595.28

    // ── Coloured top bar ──────────────────────────────────────────────────────
    doc.save();
    doc.rect(0, 0, PW, HEADER_BAR_H).fill(CLR_BRAND);
    doc.restore();

    // Company / location name — white bold centred
    doc.font("Helvetica-Bold").fontSize(16).fillColor(CLR_WHITE);
    doc.text(mainTitle, X_LEFT, 10, { width: CONTENT_W, align: "center", lineBreak: false });

    // Subtitle — muted, smaller
    doc.font("Helvetica").fontSize(9).fillColor(CLR_MUTED);
    doc.text(subTitle, X_LEFT, 30, { width: CONTENT_W - 80, align: "center", lineBreak: false });

    // Date — right side of the bar, same row as subtitle
    doc.font("Helvetica").fontSize(9).fillColor(CLR_MUTED);
    doc.text(dateStr, X_LEFT, 30, { width: CONTENT_W, align: "right", lineBreak: false });

    // ── Meta row (printed / page) ─────────────────────────────────────────────
    const metaY = HEADER_BAR_H + 4;
    doc.font("Helvetica").fontSize(7.5).fillColor("#888888");
    doc.text(`Printed: ${printedStr}`, X_LEFT, metaY, { lineBreak: false });
    doc.text(`Page ${pageNum}`, X_LEFT, metaY, { width: CONTENT_W, align: "right", lineBreak: false });

    // ── Column header row ─────────────────────────────────────────────────────
    const thY = metaY + META_H;
    doc.save();
    doc.rect(X_LEFT, thY, CONTENT_W, COL_HDR_H).fill("#f1f5f9");
    // top + bottom border
    doc.moveTo(X_LEFT, thY).lineTo(X_RIGHT, thY).strokeColor("#cbd5e1").lineWidth(1).stroke();
    doc
      .moveTo(X_LEFT, thY + COL_HDR_H)
      .lineTo(X_RIGHT, thY + COL_HDR_H)
      .strokeColor("#cbd5e1")
      .lineWidth(1)
      .stroke();
    doc.restore();

    doc.font("Helvetica-Bold").fontSize(8).fillColor("#64748b");

    // Particulars
    doc.text("PARTICULARS", X_LEFT + 4, thY + 7, { lineBreak: false });

    // Qty (number + uom together as one header label)
    const qtyHdrX = X_NUM - COL_NUM_W;
    const qtyHdrW = COL_NUM_W + 4 + COL_UOM_W;
    doc.text("QTY", qtyHdrX, thY + 7, { width: qtyHdrW, align: "right", lineBreak: false });

    if (includeCost) {
      doc.text("AVG RATE", X_RATE - COL_RATE_W, thY + 7, { width: COL_RATE_W, align: "right", lineBreak: false });
      doc.text("TOTAL VALUE", X_VAL - COL_VAL_W, thY + 7, { width: COL_VAL_W, align: "right", lineBreak: false });
    }

    doc.y = thY + COL_HDR_H + 2;
    doc.fillColor(CLR_BODY);
  }

  drawPageHeader();

  doc.on("pageAdded", () => {
    pageNum++;
    rowIndex = 0;
    drawPageHeader();
  });

  // ── Group + item rows ─────────────────────────────────────────────────────────
  const GROUP_H = 18;
  const ITEM_H = 19;

  for (const { groupName, items } of grouped) {
    const groupQty = items.reduce((s, r) => s + r.qty, 0);
    const groupValue = items.reduce((s, r) => s + r.totalValue, 0);
    const firstUom = items[0]?.uom || "BL";
    const isGroupNeg = groupQty < 0;

    ensureSpace(GROUP_H + ITEM_H);

    // ── Group header — dark brand row ─────────────────────────────────────────
    const gY = doc.y;
    doc.save();
    doc.rect(X_LEFT, gY, CONTENT_W, GROUP_H).fill(isGroupNeg ? CLR_NEG_TEXT : CLR_BRAND);
    doc.restore();

    doc.font("Helvetica-Bold").fontSize(9).fillColor(CLR_WHITE);
    doc.text(groupName, X_LEFT + 8, gY + 5, { lineBreak: false });

    // group qty number
    doc.text(fmtQty(groupQty), X_NUM - COL_NUM_W, gY + 5, { width: COL_NUM_W, align: "right", lineBreak: false });
    // group uom — muted
    doc.font("Helvetica").fontSize(8).fillColor(CLR_MUTED);
    doc.text(firstUom, X_NUM + 4, gY + 6, { width: COL_UOM_W, lineBreak: false });

    if (includeCost) {
      doc.font("Helvetica-Bold").fontSize(9).fillColor(CLR_WHITE);
      doc.text(fmtAmt(groupValue), X_VAL - COL_VAL_W, gY + 5, { width: COL_VAL_W, align: "right", lineBreak: false });
    }

    doc.y = gY + GROUP_H;

    // ── Item rows ─────────────────────────────────────────────────────────────
    for (const item of items) {
      ensureSpace(ITEM_H);

      const iY = doc.y;
      const isNeg = item.qty < 0;
      const isBg = isNeg ? CLR_ROW_NEG : rowIndex % 2 === 1 ? CLR_ROW_ALT : CLR_WHITE;

      doc.save();
      doc.rect(X_LEFT, iY, CONTENT_W, ITEM_H).fill(isBg);
      // bottom separator
      doc
        .moveTo(X_LEFT, iY + ITEM_H)
        .lineTo(X_RIGHT, iY + ITEM_H)
        .strokeColor(CLR_SEP)
        .lineWidth(0.75)
        .stroke();
      doc.restore();

      const textColor = isNeg ? CLR_NEG_TEXT : CLR_BODY;

      // Item name
      doc
        .font(isNeg ? "Helvetica-Bold" : "Helvetica")
        .fontSize(9)
        .fillColor(textColor);
      doc.text(item.itemName, X_LEFT + 18, iY + 5, { lineBreak: false });

      // Qty number — bold, slightly larger
      doc
        .font("Helvetica-Bold")
        .fontSize(9.5)
        .fillColor(isNeg ? CLR_NEG_TEXT : CLR_BRAND);
      doc.text(fmtQty(item.qty), X_NUM - COL_NUM_W, iY + 5, { width: COL_NUM_W, align: "right", lineBreak: false });

      // UOM — small gray label
      doc.font("Helvetica").fontSize(7.5).fillColor(CLR_MUTED);
      doc.text(item.uom, X_NUM + 4, iY + 7, { width: COL_UOM_W, lineBreak: false });

      if (includeCost) {
        doc.font("Helvetica").fontSize(9).fillColor(textColor);
        doc.text(fmtAmt(item.rate), X_RATE - COL_RATE_W, iY + 5, {
          width: COL_RATE_W,
          align: "right",
          lineBreak: false,
        });
        doc.text(fmtAmt(item.totalValue), X_VAL - COL_VAL_W, iY + 5, {
          width: COL_VAL_W,
          align: "right",
          lineBreak: false,
        });
      }

      doc.y = iY + ITEM_H;
      rowIndex++;
    }
  }

  // ── Grand Total row ───────────────────────────────────────────────────────────
  ensureSpace(24);
  doc.y += 3;
  const tY = doc.y;
  const tH = 22;

  doc.save();
  doc.rect(X_LEFT, tY, CONTENT_W, tH).fill(CLR_ACCENT);
  doc.restore();

  doc.font("Helvetica-Bold").fontSize(10).fillColor(CLR_WHITE);
  doc.text("GRAND TOTAL", X_LEFT + 8, tY + 6, { lineBreak: false });

  // Total qty number
  doc.text(fmtQty(grandTotalQty), X_NUM - COL_NUM_W, tY + 6, { width: COL_NUM_W, align: "right", lineBreak: false });

  // Total UOM — slightly muted white
  doc.font("Helvetica").fontSize(8).fillColor("rgba(255,255,255,0.75)");
  doc.text(uomFirst, X_NUM + 4, tY + 8, { width: COL_UOM_W, lineBreak: false });

  if (includeCost) {
    doc.font("Helvetica-Bold").fontSize(10).fillColor(CLR_WHITE);
    doc.text(fmtAmt(grandTotalValue), X_VAL - COL_VAL_W, tY + 6, {
      width: COL_VAL_W,
      align: "right",
      lineBreak: false,
    });
  }

  // ── Footer on last page ───────────────────────────────────────────────────────
  const footerY = pageBottom() - 14;
  doc.font("Helvetica").fontSize(7).fillColor("#b0b8c4");
  doc.text("HMD International Group · Confidential", X_LEFT, footerY, {
    width: CONTENT_W,
    align: "center",
    lineBreak: false,
  });

  doc.end();
  const buffer = await pdfReady;

  return { buffer, pageCount: pageNum, rowCount: rows.length };
}
