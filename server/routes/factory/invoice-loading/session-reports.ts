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
import { renderSessionLoadingReportHtml } from "./reportHtml";

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
        const html = renderSessionLoadingReportHtml({ pdfTitle, session, invoice, sessionBales, remainingBales });

        res.setHeader("Content-Type", "text/html");
        res.send(html);
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
