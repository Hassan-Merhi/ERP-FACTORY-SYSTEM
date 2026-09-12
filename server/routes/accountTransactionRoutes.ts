/**
 * Account-transaction routes.
 *
 * Per-account transaction listings (ledger, bank, fixed-asset, supplier,
 * employee, customer) with optional date filtering. Extracted from
 * accountRoutes.ts as a sub-registrar; behaviour is unchanged.
 */
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { eq, and, isNull } from "drizzle-orm";
import { db, pool } from "../db";
import { storage } from "../storage";
import { requireAuth } from "../auth";
import { authorizeCompanyIdParam } from "./helpers/supplierBalanceHelpers";
import { getClientDate } from "../lib/dateUtils";
import { buildFactoryCustomerLedgerEntries, getCustomerByLedgerId } from "../lib/factoryCustomerLedger";
import { bankAccounts, customers, employees, fixedAssets, ledgerAccounts } from "@shared/schema";
import { summarizeAccountStatementCurrency } from "../services/accounting/accountStatementCurrency";

function statementResponse(transactions: unknown[], fields: Record<string, unknown>) {
  return { transactions, currencySummary: summarizeAccountStatementCurrency(transactions), ...fields };
}

export function registerAccountTransactionRoutes(app: Express) {
  // Get transactions for a specific ledger account with optional date filtering
  app.get("/api/accounts/ledger/:id/transactions", requireAuth, async (req, res) => {
    try {
      const ledgerAccountId = parseInt(req.params.id);

      if (isNaN(ledgerAccountId)) {
        return res.status(400).json({ message: "Invalid ledger account ID" });
      }

      const asOfDate = getClientDate(req);
      const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
      const rawStart =
        typeof req.query.startDate === "string" && ISO_DATE.test(req.query.startDate) ? req.query.startDate : undefined;
      const rawEnd =
        typeof req.query.endDate === "string" && ISO_DATE.test(req.query.endDate) ? req.query.endDate : undefined;
      // Cap the end date at today so future-dated vouchers are never shown
      const effectiveEndDate = rawEnd && rawEnd < asOfDate ? rawEnd : asOfDate;

      // 1. Load the ledger account to get its authoritative company scope.
      //    Using ledgerAccount.companyId (not req.session.currentCompanyId) so the
      //    correct company is used even when the caller is in factory mode.
      const [ledgerAccount] = await db
        .select()
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.id, ledgerAccountId), isNull(ledgerAccounts.deletedAt)));

      if (!ledgerAccount) {
        return res.status(404).json({ message: "Ledger account not found" });
      }
      const companyId: number = ledgerAccount.companyId;
      const authorizedCompanyId = await authorizeCompanyIdParam(req, companyId);
      if (authorizedCompanyId === null) {
        return res.status(403).json({ message: "No access to this account's company" });
      }

      // 2. If this ledger is linked to a factory customer, return the unified
      //    factory-customer ledger view (plain array — frontend handles both shapes).
      try {
        const linkedCust = await getCustomerByLedgerId(ledgerAccountId);
        if (linkedCust) {
          const company = await storage.getCompanyById(linkedCust.companyId);
          if (company?.companyType === "factory") {
            const entries = await buildFactoryCustomerLedgerEntries(
              linkedCust.id,
              ledgerAccountId,
              linkedCust.companyId,
              rawStart,
              effectiveEndDate
            );
            return res.json(entries);
          }
        }
      } catch (e) {
        // If the factory-customer lookup fails for any reason, fall back to
        // the regular ledger entries so the page never breaks.
        logger.error("[ledger transactions] factory-customer lookup failed:", { error: e });
      }

      // 3. Main query: period transactions capped at today
      const transactions = await storage.getVoucherEntriesByLedger(
        ledgerAccountId,
        rawStart,
        effectiveEndDate,
        companyId
      );

      // 4. Brought-forward balance: sum of entries strictly before the period start.
      //    For All Time (no rawStart), preNetBalance = 0 — the stored opening balance suffices.
      let preNetBalance = 0;
      if (rawStart) {
        const bfParams = [ledgerAccountId, rawStart];
        let bfCompanyFilter = "";
        if (companyId) {
          bfParams.push(companyId);
          bfCompanyFilter = "AND v.company_id = $" + bfParams.length;
        }
        const bfResult = await pool.query(
          `SELECT COALESCE(SUM(ve.debit_amount::numeric - ve.credit_amount::numeric), 0) AS net
           FROM voucher_entries ve
           JOIN vouchers v ON ve.voucher_id = v.id
           WHERE ve.ledger_account_id = $1
             AND v.optional = false
             AND v.deleted_at IS NULL
             AND COALESCE(v.effective_date::date, v.voucher_date::date) < $2::date
             ${bfCompanyFilter}`,
          bfParams
        );
        preNetBalance = parseFloat(bfResult.rows[0]?.net ?? "0");
      }

      return res.json(statementResponse(transactions, {
        preNetBalance,
        asOfDate,
        startDate: rawStart ?? null,
        endDate: effectiveEndDate,
      }));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Get transactions for a specific bank account with optional date filtering
  app.get("/api/accounts/bank/:id/transactions", requireAuth, async (req, res) => {
    try {
      const bankAccountId = parseInt(req.params.id);
      if (isNaN(bankAccountId)) {
        return res.status(400).json({ message: "Invalid bank account ID" });
      }

      const asOfDate = getClientDate(req);
      const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
      const rawStart =
        typeof req.query.startDate === "string" && ISO_DATE.test(req.query.startDate) ? req.query.startDate : undefined;
      const rawEnd =
        typeof req.query.endDate === "string" && ISO_DATE.test(req.query.endDate) ? req.query.endDate : undefined;
      const effectiveEndDate = rawEnd && rawEnd < asOfDate ? rawEnd : asOfDate;

      // Load account to get authoritative company scope
      const [bankAccount] = await db.select().from(bankAccounts).where(eq(bankAccounts.id, bankAccountId));
      if (!bankAccount) return res.status(404).json({ message: "Bank account not found" });
      const companyId = bankAccount.companyId;

      // Authorize: confirm the logged-in user can access this company
      const authorizedCompanyId = await authorizeCompanyIdParam(req, companyId);
      if (authorizedCompanyId === null) {
        return res.status(403).json({ message: "No access to this account's company" });
      }

      const transactions = await storage.getVoucherEntriesByBankAccount(
        bankAccountId,
        rawStart,
        effectiveEndDate,
        companyId
      );

      let preNetBalance = 0;
      if (rawStart) {
        const bfResult = await pool.query(
          `SELECT COALESCE(SUM(ve.debit_amount::numeric - ve.credit_amount::numeric), 0) AS net
           FROM voucher_entries ve
           JOIN vouchers v ON ve.voucher_id = v.id
           WHERE ve.bank_account_id = $1
             AND v.optional = false
             AND v.deleted_at IS NULL
             AND v.company_id = $2
             AND COALESCE(v.effective_date::date, v.voucher_date::date) < $3::date`,
          [bankAccountId, companyId, rawStart]
        );
        preNetBalance = parseFloat(bfResult.rows[0]?.net ?? "0");
      }

      return res.json(statementResponse(transactions, {
        preNetBalance,
        asOfDate,
        startDate: rawStart ?? null,
        endDate: effectiveEndDate,
      }));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Get transactions for a specific fixed asset with optional date filtering
  app.get("/api/accounts/fixed-asset/:id/transactions", requireAuth, async (req, res) => {
    try {
      const fixedAssetId = parseInt(req.params.id);
      if (isNaN(fixedAssetId)) {
        return res.status(400).json({ message: "Invalid fixed asset ID" });
      }

      const asOfDate = getClientDate(req);
      const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
      const rawStart =
        typeof req.query.startDate === "string" && ISO_DATE.test(req.query.startDate) ? req.query.startDate : undefined;
      const rawEnd =
        typeof req.query.endDate === "string" && ISO_DATE.test(req.query.endDate) ? req.query.endDate : undefined;
      const effectiveEndDate = rawEnd && rawEnd < asOfDate ? rawEnd : asOfDate;

      // Load account to get authoritative company scope
      const [fixedAsset] = await db.select().from(fixedAssets).where(eq(fixedAssets.id, fixedAssetId));
      if (!fixedAsset) return res.status(404).json({ message: "Fixed asset not found" });
      const companyId = fixedAsset.companyId;

      // Authorize: confirm the logged-in user can access this company
      const authorizedCompanyId = await authorizeCompanyIdParam(req, companyId);
      if (authorizedCompanyId === null) {
        return res.status(403).json({ message: "No access to this account's company" });
      }

      const transactions = await storage.getVoucherEntriesByFixedAsset(
        fixedAssetId,
        rawStart,
        effectiveEndDate,
        companyId
      );

      let preNetBalance = 0;
      if (rawStart) {
        const bfResult = await pool.query(
          `SELECT COALESCE(SUM(ve.debit_amount::numeric - ve.credit_amount::numeric), 0) AS net
           FROM voucher_entries ve
           JOIN vouchers v ON ve.voucher_id = v.id
           WHERE ve.fixed_asset_id = $1
             AND v.optional = false
             AND v.deleted_at IS NULL
             AND v.company_id = $2
             AND COALESCE(v.effective_date::date, v.voucher_date::date) < $3::date`,
          [fixedAssetId, companyId, rawStart]
        );
        preNetBalance = parseFloat(bfResult.rows[0]?.net ?? "0");
      }

      return res.json(statementResponse(transactions, {
        preNetBalance,
        asOfDate,
        startDate: rawStart ?? null,
        endDate: effectiveEndDate,
      }));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Get transactions for a specific supplier with optional date filtering
  app.get("/api/accounts/supplier/:id/transactions", requireAuth, async (req, res) => {
    try {
      const supplierId = parseInt(req.params.id);
      if (isNaN(supplierId)) {
        return res.status(400).json({ message: "Invalid supplier ID" });
      }

      const asOfDate = getClientDate(req);
      const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
      const rawStart =
        typeof req.query.startDate === "string" && ISO_DATE.test(req.query.startDate) ? req.query.startDate : undefined;
      const rawEnd =
        typeof req.query.endDate === "string" && ISO_DATE.test(req.query.endDate) ? req.query.endDate : undefined;
      const effectiveEndDate = rawEnd && rawEnd < asOfDate ? rawEnd : asOfDate;

      const requestedCompanyId = req.query.companyId ? parseInt(req.query.companyId as string) : undefined;

      // Suppliers are shared across companies, so a caller-supplied companyId
      // must be authorized against the user's actual company access — never
      // trusted blindly (it would otherwise let one company's session peek at
      // another company's supplier ledger).
      const filterCompanyId = await authorizeCompanyIdParam(req, requestedCompanyId);
      if (requestedCompanyId && filterCompanyId === null) {
        return res.status(403).json({ message: "No access to this company" });
      }

      const transactions = await storage.getVoucherEntriesBySupplier(
        supplierId,
        filterCompanyId ?? undefined,
        rawStart,
        effectiveEndDate
      );

      let preNetBalance = 0;
      if (rawStart) {
        // Brought-forward balance must be scoped to the same company as the
        // transactions above — otherwise it silently pulls in every other
        // company's history for this (globally shared) supplier record.
        const conditions = [
          `ve.supplier_id = $1`,
          `v.optional = false`,
          `v.deleted_at IS NULL`,
          `COALESCE(v.effective_date::date, v.voucher_date::date) < $2::date`,
        ];
        const params = [supplierId, rawStart];
        if (filterCompanyId) {
          conditions.push("v.company_id = $" + (params.length + 1));
          params.push(filterCompanyId);
        }
        const bfResult = await pool.query(
          `SELECT COALESCE(SUM(ve.debit_amount::numeric - ve.credit_amount::numeric), 0) AS net
           FROM voucher_entries ve
           JOIN vouchers v ON ve.voucher_id = v.id
           WHERE ${conditions.join(" AND ")}`,
          params
        );
        preNetBalance = parseFloat(bfResult.rows[0]?.net ?? "0");
      }

      return res.json(statementResponse(transactions, {
        preNetBalance,
        asOfDate,
        startDate: rawStart ?? null,
        endDate: effectiveEndDate,
      }));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Get transactions for a specific employee with optional date filtering
  app.get("/api/accounts/employee/:id/transactions", requireAuth, async (req, res) => {
    try {
      const employeeId = parseInt(req.params.id);
      if (isNaN(employeeId)) {
        return res.status(400).json({ message: "Invalid employee ID" });
      }

      const asOfDate = getClientDate(req);
      const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
      const rawStart =
        typeof req.query.startDate === "string" && ISO_DATE.test(req.query.startDate) ? req.query.startDate : undefined;
      const rawEnd =
        typeof req.query.endDate === "string" && ISO_DATE.test(req.query.endDate) ? req.query.endDate : undefined;
      const effectiveEndDate = rawEnd && rawEnd < asOfDate ? rawEnd : asOfDate;

      // Load employee to get authoritative company scope
      const [employee] = await db.select().from(employees).where(eq(employees.id, employeeId));
      if (!employee) return res.status(404).json({ message: "Employee not found" });
      const companyId = employee.companyId;

      // Authorize: confirm the logged-in user can access this company
      const authorizedCompanyId = await authorizeCompanyIdParam(req, companyId);
      if (authorizedCompanyId === null) {
        return res.status(403).json({ message: "No access to this account's company" });
      }

      const transactions = await storage.getVoucherEntriesByEmployee(employeeId, companyId, rawStart, effectiveEndDate);

      let preNetBalance = 0;
      if (rawStart) {
        const bfResult = await pool.query(
          `SELECT COALESCE(SUM(ve.debit_amount::numeric - ve.credit_amount::numeric), 0) AS net
           FROM voucher_entries ve
           JOIN vouchers v ON ve.voucher_id = v.id
           WHERE ve.employee_id = $1
             AND v.optional = false
             AND v.deleted_at IS NULL
             AND v.company_id = $2
             AND COALESCE(v.effective_date::date, v.voucher_date::date) < $3::date`,
          [employeeId, companyId, rawStart]
        );
        preNetBalance = parseFloat(bfResult.rows[0]?.net ?? "0");
      }

      return res.json(statementResponse(transactions, {
        preNetBalance,
        asOfDate,
        startDate: rawStart ?? null,
        endDate: effectiveEndDate,
      }));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Get transactions for a specific customer (maps customerBalances to voucher-entry format)
  app.get("/api/accounts/customer/:id/transactions", requireAuth, async (req, res) => {
    try {
      const customerId = parseInt(req.params.id);
      if (isNaN(customerId)) {
        return res.status(400).json({ message: "Invalid customer ID" });
      }

      const asOfDate = getClientDate(req);
      const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
      const rawStart =
        typeof req.query.startDate === "string" && ISO_DATE.test(req.query.startDate) ? req.query.startDate : undefined;
      const rawEnd =
        typeof req.query.endDate === "string" && ISO_DATE.test(req.query.endDate) ? req.query.endDate : undefined;
      const effectiveEndDate = rawEnd && rawEnd < asOfDate ? rawEnd : asOfDate;

      // Load customer to get authoritative company scope
      const [customer] = await db.select().from(customers).where(eq(customers.id, customerId));
      if (!customer) return res.status(404).json({ message: "Customer not found" });
      const companyId = customer.companyId;

      // Authorize: confirm the logged-in user can access this company
      const authorizedCompanyId = await authorizeCompanyIdParam(req, companyId);
      if (authorizedCompanyId === null) {
        return res.status(403).json({ message: "No access to this account's company" });
      }

      const statement = await storage.getCustomerStatement(customerId, companyId, rawStart, effectiveEndDate);
      // Map CustomerBalance rows to the same shape the Accounts page expects for transactions
      const mapped = statement.map((row) => ({
        id: row.id,
        voucherId: row.referenceId ?? row.id,
        voucherNumber: row.referenceType ? `${row.referenceType}-${row.referenceId}` : `CB-${row.id}`,
        voucherType: row.transactionType,
        voucherDate: row.transactionDate,
        voucherDescription: row.description || "",
        narration: row.description || "",
        debitAmount: row.debitAmount,
        creditAmount: row.creditAmount,
        transactionCurrency: row.currency,
        transactionDebitAmount: row.debitAmount,
        transactionCreditAmount: row.creditAmount,
        baseDebitAmount: row.currency === "USD" ? row.debitAmount : null,
        baseCreditAmount: row.currency === "USD" ? row.creditAmount : null,
        historicalExchangeRate: row.currency === "USD" ? "1.0000000000" : null,
        rateConvention: row.currency === "USD" ? "IDENTITY" : null,
        currency: row.currency,
      }));

      let preNetBalance = 0;
      if (rawStart) {
        const bfResult = await pool.query(
          `SELECT COALESCE(SUM(cb.debit_amount::numeric - cb.credit_amount::numeric), 0) AS net
           FROM customer_balances cb
           WHERE cb.customer_id = $1
             AND cb.company_id = $2
             AND cb.transaction_date < $3::date`,
          [customerId, companyId, rawStart]
        );
        preNetBalance = parseFloat(bfResult.rows[0]?.net ?? "0");
      }

      return res.json(statementResponse(mapped, {
        preNetBalance,
        asOfDate,
        startDate: rawStart ?? null,
        endDate: effectiveEndDate,
      }));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
