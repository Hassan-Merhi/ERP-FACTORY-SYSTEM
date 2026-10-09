/**
 * employeePosFinancialRoutes: PosSalesRead endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { factoryPosSales, factoryPosSaleItems, ledgerAccounts } from "@shared/schema";
import { eq, and, desc, inArray, isNull, asc } from "drizzle-orm";
import { requireFactoryPageAccess } from "../../../../lib/factoryAccessControl";

export function registerPosSalesReadRoutes(app: Express) {
  // Read-only dropdown options for Factory POS. Do not use /api/ledger-accounts:
  // that shared route requires Accounting module permission and is intentionally
  // suppressed on non-Accounting Factory screens.
  app.get("/api/factory/pos/account-options", requireAuth, requireFactoryPageAccess("factory/pos"), async (req: Request, res: Response) => {
    try {
      // Always scope to the active Factory company; never accept companyId from query/body.
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const accounts = await db
        .select({
          id: ledgerAccounts.id,
          name: ledgerAccounts.name,
          accountType: ledgerAccounts.accountType,
        })
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.companyId, companyId),
            isNull(ledgerAccounts.deletedAt),
            eq(ledgerAccounts.active, true),
            inArray(ledgerAccounts.accountType, ["Cash", "Expense", "Direct Expense", "Indirect Expense"])
          )
        )
        .orderBy(asc(ledgerAccounts.name));
      return res.json(accounts);
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/pos/sales", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const sales = await db
        .select()
        .from(factoryPosSales)
        .where(eq(factoryPosSales.companyId, companyId))
        .orderBy(desc(factoryPosSales.createdAt));
      res.json(sales);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // GET /api/factory/pos/sales/:id — single sale with items
  app.get("/api/factory/pos/sales/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const saleId = parseInt(req.params.id);
      const [sale] = await db
        .select()
        .from(factoryPosSales)
        .where(and(eq(factoryPosSales.id, saleId), eq(factoryPosSales.companyId, companyId)));
      if (!sale) return res.status(404).json({ message: "Sale not found" });
      const items = await db.select().from(factoryPosSaleItems).where(eq(factoryPosSaleItems.saleId, saleId));
      res.json({ ...sale, items });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
