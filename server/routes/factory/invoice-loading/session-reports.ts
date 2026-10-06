/**
 * factoryInvoiceLoadingRoutes: InvoiceLoadingSessionReport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { buildSafeFilename, contentDisposition } from "../../../lib/contentDisposition";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { customerOrders, customers, factoryInvoiceLoadingSessions, factoryInvoiceLoadingBales } from "@shared/schema";
import { eq, and } from "drizzle-orm";

import { buildLoadingSummary, cellFill, colHeaders, dataCell, getCompanyId, sectionHeader } from "./_helpers";
import { sumMoney, toMoney } from "../../../lib/money";

export function registerInvoiceLoadingSessionReportRoutes(app: Express) {
  // GET /api/factory/invoice-loading-sessions/:sessionId/export/excel
  app.get(
    "/api/factory/invoice-loading-sessions/:sessionId/export/excel",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const sessionId = parseId(req.params.sessionId);

        if (sessionId === null) return res.status(400).json({ message: "Invalid id" });
        if (isNaN(sessionId)) return res.status(400).json({ message: "Invalid session ID" });

        const [session] = await db
          .select()
          .from(factoryInvoiceLoadingSessions)
          .where(
            and(eq(factoryInvoiceLoadingSessions.id, sessionId), eq(factoryInvoiceLoadingSessions.companyId, companyId))
          );

        if (!session) return res.status(404).json({ message: "Session not found" });

        const [sessionBalesRaw, invoice, invoiceSummary] = await Promise.all([
          db
            .select()
            .from(factoryInvoiceLoadingBales)
            .where(
              and(
                eq(factoryInvoiceLoadingBales.sessionId, sessionId),
                eq(factoryInvoiceLoadingBales.companyId, companyId)
              )
            )
            .orderBy(factoryInvoiceLoadingBales.scannedAt),
          db
            .select({
              invoiceNumber: customerOrders.invoiceNumber,
              orderDate: customerOrders.orderDate,
              customerName: customers.legalName,
              containerNumber: customerOrders.containerNumber,
              destination: customerOrders.destination,
            })
            .from(customerOrders)
            .leftJoin(customers, eq(customerOrders.customerId, customers.id))
            .where(eq(customerOrders.id, session.invoiceId))
            .then((r) => r[0]),
          buildLoadingSummary(session.invoiceId, companyId, sessionId),
        ]);

        const remainingBales = invoiceSummary?.invoiceBales.filter((b) => !b.loaded) ?? [];

        const ExcelJS = (await import("exceljs")).default;
        const wb = new ExcelJS.Workbook();
        wb.creator = "HMD International Group";

        // ── Sheet 1: Session ──
        const ws = wb.addWorksheet("Session");
        ws.columns = [
          { width: 6 },
          { width: 22 },
          { width: 16 },
          { width: 32 },
          { width: 14 },
          { width: 26 },
          { width: 18 },
        ];

        // Title
        ws.mergeCells("A1:G1");
        const tc = ws.getCell("A1");
        tc.value = `LOADING SESSION #${session.id}`;
        tc.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 14 };
        cellFill(tc, "FF1E3A5F");
        tc.alignment = { horizontal: "center", vertical: "middle" };
        ws.getRow(1).height = 28;

        // Meta info
        ws.getRow(2).height = 6;
        const metaItems = [
          ["Invoice", invoice?.invoiceNumber || `#${session.invoiceId}`, "Customer", invoice?.customerName || ""],
          ["Status", session.status, "Truck No", session.truckNo || "—"],
          ["Driver", session.driverName || "—", "Notes", session.notes || "—"],
          [
            "Started",
            session.startedAt ? new Date(session.startedAt).toLocaleString() : "",
            "Completed",
            session.completedAt ? new Date(session.completedAt).toLocaleString() : "—",
          ],
          [
            "Scanned this session",
            sessionBalesRaw.length.toString(),
            "Remaining overall",
            remainingBales.length.toString(),
          ],
        ];
        let r = 3;
        metaItems.forEach((row) => {
          [0, 2].forEach((ci) => {
            const lc = ws.getRow(r).getCell(ci + 1);
            lc.value = row[ci];
            lc.font = { bold: true, color: { argb: "FF6B7280" }, size: 10 };
            lc.alignment = { horizontal: "right" };
            const vc = ws.getRow(r).getCell(ci + 2);
            vc.value = row[ci + 1];
            vc.font = { bold: true, size: 10 };
          });
          ws.getRow(r).height = 16;
          r++;
        });

        // Scanned bales
        ws.getRow(r).height = 8;
        r++;
        sectionHeader(ws, r, `SCANNED BALES (${sessionBalesRaw.length})`, 7);
        r++;
        colHeaders(ws, r, [
          "#",
          "Bale Reference",
          "Article Code",
          "Product Name",
          "Weight (kg)",
          "Scanned At",
          "Scanned By",
        ]);
        r++;
        sessionBalesRaw.forEach((b, i) => {
          const row = ws.getRow(r);
          const fill = i % 2 === 0 ? "FFF0FDF4" : "FFFAFFFE";
          dataCell(row.getCell(1), i + 1, { align: "right", fill });
          dataCell(row.getCell(2), b.baleReference, { bold: true, fill });
          dataCell(row.getCell(3), b.articleCode || "", { fill });
          dataCell(row.getCell(4), b.productName || "", { fill });
          dataCell(row.getCell(5), toMoney(b.weightKg).toFixed(3), { align: "right", fill });
          dataCell(row.getCell(6), b.scannedAt ? new Date(b.scannedAt).toLocaleString() : "", { fill });
          dataCell(row.getCell(7), b.scannedByName || "", { fill });
          row.height = 15;
          r++;
        });
        // Total row
        if (sessionBalesRaw.length > 0) {
          const tr = ws.getRow(r);
          ws.mergeCells(r, 1, r, 4);
          dataCell(tr.getCell(1), `Total: ${sessionBalesRaw.length} bales`, { bold: true, fill: "FFDBEAFE" });
          dataCell(tr.getCell(5), sumMoney(sessionBalesRaw.map((b) => b.weightKg)).toFixed(3), {
            bold: true,
            align: "right",
            fill: "FFDBEAFE",
          });
          tr.height = 16;
          r++;
        }

        // Remaining bales
        ws.getRow(r).height = 8;
        r++;
        sectionHeader(ws, r, `REMAINING BALES TO LOAD (${remainingBales.length})`, 5);
        r++;
        if (remainingBales.length === 0) {
          ws.mergeCells(r, 1, r, 5);
          const dc = ws.getRow(r).getCell(1);
          dc.value = "All bales have been loaded.";
          dc.font = { bold: true, color: { argb: "FF065F46" }, size: 10 };
          cellFill(dc, "FFD1FAE5");
          dc.alignment = { horizontal: "center" };
          ws.getRow(r).height = 20;
        } else {
          colHeaders(ws, r, ["#", "Bale Reference", "Article Code", "Product Name", "Weight (kg)"]);
          r++;
          remainingBales.forEach((b, i) => {
            const row = ws.getRow(r);
            const fill = i % 2 === 0 ? "FFFEF3C7" : "FFFFFBEB";
            dataCell(row.getCell(1), i + 1, { align: "right", fill });
            dataCell(row.getCell(2), b.baleReference, { bold: true, fill });
            dataCell(row.getCell(3), b.articleCode || "", { fill });
            dataCell(row.getCell(4), b.productName || "", { fill });
            dataCell(row.getCell(5), toMoney(b.weightKg).toFixed(3), { align: "right", fill });
            row.height = 15;
            r++;
          });
          const tr = ws.getRow(r);
          ws.mergeCells(r, 1, r, 4);
          dataCell(tr.getCell(1), `Total remaining: ${remainingBales.length} bales`, { bold: true, fill: "FFFEF3C7" });
          dataCell(tr.getCell(5), sumMoney(remainingBales.map((b) => b.weightKg)).toFixed(3), {
            bold: true,
            align: "right",
            fill: "FFFEF3C7",
          });
          tr.height = 16;
        }

        const filename = buildSafeFilename(
          [invoice?.containerNumber, invoice?.customerName, invoice?.destination],
          "xlsx"
        );
        // Build buffer BEFORE setting headers so a failed writeBuffer() can still return a JSON 500.
        const xlsBuf2 = Buffer.from(await wb.xlsx.writeBuffer());
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", contentDisposition(filename));
        res.setHeader("Content-Length", xlsBuf2.byteLength);
        res.end(xlsBuf2);
      } catch (error: unknown) {
        if (!res.headersSent) res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // GET /api/factory/invoice-loading-sessions/:sessionId/export/pdf
  app.get(
    "/api/factory/invoice-loading-sessions/:sessionId/export/pdf",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const sessionId = parseId(req.params.sessionId);

        if (sessionId === null) return res.status(400).json({ message: "Invalid id" });
        if (isNaN(sessionId)) return res.status(400).json({ message: "Invalid session ID" });

        const [session] = await db
          .select()
          .from(factoryInvoiceLoadingSessions)
          .where(
            and(eq(factoryInvoiceLoadingSessions.id, sessionId), eq(factoryInvoiceLoadingSessions.companyId, companyId))
          );

        if (!session) return res.status(404).json({ message: "Session not found" });

        const [sessionBales, invoice, invoiceSummary] = await Promise.all([
          db
            .select()
            .from(factoryInvoiceLoadingBales)
            .where(
              and(
                eq(factoryInvoiceLoadingBales.sessionId, sessionId),
                eq(factoryInvoiceLoadingBales.companyId, companyId)
              )
            )
            .orderBy(factoryInvoiceLoadingBales.scannedAt),
          db
            .select({
              invoiceNumber: customerOrders.invoiceNumber,
              orderDate: customerOrders.orderDate,
              customerName: customers.legalName,
              containerNumber: customerOrders.containerNumber,
              destination: customerOrders.destination,
            })
            .from(customerOrders)
            .leftJoin(customers, eq(customerOrders.customerId, customers.id))
            .where(eq(customerOrders.id, session.invoiceId))
            .then((r) => r[0]),
          buildLoadingSummary(session.invoiceId, companyId, sessionId),
        ]);

        const remainingBales = invoiceSummary?.invoiceBales.filter((b) => !b.loaded) ?? [];

        const pdfTitle = buildSafeFilename([invoice?.containerNumber, invoice?.customerName, invoice?.destination], "");
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${pdfTitle || `Loading Session #${session.id}`}</title>
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
  <div class="meta-box"><div class="lbl">Invoice</div><div class="val">${invoice?.invoiceNumber || "#" + session.invoiceId}</div></div>
  <div class="meta-box"><div class="lbl">Customer</div><div class="val">${invoice?.customerName || "—"}</div></div>
  <div class="meta-box"><div class="lbl">Truck No</div><div class="val">${session.truckNo || "—"}</div></div>
  <div class="meta-box"><div class="lbl">Driver</div><div class="val">${session.driverName || "—"}</div></div>
  <div class="meta-box"><div class="lbl">Status</div><div class="val">${session.status}</div></div>
  <div class="meta-box"><div class="lbl">Started</div><div class="val">${session.startedAt ? new Date(session.startedAt).toLocaleString() : "—"}</div></div>
  <div class="meta-box"><div class="lbl">Completed</div><div class="val">${session.completedAt ? new Date(session.completedAt).toLocaleString() : "—"}</div></div>
  <div class="meta-box"><div class="lbl">Notes</div><div class="val">${session.notes || "—"}</div></div>
</div>

<div class="totals">
  <div class="total-box t-scanned"><div class="num">${sessionBales.length}</div><div class="lbl">Scanned This Session</div></div>
  <div class="total-box t-remaining${remainingBales.length === 0 ? " done" : ""}"><div class="num">${remainingBales.length}</div><div class="lbl">Remaining Overall</div></div>
</div>

<div class="section-title">SCANNED BALES (${sessionBales.length})</div>
<table>
  <tr><th>#</th><th>Bale Reference</th><th>Article Code</th><th>Product Name</th><th class="r">Weight (kg)</th><th>Scanned At</th></tr>
  ${sessionBales.map((b, i) => `<tr class="scanned-row"><td>${i + 1}</td><td>${b.baleReference}</td><td>${b.articleCode || ""}</td><td>${b.productName || ""}</td><td class="r">${toMoney(b.weightKg).toFixed(3)}</td><td>${b.scannedAt ? new Date(b.scannedAt).toLocaleString() : ""}</td></tr>`).join("")}
  <tr class="total-row"><td colspan="4">Total</td><td class="r">${sumMoney(sessionBales.map((b) => b.weightKg)).toFixed(3)}</td><td>${sessionBales.length} bales</td></tr>
</table>

<div class="section-title">REMAINING BALES TO LOAD (${remainingBales.length})</div>
${
  remainingBales.length === 0
    ? `<div class="all-done">All bales for this invoice have been loaded.</div>`
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
