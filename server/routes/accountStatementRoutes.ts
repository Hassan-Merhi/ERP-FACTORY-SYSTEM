import { toArrayBuffer } from "../lib/bufferCompatibility";
/**
 * Account statement & detail routes.
 *
 * Deleted-voucher listings, pre-period opening balances, statement PDF
 * rendering, and statement Excel export for a specific account. Extracted
 * from accountRoutes.ts as a sub-registrar; behaviour is unchanged.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import {
  assertValidPdfBuffer,
  normalizeStatementDate,
  statementDateKey,
  validateStatementDateRange,
} from "../lib/accountStatementExportSafety";
import path from "path";
import fs from "fs";
import { eq, and, desc, isNull, isNotNull, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth } from "../auth";
import { isParentCompanyContext } from "./helpers/supplierBalanceHelpers";
import { projectExportCurrencyRow, summarizeExportCurrencyRows } from "../services/accounting/exportCurrency";
import {
  bankAccounts,
  companies,
  customerBalances,
  customerOrders,
  customers,
  employees,
  fixedAssets,
  ledgerAccounts,
  suppliers,
  voucherEntries,
  vouchers,
} from "@shared/schema";
import type { AccountStatementEntryRow } from "../storage/accounting/vouchers";

export function registerAccountStatementRoutes(app: Express) {
  app.get("/api/accounts/:type/:id/deleted-vouchers", requireAuth, async (req, res) => {
    try {
      const accountType = req.params.type;
      const accountId = parseInt(req.params.id);
      const companyId = req.session.currentCompanyId;

      if (isNaN(accountId)) return res.status(400).json({ message: "Invalid ID" });
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      let entryFilter: SQL<unknown> | undefined;
      switch (accountType) {
        case "ledger":
          entryFilter = eq(voucherEntries.ledgerAccountId, accountId);
          break;
        case "bank":
          entryFilter = eq(voucherEntries.bankAccountId, accountId);
          break;
        case "fixed-asset":
          entryFilter = eq(voucherEntries.fixedAssetId, accountId);
          break;
        case "supplier":
          entryFilter = eq(voucherEntries.supplierId, accountId);
          break;
        case "employee":
          entryFilter = eq(voucherEntries.employeeId, accountId);
          break;
        case "customer":
          entryFilter = eq(voucherEntries.customerId, accountId);
          break;
        default:
          return res.json([]);
      }

      const results = await db
        .selectDistinct({
          id: vouchers.id,
          voucherNumber: vouchers.voucherNumber,
          voucherType: vouchers.voucherType,
          voucherDate: vouchers.voucherDate,
          totalAmount: vouchers.totalAmount,
          description: vouchers.description,
          locationName: vouchers.locationName,
          deletedAt: vouchers.deletedAt,
        })
        .from(vouchers)
        .innerJoin(voucherEntries, eq(voucherEntries.voucherId, vouchers.id))
        .where(and(eq(vouchers.companyId, companyId), isNotNull(vouchers.deletedAt), entryFilter))
        .orderBy(desc(vouchers.deletedAt));

      res.json(results);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/accounts/:type/:id/pre-period-balance", requireAuth, async (req, res) => {
    try {
      const accountType = req.params.type;
      const accountId = parseInt(req.params.id);
      const endDateRaw = req.query.endDate;
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (isNaN(accountId)) return res.status(400).json({ message: "Invalid account ID" });
      if (endDateRaw !== undefined && typeof endDateRaw !== "string") {
        return res.status(400).json({ message: "endDate must be a single YYYY-MM-DD value" });
      }
      const endDate = endDateRaw;
      const endDateValidation = validateStatementDateRange(undefined, endDate);
      if (!endDateValidation.ok) return res.status(400).json({ message: endDateValidation.message });

      const typeToColumn: Record<string, PgColumn> = {
        ledger: voucherEntries.ledgerAccountId,
        bank: voucherEntries.bankAccountId,
        "fixed-asset": voucherEntries.fixedAssetId,
        supplier: voucherEntries.supplierId,
        employee: voucherEntries.employeeId,
        customer: voucherEntries.customerId,
      };
      const entryColumn = typeToColumn[accountType];
      if (!entryColumn) return res.status(400).json({ message: "Unknown account type" });

      let rawOB = 0;
      let obSide = "Dr";
      if (accountType === "ledger") {
        const [acct] = await db
          .select({ ob: ledgerAccounts.openingBalance, side: ledgerAccounts.openingBalanceSide })
          .from(ledgerAccounts)
          .where(eq(ledgerAccounts.id, accountId));
        const [linkedCust] = await db
          .select({ id: customers.id, ob: customers.openingBalance, side: customers.openingBalanceSide })
          .from(customers)
          .where(eq(customers.ledgerAccountId, accountId))
          .limit(1);
        rawOB = parseFloat(linkedCust?.ob ?? acct?.ob ?? "0") || 0;
        obSide = linkedCust?.side ?? acct?.side ?? "Dr";

        if (linkedCust) {
          const currentCompany = await storage.getCompanyById(companyId);
          if (currentCompany?.companyType === "factory") {
            const custId = linkedCust.id;
            const dateFilter = endDate ? sql`${vouchers.voucherDate} < ${endDate}` : sql`1=1`;
            const orderDateFilter = endDate ? sql`${customerOrders.orderDate} < ${endDate}` : sql`1=1`;
            const cbDateFilter = endDate ? sql`${customerBalances.transactionDate} < ${endDate}` : sql`1=1`;

            const [salesRows, cbRows, lVRows, cVRows] = await Promise.all([
              db
                .select({ total: sql<string>`COALESCE(SUM(CAST(${customerOrders.grandTotal} AS numeric)), 0)` })
                .from(customerOrders)
                .where(
                  and(
                    eq(customerOrders.customerId, custId),
                    eq(customerOrders.companyId, companyId),
                    eq(customerOrders.status, "FINALIZED"),
                    orderDateFilter
                  )
                ),
              db
                .select({
                  net: sql<string>`COALESCE(SUM(CAST(${customerBalances.debitAmount} AS numeric) - CAST(${customerBalances.creditAmount} AS numeric)), 0)`,
                })
                .from(customerBalances)
                .where(
                  and(
                    eq(customerBalances.customerId, custId),
                    eq(customerBalances.companyId, companyId),
                    sql`${customerBalances.referenceType} IS DISTINCT FROM 'INVOICE'`,
                    cbDateFilter
                  )
                ),
              db
                .select({
                  net: sql<string>`COALESCE(SUM(CAST(${voucherEntries.debitAmount} AS numeric) - CAST(${voucherEntries.creditAmount} AS numeric)), 0)`,
                })
                .from(voucherEntries)
                .leftJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
                .where(
                  and(
                    eq(voucherEntries.ledgerAccountId, accountId),
                    eq(vouchers.optional, false),
                    isNull(vouchers.deletedAt),
                    sql`${vouchers.voucherNumber} NOT LIKE 'CHARGE-%'`,
                    dateFilter
                  )
                ),
              db
                .select({
                  net: sql<string>`COALESCE(SUM(CAST(${voucherEntries.debitAmount} AS numeric) - CAST(${voucherEntries.creditAmount} AS numeric)), 0)`,
                })
                .from(voucherEntries)
                .leftJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
                .where(
                  and(
                    eq(voucherEntries.customerId, custId),
                    isNull(voucherEntries.ledgerAccountId),
                    eq(vouchers.optional, false),
                    isNull(vouchers.deletedAt),
                    sql`${vouchers.voucherNumber} NOT LIKE 'CHARGE-%'`,
                    dateFilter
                  )
                ),
            ]);

            const salesTotal = parseFloat(salesRows[0]?.total || "0");
            const nonInvNet = parseFloat(cbRows[0]?.net || "0");
            const vNet = parseFloat(lVRows[0]?.net || "0") + parseFloat(cVRows[0]?.net || "0");
            const ob = parseFloat(linkedCust.ob || "0");
            const side = linkedCust.side || "Dr";
            const prePeriodBalance = (side === "Dr" ? ob : -ob) + salesTotal + nonInvNet + vNet;
            return res.json({ balance: prePeriodBalance });
          }
        }
      } else if (accountType === "bank") {
        const [acct] = await db
          .select({ ob: bankAccounts.openingBalance, side: bankAccounts.openingBalanceSide })
          .from(bankAccounts)
          .where(eq(bankAccounts.id, accountId));
        rawOB = parseFloat(acct?.ob ?? "0") || 0;
        obSide = acct?.side ?? "Dr";
      } else if (accountType === "supplier") {
        const isParentForSupplier = await isParentCompanyContext(companyId);
        if (isParentForSupplier) {
          const [acct] = await db
            .select({ ob: suppliers.openingBalance })
            .from(suppliers)
            .where(eq(suppliers.id, accountId));
          rawOB = parseFloat(acct?.ob ?? "0") || 0;
        } else {
          rawOB = 0;
        }
        obSide = "Cr";
      } else if (accountType === "employee") {
        const [acct] = await db
          .select({ ob: employees.openingBalance })
          .from(employees)
          .where(eq(employees.id, accountId));
        rawOB = parseFloat(acct?.ob ?? "0") || 0;
        obSide = "Cr";
      } else if (accountType === "customer") {
        const [acct] = await db
          .select({ ob: customers.openingBalance })
          .from(customers)
          .where(eq(customers.id, accountId));
        rawOB = parseFloat(acct?.ob ?? "0") || 0;
        obSide = "Dr";
      } else if (accountType === "fixed-asset") {
        const [acct] = await db
          .select({ ob: fixedAssets.openingBalance })
          .from(fixedAssets)
          .where(eq(fixedAssets.id, accountId));
        rawOB = parseFloat(acct?.ob ?? "0") || 0;
        obSide = "Dr";
      }

      const isSupplier = accountType === "supplier";
      let balance = isSupplier ? rawOB : obSide === "Cr" ? -rawOB : rawOB;

      if (endDate) {
        const conditions = [
          eq(entryColumn, accountId),
          eq(vouchers.optional, false),
          isNull(vouchers.deletedAt),
          sql`${vouchers.voucherDate} < ${endDate}`,
        ];
        if (isSupplier) conditions.push(eq(vouchers.companyId, companyId));
        const [totals] = await db
          .select({
            totalDebit: sql<string>`COALESCE(SUM(${voucherEntries.debitAmount}), 0)`,
            totalCredit: sql<string>`COALESCE(SUM(${voucherEntries.creditAmount}), 0)`,
          })
          .from(voucherEntries)
          .leftJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
          .where(and(...conditions));

        const sumDebit = parseFloat(totals?.totalDebit ?? "0") || 0;
        const sumCredit = parseFloat(totals?.totalCredit ?? "0") || 0;
        balance += isSupplier ? sumCredit - sumDebit : sumDebit - sumCredit;
      }

      res.json({ balance });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/accounts/:type/:id/statement-pdf", requireAuth, async (req: Request, res: Response) => {
    try {
      const accountType = req.params.type;
      const accountId = parseInt(req.params.id);
      const companyId = req.session.currentCompanyId;
      const { startDate: startDateRaw, endDate: endDateRaw, lang: langRaw } = req.query;

      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (isNaN(accountId)) return res.status(400).json({ message: "Invalid account ID" });
      if (startDateRaw !== undefined && typeof startDateRaw !== "string") {
        return res.status(400).json({ message: "startDate must be a single YYYY-MM-DD value" });
      }
      if (endDateRaw !== undefined && typeof endDateRaw !== "string") {
        return res.status(400).json({ message: "endDate must be a single YYYY-MM-DD value" });
      }
      if (langRaw !== undefined && typeof langRaw !== "string") {
        return res.status(400).json({ message: "lang must be a single string value" });
      }
      const startDate = startDateRaw;
      const endDate = endDateRaw;
      const lang = langRaw ?? "en";
      const dateRange = validateStatementDateRange(startDate, endDate);
      if (!dateRange.ok) return res.status(400).json({ message: dateRange.message });

      const { generateAccountStatementPdf } = await import("../lib/accountStatementPdfGenerator");
      const pdfBuf = await generateAccountStatementPdf({ accountType, accountId, companyId, startDate, endDate, lang });
      assertValidPdfBuffer(pdfBuf);

      let resolvedName = `${accountType}_${accountId}`;
      try {
        if (accountType === "ledger") {
          const [r] = await db
            .select({ name: ledgerAccounts.name })
            .from(ledgerAccounts)
            .where(eq(ledgerAccounts.id, accountId));
          resolvedName = r?.name ?? resolvedName;
        } else if (accountType === "bank") {
          const [r] = await db
            .select({ name: bankAccounts.name })
            .from(bankAccounts)
            .where(eq(bankAccounts.id, accountId));
          resolvedName = r?.name ?? resolvedName;
        } else if (accountType === "fixed-asset") {
          const [r] = await db
            .select({ name: fixedAssets.name })
            .from(fixedAssets)
            .where(eq(fixedAssets.id, accountId));
          resolvedName = r?.name ?? resolvedName;
        } else if (accountType === "supplier") {
          const [r] = await db.select({ name: suppliers.legalName }).from(suppliers).where(eq(suppliers.id, accountId));
          resolvedName = r?.name ?? resolvedName;
        } else if (accountType === "customer") {
          const [r] = await db.select({ name: customers.legalName }).from(customers).where(eq(customers.id, accountId));
          resolvedName = r?.name ?? resolvedName;
        } else if (accountType === "employee") {
          const [r] = await db
            .select({ firstName: employees.firstName, lastName: employees.lastName })
            .from(employees)
            .where(eq(employees.id, accountId));
          if (r) resolvedName = `${r.firstName} ${r.lastName}`.trim();
        }
      } catch {
        // filename fallback is non-fatal
      }
      const safeAccName = resolvedName.replace(/[^\w\s.()-]/g, "_").replace(/\s+/g, "_");
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename=statement_${safeAccName}.pdf`);
      res.setHeader("Content-Length", String(pdfBuf.length));
      res.setHeader("Cache-Control", "no-store");
      res.end(pdfBuf);
      return;
    } catch (err: unknown) {
      logger.error("Statement PDF error:", { error: err });
      if (!res.headersSent) res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  app.get("/api/accounts/statement/export-excel", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId as number;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const accountTypeRaw = req.query.accountType;
      const accountIdRaw = req.query.accountId;
      const startDateRaw = req.query.startDate;
      const endDateRaw = req.query.endDate;
      if (accountTypeRaw !== undefined && typeof accountTypeRaw !== "string") {
        return res.status(400).json({ message: "accountType must be a single string value" });
      }
      if (typeof accountIdRaw !== "string") {
        return res.status(400).json({ message: "Invalid accountId" });
      }
      if (startDateRaw !== undefined && typeof startDateRaw !== "string") {
        return res.status(400).json({ message: "startDate must be a single YYYY-MM-DD value" });
      }
      if (endDateRaw !== undefined && typeof endDateRaw !== "string") {
        return res.status(400).json({ message: "endDate must be a single YYYY-MM-DD value" });
      }

      const accountType = accountTypeRaw || "ledger";
      const accountId = Number.parseInt(accountIdRaw, 10);
      if (!Number.isSafeInteger(accountId) || accountId <= 0) {
        return res.status(400).json({ message: "Invalid accountId" });
      }
      const startDate = startDateRaw;
      const endDate = endDateRaw;
      const dateRange = validateStatementDateRange(startDate, endDate);
      if (!dateRange.ok) return res.status(400).json({ message: dateRange.message });

      let accountName = "Account";
      let openingBalance = 0;
      let openingBalanceSide = "Dr";

      const [company] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId));

      if (accountType === "ledger") {
        const [acct] = await db
          .select({
            name: ledgerAccounts.name,
            openingBalance: ledgerAccounts.openingBalance,
            openingBalanceSide: ledgerAccounts.openingBalanceSide,
          })
          .from(ledgerAccounts)
          .where(and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.companyId, companyId)));
        if (!acct) return res.status(404).json({ message: "Account not found" });
        accountName = acct.name;
        openingBalance = parseFloat(acct.openingBalance || "0");
        openingBalanceSide = acct.openingBalanceSide || "Dr";
      } else if (accountType === "bank") {
        const [acct] = await db
          .select({ name: bankAccounts.name })
          .from(bankAccounts)
          .where(and(eq(bankAccounts.id, accountId), eq(bankAccounts.companyId, companyId)));
        if (!acct) return res.status(404).json({ message: "Bank account not found" });
        accountName = acct.name;
      } else if (accountType === "supplier") {
        const [acct] = await db
          .select({ name: suppliers.legalName })
          .from(suppliers)
          .where(eq(suppliers.id, accountId));
        if (!acct) return res.status(404).json({ message: "Supplier not found" });
        accountName = acct.name ?? "Supplier";
      } else if (accountType === "employee") {
        const [acct] = await db
          .select({ firstName: employees.firstName, lastName: employees.lastName })
          .from(employees)
          .where(and(eq(employees.id, accountId), eq(employees.companyId, companyId)));
        if (!acct) return res.status(404).json({ message: "Employee not found" });
        accountName = `${acct.firstName} ${acct.lastName}`.trim();
      }

      let txRows: AccountStatementEntryRow[] = [];
      if (accountType === "ledger") {
        txRows = await storage.getVoucherEntriesByLedger(accountId, startDate, endDate, companyId);
      } else if (accountType === "bank") {
        txRows = await storage.getVoucherEntriesByBankAccount(accountId, startDate, endDate, companyId);
      } else if (accountType === "supplier") {
        txRows = await storage.getVoucherEntriesBySupplier(accountId, companyId, startDate, endDate);
      } else if (accountType === "employee") {
        txRows = await storage.getVoucherEntriesByEmployee(accountId, companyId, startDate, endDate);
      }

      let allTxForBF: AccountStatementEntryRow[] = [];
      if (startDate && accountType === "ledger") {
        allTxForBF = await storage.getVoucherEntriesByLedger(accountId, undefined, undefined, companyId);
      }
      let bfBalance = openingBalanceSide === "Dr" ? openingBalance : -openingBalance;
      if (startDate && allTxForBF.length > 0) {
        for (const r of allTxForBF) {
          const rDate = statementDateKey(r.voucherDate);
          if (rDate && rDate < startDate) {
            const projected = projectExportCurrencyRow(r as Record<string, unknown>);
            bfBalance += parseFloat(projected.historicalBaseDebit) - parseFloat(projected.historicalBaseCredit);
          }
        }
      }

      let runBal = startDate ? bfBalance : openingBalanceSide === "Dr" ? openingBalance : -openingBalance;
      const enrichedRows = txRows.map((r) => {
        const projected = projectExportCurrencyRow(r as Record<string, unknown>);
        const dr = parseFloat(projected.historicalBaseDebit || "0");
        const cr = parseFloat(projected.historicalBaseCredit || "0");
        runBal += dr - cr;
        return { ...r, dr, cr, runBal, projected };
      });

      const totalDr = enrichedRows.reduce((s: number, r) => s + r.dr, 0);
      const totalCr = enrichedRows.reduce((s: number, r) => s + r.cr, 0);
      const closingRaw = runBal;
      const closingBalance2 = Math.abs(closingRaw);
      const closingBalanceSide2 = closingRaw >= 0 ? "Dr" : "Cr";

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
      workbook.creator = "Business OS";
      workbook.created = new Date();
      workbook.modified = new Date();
      const sheet = workbook.addWorksheet("Statement", {
        properties: { defaultRowHeight: 18 },
        pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
      });
      sheet.pageSetup.margins = {
        left: 0.25,
        right: 0.25,
        top: 0.5,
        bottom: 0.5,
        header: 0.2,
        footer: 0.2,
      };

      sheet.columns = [
        { key: "date", width: 13 },
        { key: "voucher", width: 18 },
        { key: "particulars", width: 42 },
        { key: "dr", width: 16 },
        { key: "cr", width: 16 },
        { key: "balance", width: 18 },
      ];

      try {
        const logoPath = path.join(process.cwd(), "server", "hmd-logo.png");
        if (fs.existsSync(logoPath)) {
          const logoBuf = fs.readFileSync(logoPath);
          const logoId = workbook.addImage({ buffer: toArrayBuffer(logoBuf), extension: "jpeg" });
          const logoRow = sheet.addRow([]);
          logoRow.height = 80;
          sheet.addImage(logoId, { tl: { col: 2.5, row: 0 }, ext: { width: 260, height: 80 } });
          sheet.mergeCells("A1:F1");
        }
      } catch {
        // logo is optional
      }

      const rComp = sheet.addRow([company?.name || "Company"]);
      rComp.getCell(1).font = { bold: true, size: 14, color: { argb: "FF1F3864" } };
      sheet.mergeCells(`A${rComp.number}:F${rComp.number}`);

      const rTitle = sheet.addRow(["Account Statement"]);
      rTitle.getCell(1).font = { bold: true, size: 11 };
      sheet.mergeCells(`A${rTitle.number}:F${rTitle.number}`);

      const rAcct = sheet.addRow([
        `Account: ${accountName}   |   Type: ${accountType.charAt(0).toUpperCase() + accountType.substring(1)}`,
      ]);
      sheet.mergeCells(`A${rAcct.number}:F${rAcct.number}`);

      if (openingBalance !== 0 && accountType === "ledger") {
        const rOb = sheet.addRow([
          `Opening Balance: ${openingBalance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${openingBalanceSide}`,
        ]);
        sheet.mergeCells(`A${rOb.number}:F${rOb.number}`);
      }

      if (startDate || endDate) {
        const rPeriod = sheet.addRow([`Period: ${startDate || "Start"} to ${endDate || "End"}`]);
        rPeriod.getCell(1).font = { italic: true, color: { argb: "FF555555" } };
        sheet.mergeCells(`A${rPeriod.number}:F${rPeriod.number}`);
      }

      const rPrinted = sheet.addRow([
        `Printed: ${new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}`,
      ]);
      sheet.mergeCells(`A${rPrinted.number}:F${rPrinted.number}`);
      sheet.addRow([]);

      const hdr = sheet.addRow(["Date", "Voucher No.", "Particulars", "Debit (Dr)", "Credit (Cr)", "Balance"]);
      hdr.height = 22;
      hdr.eachCell((cell) => {
        cell.fill = navyFill;
        cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
        cell.border = allBorders;
        cell.alignment = { horizontal: "center", vertical: "middle" };
      });
      sheet.autoFilter = { from: { row: hdr.number, column: 1 }, to: { row: hdr.number, column: 6 } };
      sheet.views = [
        {
          state: "frozen",
          ySplit: hdr.number,
          topLeftCell: `A${hdr.number + 1}`,
          activeCell: `A${hdr.number + 1}`,
          showGridLines: false,
        },
      ];

      if (!startDate && openingBalance > 0 && accountType === "ledger") {
        const obRow = sheet.addRow([
          "",
          "—",
          "Opening Balance",
          openingBalanceSide === "Dr" ? openingBalance : null,
          openingBalanceSide === "Cr" ? openingBalance : null,
          openingBalance,
        ]);
        obRow.eachCell((cell) => {
          cell.fill = lightBlueFill;
          cell.border = allBorders;
          cell.alignment = { vertical: "middle" };
        });
        obRow.getCell(4).numFmt = numFmt;
        obRow.getCell(5).numFmt = numFmt;
        obRow.getCell(6).numFmt = `${numFmt} "${openingBalanceSide}"`;
        obRow.getCell(4).alignment = { horizontal: "right", vertical: "middle" };
        obRow.getCell(5).alignment = { horizontal: "right", vertical: "middle" };
        obRow.getCell(6).alignment = { horizontal: "right", vertical: "middle" };
      } else if (startDate && Math.abs(bfBalance) > 0.005 && accountType === "ledger") {
        const bfAbs = Math.abs(bfBalance);
        const bfSide = bfBalance >= 0 ? "Dr" : "Cr";
        const bfRow = sheet.addRow([
          normalizeStatementDate(startDate) ?? "",
          "—",
          "Balance Brought Forward",
          bfSide === "Dr" ? bfAbs : null,
          bfSide === "Cr" ? bfAbs : null,
          bfAbs,
        ]);
        bfRow.eachCell((cell) => {
          cell.fill = lightBlueFill;
          cell.font = { bold: true };
          cell.border = allBorders;
          cell.alignment = { vertical: "middle" };
        });
        bfRow.getCell(1).numFmt = "dd/mm/yyyy";
        bfRow.getCell(4).numFmt = numFmt;
        bfRow.getCell(5).numFmt = numFmt;
        bfRow.getCell(6).numFmt = `${numFmt} "${bfSide}"`;
        bfRow.getCell(4).alignment = { horizontal: "right", vertical: "middle" };
        bfRow.getCell(5).alignment = { horizontal: "right", vertical: "middle" };
        bfRow.getCell(6).alignment = { horizontal: "right", vertical: "middle" };
      }

      enrichedRows.forEach((row, idx: number) => {
        const dr = row.dr > 0 ? row.dr : null;
        const cr = row.cr > 0 ? row.cr : null;
        const dateVal = normalizeStatementDate(row.voucherDate) ?? "";
        const particulars = row.narration || row.voucherDescription || row.voucherType || "—";
        const balAbs = Math.abs(row.runBal);
        const balSide = row.runBal >= 0 ? "Dr" : "Cr";
        const dataRow = sheet.addRow([dateVal, row.voucherNumber || "—", particulars, dr, cr, balAbs]);
        dataRow.eachCell((cell) => {
          cell.border = allBorders;
          cell.alignment = { vertical: "top" };
        });
        if (idx % 2 === 0) {
          dataRow.eachCell((cell) => {
            cell.fill = greyFill;
          });
        }
        if (dateVal instanceof Date) dataRow.getCell(1).numFmt = "dd/mm/yyyy";
        dataRow.getCell(3).alignment = { vertical: "top", wrapText: true };
        dataRow.getCell(4).numFmt = numFmt;
        dataRow.getCell(5).numFmt = numFmt;
        dataRow.getCell(6).numFmt = `${numFmt} "${balSide}"`;
        dataRow.getCell(4).alignment = { horizontal: "right", vertical: "top" };
        dataRow.getCell(5).alignment = { horizontal: "right", vertical: "top" };
        dataRow.getCell(6).alignment = { horizontal: "right", vertical: "top" };
      });

      const totRow = sheet.addRow(["", "", "TOTAL", totalDr, totalCr, ""]);
      totRow.eachCell((cell) => {
        cell.fill = navyFill;
        cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
        cell.border = allBorders;
      });
      totRow.getCell(4).numFmt = numFmt;
      totRow.getCell(5).numFmt = numFmt;
      totRow.getCell(4).alignment = { horizontal: "right" };
      totRow.getCell(5).alignment = { horizontal: "right" };

      const cbRow = sheet.addRow([
        "",
        "",
        "Closing Balance",
        closingBalanceSide2 === "Dr" ? closingBalance2 : null,
        closingBalanceSide2 === "Cr" ? closingBalance2 : null,
        closingBalance2,
      ]);
      cbRow.eachCell((cell) => {
        cell.fill = lightBlueFill;
        cell.font = { bold: true };
        cell.border = allBorders;
      });
      cbRow.getCell(4).numFmt = numFmt;
      cbRow.getCell(5).numFmt = numFmt;
      cbRow.getCell(6).numFmt = `${numFmt} "${closingBalanceSide2}"`;
      cbRow.getCell(4).alignment = { horizontal: "right" };
      cbRow.getCell(5).alignment = { horizontal: "right" };
      cbRow.getCell(6).alignment = { horizontal: "right" };

      // Keep the original transaction currency visible beside the historical
      // base ledger. Native values are intentionally grouped by currency and
      // are never folded into one mixed-currency total.
      const currencySheet = workbook.addWorksheet("Currency Detail");
      currencySheet.addRow(["Currency-safe export detail"]);
      currencySheet.addRow(["Historical base currency", "USD"]);
      currencySheet.addRow(["Rate convention", "TRANSACTION_PER_BASE"]);
      const currencySummary = summarizeExportCurrencyRows(txRows as unknown[]);
      currencySheet.addRow(["Totals provisional", currencySummary.totalsProvisional ? "YES" : "NO"]);
      currencySheet.addRow(["Unresolved legacy entries", currencySummary.unresolvedEntryCount]);
      currencySheet.addRow([]);
      const nativeHeaders = currencySheet.addRow([
        "Date",
        "Voucher No.",
        "Particulars",
        "Native Currency",
        "Native Debit",
        "Native Credit",
        "Historical Base Debit (USD)",
        "Historical Base Credit (USD)",
        "Historical Rate",
        "Status",
      ]);
      nativeHeaders.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
        cell.fill = navyFill;
        cell.border = allBorders;
      });
      for (const row of enrichedRows) {
        const projected = row.projected;
        const detail = currencySheet.addRow([
          normalizeStatementDate(row.voucherDate) ?? "",
          row.voucherNumber || "—",
          row.narration || row.voucherDescription || row.voucherType || "—",
          projected.transactionCurrency || "UNRESOLVED",
          Number(projected.nativeDebit) || null,
          Number(projected.nativeCredit) || null,
          Number(projected.historicalBaseDebit) || null,
          Number(projected.historicalBaseCredit) || null,
          projected.historicalExchangeRate || "",
          projected.status,
        ]);
        detail.eachCell((cell) => {
          cell.border = allBorders;
          cell.alignment = { vertical: "top", wrapText: true };
        });
        [5, 6, 7, 8].forEach((column) => {
          detail.getCell(column).numFmt = numFmt;
          detail.getCell(column).alignment = { horizontal: "right" };
        });
        if (projected.status === "UNRESOLVED_LEGACY") {
          detail.eachCell((cell) => {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF3CD" } };
          });
        }
      }
      currencySheet.addRow([]);
      currencySheet.addRow(["Native debit by currency", JSON.stringify(currencySummary.nativeDebitByCurrency)]);
      currencySheet.addRow(["Native credit by currency", JSON.stringify(currencySummary.nativeCreditByCurrency)]);
      currencySheet.addRow(["Historical base debit total (USD)", Number(currencySummary.historicalBaseDebitTotal)]);
      currencySheet.addRow(["Historical base credit total (USD)", Number(currencySummary.historicalBaseCreditTotal)]);
      currencySheet.columns = [
        { width: 14 },
        { width: 18 },
        { width: 42 },
        { width: 18 },
        { width: 18 },
        { width: 18 },
        { width: 24 },
        { width: 24 },
        { width: 18 },
        { width: 22 },
      ];
      currencySheet.views = [{ state: "frozen", ySplit: 7 }];

      sheet.pageSetup.printArea = `A1:F${cbRow.number}`;
      sheet.headerFooter.oddFooter = "&LAccount Statement&CPage &P of &N&R&D";

      const safeAccName = accountName.replace(/[^\w\s.()-]/g, "_").replace(/\s+/g, "_");
      const buf = Buffer.from(await workbook.xlsx.writeBuffer());
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${safeAccName}_Statement.xlsx"`);
      res.setHeader("Content-Length", String(buf.length));
      res.setHeader("Cache-Control", "no-store");
      res.end(buf);
    } catch (err: unknown) {
      logger.error("Account statement Excel error:", { error: err });
      if (!res.headersSent) res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
