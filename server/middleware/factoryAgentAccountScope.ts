/**
 * Factory Agent Ledger reads only accounts belonging to the pinned Factory
 * company. A browser tab can change the ordinary ERP company independently.
 */
import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { bankAccounts, employees, fixedAssets, ledgerAccounts } from "@shared/schema";
import { authorizeFactoryPageAccess, sendFactoryAccessDenied } from "../lib/factoryAccessControl";

export async function requireFactoryAgentStatementAccount(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // The same handlers also serve ERP; leave those authorization rules alone.
  if (!req.path.toLowerCase().startsWith("/api/factory/agents/")) {
    next();
    return;
  }

  try {
    const decision = await authorizeFactoryPageAccess(req, "factory/agents");
    if (!decision.allowed) {
      sendFactoryAccessDenied(res, decision);
      return;
    }

    const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
    const accountId = Number(req.params.id);
    if (!companyId || !Number.isSafeInteger(accountId) || accountId <= 0) {
      res.status(400).json({ message: "Invalid Factory account context" });
      return;
    }

    // Factory's account catalog returns these four account types. Reject every
    // unsupported type rather than allowing a different company through an ID.
    const type = req.path.toLowerCase().split("/")[4];
    let ownerCompanyId: number | undefined;
    switch (type) {
      case "ledger": {
        const [row] = await db.select({ companyId: ledgerAccounts.companyId }).from(ledgerAccounts)
          .where(eq(ledgerAccounts.id, accountId)).limit(1);
        ownerCompanyId = row?.companyId;
        break;
      }
      case "bank": {
        const [row] = await db.select({ companyId: bankAccounts.companyId }).from(bankAccounts)
          .where(eq(bankAccounts.id, accountId)).limit(1);
        ownerCompanyId = row?.companyId;
        break;
      }
      case "fixed-asset": {
        const [row] = await db.select({ companyId: fixedAssets.companyId }).from(fixedAssets)
          .where(eq(fixedAssets.id, accountId)).limit(1);
        ownerCompanyId = row?.companyId;
        break;
      }
      case "employee": {
        const [row] = await db.select({ companyId: employees.companyId }).from(employees)
          .where(eq(employees.id, accountId)).limit(1);
        ownerCompanyId = row?.companyId;
        break;
      }
    }
    if (ownerCompanyId !== companyId) {
      res.status(404).json({ message: "Account not found in the Factory company" });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
}
