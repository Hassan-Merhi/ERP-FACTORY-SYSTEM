import * as XLSX from "@/lib/excelHelper";
import { exportFileName } from "@/lib/exportFile";

import type { BaleDetail, GroupRow } from "./types";
import { buildWorkerMatrix } from "./utils";

interface StockEntryHistoryReportsInput {
  filteredGroups: GroupRow[];
  fetchGroupsWithBales: () => Promise<GroupRow[]>;
  fromDate: string;
  toDate: string;
}

export function createStockEntryHistoryReports({
  filteredGroups,
  fetchGroupsWithBales,
  fromDate,
  toDate,
}: StockEntryHistoryReportsInput) {
  async function exportExcel() {
    const wb = XLSX.utils.book_new();

    const summaryRows = filteredGroups.map((g) => ({
      "Stock Entry Date": g.stockEntryDate,
      Location: g.locationName,
      Worker: g.workerName || "Unassigned",
      Product: g.productName || "—",
      "Article Code": g.articleCode || "—",
      "Bale Count": g.baleCount,
      "Total Weight (kg)": parseFloat(g.totalWeight || "0"),
      "Avg Weight (kg)": parseFloat(g.avgWeight || "0"),
      "First Bale Time": g.firstFinalizedAt ? new Date(g.firstFinalizedAt).toLocaleString() : "—",
      "Last Bale Time": g.lastFinalizedAt ? new Date(g.lastFinalizedAt).toLocaleString() : "—",
    }));
    const ws1 = XLSX.utils.json_to_sheet(summaryRows);
    XLSX.utils.book_append_sheet(wb, ws1, "Summary");

    // In lite mode, we need to fetch full bale data for the detail and matrix sheets.
    const groupsWithBales = await fetchGroupsWithBales();

    const detailRows = groupsWithBales.flatMap((g) =>
      g.bales.map((b) => ({
        "Stock Entry Date": b.stockEntryDate,
        Location: b.locationName,
        Worker: b.workerName || "Unassigned",
        Product: b.productName || "—",
        "Article Code": b.articleCode || "—",
        "Reference Number": b.referenceNumber,
        "Weight (kg)": parseFloat(b.weightKg || "0"),
        Status: b.status,
        "Finalized At": b.finalizedAt ? new Date(b.finalizedAt).toLocaleString() : "—",
      }))
    );
    const ws2 = XLSX.utils.json_to_sheet(detailRows);
    XLSX.utils.book_append_sheet(wb, ws2, "Bale Details");

    const matrix = buildWorkerMatrix(groupsWithBales);
    const ws3 = XLSX.utils.aoa_to_sheet([]);

    XLSX.utils.sheet_add_aoa(ws3, [["Stock Entry History — Worker Matrix"]], { origin: "A1" });
    XLSX.utils.sheet_add_aoa(ws3, [[`Period: ${fromDate}  →  ${toDate}`]], { origin: "A2" });

    const matrixHeader = ["Bale / Product", ...matrix.workers, "Total"];
    XLSX.utils.sheet_add_aoa(ws3, [matrixHeader], { origin: "A4" });

    const matrixData = matrix.rows.map((row) => [
      row.productLabel,
      ...matrix.workers.map((w) => row.counts[w] || 0),
      row.total,
    ]);
    if (matrixData.length > 0) {
      XLSX.utils.sheet_add_aoa(ws3, matrixData, { origin: "A5" });
    }

    const totalsRow = ["TOTAL", ...matrix.workers.map((w) => matrix.workerTotals[w] || 0), matrix.grandTotal];
    XLSX.utils.sheet_add_aoa(ws3, [totalsRow], { origin: { r: 4 + matrix.rows.length, c: 0 } });

    const colWidths = [{ wch: 36 }, ...matrix.workers.map(() => ({ wch: 14 })), { wch: 10 }];
    ws3["!cols"] = colWidths;
    ws3["!freeze"] = { xSplit: 0, ySplit: 4 };

    XLSX.utils.book_append_sheet(wb, ws3, "Worker Matrix");

    await XLSX.writeFile(wb, exportFileName("stock entry history", "xlsx", { from: fromDate, to: toDate }));
  }

  async function handlePrintMatrix() {
    if (filteredGroups.length === 0) return;
    const groupsWithBales = await fetchGroupsWithBales();
    const matrix = buildWorkerMatrix(groupsWithBales);
    const { workers: cols, rows, workerTotals, grandTotal } = matrix;

    // Readable font — minimum 8.5 px regardless of column count
    const fontSize = cols.length > 20 ? 8.5 : cols.length > 14 ? 9.5 : cols.length > 10 ? 10.5 : 11.5;

    // Palette of vivid accent colors for worker columns (cycles if more workers than colors)
    const palette = [
      "#2563eb",
      "#16a34a",
      "#dc2626",
      "#9333ea",
      "#ea580c",
      "#0891b2",
      "#be185d",
      "#65a30d",
      "#7c3aed",
      "#b45309",
      "#0284c7",
      "#15803d",
      "#e11d48",
      "#7e22ce",
      "#c2410c",
      "#0e7490",
      "#9d174d",
      "#4d7c0f",
      "#6d28d9",
      "#92400e",
    ];
    const colColor = (i: number) => palette[i % palette.length];

    // Worker header — split on the last space so two short lines fit the narrow column
    const headerCells = cols
      .map((w, i) => {
        const c = colColor(i);
        const lastSpace = w.lastIndexOf(" ");
        const label = lastSpace > 0 ? `${w.slice(0, lastSpace)}<br/>${w.slice(lastSpace + 1)}` : w;
        return `<th class="wc" style="background:${c};">${label}</th>`;
      })
      .join("");

    // Split "Product Name (CODE)" into two stacked lines to keep the cell narrow
    const prodHtml = (label: string) => {
      const m = label.match(/^(.*)\s\(([^)]+)\)$/);
      if (m) return `${m[1]}<br/><span class="code">${m[2]}</span>`;
      return label;
    };

    const dataRows = rows
      .map((row, idx) => {
        const rowBg = idx % 2 === 0 ? "#ffffff" : "#f1f5f9";
        const cells = cols
          .map((w, i) => {
            const v = row.counts[w] || 0;
            const accent = colColor(i);
            const style =
              v > 0
                ? `style="color:${accent};font-weight:700;background:${rowBg};"`
                : `style="background:${rowBg};color:#cbd5e1;"`;
            return `<td class="num" ${style}>${v > 0 ? v : "&middot;"}</td>`;
          })
          .join("");
        return `<tr>
        <td class="prod" style="background:${rowBg};">${prodHtml(row.productLabel)}</td>
        ${cells}
        <td class="num total-col" style="background:${idx % 2 === 0 ? "#e0f2fe" : "#bae6fd"};">${row.total}</td>
      </tr>`;
      })
      .join("");

    const totalCells = cols
      .map((w, i) => {
        const c = colColor(i);
        return `<td class="num" style="background:${c};color:#fff;">${workerTotals[w] || 0}</td>`;
      })
      .join("");

    // Column widths: product = 12%, total = 7%, workers share the remaining 81%
    const workerColPct = Math.max(2, Math.floor(81 / Math.max(cols.length, 1)));

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Worker Matrix — ${fromDate} to ${toDate}</title>
  <style>
    @page { size: landscape; margin: 8mm 7mm; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; font-size: ${fontSize}px; color: #1e293b; background: #fff; }

    .header { margin-bottom: 5px; display: flex; align-items: flex-end; justify-content: space-between; border-bottom: 2px solid #2563eb; padding-bottom: 3px; }
    .header-left h1 { font-size: ${fontSize + 2.5}px; font-weight: 800; color: #1e3a8a; letter-spacing: -0.3px; }
    .header-left .sub { font-size: ${fontSize - 0.5}px; color: #475569; margin-top: 1px; }
    .header-right { text-align: right; font-size: ${fontSize - 0.5}px; color: #64748b; line-height: 1.5; }
    .header-right strong { color: #1e3a8a; }

    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    thead { display: table-header-group; }
    th, td { border: 1px solid #e2e8f0; padding: 2px 3px; overflow: hidden; }
    th { color: #fff; font-weight: 700; text-align: center; font-size: ${fontSize}px; line-height: 1.3; }
    th.prod-h { background: #1e3a8a; text-align: left; width: 12%; }
    th.wc { width: ${workerColPct}%; }
    th.total-h { background: #0369a1; width: 7%; }

    td.prod { text-align: left; font-weight: 500; word-break: break-word; color: #1e293b; font-size: ${fontSize}px; line-height: 1.3; }
    .code { color: #64748b; font-size: ${Math.max(6.5, fontSize - 1.5)}px; font-weight: 400; }
    td.num { text-align: center; font-size: ${fontSize}px; }
    td.total-col { font-weight: 800; text-align: center; }

    tr.totals-row td { font-weight: 800; border-color: #1e3a8a; }
    tr.totals-row td.prod-total { background: #1e3a8a; color: #fff; text-align: left; }
    tr.totals-row td.grand { background: #0369a1; color: #fff; text-align: center; font-weight: 800; }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <h1>Worker Bale Matrix</h1>
      <div class="sub">Stock Entry History &nbsp;&middot;&nbsp; ${fromDate} &rarr; ${toDate}</div>
    </div>
    <div class="header-right">
      <strong>${cols.length}</strong> worker${cols.length !== 1 ? "s" : ""} &nbsp;|&nbsp;
      <strong>${rows.length}</strong> product${rows.length !== 1 ? "s" : ""} &nbsp;|&nbsp;
      <strong>${grandTotal}</strong> bales total
    </div>
  </div>
  <table>
    <thead>
      <tr>
        <th class="prod-h">Product / Article</th>
        ${headerCells}
        <th class="total-h">Total</th>
      </tr>
    </thead>
    <tbody>
      ${dataRows}
      <tr class="totals-row">
        <td class="prod-total">TOTAL</td>
        ${totalCells}
        <td class="grand">${grandTotal}</td>
      </tr>
    </tbody>
  </table>
  <script>window.onload = function(){ window.print(); };</script>
</body>
</html>`;

    const win = window.open("", "_blank", "width=1200,height=800");
    if (!win) return;
    win.document.write(html);
    win.document.close();
  }

  async function handleExportWorkerPDF() {
    if (filteredGroups.length === 0) return;

    // In lite mode, fetch full bale data for the per-worker PDF.
    const groupsWithBales = await fetchGroupsWithBales();

    // Collect all bales across all groups
    const allBales: BaleDetail[] = groupsWithBales.flatMap((g) => g.bales);

    // Group bales by worker
    const byWorker = new Map<string, BaleDetail[]>();
    for (const b of allBales) {
      const w = b.workerName || "Unassigned";
      if (!byWorker.has(w)) byWorker.set(w, []);
      byWorker.get(w)!.push(b);
    }

    // Sort workers alphabetically
    const sortedWorkers = Array.from(byWorker.keys()).sort((a, b) => a.localeCompare(b, "ar"));

    // Build detail rows (grouped by worker, bales sorted by product)
    let detailRowsHtml = "";
    for (const worker of sortedWorkers) {
      const bales = byWorker.get(worker)!.sort((a, b) => (a.productName || "").localeCompare(b.productName || ""));
      const workerBaleCount = bales.length;
      const workerTotalKg = bales.reduce((s, b) => s + parseFloat(b.weightKg || "0"), 0);

      bales.forEach((b, idx) => {
        const isFirst = idx === 0;
        const isLast = idx === bales.length - 1;
        const productLabel = b.productName
          ? b.articleCode
            ? `${b.productName} (${b.articleCode})`
            : b.productName
          : "—";
        const evenOdd = idx % 2 === 0 ? "#fff" : "#f8fafc";
        detailRowsHtml += `<tr style="background:${evenOdd};">
          <td class="ref">${b.referenceNumber || "—"}</td>
          <td class="worker">${isFirst ? `<span class="worker-name">${worker}</span>` : ""}</td>
          <td class="prod">${productLabel}</td>
          <td class="wt">${parseFloat(b.weightKg || "0").toFixed(0)}</td>
          <td class="total-pp">${isLast ? `<strong>${workerBaleCount}</strong><br/><span class="total-kg">${workerTotalKg.toFixed(0)} kg</span>` : ""}</td>
        </tr>`;
      });
    }

    // Summary — sorted by bale count descending
    const summaryRows = sortedWorkers
      .map((w) => {
        const bales = byWorker.get(w)!;
        const count = bales.length;
        const totalKg = bales.reduce((s, b) => s + parseFloat(b.weightKg || "0"), 0);
        return { worker: w, count, totalKg };
      })
      .sort((a, b) => b.count - a.count);

    const grandBales = summaryRows.reduce((s, r) => s + r.count, 0);
    const grandKg = summaryRows.reduce((s, r) => s + r.totalKg, 0);

    const summaryRowsHtml = summaryRows
      .map(
        (r, idx) => `
      <tr style="background:${idx % 2 === 0 ? "#fff" : "#f8fafc"};">
        <td class="sum-worker">${r.worker}</td>
        <td class="sum-num">${r.count}</td>
        <td class="sum-num">${r.totalKg.toFixed(0)}</td>
      </tr>`
      )
      .join("");

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Worker Bales Report — ${fromDate} to ${toDate}</title>
  <style>
    @page { size: portrait; margin: 10mm 8mm; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 9px; color: #1e293b; background: #fff; }

    .page-header { display: flex; align-items: flex-end; justify-content: space-between; border-bottom: 2px solid #1e3a8a; padding-bottom: 4px; margin-bottom: 8px; }
    .page-header h1 { font-size: 13px; font-weight: 800; color: #1e3a8a; }
    .page-header .sub { font-size: 8.5px; color: #64748b; margin-top: 2px; }
    .page-header .meta { text-align: right; font-size: 8px; color: #64748b; line-height: 1.6; }

    table { width: 100%; border-collapse: collapse; }
    th { background: #1e3a8a; color: #fff; font-weight: 700; padding: 3px 5px; text-align: left; font-size: 8.5px; border: 1px solid #c8d5e8; }
    th.r { text-align: right; }
    td { padding: 2px 5px; border: 1px solid #e2e8f0; vertical-align: middle; font-size: 8.5px; }

    td.ref { font-family: monospace; font-size: 7.5px; color: #334155; white-space: nowrap; }
    td.worker { min-width: 60px; }
    .worker-name { font-weight: 700; color: #1e3a8a; }
    td.prod { color: #334155; }
    td.wt { text-align: right; font-variant-numeric: tabular-nums; }
    td.total-pp { text-align: center; font-size: 8px; color: #0369a1; border-left: 2px solid #bae6fd; }
    .total-kg { font-size: 7px; color: #64748b; }

    .page-break { page-break-before: always; }
    .section-title { font-size: 12px; font-weight: 700; color: #1e3a8a; margin-bottom: 6px; border-bottom: 1.5px solid #1e3a8a; padding-bottom: 3px; }

    td.sum-worker { font-weight: 600; }
    td.sum-num { text-align: right; font-variant-numeric: tabular-nums; font-weight: 500; }
    tr.grand-total td { background: #1e3a8a !important; color: #fff; font-weight: 700; }
    tr.grand-total td.sum-num { text-align: right; }
  </style>
</head>
<body>
  <div class="page-header">
    <div>
      <h1>Worker Bales Report</h1>
      <div class="sub">Stock Entry History &nbsp;&middot;&nbsp; ${fromDate} &rarr; ${toDate}</div>
    </div>
    <div class="meta">
      ${sortedWorkers.length} workers &nbsp;|&nbsp; ${grandBales} bales &nbsp;|&nbsp; ${grandKg.toFixed(0)} kg total
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:16%">Reference</th>
        <th style="width:18%">Worker</th>
        <th>Product</th>
        <th class="r" style="width:9%">Weight (kg)</th>
        <th class="r" style="width:14%">Total / Person</th>
      </tr>
    </thead>
    <tbody>
      ${detailRowsHtml}
      <tr style="background:#1e3a8a;color:#fff;font-weight:800;">
        <td colspan="3" style="color:#fff;padding:3px 5px;">TOTAL</td>
        <td style="text-align:right;color:#fff;padding:3px 5px;">${grandKg.toFixed(0)}</td>
        <td style="text-align:center;color:#fff;padding:3px 5px;">${grandBales}</td>
      </tr>
    </tbody>
  </table>

  <div class="page-break"></div>

  <div class="page-header">
    <div>
      <h1>Worker Summary</h1>
      <div class="sub">Stock Entry History &nbsp;&middot;&nbsp; ${fromDate} &rarr; ${toDate}</div>
    </div>
    <div class="meta">
      ${sortedWorkers.length} workers &nbsp;|&nbsp; ${grandBales} bales &nbsp;|&nbsp; ${grandKg.toFixed(0)} kg
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Worker</th>
        <th class="r" style="width:18%">Bales</th>
        <th class="r" style="width:22%">Total Weight (kg)</th>
      </tr>
    </thead>
    <tbody>
      ${summaryRowsHtml}
      <tr class="grand-total">
        <td></td>
        <td class="sum-num">${grandBales}</td>
        <td class="sum-num">${grandKg.toFixed(0)}</td>
      </tr>
    </tbody>
  </table>

  <script>window.onload = function(){ window.print(); };</script>
</body>
</html>`;

    const win = window.open("", "_blank", "width=900,height=1000");
    if (!win) return;
    win.document.write(html);
    win.document.close();
  }

  return { exportExcel, handlePrintMatrix, handleExportWorkerPDF };
}
