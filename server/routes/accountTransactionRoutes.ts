/**
 * Account-transaction routes.
 *
 * Per-account transaction listings (ledger, bank, fixed-asset, supplier,
 * employee, customer) with optional date filtering. Extracted from
 * accountRoutes.ts as a sub-registrar; behaviour is unchanged.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { eq, and, isNull } from "drizzle-orm";
import { db, pool } from "../db";
import { storage } from "../storage";
import { requireAuth } from "../auth";
import { requireFactoryAgentStatementAccount } from "../middleware/factoryAgentAccountScope";
import { authorizeCompanyIdParam } from "./helpers/supplierBalanceHelpers";
import { flagFutureDated, serverBusinessDate, statementWindow } from "./helpers/statementWindow";
import { higherPriorityTargetsAbsent } from "../services/accounting/balances/partyLineRules";
import { getCustomerByLedgerId } from "../lib/factoryCustomerLedger";
import { bankAccounts, customers, employees, fixedAssets, ledgerAccounts } from "@shared/schema";
import {
  customerLedgerNetBefore,
  loadCustomerLedgerLines,
  loadCustomerNotInLedger,
} from "../services/accounting/balances/customerLedgerStatement";
import { summarizeAccountStatementCurrency } from "../services/accounting/accountStatementCurrency";

/**
 * The statement body. Lines dated after the server's business date are
 * flagged `futureDated` (wave 17 A); `endDate` is null when the statement
 * lists everything posted.
 */
function statementResponse(transactions: unknown[], fields: Record<string, unknown>) {
  const businessDate = serverBusinessDate();
  const flagged = flagFutureDated(transactions, businessDate);
  return {
    transactions: flagged.rows,
    currencySummary: summarizeAccountStatementCurrency(flagged.rows),
    ...fields,
    endDate: fields.endDate ?? null,
    businessDate,
    futureDatedCount: flagged.futureDatedCount,
  };
}

