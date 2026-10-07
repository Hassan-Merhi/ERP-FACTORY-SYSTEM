/**
 * Printable HTML for the invoice and session loading reports.
 *
 * Kept apart from the route handlers: these functions only format data the
 * handlers already loaded and scoped to the company, and every user-entered
 * value is passed through escapeHtml.
 */
import { escapeHtml } from "../../../lib/escapeHtml";
import { sumMoney, toMoney } from "../../../lib/money";
import type { buildLoadingSummary } from "./_helpers";

export type LoadingSummary = NonNullable<Awaited<ReturnType<typeof buildLoadingSummary>>>;

interface ReportBale {
  baleReference: string;
  articleCode?: string | null;
  productName?: string | null;
  weightKg: string | null;
}

export function renderInvoiceLoadingReportHtml(summary: LoadingSummary): string {
  const inv = summary.invoice;
  const remainingBales = summary.invoiceBales.filter((b) => !b.loaded);
  const loadedBales = summary.invoiceBales.filter((b) => b.loaded);
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Loading Report - ${escapeHtml(inv.invoiceNumber || "#" + inv.id)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 11px; padding: 20px 24px; color: #111827; background: #fff; }
  .header { background: #1e3a5f; color: #fff; padding: 12px 16px; border-radius: 4px; margin-bottom: 14px; }
  .header h1 { font-size: 16px; font-weight: 700; letter-spacing: 0.5px; }
  .header p { font-size: 10px; opacity: 0.75; margin-top: 2px; }
  .meta-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 14px; }
  .meta-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 3px; padding: 6px 10px; }
  .meta-box .lbl { font-size: 9px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.4px; }
  .meta-box .val { font-weight: 700; font-size: 11px; margin-top: 2px; }
  .totals { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin-bottom: 14px; }
  .total-box { border-radius: 4px; padding: 10px; text-align: center; }
  .total-box .num { font-size: 28px; font-weight: 800; line-height: 1; }
  .total-box .lbl { font-size: 9px; text-transform: uppercase; letter-spacing: 0.4px; margin-top: 3px; }
  .total-all { background: #e0e7ff; color: #3730a3; }
  .total-loaded { background: #d1fae5; color: #065f46; }
  .total-remaining { background: #fef3c7; color: #b45309; }
  .total-remaining.done { background: #d1fae5; color: #065f46; }
  .section-title { background: #1e3a5f; color: #fff; font-size: 10px; font-weight: 700; padding: 5px 8px; letter-spacing: 0.5px; margin-top: 12px; margin-bottom: 0; border-radius: 3px 3px 0 0; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
  th { background: #dbeafe; color: #1e40af; font-size: 9px; font-weight: 700; padding: 5px 7px; border: 1px solid #bfdbfe; text-align: left; }
  th.r { text-align: right; }
  td { padding: 4px 7px; border: 1px solid #e5e7eb; font-size: 10px; }
  td.r { text-align: right; }
  tr:nth-child(even) td { background: #f8fafc; }
  .loaded-row td { background: #f0fdf4; }
  .remaining-row td { background: #fffbeb; }
  .total-row td { background: #dbeafe; font-weight: 700; }
  .status-completed { color: #065f46; font-weight: 700; }
  .status-open { color: #1d4ed8; font-weight: 700; }
  .status-cancelled { color: #6b7280; }
  .badge-loaded { color: #065f46; font-weight: 700; }
  .badge-pending { color: #b45309; font-weight: 700; }
  .all-done { background: #d1fae5; color: #065f46; padding: 8px 12px; border-radius: 3px; font-weight: 700; text-align: center; margin-bottom: 12px; }
  @media print { @page { margin: 12mm; } .section-title { break-after: avoid; } }
</style></head><body>

<div class="header">
  <h1>INVOICE LOADING REPORT</h1>
  <p>Generated ${new Date().toLocaleString()}</p>
</div>

<div class="meta-grid">
  <div class="meta-box"><div class="lbl">Invoice</div><div class="val">${escapeHtml(inv.invoiceNumber || "#" + inv.id)}</div></div>
  <div class="meta-box"><div class="lbl">Customer</div><div class="val">${escapeHtml(inv.customerName || "—")}</div></div>
  <div class="meta-box"><div class="lbl">Date</div><div class="val">${escapeHtml(inv.orderDate || "—")}</div></div>
  <div class="meta-box"><div class="lbl">Status</div><div class="val">${escapeHtml(inv.status || "—")}</div></div>
</div>

<div class="totals">
  <div class="total-box total-all"><div class="num">${summary.totals.invoiceBales}</div><div class="lbl">Invoice Bales</div></div>
  <div class="total-box total-loaded"><div class="num">${summary.totals.alreadyLoaded}</div><div class="lbl">Loaded</div></div>
  <div class="total-box total-remaining${summary.totals.remaining === 0 ? " done" : ""}"><div class="num">${summary.totals.remaining}</div><div class="lbl">Remaining</div></div>
</div>

<div class="section-title">SUMMARY BY ARTICLE</div>
<table>
  <tr><th>Article Code</th><th>Product Name</th><th class="r">Invoice Qty</th><th class="r">Loaded</th><th class="r">Remaining</th><th class="r">Progress</th></tr>
  ${summary.lines
    .map((l) => {
      const pct = l.invoiceQty > 0 ? Math.round((l.alreadyLoaded / l.invoiceQty) * 100) : 0;
      return `<tr${l.remaining === 0 ? ' class="loaded-row"' : ""}><td>${escapeHtml(l.articleCode)}</td><td>${escapeHtml(l.productName || "")}</td><td class="r">${l.invoiceQty}</td><td class="r">${l.alreadyLoaded}</td><td class="r ${l.remaining === 0 ? "badge-loaded" : "badge-pending"}">${l.remaining}</td><td class="r">${pct}%</td></tr>`;
    })
    .join("")}
</table>

<div class="section-title">LOADING SESSIONS (${summary.sessions.length})</div>
<table>
  <tr><th>#</th><th>Status</th><th>Truck</th><th>Driver</th><th>Started</th><th>Completed</th><th class="r">Bales</th></tr>
  ${summary.sessions.map((s, i) => `<tr><td>${i + 1}</td><td class="status-${escapeHtml(s.status.toLowerCase())}">${escapeHtml(s.status)}</td><td>${escapeHtml(s.truckNo || "—")}</td><td>${escapeHtml(s.driverName || "—")}</td><td>${s.startedAt ? new Date(s.startedAt).toLocaleString() : ""}</td><td>${s.completedAt ? new Date(s.completedAt).toLocaleString() : "—"}</td><td class="r">${s.totalBales}</td></tr>`).join("")}
</table>

<div class="section-title">LOADED BALES (${loadedBales.length})</div>
<table>
  <tr><th>#</th><th>Bale Reference</th><th>Article Code</th><th>Product Name</th><th class="r">Weight (kg)</th><th class="r">Session</th></tr>
  ${loadedBales.map((b, i) => `<tr class="loaded-row"><td>${i + 1}</td><td>${escapeHtml(b.baleReference)}</td><td>${escapeHtml(b.articleCode || "")}</td><td>${escapeHtml(b.productName || "")}</td><td class="r">${toMoney(b.weightKg).toFixed(3)}</td><td class="r">${b.loadedSessionId ? "#" + b.loadedSessionId : ""}</td></tr>`).join("")}
  <tr class="total-row"><td colspan="4">Total loaded</td><td class="r">${sumMoney(loadedBales.map((b) => b.weightKg)).toFixed(3)}</td><td class="r">${loadedBales.length} bales</td></tr>
</table>

<div class="section-title">REMAINING BALES TO LOAD (${remainingBales.length})</div>
${
  remainingBales.length === 0
    ? `<div class="all-done">All bales have been loaded.</div>`
    : `<table>
  <tr><th>#</th><th>Bale Reference</th><th>Article Code</th><th>Product Name</th><th class="r">Weight (kg)</th></tr>
  ${remainingBales.map((b, i) => `<tr class="remaining-row"><td>${i + 1}</td><td>${escapeHtml(b.baleReference)}</td><td>${escapeHtml(b.articleCode || "")}</td><td>${escapeHtml(b.productName || "")}</td><td class="r">${toMoney(b.weightKg).toFixed(3)}</td></tr>`).join("")}
  <tr class="total-row"><td colspan="4">Total remaining</td><td class="r">${sumMoney(remainingBales.map((b) => b.weightKg)).toFixed(3)} kg · ${remainingBales.length} bales</td></tr>
</table>`
}

</body></html>`;
}

export interface SessionLoadingReportInput {
  pdfTitle: string;
  session: {
    id: number;
    invoiceId: number;
    truckNo?: string | null;
    driverName?: string | null;
    status: string;
    notes?: string | null;
    startedAt?: Date | string | null;
    completedAt?: Date | string | null;
  };
  invoice?: { invoiceNumber?: string | null; customerName?: string | null } | null;
  sessionBales: Array<ReportBale & { scannedAt?: Date | string | null }>;
  remainingBales: ReportBale[];
}

export function renderSessionLoadingReportHtml({
  pdfTitle,
  session,
  invoice,
  sessionBales,
  remainingBales,
}: SessionLoadingReportInput): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${escapeHtml(pdfTitle || `Loading Session #${session.id}`)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 11px; padding: 20px 24px; color: #111827; }
  .header { background: #1e3a5f; color: #fff; padding: 12px 16px; border-radius: 4px; margin-bottom: 14px; }
  .header h1 { font-size: 15px; font-weight: 700; }
  .header p { font-size: 9px; opacity: 0.7; margin-top: 2px; }
  .meta-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 7px; margin-bottom: 12px; }
  .meta-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 3px; padding: 5px 8px; }
  .meta-box .lbl { font-size: 8px; color: #6b7280; text-transform: uppercase; }
  .meta-box .val { font-weight: 700; font-size: 10px; margin-top: 1px; }
  .totals { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px; }
  .total-box { border-radius: 3px; padding: 8px; text-align: center; }
  .total-box .num { font-size: 24px; font-weight: 800; line-height: 1; }
  .total-box .lbl { font-size: 8px; text-transform: uppercase; margin-top: 2px; }
  .t-scanned { background: #d1fae5; color: #065f46; }
  .t-remaining { background: #fef3c7; color: #b45309; }
  .t-remaining.done { background: #d1fae5; color: #065f46; }
  .section-title { background: #1e3a5f; color: #fff; font-size: 9px; font-weight: 700; padding: 4px 8px; letter-spacing: 0.5px; margin-top: 10px; border-radius: 3px 3px 0 0; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
  th { background: #dbeafe; color: #1e40af; font-size: 8px; font-weight: 700; padding: 4px 6px; border: 1px solid #bfdbfe; }
  th.r { text-align: right; }
  td { padding: 3px 6px; border: 1px solid #e5e7eb; font-size: 10px; }
  td.r { text-align: right; }
  tr:nth-child(even) td { background: #f8fafc; }
  .scanned-row td { background: #f0fdf4; }
  .remaining-row td { background: #fffbeb; }
  .total-row td { background: #dbeafe; font-weight: 700; font-size: 10px; }
  .all-done { background: #d1fae5; color: #065f46; padding: 7px; border-radius: 3px; font-weight: 700; text-align: center; margin-bottom: 10px; font-size: 10px; }
  @media print { @page { margin: 12mm; } }
</style></head><body>

<div class="header">
  <h1>LOADING SESSION #${session.id}</h1>
  <p>Generated ${new Date().toLocaleString()}</p>
</div>

<div class="meta-grid">
  <div class="meta-box"><div class="lbl">Invoice</div><div class="val">${escapeHtml(invoice?.invoiceNumber || "#" + session.invoiceId)}</div></div>
  <div class="meta-box"><div class="lbl">Customer</div><div class="val">${escapeHtml(invoice?.customerName || "—")}</div></div>
  <div class="meta-box"><div class="lbl">Truck No</div><div class="val">${escapeHtml(session.truckNo || "—")}</div></div>
  <div class="meta-box"><div class="lbl">Driver</div><div class="val">${escapeHtml(session.driverName || "—")}</div></div>
  <div class="meta-box"><div class="lbl">Status</div><div class="val">${escapeHtml(session.status)}</div></div>
  <div class="meta-box"><div class="lbl">Started</div><div class="val">${session.startedAt ? new Date(session.startedAt).toLocaleString() : "—"}</div></div>
  <div class="meta-box"><div class="lbl">Completed</div><div class="val">${session.completedAt ? new Date(session.completedAt).toLocaleString() : "—"}</div></div>
  <div class="meta-box"><div class="lbl">Notes</div><div class="val">${escapeHtml(session.notes || "—")}</div></div>
</div>

<div class="totals">
  <div class="total-box t-scanned"><div class="num">${sessionBales.length}</div><div class="lbl">Scanned This Session</div></div>
  <div class="total-box t-remaining${remainingBales.length === 0 ? " done" : ""}"><div class="num">${remainingBales.length}</div><div class="lbl">Remaining Overall</div></div>
</div>

<div class="section-title">SCANNED BALES (${sessionBales.length})</div>
<table>
  <tr><th>#</th><th>Bale Reference</th><th>Article Code</th><th>Product Name</th><th class="r">Weight (kg)</th><th>Scanned At</th></tr>
  ${sessionBales.map((b, i) => `<tr class="scanned-row"><td>${i + 1}</td><td>${escapeHtml(b.baleReference)}</td><td>${escapeHtml(b.articleCode || "")}</td><td>${escapeHtml(b.productName || "")}</td><td class="r">${toMoney(b.weightKg).toFixed(3)}</td><td>${b.scannedAt ? new Date(b.scannedAt).toLocaleString() : ""}</td></tr>`).join("")}
  <tr class="total-row"><td colspan="4">Total</td><td class="r">${sumMoney(sessionBales.map((b) => b.weightKg)).toFixed(3)}</td><td>${sessionBales.length} bales</td></tr>
</table>

<div class="section-title">REMAINING BALES TO LOAD (${remainingBales.length})</div>
${
  remainingBales.length === 0
    ? `<div class="all-done">All bales for this invoice have been loaded.</div>`
    : `<table>
  <tr><th>#</th><th>Bale Reference</th><th>Article Code</th><th>Product Name</th><th class="r">Weight (kg)</th></tr>
  ${remainingBales.map((b, i) => `<tr class="remaining-row"><td>${i + 1}</td><td>${escapeHtml(b.baleReference)}</td><td>${escapeHtml(b.articleCode || "")}</td><td>${escapeHtml(b.productName || "")}</td><td class="r">${toMoney(b.weightKg).toFixed(3)}</td></tr>`).join("")}
  <tr class="total-row"><td colspan="4">Total remaining</td><td class="r">${sumMoney(remainingBales.map((b) => b.weightKg)).toFixed(3)} kg · ${remainingBales.length} bales</td></tr>
</table>`
}

</body></html>`;
}
