/**
 * rentalUnitsContractsRoutes: RentalStatementExport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { RentalRoutesContext } from "./_helpers";
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { buildSafeFilename, contentDisposition } from "../../../lib/contentDisposition";
import type ExcelJS from "exceljs";
import { getCompanyId, monthlyLedgerRowsForRead } from "../shared";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { eq, and, desc } from "drizzle-orm";
import { propertyUnits, propertyContracts, propertyPayments } from "@shared/schema";
import { parseId } from "../../../lib/parseId";

export function registerRentalStatementExportRoutes(app: Express, ctx: RentalRoutesContext) {
  const { module, urlPrefix, tag } = ctx;
  // ── STATEMENT EXCEL EXPORT ──
  app.get(`${urlPrefix}/units/:id/statement/export`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const unitId = parseId(req.params.id);
      if (unitId === null) return res.status(400).json({ message: "Invalid id" });

      const [unit] = await db
        .select()
        .from(propertyUnits)
        .where(
          and(eq(propertyUnits.id, unitId), eq(propertyUnits.companyId, companyId), eq(propertyUnits.module, module))
        );
      if (!unit) return res.status(404).json({ message: "Unit not found" });

      const [contract] = await db
        .select()
        .from(propertyContracts)
        .where(
          and(
            eq(propertyContracts.companyId, companyId),
            eq(propertyContracts.module, module),
            eq(propertyContracts.unitId, unitId),
            eq(propertyContracts.status, "ACTIVE")
          )
        );
      if (!contract) return res.status(404).json({ message: "No active contract" });

      // Phase 19 (B), PE2: read only (it created and updated monthly rows).
      const ledger = await monthlyLedgerRowsForRead(contract.id);
      const allPaymentsExport = await db
        .select()
        .from(propertyPayments)
        .where(eq(propertyPayments.contractId, contract.id))
        .orderBy(desc(propertyPayments.paymentDate));
      const payments = allPaymentsExport.filter(
        (p) => p.ledgerRowId !== null && !(p.notes ?? "").includes("[Guarantee release]")
      );
      const guaranteePaymentsExport = allPaymentsExport.filter(
        (p) => p.ledgerRowId === null || (p.notes ?? "").includes("[Guarantee release]")
      );

      const monthNames = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const fmtNum = (v: unknown) => Number(v || 0);

      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      wb.creator = "Rental Management";
      wb.created = new Date();

      const ws = wb.addWorksheet("Statement");
      ws.pageSetup = {
        paperSize: 9,
        orientation: "portrait",
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        margins: { left: 0.5, right: 0.5, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 },
      };

      const titleFont = { bold: true, size: 14 };
      const headerFont = { bold: true, size: 10 };
      const bodyFont = { size: 10 };
      const grayFill: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEEEEE" } };
      const blueFill: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1A56DB" } };
      const totalFill: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE5E7EB" } };

      ws.columns = [
        { key: "month", width: 16 },
        { key: "expected", width: 16 },
        { key: "paid", width: 16 },
        { key: "outstanding", width: 16 },
        { key: "notes", width: 28 },
      ];

      // Title row
      const titleRow = ws.addRow(["RENTAL STATEMENT", "", "", "", ""]);
      ws.mergeCells(`A${titleRow.number}:E${titleRow.number}`);
      titleRow.getCell(1).font = { ...titleFont, color: { argb: "FFFFFFFF" } };
      titleRow.getCell(1).fill = blueFill;
      titleRow.getCell(1).alignment = { horizontal: "center", vertical: "middle" };
      titleRow.height = 28;

      // Info rows
      const addInfo = (label: string, value: string) => {
        const r = ws.addRow([label, value, "", "", ""]);
        ws.mergeCells(`B${r.number}:E${r.number}`);
        r.getCell(1).font = { bold: true, size: 10 };
        r.getCell(2).font = bodyFont;
        r.getCell(1).fill = grayFill;
        r.height = 16;
      };
      addInfo("Unit", `${unit.locationGroup} / ${unit.unitNumber}`);
      addInfo("Tenant", contract.tenantName);
      addInfo(
        "Start Date",
        contract.startDate
          ? new Date(contract.startDate).toLocaleDateString("en-GB", {
              day: "2-digit",
              month: "short",
              year: "numeric",
            })
          : ""
      );
      addInfo(
        "Monthly Rent",
        `$${fmtNum(contract.rentalAmount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      );
      if (contract.guaranteeAmount && Number(contract.guaranteeAmount) > 0) {
        addInfo(
          "Guarantee",
          `$${fmtNum(contract.guaranteeAmount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        );
      }
      ws.addRow([]);

      // Table header
      const hdr = ws.addRow(["Month", "Expected ($)", "Paid ($)", "Outstanding ($)", "Notes"]);
      hdr.eachCell((c) => {
        c.font = { ...headerFont, color: { argb: "FFFFFFFF" } };
        c.fill = blueFill;
        c.alignment = { horizontal: "center" };
        c.border = { bottom: { style: "thin", color: { argb: "FFAAAAAA" } } };
      });
      hdr.height = 18;

      // Data rows — only count expected for months up to today so advance payments show as credit
      const nowDate = new Date();
      const nowYear = nowDate.getUTCFullYear();
      const nowMonth = nowDate.getUTCMonth() + 1;
      let totalExpected = 0,
        totalPaid = 0;
      for (const row of ledger) {
        const isFutureRow = row.year > nowYear || (row.year === nowYear && row.month > nowMonth);
        const exp = isFutureRow ? 0 : fmtNum(row.expectedAmount);
        const paid = fmtNum(row.paidAmount);
        const out = exp - paid;
        totalExpected += exp;
        totalPaid += paid;
        const monthLabel = isFutureRow
          ? `${monthNames[row.month]} ${row.year} (prepaid)`
          : `${monthNames[row.month]} ${row.year}`;
        const r = ws.addRow([monthLabel, isFutureRow ? "" : exp, paid, out, row.notes || ""]);
        r.getCell(1).font = bodyFont;
        r.getCell(2).font = bodyFont;
        r.getCell(2).numFmt = "#,##0.00";
        r.getCell(2).alignment = { horizontal: "right" };
        r.getCell(3).font = bodyFont;
        r.getCell(3).numFmt = "#,##0.00";
        r.getCell(3).alignment = { horizontal: "right" };
        r.getCell(4).numFmt = "#,##0.00";
        r.getCell(4).alignment = { horizontal: "right" };
        r.getCell(4).font = { ...bodyFont, color: { argb: out > 0 ? "FFCC0000" : out < 0 ? "FF006600" : "FF666666" } };
        r.getCell(5).font = { ...bodyFont, color: { argb: "FF666666" } };
        r.height = 15;
      }

      // Totals row
      const balance = totalExpected - totalPaid;
      const tot = ws.addRow(["TOTALS", totalExpected, totalPaid, balance, ""]);
      tot.eachCell((c, i) => {
        c.font = { bold: true, size: 10 };
        c.fill = totalFill;
        if (i >= 2 && i <= 4) {
          c.numFmt = "#,##0.00";
          c.alignment = { horizontal: "right" };
        }
        if (i === 4)
          c.font = {
            bold: true,
            size: 10,
            color: { argb: balance > 0 ? "FFCC0000" : balance < 0 ? "FF006600" : "FF000000" },
          };
      });
      tot.height = 18;

      if (contract.statementNote) {
        ws.addRow([]);
        const nr = ws.addRow(["NOTE:", contract.statementNote, "", "", ""]);
        ws.mergeCells(`B${nr.number}:E${nr.number}`);
        nr.getCell(1).font = { bold: true, size: 10 };
        nr.getCell(2).font = { italic: true, size: 10 };
        nr.getCell(2).alignment = { wrapText: true, vertical: "top" };
        nr.height = Math.max(18, Math.ceil(contract.statementNote.length / 60) * 15);
      }

      const addPaymentSection = (title: string, rows: typeof payments) => {
        if (rows.length === 0) return;
        ws.addRow([]);
        const ph = ws.addRow([title, "", "", "", ""]);
        ws.mergeCells(`A${ph.number}:E${ph.number}`);
        ph.getCell(1).font = { bold: true, size: 10 };
        ph.getCell(1).fill = grayFill;
        ph.height = 16;

        const ph2 = ws.addRow(["Date", "For", "Amount ($)", "Notes", ""]);
        ph2.eachCell((c) => {
          c.font = headerFont;
          c.fill = grayFill;
        });
        ph2.height = 15;

        for (const p of rows) {
          const r = ws.addRow([
            new Date(p.paymentDate).toLocaleDateString("en-GB", {
              day: "2-digit",
              month: "short",
              year: "numeric",
            }),
            `${monthNames[p.forMonth]} ${p.forYear}`,
            Number(p.amount || 0),
            p.notes || "",
            "",
          ]);
          r.getCell(3).numFmt = "#,##0.00";
          r.getCell(3).alignment = { horizontal: "right" };
          r.height = 15;
        }
      };

      addPaymentSection("RENT PAYMENT HISTORY", payments);
      addPaymentSection("GUARANTEE / DEPOSIT ACTIVITY", guaranteePaymentsExport);

      const filename = buildSafeFilename(["Rental", unit.unitNumber, contract.tenantName], "xlsx");
      const xlsBuffer = Buffer.from(await wb.xlsx.writeBuffer());
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", contentDisposition(filename));
      res.setHeader("Content-Length", xlsBuffer.byteLength);
      res.end(xlsBuffer);
    } catch (e: unknown) {
      logger.error(`${tag} statement export:`, { error: e });
      if (!res.headersSent) res.status(500).json({ message: getErrorMessage(e) });
    }
  });
}