export function registerAccountTransactionRoutes(app: Express) {
  // Get transactions for a specific ledger account with optional date filtering
  const readAgentLedgerTransactions = async (req: Request, res: Response) => {
    try {
      const ledgerAccountId = parseInt(req.params.id);

      if (isNaN(ledgerAccountId)) {
        return res.status(400).json({ message: "Invalid ledger account ID" });
      }

      // One end-date rule with the balance engine (wave 17 A, statementWindow.ts):
      // no endDate lists everything posted; future-dated lines are flagged.
      const { rawStart, effectiveEndDate, asOfDate } = statementWindow(req);

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

      // 2. A ledger account linked to a customer has no balance of its own: the
      //    balance engine rolls its lines into the customer it belongs to (the
      //    lowest customer id linking it), whatever the company type. Return the
      //    customer's ledger statement, with amounts not yet in the ledger in a
      //    separate `notInLedger` section (the factory composite used to mix
      //    finalized orders and the customer_balances cache into the rows).
      const owner = await getCustomerByLedgerId(ledgerAccountId);
      if (owner && owner.companyId === companyId) {
        const window = { companyId, customerId: owner.id, from: rawStart ?? null, to: effectiveEndDate };
        const [lines, preNetBalance, notInLedger] = await Promise.all([
          loadCustomerLedgerLines(db, window),
          customerLedgerNetBefore(db, companyId, owner.id, rawStart),
          loadCustomerNotInLedger(db, window),
        ]);
        return res.json(
          statementResponse(lines, {
            preNetBalance,
            asOfDate,
            startDate: rawStart ?? null,
            endDate: effectiveEndDate,
            customerId: owner.id,
            notInLedger,
          })
        );
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

      return res.json(
        statementResponse(transactions, {
          preNetBalance,
          asOfDate,
          startDate: rawStart ?? null,
          endDate: effectiveEndDate,
        })
      );
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  };
  app.get("/api/accounts/ledger/:id/transactions", requireAuth, (req, res) => readAgentLedgerTransactions(req, res));
  app.get(
    "/api/factory/agents/ledger/:id/transactions",
    requireAuth,
    requireFactoryAgentStatementAccount,
    readAgentLedgerTransactions
  );

  // Get transactions for a specific bank account with optional date filtering
  const readAgentBankTransactions = async (req: Request, res: Response) => {
    try {
      const bankAccountId = parseInt(req.params.id);
      if (isNaN(bankAccountId)) {
        return res.status(400).json({ message: "Invalid bank account ID" });
      }

      // One end-date rule with the balance engine (wave 17 A, statementWindow.ts):
      // no endDate lists everything posted; future-dated lines are flagged.
      const { rawStart, effectiveEndDate, asOfDate } = statementWindow(req);

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

      return res.json(
        statementResponse(transactions, {
          preNetBalance,
          asOfDate,
          startDate: rawStart ?? null,
          endDate: effectiveEndDate,
        })
      );
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  };
  app.get("/api/accounts/bank/:id/transactions", requireAuth, (req, res) => readAgentBankTransactions(req, res));
  app.get(
    "/api/factory/agents/bank/:id/transactions",
    requireAuth,
    requireFactoryAgentStatementAccount,
    readAgentBankTransactions
  );

  // Get transactions for a specific fixed asset with optional date filtering
  const readAgentAssetTransactions = async (req: Request, res: Response) => {
    try {
      const fixedAssetId = parseInt(req.params.id);
      if (isNaN(fixedAssetId)) {
        return res.status(400).json({ message: "Invalid fixed asset ID" });
      }

      // One end-date rule with the balance engine (wave 17 A, statementWindow.ts):
      // no endDate lists everything posted; future-dated lines are flagged.
      const { rawStart, effectiveEndDate, asOfDate } = statementWindow(req);

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

      return res.json(
        statementResponse(transactions, {
          preNetBalance,
          asOfDate,
          startDate: rawStart ?? null,
          endDate: effectiveEndDate,
        })
      );
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  };
  app.get("/api/accounts/fixed-asset/:id/transactions", requireAuth, (req, res) =>
    readAgentAssetTransactions(req, res)
  );
  app.get(
    "/api/factory/agents/fixed-asset/:id/transactions",
    requireAuth,
    requireFactoryAgentStatementAccount,
    readAgentAssetTransactions
  );

  // Get transactions for a specific supplier with optional date filtering
  app.get("/api/accounts/supplier/:id/transactions", requireAuth, async (req, res) => {
    try {
      const supplierId = parseInt(req.params.id);
      if (isNaN(supplierId)) {
        return res.status(400).json({ message: "Invalid supplier ID" });
      }

      // One end-date rule with the balance engine (wave 17 A, statementWindow.ts):
      // no endDate lists everything posted; future-dated lines are flagged.
      const { rawStart, effectiveEndDate, asOfDate } = statementWindow(req);

      const requestedCompanyId = req.query.companyId ? parseInt(req.query.companyId as string) : undefined;

      // Suppliers are shared across companies, so a caller-supplied companyId
      // must be authorized against the user's actual company access — never
      // trusted blindly (it would otherwise let one company's session peek at
      // another company's supplier ledger).
      const filterCompanyId = await authorizeCompanyIdParam(req, requestedCompanyId);
      if (requestedCompanyId && filterCompanyId === null) {
        return res.status(403).json({ message: "No access to this company" });
      }

      // The supplier's own lines, as the balance engine attributes them (wave 13).
      const transactions = await storage.getVoucherEntriesBySupplier(
        supplierId,
        filterCompanyId ?? undefined,
        rawStart,
        effectiveEndDate,
        { ownedOnly: true }
      );

      let preNetBalance = 0;
      if (rawStart) {
        // Brought-forward balance must be scoped to the same company as the
        // transactions above — otherwise it silently pulls in every other
        // company's history for this (globally shared) supplier record.
        const conditions = [
          `ve.supplier_id = $1`,
          // The supplier's own lines, as the balance engine attributes them (wave 13).
          higherPriorityTargetsAbsent("ve", "supplier_id"),
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

      return res.json(
        statementResponse(transactions, {
          preNetBalance,
          asOfDate,
          startDate: rawStart ?? null,
          endDate: effectiveEndDate,
        })
      );
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Get transactions for a specific employee with optional date filtering
  const readAgentEmployeeTransactions = async (req: Request, res: Response) => {
    try {
      const employeeId = parseInt(req.params.id);
      if (isNaN(employeeId)) {
        return res.status(400).json({ message: "Invalid employee ID" });
      }

      // One end-date rule with the balance engine (wave 17 A, statementWindow.ts):
      // no endDate lists everything posted; future-dated lines are flagged.
      const { rawStart, effectiveEndDate, asOfDate } = statementWindow(req);

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

      return res.json(
        statementResponse(transactions, {
          preNetBalance,
          asOfDate,
          startDate: rawStart ?? null,
          endDate: effectiveEndDate,
        })
      );
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  };
  app.get("/api/accounts/employee/:id/transactions", requireAuth, readAgentEmployeeTransactions);
  app.get(
    "/api/factory/agents/employee/:id/transactions",
    requireAuth,
    requireFactoryAgentStatementAccount,
    readAgentEmployeeTransactions
  );

  // Get transactions for a specific customer (maps customerBalances to voucher-entry format)
  app.get("/api/accounts/customer/:id/transactions", requireAuth, async (req, res) => {
    try {
      const customerId = parseInt(req.params.id);
      if (isNaN(customerId)) {
        return res.status(400).json({ message: "Invalid customer ID" });
      }

      // One end-date rule with the balance engine (wave 17 A, statementWindow.ts):
      // no endDate lists everything posted; future-dated lines are flagged.
      const { rawStart, effectiveEndDate, asOfDate } = statementWindow(req);

      // Load customer to get authoritative company scope
      const [customer] = await db.select().from(customers).where(eq(customers.id, customerId));
      if (!customer) return res.status(404).json({ message: "Customer not found" });
      const companyId = customer.companyId;

      // Authorize: confirm the logged-in user can access this company
      const authorizedCompanyId = await authorizeCompanyIdParam(req, companyId);
      if (authorizedCompanyId === null) {
        return res.status(403).json({ message: "No access to this account's company" });
      }

      // The customer's ledger lines under the balance engine's rules, so
      // opening + preNetBalance + these rows is the engine closing (the
      // trial balance's customer row, /api/customers/stats, the voucher
      // sidebar). Amounts not yet in the ledger (factory POS credit sales,
      // unposted factory invoices, cache-only rows) are listed separately in
      // `notInLedger` and never added to the rows or preNetBalance.
      const window = { companyId, customerId, from: rawStart ?? null, to: effectiveEndDate };
      const [mapped, preNetBalance, notInLedger] = await Promise.all([
        loadCustomerLedgerLines(db, window),
        customerLedgerNetBefore(db, companyId, customerId, rawStart),
        loadCustomerNotInLedger(db, window),
      ]);

      return res.json(
        statementResponse(mapped, {
          preNetBalance,
          asOfDate,
          startDate: rawStart ?? null,
          endDate: effectiveEndDate,
          notInLedger,
        })
      );
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
