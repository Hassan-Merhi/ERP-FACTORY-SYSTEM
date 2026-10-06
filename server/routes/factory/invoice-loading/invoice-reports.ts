/**
 * factoryInvoiceLoadingRoutes: InvoiceLoadingReport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { buildSafeFilename, contentDisposition } from "../../../lib/contentDisposition";
import { requireAuth } from "../../../auth";

import {
  buildLoadingSummary,
  cellBorder,
  cellFill,
  colHeaders,
  dataCell,
  getCompanyId,
  sectionHeader,
} from "./_helpers";
import { sumMoney, toMoney } from "../../../lib/money";

export function registerInvoiceLoadingReportRoutes(app: Express) {
  // GET /api/factory/invoices/:invoiceId/loading-report/export/excel
  app.get(
    "/api/factory/invoices/:invoiceId/loading-report/export/excel",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const invoiceId = parseId(req.params.invoiceId);

        if (invoiceId === null) return res.status(400).json({ message: "Invalid id" });
        if (isNaN(invoiceId)) return res.status(400).json({ message: "Invalid invoice ID" });

        const summary = await buildLoadingSummary(invoiceId, companyId);
        if (!summary) return res.status(404).json({ message: "Invoice not found" });

        const ExcelJS = (await import("exceljs")).default;
        const wb = new ExcelJS.Workbook();
        wb.creator = "HMD International Group";
        wb.created = new Date();

        const inv = summary.invoice;
        const loadedBales = summary.invoiceBales.filter((b) => b.loaded);
        const remainingBales = summary.invoiceBales.filter((b) => !b.loaded);

        // ── Sheet 1: Summary ──
        const ws1 = wb.addWorksheet("Summary");
        ws1.columns = [
          { width: 18 },
          { width: 32 },
          { width: 14 },
          { width: 14 },
          { width: 14 },
          { width: 20 },
          { width: 20 },
        ];

        // Title
        ws1.mergeCells("A1:G1");
        const titleCell = ws1.getCell("A1");
        titleCell.value = "INVOICE LOADING REPORT";
        titleCell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 14 };
        cellFill(titleCell, "FF1E3A5F");
        titleCell.alignment = { horizontal: "center", vertical: "middle" };
        ws1.getRow(1).height = 28;

        // Meta block
        ws1.getRow(2).height = 6;
        const meta = [
          ["Invoice", inv.invoiceNumber || `#${inv.id}`, "Customer", inv.customerName || ""],
          ["Date", inv.orderDate || "", "Status", inv.status || ""],
        ];
        let r = 3;
        meta.forEach((row) => {
          [0, 2].forEach((ci, _idx) => {
            const lc = ws1.getRow(r).getCell(ci + 1);
            lc.value = row[ci];
            lc.font = { bold: true, color: { argb: "FF6B7280" }, size: 10 };
            lc.alignment = { horizontal: "right" };
            const vc = ws1.getRow(r).getCell(ci + 2);
            vc.value = row[ci + 1];
            vc.font = { bold: true, size: 10 };
          });
          ws1.getRow(r).height = 16;
          r++;
        });

        // Totals block
        ws1.getRow(r).height = 8;
        r++;
        const totalsRow = ws1.getRow(r);
        const totalDefs = [
          { label: "INVOICE BALES", val: summary.totals.invoiceBales, fill: "FFE0E7FF", fc: "FF3730A3" },
          { label: "LOADED", val: summary.totals.alreadyLoaded, fill: "FFD1FAE5", fc: "FF065F46" },
          {
            label: "REMAINING",
            val: summary.totals.remaining,
            fill: summary.totals.remaining === 0 ? "FFD1FAE5" : "FFFEF3C7",
            fc: summary.totals.remaining === 0 ? "FF065F46" : "FFB45309",
          },
        ];
        totalDefs.forEach((td, i) => {
          ws1.mergeCells(r, i * 2 + 1, r, i * 2 + 2);
          const hc = ws1.getRow(r).getCell(i * 2 + 1);
          hc.value = td.label;
          hc.font = { bold: true, color: { argb: "FF6B7280" }, size: 9 };
          cellFill(hc, td.fill);
          hc.alignment = { horizontal: "center" };
        });
        totalsRow.height = 16;
        r++;
        const valsRow = ws1.getRow(r);
        totalDefs.forEach((td, i) => {
          ws1.mergeCells(r, i * 2 + 1, r, i * 2 + 2);
          const vc = ws1.getRow(r).getCell(i * 2 + 1);
          vc.value = td.val;
          vc.font = { bold: true, color: { argb: td.fc }, size: 20 };
          cellFill(vc, td.fill);
          vc.alignment = { horizontal: "center", vertical: "middle" };
        });
        valsRow.height = 32;
        r++;

        // Summary by article
        ws1.getRow(r).height = 8;
        r++;
        sectionHeader(ws1, r, "SUMMARY BY ARTICLE", 6);
        r++;
        colHeaders(ws1, r, ["Article Code", "Product Name", "Invoice Qty", "Loaded", "Remaining", "Progress"]);
        r++;
        summary.lines.forEach((l, i) => {
          const pct = l.invoiceQty > 0 ? Math.round((l.alreadyLoaded / l.invoiceQty) * 100) : 0;
          const fillColor = l.remaining === 0 ? "FFF0FDF4" : i % 2 === 0 ? "FFFFFFFF" : "FFF8FAFC";
          const row = ws1.getRow(r);
          dataCell(row.getCell(1), l.articleCode, { fill: fillColor });
          dataCell(row.getCell(2), l.productName, { fill: fillColor });
          dataCell(row.getCell(3), l.invoiceQty, { align: "right", fill: fillColor });
          dataCell(row.getCell(4), l.alreadyLoaded, {
            align: "right",
            fill: fillColor,
            color: "FF065F46",
            bold: l.alreadyLoaded > 0,
          });
          dataCell(row.getCell(5), l.remaining, {
            align: "right",
            fill: fillColor,
            color: l.remaining === 0 ? "FF065F46" : "FFB45309",
            bold: true,
          });
          dataCell(row.getCell(6), `${pct}%`, {
            align: "right",
            fill: fillColor,
            color: pct === 100 ? "FF065F46" : "FF6B7280",
          });
          row.height = 15;
          r++;
        });

        // Loading sessions
        ws1.getRow(r).height = 8;
        r++;
        sectionHeader(ws1, r, "LOADING SESSIONS", 7);
        r++;
        colHeaders(ws1, r, ["Session #", "Status", "Truck No", "Driver", "Started", "Completed", "Bales"]);
        r++;
        summary.sessions.forEach((s, i) => {
          const fill = i % 2 === 0 ? "FFFFFFFF" : "FFF8FAFC";
          const row = ws1.getRow(r);
          dataCell(row.getCell(1), `#${s.id}`, { fill });
          const sc = row.getCell(2);
          sc.value = s.status;
          sc.font = {
            bold: true,
            size: 10,
            color: { argb: s.status === "COMPLETED" ? "FF065F46" : s.status === "CANCELLED" ? "FF6B7280" : "FF1D4ED8" },
          };
          cellFill(sc, fill);
          cellBorder(sc);
          dataCell(row.getCell(3), s.truckNo || "—", { fill });
          dataCell(row.getCell(4), s.driverName || "—", { fill });
          dataCell(row.getCell(5), s.startedAt ? new Date(s.startedAt).toLocaleString() : "", { fill });
          dataCell(row.getCell(6), s.completedAt ? new Date(s.completedAt).toLocaleString() : "—", { fill });
          dataCell(row.getCell(7), s.totalBales, { align: "right", bold: true, fill });
          row.height = 15;
          r++;
        });

        // ── Sheet 2: Loaded Bales ──
        const ws2 = wb.addWorksheet("Loaded Bales");
        ws2.columns = [
          { width: 6 },
          { width: 20 },
          { width: 16 },
          { width: 32 },
          { width: 14 },
          { width: 12 },
          { width: 24 },
        ];
        sectionHeader(ws2, 1, `LOADED BALES  (${loadedBales.length} of ${summary.totals.invoiceBales})`, 7);
        colHeaders(ws2, 2, [
          "#",
          "Bale Reference",
          "Article Code",
          "Product Name",
          "Weight (kg)",
          "Session",
          "Loaded At",
        ]);
        loadedBales.forEach((b, i) => {
          const row = ws2.getRow(i + 3);
          const fill = i % 2 === 0 ? "FFF0FDF4" : "FFFAFFFE";
          dataCell(row.getCell(1), i + 1, { align: "right", fill });
          dataCell(row.getCell(2), b.baleReference, { fill });
          dataCell(row.getCell(3), b.articleCode || "", { fill });
          dataCell(row.getCell(4), b.productName || "", { fill });
          dataCell(row.getCell(5), toMoney(b.weightKg).toFixed(3), { align: "right", fill });
          dataCell(row.getCell(6), b.loadedSessionId ? `#${b.loadedSessionId}` : "", { align: "center", fill });
          dataCell(row.getCell(7), b.loadedAt ? new Date(b.loadedAt).toLocaleString() : "", { fill });
          row.height = 15;
        });
        // Total weight row
        if (loadedBales.length > 0) {
          const tr = ws2.getRow(loadedBales.length + 3);
          ws2.mergeCells(loadedBales.length + 3, 1, loadedBales.length + 3, 4);
          dataCell(tr.getCell(1), `Total: ${loadedBales.length} bales`, { bold: true, fill: "FFDBEAFE" });
          dataCell(tr.getCell(5), sumMoney(loadedBales.map((b) => b.weightKg)).toFixed(3), {
            bold: true,
            align: "right",
            fill: "FFDBEAFE",
          });
          tr.height = 16;
        }

        // ── Sheet 3: Remaining Bales ──
        const ws3 = wb.addWorksheet("Remaining Bales");
        ws3.columns = [{ width: 6 }, { width: 20 }, { width: 16 }, { width: 32 }, { width: 14 }];
        sectionHeader(ws3, 1, `REMAINING BALES TO LOAD  (${remainingBales.length} bales)`, 5);
        if (remainingBales.length === 0) {
          ws3.mergeCells("A2:E2");
          const dc = ws3.getCell("A2");
          dc.value = "All bales have been loaded.";
          dc.font = { bold: true, color: { argb: "FF065F46" }, size: 11 };
          cellFill(dc, "FFD1FAE5");
          dc.alignment = { horizontal: "center" };
          ws3.getRow(2).height = 24;
        } else {
          colHeaders(ws3, 2, ["#", "Bale Reference", "Article Code", "Product Name", "Weight (kg)"]);
          remainingBales.forEach((b, i) => {
            const row = ws3.getRow(i + 3);
            const fill = i % 2 === 0 ? "FFFEF3C7" : "FFFFFBEB";
            dataCell(row.getCell(1), i + 1, { align: "right", fill });
            dataCell(row.getCell(2), b.baleReference, { bold: true, fill });
            dataCell(row.getCell(3), b.articleCode || "", { fill });
            dataCell(row.getCell(4), b.productName || "", { fill });
            dataCell(row.getCell(5), toMoney(b.weightKg).toFixed(3), { align: "right", fill });
            row.height = 15;
          });
          // Total row
          const tr = ws3.getRow(remainingBales.length + 3);
          ws3.mergeCells(remainingBales.length + 3, 1, remainingBales.length + 3, 4);
          dataCell(tr.getCell(1), `Total: ${remainingBales.length} bales remaining`, { bold: true, fill: "FFFEF3C7" });
          dataCell(tr.getCell(5), sumMoney(remainingBales.map((b) => b.weightKg)).toFixed(3), {
            bold: true,
            align: "right",
            fill: "FFFEF3C7",
          });
          tr.height = 16;
        }

        const filename = buildSafeFilename([inv.containerNumber, inv.customerName, inv.destination], "xlsx");
        // Build buffer BEFORE setting headers so a failed writeBuffer() can still return a JSON 500.
        const xlsBuf1 = Buffer.from(await wb.xlsx.writeBuffer());
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", contentDisposition(filename));
        res.setHeader("Content-Length", xlsBuf1.byteLength);
        res.end(xlsBuf1);
      } catch (error: unknown) {
        logger.error("loading report excel error:", { error: error });
        if (!res.headersSent) res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // GET /api/factory/invoices/:invoiceId/loading-report/export/pdf
  app.get(
    "/api/factory/invoices/:invoiceId/loading-report/export/pdf",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const invoiceId = parseId(req.params.invoiceId);

        if (invoiceId === null) return res.status(400).json({ message: "Invalid id" });
        if (isNaN(invoiceId)) return res.status(400).json({ message: "Invalid invoice ID" });

        const summary = await buildLoadingSummary(invoiceId, companyId);
        if (!summary) return res.status(404).json({ message: "Invoice not found" });

        const inv = summary.invoice;
        const remainingBales = summary.invoiceBales.filter((b) => !b.loaded);
        const loadedBales = summary.invoiceBales.filter((b) => b.loaded);

        const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Loading Report - ${inv.invoiceNumber || "#" + inv.id}</title>
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
  <div class="meta-box"><div class="lbl">Invoice</div><div class="val">${inv.invoiceNumber || "#" + inv.id}</div></div>
  <div class="meta-box"><div class="lbl">Customer</div><div class="val">${inv.customerName || "—"}</div></div>
  <div class="meta-box"><div class="lbl">Date</div><div class="val">${inv.orderDate || "—"}</div></div>
  <div class="meta-box"><div class="lbl">Status</div><div class="val">${inv.status || "—"}</div></div>
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
      return `<tr${l.remaining === 0 ? ' class="loaded-row"' : ""}><td>${l.articleCode}</td><td>${l.productName || ""}</td><td class="r">${l.invoiceQty}</td><td class="r">${l.alreadyLoaded}</td><td class="r ${l.remaining === 0 ? "badge-loaded" : "badge-pending"}">${l.remaining}</td><td class="r">${pct}%</td></tr>`;
    })
    .join("")}
</table>

<div class="section-title">LOADING SESSIONS (${summary.sessions.length})</div>
<table>
  <tr><th>#</th><th>Status</th><th>Truck</th><th>Driver</th><th>Started</th><th>Completed</th><th class="r">Bales</th></tr>
  ${summary.sessions.map((s, i) => `<tr><td>${i + 1}</td><td class="status-${s.status.toLowerCase()}">${s.status}</td><td>${s.truckNo || "—"}</td><td>${s.driverName || "—"}</td><td>${s.startedAt ? new Date(s.startedAt).toLocaleString() : ""}</td><td>${s.completedAt ? new Date(s.completedAt).toLocaleString() : "—"}</td><td class="r">${s.totalBales}</td></tr>`).join("")}
</table>

<div class="section-title">LOADED BALES (${loadedBales.length})</div>
<table>
  <tr><th>#</th><th>Bale Reference</th><th>Article Code</th><th>Product Name</th><th class="r">Weight (kg)</th><th class="r">Session</th></tr>
  ${loadedBales.map((b, i) => `<tr class="loaded-row"><td>${i + 1}</td><td>${b.baleReference}</td><td>${b.articleCode || ""}</td><td>${b.productName || ""}</td><td class="r">${toMoney(b.weightKg).toFixed(3)}</td><td class="r">${b.loadedSessionId ? "#" + b.loadedSessionId : ""}</td></tr>`).join("")}
  <tr class="total-row"><td colspan="4">Total loaded</td><td class="r">${sumMoney(loadedBales.map((b) => b.weightKg)).toFixed(3)}</td><td class="r">${loadedBales.length} bales</td></tr>
</table>

<div class="section-title">REMAINING BALES TO LOAD (${remainingBales.length})</div>
${
  remainingBales.length === 0
    ? `<div class="all-done">All bales have been loaded.</div>`
    : `<table>
  <tr><th>#</th><th>Bale Reference</th><th>Article Code</th><th>Product Name</th><th class="r">Weight (kg)</th></tr>
  ${remainingBales.map((b, i) => `<tr class="remaining-row"><td>${i + 1}</td><td>${b.baleReference}</td><td>${b.articleCode || ""}</td><td>${b.productName || ""}</td><td class="r">${toMoney(b.weightKg).toFixed(3)}</td></tr>`).join("")}
  <tr class="total-row"><td colspan="4">Total remaining</td><td class="r">${sumMoney(remainingBales.map((b) => b.weightKg)).toFixed(3)} kg · ${remainingBales.length} bales</td></tr>
</table>`
}

</body></html>`;

        res.setHeader("Content-Type", "text/html");
        res.send(html);
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
