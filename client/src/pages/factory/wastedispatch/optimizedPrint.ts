import type { HistoryBale, PrintDispatch } from "./optimizedTypes";
import { fmt, fmtKg } from "./utils";
import { printDocument } from "@/lib/printDocument";

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function printDispatchDocument(dispatch: PrintDispatch, bales: HistoryBale[]) {
  const totalWeight = bales.reduce((sum, bale) => sum + Number(bale.weightKg || 0), 0);
  const totalCost = bales.reduce((sum, bale) => sum + Number(bale.totalCost || 0), 0);
  const rows = bales
    .map(
      (bale) => `<tr>
        <td>${escapeHtml(bale.referenceNumber)}</td>
        <td>${escapeHtml(bale.productName)}</td>
        <td class="num">${fmtKg(Number(bale.weightKg || 0))}</td>
        <td class="num">${fmt(Number(bale.totalCost || 0))}</td>
      </tr>`
    )
    .join("");

  printDocument(
    `<!doctype html><html><head><title>Waste Disposal — ${escapeHtml(dispatch.dispatchNumber)}</title>
    <style>
      body{font-family:Arial,sans-serif;font-size:12px;margin:20px;color:#111}
      h1{font-size:18px;margin:0 0 4px}.sub{color:#555;font-size:11px;margin-bottom:16px}
      table{width:100%;border-collapse:collapse;margin-top:12px}th,td{border:1px solid #ccc;padding:6px 8px;text-align:left}
      th{background:#f3f4f6}.num{text-align:right}.total{font-weight:700}.note{margin-top:8px;color:#555}
    </style></head><body>
    <h1>Waste Disposal Record</h1>
    <div class="sub">Dispatch No: ${escapeHtml(dispatch.dispatchNumber)} &nbsp;|&nbsp; Date: ${escapeHtml(dispatch.dispatchDate)}</div>
    ${dispatch.notes ? `<div class="note">Note: ${escapeHtml(dispatch.notes)}</div>` : ""}
    <table><thead><tr><th>Reference</th><th>Product</th><th class="num">Weight (kg)</th><th class="num">Cost Written Off</th></tr></thead>
    <tbody>${rows}</tbody><tfoot><tr class="total"><td colspan="2">TOTAL — ${bales.length} bale(s)</td><td class="num">${fmtKg(totalWeight)}</td><td class="num">${fmt(totalCost)}</td></tr></tfoot></table>
    </body></html>`,
    { closeAfterPrint: true }
  );
}
