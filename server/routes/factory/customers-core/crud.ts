/**
 * factoryCustomersRoutes: FactoryCustomerCrud endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { customers, insertCustomerSchema, ledgerAccounts } from "@shared/schema";
import { eq, and, asc, desc, sql } from "drizzle-orm";
import { getCustomerLedgerAndMemo, splitBalanceFields } from "./customerLedgerSplit";
import { registerFactoryDaybookRoutes } from "../factoryDaybookRoutes";

export function registerFactoryCustomerCrudRoutes(app: Express) {
  registerFactoryDaybookRoutes(app);
  app.get("/api/factory/customers", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const allCustomers = await db
        .select()
        .from(customers)
        .where(and(eq(customers.companyId, companyId), sql`${customers.deletedAt} IS NULL`))
        .orderBy(asc(customers.legalName));

      if (allCustomers.length === 0) {
        return res.json([]);
      }

      // Ledger balance from the one balance engine, plus the amounts that are
      // not yet in the ledger (unposted factory invoices, factory POS credit
      // sales, cache-only rows) as a separate memo total. `balance` keeps its
      // meaning on this page — what the customer owes including those amounts
      // — and is now explicitly ledger + not-in-ledger (`balanceBasis`).
      const figures = await getCustomerLedgerAndMemo(
        companyId,
        allCustomers.map((c) => c.id)
      );
      const customersWithBalances = allCustomers.map((customer) => ({
        ...customer,
        ...splitBalanceFields(figures.get(customer.id)),
      }));

      res.json(customersWithBalances);
    } catch (error: unknown) {
      logger.error("Error fetching factory customers:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/factory/customers", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const dataWithCompany = { ...req.body, companyId };
      const parsed = insertCustomerSchema.parse(dataWithCompany);
      if (parsed.ledgerAccountId !== undefined) {
        const [linkedLedger] = await db
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(and(eq(ledgerAccounts.id, parsed.ledgerAccountId), eq(ledgerAccounts.companyId, companyId)))
          .limit(1);
        if (!linkedLedger) {
          return res.status(400).json({ message: "Linked ledger account must belong to the customer company" });
        }
      }

      let suffix = 1;
      const allExisting = await db.select().from(customers).where(eq(customers.companyId, companyId));

      const existingCodes = allExisting
        .map((c) => c.code)
        .filter((c) => c.startsWith("CUST"))
        .map((c) => parseInt(c.replace("CUST", "")))
        .filter((n) => !isNaN(n));

      if (existingCodes.length > 0) {
        suffix = Math.max(...existingCodes) + 1;
      }
      let code = `CUST${suffix.toString().padStart(3, "0")}`;

      let codeExists = true;
      while (codeExists) {
        const [dup] = await db
          .select()
          .from(customers)
          .where(and(eq(customers.code, code), eq(customers.companyId, companyId)));
        if (dup) {
          suffix++;
          code = `CUST${suffix.toString().padStart(3, "0")}`;
        } else {
          codeExists = false;
        }
      }

      const [customer] = await db
        .insert(customers)
        .values({ ...parsed, code })
        .returning();

      res.status(201).json(customer);
    } catch (error: unknown) {
      logger.error("Error creating factory customer:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.put("/api/factory/customers/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const customerId = parseInt(req.params.id);
      if (isNaN(customerId)) return res.status(400).json({ message: "Invalid customer ID" });

      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const [existing] = await db.select().from(customers).where(eq(customers.id, customerId));
      if (!existing) return res.status(404).json({ message: "Customer not found" });
      if (existing.companyId !== companyId) return res.status(403).json({ message: "Access denied" });

      if (req.body.code && req.body.code !== existing.code) {
        const [dup] = await db
          .select()
          .from(customers)
          .where(and(eq(customers.code, req.body.code), eq(customers.companyId, companyId)));
        if (dup) return res.status(400).json({ message: "Customer code already exists" });
      }

      const parsed = insertCustomerSchema.partial().parse(req.body);
      if (parsed.ledgerAccountId !== undefined) {
        const [linkedLedger] = await db
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(and(eq(ledgerAccounts.id, parsed.ledgerAccountId), eq(ledgerAccounts.companyId, companyId)))
          .limit(1);
        if (!linkedLedger) {
          return res.status(400).json({ message: "Linked ledger account must belong to the customer company" });
        }
      }
      const [updated] = await db.update(customers).set(parsed).where(eq(customers.id, customerId)).returning();

      res.json(updated);
    } catch (error: unknown) {
      logger.error("Error updating factory customer:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/factory/customers/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const customerId = parseInt(req.params.id);
      if (isNaN(customerId)) return res.status(400).json({ message: "Invalid customer ID" });

      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const [existing] = await db.select().from(customers).where(eq(customers.id, customerId));
      if (!existing) return res.status(404).json({ message: "Customer not found" });
      if (existing.companyId !== companyId) return res.status(403).json({ message: "Access denied" });

      const [deleted] = await db
        .update(customers)
        .set({ deletedAt: new Date() })
        .where(eq(customers.id, customerId))
        .returning();

      res.json(deleted);
    } catch (error: unknown) {
      logger.error("Error deleting factory customer:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  // RESTORE DELETED CUSTOMER
  app.post("/api/factory/customers/:id/restore", requireAuth, async (req: Request, res: Response) => {
    try {
      const customerId = parseInt(req.params.id);
      if (isNaN(customerId)) return res.status(400).json({ message: "Invalid customer ID" });
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const [existing] = await db.select().from(customers).where(eq(customers.id, customerId));
      if (!existing) return res.status(404).json({ message: "Customer not found" });
      if (existing.companyId !== companyId) return res.status(403).json({ message: "Access denied" });

      const [restored] = await db
        .update(customers)
        .set({ deletedAt: null })
        .where(eq(customers.id, customerId))
        .returning();

      res.json(restored);
    } catch (error: unknown) {
      logger.error("Error restoring factory customer:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  // LIST DELETED CUSTOMERS
  app.get("/api/factory/customers/deleted", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const deletedCustomers = await db
        .select()
        .from(customers)
        .where(and(eq(customers.companyId, companyId), sql`${customers.deletedAt} IS NOT NULL`))
        .orderBy(desc(customers.deletedAt));

      res.json(deletedCustomers);
    } catch (error: unknown) {
      logger.error("Error fetching deleted factory customers:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
