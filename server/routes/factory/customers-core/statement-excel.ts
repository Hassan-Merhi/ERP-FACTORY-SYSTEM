import { toArrayBuffer } from "../../../lib/bufferCompatibility";
/**
 * factoryCustomersRoutes: FactoryCustomerStatementExcel endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { buildSafeFilename, contentDisposition } from "../../../lib/contentDisposition";
import { getClientDate } from "../../../lib/dateUtils";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { customerOrders, customers, companies } from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { MoneyDecimal } from "../../../lib/money";
import { buildFactoryCustomerStatement } from "./statementRows";
import path from "path";
import fs from "fs";

export function registerFactoryCustomerStatementExcelRoutes(app: Express) {
  // ── Customer Statement: Excel Export ────────────────────────────────────
  app.get("/api/factory/customers/:id/statement/export-excel", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const customerId = parseInt(req.params.id);
      if (isNaN(customerId)) return res.status(400).json({ message: "Invalid customer ID" });

      const [customer] = await db
        .select()
        .from(customers)
        .where(and(eq(customers.id, customerId), eq(customers.companyId, companyId)));
      if (!customer) return res.status(404).json({ message: "Customer not found" });

      const [_company] = await db.select().from(companies).where(eq(companies.id, companyId));

      // Ledger rows from the balance engine plus the amounts not yet in the
      // ledger, flagged (statementRows.ts). Debit/credit are each row's effect
      // on the combined figure the statement has always closed on; the closing
      // is then split into its ledger and not-yet-in-the-ledger parts.
      const statement = await buildFactoryCustomerStatement(companyId, customerId);
      const allRowsXlsx = statement.rows.map((row) => ({
        transactionDate: row.transactionDate,
        transactionType: row.transactionType,
        referenceType: row.referenceType,
        referenceId: row.referenceId,
        description: row.notInLedger
          ? `${row.description || row.referenceNumber || ""} — not yet in the ledger`
          : row.description,
        rowNote: row.rowNote,
        notInLedger: row.notInLedger,
        combinedEffect: row.combinedEffect,
        ledgerEffect: row.ledgerEffect,
      }));

      // Build destination map for Excel
      const xlsxInvoiceRefIds = [
        ...new Set(
          allRowsXlsx.filter((r) => r.referenceType === "INVOICE" && r.referenceId).map((r) => r.referenceId as number)
        ),
      ];
      const destinationMapXlsx = new Map<number, string>();
      if (xlsxInvoiceRefIds.length > 0) {
        const xlsxOrderRows = await db
          .select({ id: customerOrders.id, destination: customerOrders.destination })
          .from(customerOrders)
          .where(inArray(customerOrders.id, xlsxInvoiceRefIds));
        for (const o of xlsxOrderRows) {
          if (o.destination) destinationMapXlsx.set(o.id, o.destination);
        }
      }

      const openingExact = statement.opening;
      const openingBalance = openingExact.abs().toNumber();
      const openingSide = openingExact.lessThan(0) ? "Cr" : "Dr";

      // Read filter params (forwarded from frontend export button)
      const dateFromXlsx = ((req.query.dateFrom as string) || "").trim();
      const dateToXlsx = ((req.query.dateTo as string) || "").trim();
      const destFilterXlsx = ((req.query.destination as string) || "").trim().toLowerCase();

      // First pass: enrich ALL rows (needed before filtering)
      const allEnrichedXlsx = allRowsXlsx.map((row) => {
        const debit = row.combinedEffect.greaterThan(0) ? row.combinedEffect.toNumber() : 0;
        const credit = row.combinedEffect.lessThan(0) ? row.combinedEffect.negated().toNumber() : 0;
        const destination =
          row.referenceType === "INVOICE" && row.referenceId ? destinationMapXlsx.get(row.referenceId) || "" : "";
        return { ...row, debit, credit, destination };
      });

      // Brought-forward balances (before dateFromXlsx): combined and ledger
      let bfCombined = openingExact;
      let bfLedger = openingExact;
      if (dateFromXlsx) {
        for (const r of allEnrichedXlsx) {
          const rDate = (r.transactionDate || "").toString().slice(0, 10);
          if (rDate >= dateFromXlsx) break;
          bfCombined = bfCombined.plus(r.combinedEffect);
          bfLedger = bfLedger.plus(r.ledgerEffect);
        }
      }
      const bfRunningXlsx = bfCombined.toNumber();

      // Apply filters (mirrors frontend filteredHistory logic)
      const rows = allEnrichedXlsx.filter((row) => {
        if (destFilterXlsx) {
          if (!(row.destination || "").toLowerCase().includes(destFilterXlsx)) return false;
        }
        if (dateFromXlsx && row.transactionDate) {
          if ((row.transactionDate || "").toString().slice(0, 10) < dateFromXlsx) return false;
        }
        if (dateToXlsx && row.transactionDate) {
          if ((row.transactionDate || "").toString().slice(0, 10) > dateToXlsx) return false;
        }
        return true;
      });

      const totalDrExact = rows.reduce(
        (sum, r) => sum.plus(MoneyDecimal.max(r.combinedEffect, 0)),
        new MoneyDecimal(0)
      );
      const totalCrExact = rows.reduce(
        (sum, r) => sum.plus(MoneyDecimal.max(r.combinedEffect.negated(), 0)),
        new MoneyDecimal(0)
      );
      const totalDr = totalDrExact.toNumber();
      const totalCr = totalCrExact.toNumber();
      const closingCombined = bfCombined.plus(totalDrExact).minus(totalCrExact);
      const closingLedger = rows.reduce((sum, r) => sum.plus(r.ledgerEffect), bfLedger);
      const closingNotInLedger = closingCombined.minus(closingLedger);
      const closingBalance = closingCombined.abs().toNumber();
      const closingBalanceSide = closingCombined.lessThan(0) ? "Cr" : "Dr";

      const txLabel = (type: string) => {
        const map: Record<string, string> = {
          SALE: "Sale",
          PAYMENT: "Payment",
          RECEIPT: "Receipt",
          ADJUSTMENT: "Adjustment",
          JOURNAL: "Journal",
          OPENING_BALANCE: "Opening Bal.",
        };
        return map[type] || type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      };
      const numFmt = "#,##0.00";
      const navyFill = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FF1F3864" } };
      const lightBlueFill = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFEFF3FB" } };
      const greyFill = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFF5F5F5" } };
      const allBorders = {
        top: { style: "thin" as const },
        bottom: { style: "thin" as const },
        left: { style: "thin" as const },
        right: { style: "thin" as const },
      };

      const ExcelJS = (await import("exceljs")).default;
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Statement");

      sheet.columns = [
        { key: "date", width: 14 },
        { key: "type", width: 16 },
        { key: "desc", width: 28 },
        { key: "destination", width: 22 },
        { key: "dr", width: 16 },
        { key: "cr", width: 16 },
        { key: "note", width: 30 },
      ];

      // Rows 1–5+: Customer info block with HMD branding
      try {
        const stmtLogo = path.join(process.cwd(), "server", "hmd-logo.png");
        if (fs.existsSync(stmtLogo)) {
          const slBuf = fs.readFileSync(stmtLogo);
          const slId = workbook.addImage({ buffer: toArrayBuffer(slBuf), extension: "jpeg" });
          const slRow = sheet.addRow([]);
          slRow.height = 90;
          sheet.addImage(slId, { tl: { col: 1.9, row: 0 }, ext: { width: 300, height: 90 } });
          sheet.mergeCells(`A1:G1`);
        }
      } catch {
        // Failure here is non-fatal and the surrounding flow continues deliberately.
      }
      const r1 = sheet.addRow(["HMD INTERNATIONAL GROUP"]);
      r1.getCell(1).font = { bold: true, size: 14, color: { argb: "FF1F3864" } };
      sheet.mergeCells(`A${r1.number}:G${r1.number}`);
      const r2 = sheet.addRow(["Account Statement"]);
      r2.getCell(1).font = { bold: true, size: 11 };
      sheet.mergeCells(`A${r2.number}:G${r2.number}`);
      const r3 = sheet.addRow([
        `Customer: ${customer.legalName}   |   Code: ${customer.code || "—"}   |   Phone: ${customer.phone || "—"}`,
      ]);
      sheet.mergeCells(`A${r3.number}:G${r3.number}`);
      const r4 = sheet.addRow([
        `Opening Balance: ${openingBalance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${openingSide}`,
      ]);
      sheet.mergeCells(`A${r4.number}:G${r4.number}`);
      if (dateFromXlsx || dateToXlsx || destFilterXlsx) {
        const periodParts: string[] = [];
        if (dateFromXlsx || dateToXlsx)
          periodParts.push(`Period: ${dateFromXlsx || "Start"} to ${dateToXlsx || "End"}`);
        if (destFilterXlsx) periodParts.push(`Destination filter: ${destFilterXlsx.toUpperCase()}`);
        const r4b = sheet.addRow([periodParts.join("   |   ")]);
        sheet.mergeCells(`A${r4b.number}:G${r4b.number}`);
        r4b.getCell(1).font = { italic: true, color: { argb: "FF555555" } };
      }
      const r5 = sheet.addRow([
        `Printed: ${new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}`,
      ]);
      sheet.mergeCells(`A${r5.number}:G${r5.number}`);
      // spacer
      sheet.addRow([]);

      // Column headers
      const hdrRow = sheet.addRow(["Date", "Type", "Container", "Destination", "Debit (Dr)", "Credit (Cr)", "Note"]);
      hdrRow.eachCell((cell) => {
        cell.fill = navyFill;
        cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
        cell.border = allBorders;
        cell.alignment = { horizontal: "center" };
      });

      // Opening balance row if non-zero (suppressed when date-filtered because B/F row replaces it)
      if (openingBalance > 0 && !dateFromXlsx) {
        const obRow = sheet.addRow([
          new Date().toLocaleDateString("en-GB"),
          "Opening Bal.",
          "Opening Balance",
          "",
          openingSide === "Dr" ? openingBalance : null,
          openingSide === "Cr" ? openingBalance : null,
        ]);
        obRow.eachCell((cell) => {
          cell.fill = lightBlueFill;
          cell.border = allBorders;
        });
        obRow.getCell(5).numFmt = numFmt;
        obRow.getCell(6).numFmt = numFmt;
      }

      // Balance B/F row (when date-filtered and there's a prior balance)
      if (dateFromXlsx && Math.abs(bfRunningXlsx) > 0.005) {
        const bfAbsXlsx = Math.abs(bfRunningXlsx);
        const bfSideXlsx = bfRunningXlsx >= 0 ? "Dr" : "Cr";
        const bfRow = sheet.addRow([
          new Date(dateFromXlsx + "T00:00:00"),
          "Balance B/F",
          "Balance Brought Forward",
          "",
          bfSideXlsx === "Dr" ? bfAbsXlsx : null,
          bfSideXlsx === "Cr" ? bfAbsXlsx : null,
        ]);
        bfRow.eachCell((cell) => {
          cell.fill = lightBlueFill;
          cell.font = { bold: true };
          cell.border = allBorders;
        });
        bfRow.getCell(1).numFmt = "dd/mm/yyyy";
        bfRow.getCell(5).numFmt = numFmt;
        bfRow.getCell(6).numFmt = numFmt;
        bfRow.getCell(5).alignment = { horizontal: "right" };
        bfRow.getCell(6).alignment = { horizontal: "right" };
      }

      // Data rows
      rows.forEach((row, idx: number) => {
        const dr = row.debit > 0 ? row.debit : null;
        const cr = row.credit > 0 ? row.credit : null;
        const dateVal = row.transactionDate ? new Date(row.transactionDate + "T00:00:00") : "";
        const dr2 = sheet.addRow([
          dateVal,
          txLabel(row.transactionType),
          row.description || "—",
          row.destination || "",
          dr,
          cr,
          row.rowNote || "",
        ]);
        dr2.eachCell((cell) => {
          cell.border = allBorders;
        });
        if (idx % 2 === 0) {
          dr2.eachCell((cell) => {
            cell.fill = greyFill;
          });
        }
        dr2.getCell(1).numFmt = "dd/mm/yyyy";
        dr2.getCell(5).numFmt = numFmt;
        dr2.getCell(6).numFmt = numFmt;
        dr2.getCell(5).alignment = { horizontal: "right" };
        dr2.getCell(6).alignment = { horizontal: "right" };
        dr2.getCell(7).alignment = { wrapText: true, vertical: "top" };
        if (row.rowNote) dr2.height = Math.max(18, Math.ceil(row.rowNote.length / 30) * 15);
      });

      // Totals row
      const totRow = sheet.addRow(["", "", "TOTAL", "", totalDr, totalCr, ""]);
      totRow.eachCell((cell) => {
        cell.fill = navyFill;
        cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
        cell.border = allBorders;
      });
      totRow.getCell(5).numFmt = numFmt;
      totRow.getCell(6).numFmt = numFmt;
      totRow.getCell(5).alignment = { horizontal: "right" };
      totRow.getCell(6).alignment = { horizontal: "right" };

      // Closing balance row
      const closingDr = closingBalanceSide === "Dr" ? closingBalance : null;
      const closingCr = closingBalanceSide === "Cr" ? closingBalance : null;
      const cbRow = sheet.addRow(["", "", "Closing Balance", "", closingDr, closingCr, ""]);
      cbRow.eachCell((cell) => {
        cell.fill = lightBlueFill;
        cell.font = { bold: true };
        cell.border = allBorders;
      });
      cbRow.getCell(5).numFmt = numFmt;
      cbRow.getCell(6).numFmt = numFmt;
      cbRow.getCell(5).alignment = { horizontal: "right" };
      cbRow.getCell(6).alignment = { horizontal: "right" };

      // The closing split: what the ledger holds, and what is not in it yet.
      for (const [label, value] of [
        ["of which in the ledger", closingLedger],
        ["of which not yet in the ledger", closingNotInLedger],
      ] as const) {
        const splitRow = sheet.addRow([
          "",
          "",
          label,
          "",
          value.greaterThan(0) ? value.toNumber() : null,
          value.lessThan(0) ? value.negated().toNumber() : null,
          "",
        ]);
        splitRow.eachCell((cell) => {
          cell.font = { italic: true };
          cell.border = allBorders;
        });
        splitRow.getCell(5).numFmt = numFmt;
        splitRow.getCell(6).numFmt = numFmt;
      }

      // Statement note (if set)
      if (customer.statementNote) {
        sheet.addRow([]);
        const noteRow = sheet.addRow(["Note:", customer.statementNote, "", "", "", ""]);
        sheet.mergeCells(`B${noteRow.number}:F${noteRow.number}`);
        noteRow.getCell(1).font = { bold: true, size: 10 };
        noteRow.getCell(2).font = { italic: true, size: 10 };
        noteRow.getCell(2).alignment = { wrapText: true, vertical: "top" };
        noteRow.height = Math.max(18, Math.ceil(customer.statementNote.length / 60) * 15);
      }

      // Build buffer BEFORE setting headers so ExcelJS errors can still return a clean JSON 500.
      const xlsBuffer = Buffer.from(await workbook.xlsx.writeBuffer());
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader(
        "Content-Disposition",
        contentDisposition(
          buildSafeFilename([customer.legalName || customer.code || String(customerId), getClientDate(req)], "xlsx")
        )
      );
      res.setHeader("Content-Length", xlsBuffer.byteLength);
      res.end(xlsBuffer);
    } catch (error: unknown) {
      logger.error("Error exporting customer statement Excel:", { error: error });
      if (!res.headersSent) res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
