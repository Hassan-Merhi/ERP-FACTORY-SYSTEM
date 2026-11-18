import { type Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth } from "../../auth";
import { getCustomersWithBalances } from "../customers/customerBalanceQuery";
import { loadCustomerLedgerEntryRows } from "../../services/accounting/balances/customerLedgerStatement";
import { insertCustomerSchema, ledgerAccounts } from "@shared/schema";
import { requirePosCustomerPermission } from "../../middleware/posCustomerPermission";
import { getActiveCompanyPermissionContext } from "../../services/security/activeCompanyPermissionContext";
import { hasZeroOpeningBalance, posCustomerAccessText } from "@shared/posCustomerAccess";
import { eq, and } from "drizzle-orm";

export function registerPosCustomerRoutes(app: Express): void {
  // POS Customers - GET endpoint (for POS users with canAccessCustomers permission)
  app.get("/api/pos/customers", requireAuth, requirePosCustomerPermission, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
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
  app.post("/api/pos/customers", requireAuth, requirePosCustomerPermission, async (req, res) => {
    try {
      const access = await getActiveCompanyPermissionContext(req);
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      if (access.role === "POS" && !hasZeroOpeningBalance(req.body?.openingBalance)) {
        return res.status(403).json({ code: "POS_CUSTOMER_OPENING_BALANCE_DENIED", message: posCustomerAccessText.openingDenied });
      }
      if (access.role === "POS" && req.body?.ledgerAccountId != null) {
        return res.status(403).json({ code: "POS_CUSTOMER_LEDGER_LINK_DENIED", message: posCustomerAccessText.ledgerDenied });
      }
      const safeInput =
        access.role === "POS"
          ? { legalName: req.body?.legalName, phone: req.body?.phone, openingBalance: "0", openingBalanceSide: "Dr" }
          : req.body;
      const dataWithCompany = { ...safeInput, companyId: access.companyId };

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
  app.get("/api/pos/customers/:id/transactions", requireAuth, requirePosCustomerPermission, async (req, res) => {
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
