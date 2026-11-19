// Extracted from ./bankAccountRoutes.ts
import type { Express } from "express";
import { bankAccounts, insertBankAccountSchema } from "@shared/schema";
import { requireAuth } from "../auth";
import { db } from "../db";
import { errorStatus, getErrorMessage } from "../lib/httpHandlers";
import { toMoney } from "../lib/money";
import { storage } from "../storage";
import { buildAuditChanges } from "../services/audit";
import { logAudit } from "./_helpers";

export const BANK_ACCOUNT_AUDIT_FIELDS = [
  "name",
  "code",
  "companyId",
  "bankName",
  "accountNumber",
  "linkedLedgerId",
  "openingBalance",
  "openingBalanceSide",
  "openingBalanceNativeAmount",
  "openingBalanceCurrency",
  "openingBalanceHistoricalRate",
  "openingBalanceBaseAmount",
  "active",
] as const;

export function registerBankAccountRoutesPart1(app: Express) {
  app.get("/api/bank-accounts", requireAuth, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const accounts = await storage.getAllBankAccounts(req.session.currentCompanyId);
      res.json(accounts);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/bank-accounts", requireAuth, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      // The account belongs to the active company; a companyId in the body is ignored.
      const parsed = insertBankAccountSchema.parse({ ...req.body, companyId: req.session.currentCompanyId });

      // Check for duplicate code
      const existing = await storage.getBankAccountByCode(parsed.code);
      if (existing) {
        return res.status(400).json({ message: "Bank account code already exists" });
      }

      // Validate opening balance amount and side must both be present or both absent
      const hasBalance = parsed.openingBalance && !toMoney(parsed.openingBalance).isZero();
      const hasSide = !!parsed.openingBalanceSide;

      if (hasBalance && !hasSide) {
        return res.status(400).json({ message: "Opening balance requires Dr/Cr side" });
      }

      if (!hasBalance && hasSide) {
        return res.status(400).json({ message: "Dr/Cr side requires opening balance amount" });
      }

      // Validate linked ledger is Bank or Cash type
      if (parsed.linkedLedgerId) {
        const allLedgers = await storage.getAllLedgerAccounts(req.session.currentCompanyId!);
        const linkedLedger = allLedgers.find((l) => l.id === parsed.linkedLedgerId);

        if (!linkedLedger) {
          return res.status(400).json({ message: "Linked ledger account not found" });
        }

        if (linkedLedger.accountType !== "Bank" && linkedLedger.accountType !== "Cash") {
          return res.status(400).json({
            message: `Linked ledger must be Bank or Cash type. Found: ${linkedLedger.accountType}`,
          });
        }
      }

      // Wave 16 (B): created and audited in one transaction.
      const account = await db.transaction(async (tx) => {
        const [created] = await tx.insert(bankAccounts).values(parsed).returning();
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || "unknown",
            companyId: req.session.currentCompanyId!,
            action: "create",
            tableName: "bank_accounts",
            recordId: created.id,
            recordIdentifier: created.name,
            changes: buildAuditChanges(null, created, [...BANK_ACCOUNT_AUDIT_FIELDS]),
          },
          tx
        );
        return created;
      });
      res.status(201).json(account);
    } catch (error: unknown) {
      res.status(errorStatus(error, 400)).json({ message: getErrorMessage(error) });
    }
  });
}
