// Extracted from ./accountStatementRoutes.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { assertValidPdfBuffer, validateStatementDateRange } from "../lib/accountStatementExportSafety";
import { and, desc, eq, isNotNull, type SQL } from "drizzle-orm";
import { db } from "../db";
import { requireAuth } from "../auth";
import {
  bankAccounts,
  customers,
  employees,
  fixedAssets,
  ledgerAccounts,
  suppliers,
  voucherEntries,
  vouchers,
} from "@shared/schema";

export function registerAccountStatementRoutesPart1(app: Express) {
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
}

export function registerAccountStatementRoutesPart2(app: Express) {
  app.get("/api/accounts/:type/:id/statement-pdf", requireAuth, async (req: Request, res: Response) => {
    try {
      const accountType = req.params.type;
      const accountId = parseInt(req.params.id);
      const companyId = req.session.currentCompanyId;
      const { startDate: startDateRaw, endDate: endDateRaw, lang: langRaw } = req.query;

      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (isNaN(accountId)) return res.status(400).json({ message: "Invalid account ID" });
      // Anything outside this set reached the generator's trailing else and
      // threw "Unknown account type", which the catch reported as a 500. These
      // are exactly the types the generator branches on, and the same set the
      // statement route above validates against.
      if (!["ledger", "bank", "fixed-asset", "supplier", "employee", "customer"].includes(accountType)) {
        return res.status(400).json({ message: "Unknown account type" });
      }
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
      if (err instanceof Error && err.name === "StatementAccountNotFoundError") {
        if (!res.headersSent) res.status(404).json({ message: "Account not found" });
        return;
      }
      logger.error("Statement PDF error:", { error: err });
      if (!res.headersSent) res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
