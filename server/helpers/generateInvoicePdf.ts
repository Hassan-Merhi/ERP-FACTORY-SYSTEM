/**
 * Invoice PDF — branded POS Invoice.
 *
 * Full columns  : Description (34%) | Qty (7%) | Rate (10%) | Amt (11%) | Config (11%) | P/L Bale (13%) | Total P/L (14%)
 * Profit hidden : Description (42%) | Qty (8%)  | Rate (18%) | Amt (32%)
 *
 * compactMode/whatsappMode only control sizing (tighter margins/rows, single-
 * line description). Whether P/L columns show is controlled solely by
 * hideProfitCols (visibility settings) and by the auto-hide-when-no-
 * configured-price rule in buildPdf — a WhatsApp invoice for a location with
 * a selling price fix still gets the full 7-column layout above.
 *
 * Numbers : fmtPrint logic — strips trailing ".00", prefixes "$ " for currency
 * Colours : green (#059669) for profit, red (#c2272d) for loss
 */

import { pool } from "../db";
import { toMoney } from "../lib/money";

// ── Brand colours (matches generateStockPdf) ──────────────────────────────────
const CLR_BRAND = "#0f172a"; // dark navy  — header bar, col header, paid box
const CLR_ACCENT = "#059669"; // emerald    — total row, paid amount
const CLR_WHITE = "#ffffff";
const CLR_MUTED = "#94a3b8"; // slate-400  — subtitle / meta text
const CLR_BODY = "#1e293b"; // slate-800  — item text
const CLR_ROW_ALT = "#f8fafc"; // slate-50  — alternating stripe
const CLR_SEP = "#b0bec8"; // slate-300+ — row divider (visible)
const CLR_GREEN = "#059669";
const CLR_RED = "#c2272d";

// ── Normal (full) page geometry ───────────────────────────────────────────────
const PAGE_W = 595;
const PAGE_H = 842;

// Standard layout
const STD_MARGIN_X = 36;
const STD_MARGIN_Y = 36;
const STD_USABLE_W = PAGE_W - STD_MARGIN_X * 2; // 523 pt
const STD_HEADER_BAR_H = 52;
const STD_LINE_H_PT = 9;
const STD_MAX_LINES = 2;
const STD_SAFETY = 14;
const STD_THR_H = 18;
const STD_ROW_H = 15;
const STD_FONT_ROW = 7.5;
const STD_FONT_HDR = 7;

// Compact / WhatsApp layout (tighter, customer-safe)
const CMP_MARGIN_X = 18;
const CMP_MARGIN_Y = 18;
const CMP_USABLE_W = PAGE_W - CMP_MARGIN_X * 2; // 559 pt
const CMP_HEADER_BAR_H = 40;
const CMP_LINE_H_PT = 7.5;
const CMP_MAX_LINES = 1; // single line + ellipsis
const CMP_SAFETY = 12;
const CMP_THR_H = 13;
const CMP_ROW_H = 11;
const CMP_FONT_ROW = 6.5;
const CMP_FONT_HDR = 6.5;

// ── Date formatting ───────────────────────────────────────────────────────────
function formatDbDate(d: unknown): string {
  if (!d) return "";
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  const s = String(d);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  try {
    return new Date(s).toISOString().slice(0, 10);
  } catch {
    return s;
  }
}

