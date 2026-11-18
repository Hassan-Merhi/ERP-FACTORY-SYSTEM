// Extracted from ./generateInvoicePdf.ts to keep that module under the source-size cap.

// ── Brand colours (matches generateStockPdf) ──────────────────────────────────
export const CLR_BRAND = "#0f172a";

// dark navy  — header bar, col header, paid box
export const CLR_ACCENT = "#059669";

// emerald    — total row, paid amount
export const CLR_WHITE = "#ffffff";

export const CLR_MUTED = "#94a3b8";

// slate-400  — subtitle / meta text
export const CLR_BODY = "#1e293b";

// slate-800  — item text
export const CLR_ROW_ALT = "#f8fafc";

// slate-50  — alternating stripe
export const CLR_SEP = "#b0bec8";

// slate-300+ — row divider (visible)
const CLR_GREEN = "#059669";

const CLR_RED = "#c2272d";

// ── Normal (full) page geometry ───────────────────────────────────────────────
export const PAGE_W = 595;

export const PAGE_H = 842;

// Standard layout
export const STD_MARGIN_X = 36;

export const STD_MARGIN_Y = 36;

export const STD_USABLE_W = PAGE_W - STD_MARGIN_X * 2;

// 523 pt
export const STD_HEADER_BAR_H = 52;

export const STD_LINE_H_PT = 9;

export const STD_MAX_LINES = 2;

export const STD_SAFETY = 14;

export const STD_THR_H = 18;

export const STD_ROW_H = 15;

export const STD_FONT_ROW = 7.5;

export const STD_FONT_HDR = 7;

// Compact / WhatsApp layout (tighter, customer-safe)
export const CMP_MARGIN_X = 18;

export const CMP_MARGIN_Y = 18;

export const CMP_USABLE_W = PAGE_W - CMP_MARGIN_X * 2;

// 559 pt
export const CMP_HEADER_BAR_H = 40;

export const CMP_LINE_H_PT = 7.5;

export const CMP_MAX_LINES = 1;

// single line + ellipsis
export const CMP_SAFETY = 12;

export const CMP_THR_H = 13;

export const CMP_ROW_H = 11;

export const CMP_FONT_ROW = 6.5;

export const CMP_FONT_HDR = 6.5;

// ── Date formatting ───────────────────────────────────────────────────────────
export function formatDbDate(d: unknown): string {
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
export function wrapText(doc: PDFKit.PDFDocument, text: string, maxWidth: number, maxLines: number): string[] {
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

export function fmtQty(n: number): string {
  return fmtNum(Math.floor(Math.abs(n)));
}

export function fmtUSD(n: number): string {
  return fmtNum(n, "$");
}

export function plColor(n: number): string {
  if (n > 0) return CLR_GREEN;
  if (n < 0) return CLR_RED;
  return CLR_BODY;
}

// ── Types ─────────────────────────────────────────────────────────────────────
export interface InvoiceItem {
  stockItemName: string;
  quantity: number;
  rateUSD: number;
  configuredPrice: number;
}

export interface InvoiceData {
  voucherDate: string;
  description: string | null;
  exchangeRate: number | null;
  /** Persisted voucher currency (never the current UI selection). */
  currency: string;
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

// ── Vertically centred single-line text inside a cell ─────────────────────────
export function cellText(
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
