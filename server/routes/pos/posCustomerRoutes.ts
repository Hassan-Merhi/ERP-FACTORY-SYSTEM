import { type Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth } from "../../auth";
import { getCustomersWithBalances } from "../customers/customerBalanceQuery";
import { loadCustomerLedgerEntryRows } from "../../services/accounting/balances/customerLedgerStatement";
import { userCompanyRoles, insertCustomerSchema, ledgerAccounts } from "@shared/schema";
import { eq, and } from "drizzle-orm";

export function registerPosCustomerRoutes(app: Express): void {
  // POS Customers - GET endpoint (for POS users with canAccessCustomers permission)
  app.get("/api/pos/customers", requireAuth, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      // If session flag is missing/false, check DB directly as a fallback
      // (covers stale sessions that predate the canAccessCustomers session field)
      let hasAccess = req.user?.canAccessCustomers ?? false;
      if (!hasAccess && req.session.userId && req.session.currentCompanyId) {
        const [roleRow] = await db
          .select({ canAccessCustomers: userCompanyRoles.canAccessCustomers })
          .from(userCompanyRoles)
          .where(
            and(
              eq(userCompanyRoles.userId, String(req.session.userId)),
              eq(userCompanyRoles.companyId, req.session.currentCompanyId)
            )
          );
        if (roleRow?.canAccessCustomers) {
          hasAccess = true;
          req.session.canAccessCustomers = true;
        }
      }

      if (!hasAccess) {
        return res.status(403).json({ message: "Access denied: You do not have permission to access customers" });
      }

      // The one balance engine's customer closing, as /api/customers/stats and
      // the voucher sidebar (customers/customerBalanceQuery.ts).
      const customersWithBalances = await getCustomersWithBalances(req.session.currentCompanyId);

      res.json(customersWithBalances);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // POS Customers - POST endpoint (for POS users with canAccessCustomers permission)
  app.post("/api/pos/customers", requireAuth, async (req, res) => {
    try {
      if (!req.user?.canAccessCustomers) {
        return res.status(403).json({ message: "Access denied: You do not have permission to create customers" });
      }

      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const dataWithCompany = {
        ...req.body,
        companyId: req.session.currentCompanyId,
      };

      const parsed = insertCustomerSchema.parse(dataWithCompany);
      if (parsed.ledgerAccountId !== undefined) {
        const [linkedLedger] = await db
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(
            and(
              eq(ledgerAccounts.id, parsed.ledgerAccountId),
              eq(ledgerAccounts.companyId, req.session.currentCompanyId)
            )
          )
          .limit(1);
        if (!linkedLedger) {
          return res.status(400).json({ message: "Linked ledger account must belong to the customer company" });
        }
      }

      let code = "CUST001";
      let suffix = 1;
      const allCustomers = await storage.getAllCustomers(req.session.currentCompanyId);

      const existingCodes = allCustomers
        .map((c) => c.code)
        .filter((c) => c.startsWith("CUST"))
        .map((c) => parseInt(c.replace("CUST", "")))
        .filter((n) => !isNaN(n));

      if (existingCodes.length > 0) {
        const maxNumber = Math.max(...existingCodes);
        suffix = maxNumber + 1;
      }

      code = `CUST${suffix.toString().padStart(3, "0")}`;

      while (await storage.getCustomerByCode(code, req.session.currentCompanyId)) {
        suffix++;
        code = `CUST${suffix.toString().padStart(3, "0")}`;
      }

      const customer = await storage.createCustomer({ ...parsed, code });

      const customerAccountCode = `CUST-${customer.code}`;
      // Use getOrCreateLedgerAccount to survive soft-deleted duplicates that
      // would cause a unique-constraint crash with a plain INSERT.
      const customerAccount = await storage.getOrCreateLedgerAccount({
        companyId: req.session.currentCompanyId,
        code: customerAccountCode,
        name: `${customer.legalName} - Customer Account`,
        accountType: "Asset",
        subType: "Accounts Receivable",
        // The customer record owns the opening (counted once by the balance
        // engine); the linked ledger starts at zero.
        openingBalance: "0",
        openingBalanceSide: "Dr",
        active: true,
      });

      await storage.updateCustomer(customer.id, {
        ledgerAccountId: customerAccount.id,
      });

      res.status(201).json(customer);
    } catch (error: unknown) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  // ── POS Customer Transactions (statement) ────────────────────────────────
  app.get("/api/pos/customers/:id/transactions", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const customerId = parseInt(req.params.id);
      if (isNaN(customerId)) return res.status(400).json({ message: "Invalid customer ID" });

      const customer = await storage.getCustomerById(customerId);
      if (!customer) return res.status(404).json({ message: "Customer not found" });
      if (customer.companyId !== companyId) return res.status(403).json({ message: "Access denied" });

      // The customer's lines on the balance engine (wave 13, A3), this company
      // only, so the statement foots to the balance the POS customer list shows.
      const { startDate, endDate } = req.query;
      const transactions = await loadCustomerLedgerEntryRows(db, {
        companyId,
        customerId,
        from: typeof startDate === "string" ? startDate : null,
        to: typeof endDate === "string" ? endDate : null,
      });

      res.json(transactions);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