// ── Manual text wrapper (prevents PDFKit mid-row page breaks) ─────────────────
function wrapText(doc: PDFKit.PDFDocument, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (doc.widthOfString(candidate) <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      if (lines.length >= maxLines) break;
      current = word;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  const rendered = lines.join(" ");
  const original = words.join(" ");
  if (rendered.length < original.length && lines.length > 0) {
    let last = lines[lines.length - 1];
    const ellipsis = "…";
    while (last.length > 0 && doc.widthOfString(last + ellipsis) > maxWidth) {
      last = last.slice(0, -1).trimEnd();
    }
    lines[lines.length - 1] = last + ellipsis;
  }
  return lines.length > 0 ? lines : [""];
}

// ── Number formatting ─────────────────────────────────────────────────────────
function fmtNum(n: number, prefix = ""): string {
  const fixed = Math.abs(n).toFixed(2).replace(/\.00$/, "");
  const parts = fixed.split(".");
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const num = parts.join(".");
  return prefix ? prefix + "\u00A0" + num : num;
}
function fmtQty(n: number): string {
  return fmtNum(Math.floor(Math.abs(n)));
}
function fmtUSD(n: number): string {
  return fmtNum(n, "$");
}
function plColor(n: number): string {
  if (n > 0) return CLR_GREEN;
  if (n < 0) return CLR_RED;
  return CLR_BODY;
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface InvoiceItem {
  stockItemName: string;
  quantity: number;
  rateUSD: number;
  configuredPrice: number;
}
interface InvoiceData {
  voucherDate: string;
  description: string | null;
  exchangeRate: number | null;
  isCreditSale: boolean;
  companyName: string;
  userName: string;
  customerName: string | null;
  items: InvoiceItem[];
  hideProfitCols: boolean;
  compactMode: boolean;
}

export interface InvoicePdfOpts {
  hideProfitCols?: boolean;
  compactMode?: boolean;
  whatsappMode?: boolean;
}

export interface InvoicePdfMeta {
  buffer: Buffer;
  pageCount: number;
  itemCount: number;
}

// ── DB query ──────────────────────────────────────────────────────────────────

/**
 * Generate invoice PDF and return the raw Buffer.
 * Backward-compatible — existing callers are unaffected.
 */
export async function generateInvoicePdf(
  voucherId: number,
  companyId: number,
  callerUserName?: string,
  opts?: InvoicePdfOpts
): Promise<Buffer> {
  const { buffer } = await generateInvoicePdfMeta(voucherId, companyId, callerUserName, opts);
  return buffer;
}

/**
 * Generate invoice PDF and also return page count and item count.
 * Used by the WhatsApp backend route for validation and dry-run.
 */
export async function generateInvoicePdfMeta(
  voucherId: number,
  companyId: number,
  callerUserName?: string,
  opts?: InvoicePdfOpts
): Promise<InvoicePdfMeta> {
  const vRes = await pool.query<{
    voucher_date: string;
    description: string | null;
    exchange_rate: string | null;
    is_credit_sale: boolean;
    shift_id: number | null;
    company_name: string;
  }>(
    `SELECT v.voucher_date, v.description, v.exchange_rate, v.is_credit_sale, v.shift_id,
            c.name AS company_name
     FROM vouchers v
     JOIN companies c ON c.id = v.company_id
     WHERE v.id = $1 AND v.company_id = $2 LIMIT 1`,
    [voucherId, companyId]
  );
  if (!vRes.rows.length) throw new Error("Voucher not found");
  const v = vRes.rows[0];

  const itemsRes = await pool.query<{
    stock_item_name: string;
    quantity: string;
    selling_price: string;
    configured_price: string | null;
  }>(
    `SELECT s.name AS stock_item_name, si.quantity, si.selling_price, si.configured_price
     FROM sales_items si
     JOIN stock_items s ON s.id = si.stock_item_id
     WHERE si.voucher_id = $1 ORDER BY si.id`,
    [voucherId]
  );
  const items: InvoiceItem[] = itemsRes.rows.map((r) => ({
    stockItemName: r.stock_item_name,
    quantity: toMoney(r.quantity).toNumber(),
    rateUSD: toMoney(r.selling_price).toNumber(),
    configuredPrice: toMoney(r.configured_price).toNumber(),
  }));

  let customerName: string | null = null;
  if (v.is_credit_sale) {
    const cRes = await pool.query<{ customer_name: string }>(
      `SELECT la.name AS customer_name
       FROM voucher_entries ve
       JOIN ledger_accounts la ON la.id = ve.ledger_account_id
       WHERE ve.voucher_id = $1 AND ve.debit_amount::numeric > 0 LIMIT 1`,
      [voucherId]
    );
    customerName = cRes.rows[0]?.customer_name || null;
  }

  let userName = callerUserName || "—";
  if (!callerUserName && v.shift_id) {
    const uRes = await pool.query<{ username: string }>(
      `SELECT u.username FROM pos_shifts ps
       JOIN users u ON u.id = ps.user_id
       WHERE ps.id = $1 LIMIT 1`,
      [v.shift_id]
    );
    userName = uRes.rows[0]?.username || "—";
  }

  // whatsappMode / compactMode both trigger the compact layout (tighter
  // margins/rows). This is purely a sizing choice — it must NOT force the
  // Config/P&L columns to hide. Whether those columns show is controlled
  // solely by opts.hideProfitCols (visibility settings) and by buildPdf's
  // own auto-hide-when-no-configured-price rule below, so a location with a
  // selling price fix still gets P/L per bale + Total P/L on the WhatsApp PDF.
  const compactMode = !!(opts?.compactMode || opts?.whatsappMode);
  const hideProfitCols = opts?.hideProfitCols ?? false;

  const { buffer, pageCount } = await buildPdf({
    voucherDate: formatDbDate(v.voucher_date),
    description: v.description,
    exchangeRate: v.exchange_rate ? toMoney(v.exchange_rate).toNumber() : null,
    isCreditSale: v.is_credit_sale,
    companyName: v.company_name,
    userName,
    customerName,
    items,
    hideProfitCols,
    compactMode,
  });

  return { buffer, pageCount, itemCount: items.length };
}

// ── PDF renderer ──────────────────────────────────────────────────────────────
async function buildPdf(d: InvoiceData): Promise<{ buffer: Buffer; pageCount: number }> {
  const PDFDocument = (await import("pdfkit")).default;

  // ── Resolve geometry constants based on mode ────────────────────────────────
  const MARGIN_X = d.compactMode ? CMP_MARGIN_X : STD_MARGIN_X;
  const MARGIN_Y = d.compactMode ? CMP_MARGIN_Y : STD_MARGIN_Y;
  const USABLE_W = d.compactMode ? CMP_USABLE_W : STD_USABLE_W;
  const HEADER_BAR_H = d.compactMode ? CMP_HEADER_BAR_H : STD_HEADER_BAR_H;
  const LINE_H_PT = d.compactMode ? CMP_LINE_H_PT : STD_LINE_H_PT;
  const MAX_DESC_LINES = d.compactMode ? CMP_MAX_LINES : STD_MAX_LINES;
  const PDFKIT_LINE_SAFETY = d.compactMode ? CMP_SAFETY : STD_SAFETY;
  const THR_H = d.compactMode ? CMP_THR_H : STD_THR_H;
  const ROW_H = d.compactMode ? CMP_ROW_H : STD_ROW_H;
  const FONT_ROW = d.compactMode ? CMP_FONT_ROW : STD_FONT_ROW;
  const FONT_HDR = d.compactMode ? CMP_FONT_HDR : STD_FONT_HDR;

  const doc = new PDFDocument({ margin: 0, size: "A4", autoFirstPage: true });

  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const pdfReady = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  let pageCount = 1; // autoFirstPage adds page 1

  const isMali = d.companyName.toLowerCase().includes("mali");

  // Auto-hide profit columns when no item has a configured price set
  const hasConfiguredPrice = d.items.some((item) => item.configuredPrice > 0);
  const hideProfitCols = d.hideProfitCols || !hasConfiguredPrice;

  // ── Column geometry ──────────────────────────────────────────────────────────
  let COL_DESC_W: number, COL_QTY_W: number, COL_RATE_W: number, COL_AMT_W: number;
  let COL_CFG_W: number, COL_PLB_W: number, COL_TPL_W: number;
  let X_DESC: number, X_QTY: number, X_RATE: number, X_AMT: number;
  let X_CFG: number, X_PLB: number, X_TPL: number;
  let innerDividers: number[];

  if (hideProfitCols) {
    // 4-column compact layout — description gets the most room
    const descPct = d.compactMode ? 0.5 : 0.42;
    const qtyPct = d.compactMode ? 0.08 : 0.08;
    const ratePct = d.compactMode ? 0.18 : 0.18;
    COL_DESC_W = Math.round(USABLE_W * descPct);
    COL_QTY_W = Math.round(USABLE_W * qtyPct);
    COL_RATE_W = Math.round(USABLE_W * ratePct);
    COL_AMT_W = USABLE_W - COL_DESC_W - COL_QTY_W - COL_RATE_W;
    COL_CFG_W = COL_PLB_W = COL_TPL_W = 0;
    X_DESC = MARGIN_X;
    X_QTY = X_DESC + COL_DESC_W;
    X_RATE = X_QTY + COL_QTY_W;
    X_AMT = X_RATE + COL_RATE_W;
    X_CFG = X_PLB = X_TPL = X_AMT;
    innerDividers = [X_QTY, X_RATE, X_AMT];
  } else {
    // 7-column full layout
    COL_DESC_W = Math.round(USABLE_W * 0.34);
    COL_QTY_W = Math.round(USABLE_W * 0.07);
    COL_RATE_W = Math.round(USABLE_W * 0.1);
    COL_AMT_W = Math.round(USABLE_W * 0.11);
    COL_CFG_W = Math.round(USABLE_W * 0.11);
    COL_PLB_W = Math.round(USABLE_W * 0.13);
    COL_TPL_W = USABLE_W - COL_DESC_W - COL_QTY_W - COL_RATE_W - COL_AMT_W - COL_CFG_W - COL_PLB_W;
    X_DESC = MARGIN_X;
    X_QTY = X_DESC + COL_DESC_W;
    X_RATE = X_QTY + COL_QTY_W;
    X_AMT = X_RATE + COL_RATE_W;
    X_CFG = X_AMT + COL_AMT_W;
    X_PLB = X_CFG + COL_CFG_W;
    X_TPL = X_PLB + COL_PLB_W;
    innerDividers = [X_QTY, X_RATE, X_AMT, X_CFG, X_PLB, X_TPL];
  }

  // ── Branded header bar ────────────────────────────────────────────────────────
  doc.save();
  doc.rect(0, 0, PAGE_W, HEADER_BAR_H).fill(CLR_BRAND);
  doc.restore();

  const titleFontSize = d.compactMode ? 12 : 15;
  const metaFontSize = d.compactMode ? 7 : 8;
  const subFontSize = d.compactMode ? 7 : 8.5;
  const titleY = d.compactMode ? 7 : 10;
  const companyY = d.compactMode ? 21 : 29;
  const dateY = d.compactMode ? 9 : 23;
  const userY = d.compactMode ? 18 : 35;

  doc.font("Helvetica-Bold").fontSize(titleFontSize).fillColor(CLR_WHITE);
  doc.text("POS INVOICE", MARGIN_X, titleY, { width: USABLE_W, align: "center", lineBreak: false });

  doc.font("Helvetica").fontSize(subFontSize).fillColor(CLR_MUTED);
  doc.text(d.companyName, MARGIN_X, companyY, { width: USABLE_W * 0.55, align: "center", lineBreak: false });

  doc.font("Helvetica").fontSize(metaFontSize).fillColor(CLR_MUTED);
  doc.text(`Date: ${d.voucherDate}`, MARGIN_X, dateY, { width: USABLE_W - 2, align: "right", lineBreak: false });

  doc.font("Helvetica").fontSize(metaFontSize).fillColor(CLR_MUTED);
  doc.text(`User: ${d.userName}`, MARGIN_X, userY, { width: USABLE_W - 2, align: "right", lineBreak: false });

  let y = HEADER_BAR_H + (d.compactMode ? 4 : 6);

  // ── Daily exchange rate (Mali only) ──────────────────────────────────────────
  if (isMali && d.exchangeRate) {
    const rateH = d.compactMode ? 14 : 18;
    doc.save();
    doc.rect(MARGIN_X, y, USABLE_W, rateH).fill("#fffbeb");
    doc.rect(MARGIN_X, y, USABLE_W, rateH).strokeColor("#fde68a").lineWidth(0.75).stroke();
    doc.restore();
    doc
      .font("Helvetica-Bold")
      .fontSize(d.compactMode ? 7 : 8)
      .fillColor("#92400e");
    const rateStr = `Daily Rate: $1 = ${Math.round(d.exchangeRate).toLocaleString("en-US")} CFA`;
    doc.text(rateStr, MARGIN_X, y + (d.compactMode ? 3 : 5), { width: USABLE_W, align: "center", lineBreak: false });
    y += rateH + (d.compactMode ? 3 : 5);
  }

  // ── Credit sale customer box ──────────────────────────────────────────────────
  if (d.isCreditSale && d.customerName) {
    const boxH = d.compactMode ? 20 : 28;
    doc.save();
    doc.rect(MARGIN_X, y, USABLE_W, boxH).fill("#eff6ff");
    doc.rect(MARGIN_X, y, USABLE_W, boxH).strokeColor("#bfdbfe").lineWidth(0.75).stroke();
    doc.restore();
    doc
      .font("Helvetica-Bold")
      .fontSize(d.compactMode ? 6.5 : 7.5)
      .fillColor("#1e40af");
    doc.text("CREDIT SALE", MARGIN_X + 6, y + (d.compactMode ? 3 : 5), { lineBreak: false });
    doc
      .font("Helvetica")
      .fontSize(d.compactMode ? 6.5 : 7.5)
      .fillColor(CLR_BODY);
    doc.text(`Customer: ${d.customerName}`, MARGIN_X + 6, y + (d.compactMode ? 11 : 16), { lineBreak: false });
    y += boxH + (d.compactMode ? 3 : 5);
  }

  // ── Table column header ───────────────────────────────────────────────────────
  function drawTableHeader(atY: number): number {
    doc.save();
    doc.rect(MARGIN_X, atY, USABLE_W, THR_H).fill(CLR_BRAND);
    doc.restore();

    doc.save();
    doc.strokeColor("rgba(255,255,255,0.15)").lineWidth(0.5);
    for (const x of innerDividers) {
      doc
        .moveTo(x, atY)
        .lineTo(x, atY + THR_H)
        .stroke();
    }
    doc.restore();

    doc.font("Helvetica-Bold").fontSize(FONT_HDR).fillColor(CLR_WHITE);
    cellText(doc, "DESCRIPTION", X_DESC, COL_DESC_W, atY, THR_H, "left");
    cellText(doc, "QTY", X_QTY, COL_QTY_W, atY, THR_H, "center");
    cellText(doc, "RATE", X_RATE, COL_RATE_W, atY, THR_H, "center");
    cellText(doc, "AMT", X_AMT, COL_AMT_W, atY, THR_H, "center");
    if (!hideProfitCols) {
      cellText(doc, "CONFIG", X_CFG, COL_CFG_W, atY, THR_H, "center");
      cellText(doc, "P/L BALE", X_PLB, COL_PLB_W, atY, THR_H, "center");
      cellText(doc, "TOTAL P/L", X_TPL, COL_TPL_W, atY, THR_H, "center");
    }
    return atY + THR_H;
  }

  y = drawTableHeader(y);

  // ── Item rows ─────────────────────────────────────────────────────────────────
  let totalQty = 0;
  let totalAmt = 0;
  let totalPL = 0;
  let rowIndex = 0;

  for (const item of d.items) {
    const amtUSD = item.quantity * item.rateUSD;
    const plBale = item.rateUSD - item.configuredPrice;
    const itemPL = plBale * item.quantity;

    totalQty += item.quantity;
    totalAmt += amtUSD;
    totalPL += itemPL;

    doc.font("Helvetica-Bold").fontSize(FONT_ROW);
    const descW = COL_DESC_W - 8;
    const descLines = wrapText(doc, item.stockItemName, descW, MAX_DESC_LINES);
    const dynH = Math.max(ROW_H, descLines.length * LINE_H_PT + (d.compactMode ? 4 : 6));

    if (y + dynH + PDFKIT_LINE_SAFETY > PAGE_H - MARGIN_Y) {
      doc.addPage({ size: "A4" });
      pageCount++;
      y = MARGIN_Y;
      rowIndex = 0;
      y = drawTableHeader(y);
    }

    // Alternating row stripe
    const rowBg = rowIndex % 2 === 1 ? CLR_ROW_ALT : CLR_WHITE;
    doc.save();
    doc.rect(MARGIN_X, y, USABLE_W, dynH).fill(rowBg);
    doc
      .moveTo(MARGIN_X, y + dynH)
      .lineTo(MARGIN_X + USABLE_W, y + dynH)
      .strokeColor(CLR_SEP)
      .lineWidth(0.75)
      .stroke();
    doc.strokeColor(CLR_SEP).lineWidth(0.75);
    for (const x of innerDividers) {
      doc
        .moveTo(x, y)
        .lineTo(x, y + dynH)
        .stroke();
    }
    doc.restore();

    // Description (wrapped lines — max 1 in compact mode)
    doc.font("Helvetica-Bold").fontSize(FONT_ROW).fillColor(CLR_BRAND);
    for (let li = 0; li < descLines.length; li++) {
      doc.text(descLines[li], X_DESC + 4, y + 3 + li * LINE_H_PT, {
        width: descW,
        align: "left",
        lineBreak: false,
      });
    }

    const cy = y + Math.round((dynH - FONT_ROW) / 2);

    doc.font("Helvetica").fontSize(FONT_ROW).fillColor(CLR_BODY);
    doc.text(fmtQty(item.quantity), X_QTY + 1, cy, { width: COL_QTY_W - 2, align: "center", lineBreak: false });
    doc.text(fmtUSD(item.rateUSD), X_RATE + 1, cy, { width: COL_RATE_W - 2, align: "center", lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(FONT_ROW).fillColor(CLR_BODY);
    doc.text(fmtUSD(amtUSD), X_AMT + 1, cy, { width: COL_AMT_W - 2, align: "center", lineBreak: false });

    if (!hideProfitCols) {
      doc.font("Helvetica").fontSize(FONT_ROW).fillColor(CLR_BODY);
      doc.text(fmtUSD(item.configuredPrice), X_CFG + 1, cy, {
        width: COL_CFG_W - 2,
        align: "center",
        lineBreak: false,
      });
      doc.font("Helvetica-Bold").fontSize(FONT_ROW);
      doc.fillColor(plColor(plBale));
      doc.text(fmtUSD(plBale), X_PLB + 1, cy, { width: COL_PLB_W - 2, align: "center", lineBreak: false });
      doc.fillColor(plColor(itemPL));
      doc.text(fmtUSD(itemPL), X_TPL + 1, cy, { width: COL_TPL_W - 2, align: "center", lineBreak: false });
    }

    y += dynH;
    rowIndex++;

    // Sync PDFKit's internal cursor to our manual tracker after every row.
    doc.y = y;
    doc.x = MARGIN_X;
  }

  // ── TOTAL + TOTAL PAID + footer — keep together on the same page ─────────────
  const totH = d.compactMode ? 14 : 18;
  const paidH = d.compactMode ? 24 : 32;
  const SUMMARY_MIN_H = totH + 6 + paidH + 6 + 22;
  if (y + SUMMARY_MIN_H + PDFKIT_LINE_SAFETY > PAGE_H - MARGIN_Y) {
    doc.addPage({ size: "A4" });
    pageCount++;
    y = MARGIN_Y;
  }

  doc.save();
  doc.rect(MARGIN_X, y, USABLE_W, totH).fill(CLR_ACCENT);
  doc.restore();

  doc
    .font("Helvetica-Bold")
    .fontSize(d.compactMode ? 7 : 8)
    .fillColor(CLR_WHITE);
  cellText(doc, "TOTAL", X_DESC, COL_DESC_W, y, totH, "left");
  cellText(doc, fmtQty(totalQty), X_QTY, COL_QTY_W, y, totH, "center");
  cellText(doc, fmtUSD(totalAmt), X_AMT, COL_AMT_W, y, totH, "center");
  if (!hideProfitCols) {
    const plSign = totalPL > 0 ? "+" : totalPL < 0 ? "−" : "";
    doc.fillColor(totalPL >= 0 ? CLR_WHITE : "#ffaaaa");
    cellText(doc, plSign + fmtUSD(Math.abs(totalPL)), X_TPL, COL_TPL_W, y, totH, "center");
  }
  y += totH + (d.compactMode ? 5 : 8);

  // ── TOTAL PAID block ──────────────────────────────────────────────────────────
  const paidStr = fmtUSD(totalAmt);
  doc.save();
  doc.rect(MARGIN_X, y, USABLE_W, paidH).fill(CLR_BRAND);
  doc.restore();

  doc
    .font("Helvetica")
    .fontSize(d.compactMode ? 7 : 8)
    .fillColor(CLR_MUTED);
  doc.text("TOTAL PAID", MARGIN_X + 10, y + (d.compactMode ? 6 : 8), { lineBreak: false });

  doc
    .font("Helvetica-Bold")
    .fontSize(d.compactMode ? 11 : 14)
    .fillColor(CLR_WHITE);
  const paidW = doc.widthOfString(paidStr);
  doc.text(paidStr, MARGIN_X + USABLE_W - paidW - 10, y + (d.compactMode ? 7 : 9), { lineBreak: false });

  y += paidH + (d.compactMode ? 5 : 8);

  // ── Note box ──────────────────────────────────────────────────────────────────
  if (d.description) {
    doc.font("Helvetica-Bold").fontSize(d.compactMode ? 6.5 : 7.5);
    const noteBodyH = doc.heightOfString(d.description, { width: USABLE_W - 16 });
    const noteH = Math.ceil(noteBodyH) + 14;
    if (y + noteH > PAGE_H - MARGIN_Y) {
      doc.addPage({ size: "A4" });
      pageCount++;
      y = MARGIN_Y;
    }
    doc.save();
    doc.rect(MARGIN_X, y, USABLE_W, noteH).fill("#fffbeb");
    doc.rect(MARGIN_X, y, USABLE_W, noteH).strokeColor("#fde68a").lineWidth(0.75).stroke();
    doc.restore();
    doc
      .font("Helvetica-Bold")
      .fontSize(d.compactMode ? 6.5 : 7.5)
      .fillColor("#92400e");
    doc.text("Note: ", MARGIN_X + 6, y + 5, { lineBreak: false });
    const noteX = MARGIN_X + 6 + doc.widthOfString("Note: ");
    doc
      .font("Helvetica")
      .fontSize(d.compactMode ? 6.5 : 7.5)
      .fillColor(CLR_BODY);
    doc.text(d.description, noteX, y + 5, {
      width: USABLE_W - 6 - doc.widthOfString("Note: "),
      lineBreak: false,
    });
    y += noteH + 8;
  }

  // ── Footer ────────────────────────────────────────────────────────────────────
  y += 4;
  doc.save();
  doc
    .moveTo(MARGIN_X, y)
    .lineTo(MARGIN_X + USABLE_W, y)
    .strokeColor(CLR_ACCENT)
    .lineWidth(1.5)
    .stroke();
  doc.restore();
  y += 6;
  doc
    .font("Helvetica-Bold")
    .fontSize(d.compactMode ? 7 : 8)
    .fillColor(CLR_ACCENT);
  doc.text("Thank you for your business!", MARGIN_X, y, { width: USABLE_W, align: "center", lineBreak: false });

  doc.end();
  const buffer = await pdfReady;
  return { buffer, pageCount };
}

// ── Vertically centred single-line text inside a cell ─────────────────────────
function cellText(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  w: number,
  rowY: number,
  rowH: number,
  align: "left" | "center" | "right"
): void {
  const textY = rowY + Math.round((rowH - 8) / 2);
  const pad = align === "left" ? 4 : 1;
  doc.text(text, x + pad, textY, { width: w - pad * 2, align, lineBreak: false });
}
