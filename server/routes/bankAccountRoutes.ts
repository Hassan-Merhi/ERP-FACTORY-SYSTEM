/**
 * Bank account master routes (split out of bankAssetRoutes.ts, wave 16 B).
 *
 * A bank account with posted lines (on the account or its linked ledger)
 * changes its opening only by an Admin or Owner and never moves company
 * (services/accounting/accountHistoryPolicy.ts); every create, edit and
 * delete is audited in the transaction that makes it, and the opening-balance
 * lock refuses an opening change after a close.
 */
import type { Express } from "express";
import { and, eq, ne } from "drizzle-orm";
import { bankAccounts, insertBankAccountSchema } from "@shared/schema";

import { requireAuth } from "../auth";
import { db } from "../db";
import { errorStatus, getErrorMessage } from "../lib/httpHandlers";
import { toMoney } from "../lib/money";
import { storage } from "../storage";
import { buildAuditChanges } from "../services/audit";
import {
  accountHistoryErrorResponse,
  assertAccountChangeAllowed,
  countAccountLines,
  lockAccountRow,
  requestRole,
} from "../services/accounting/accountHistoryPolicy";
import { logAudit } from "./_helpers";

class BankAccountRouteError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

const BANK_ACCOUNT_AUDIT_FIELDS = [
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

export function registerBankAccountRoutes(app: Express) {
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

  // Wave 16 (B): an account with posted lines changes its opening only by an
  // Admin or Owner, never moves company, and every change is audited in the
  // transaction that makes it (the opening-balance lock refuses an opening
  // change after a close).
  app.put("/api/bank-accounts/:id", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid bank account ID" });
      const parsed = insertBankAccountSchema.partial().parse(req.body);

      // Validate opening balance amount and side must both be present or both absent
      const hasBalance = parsed.openingBalance && !toMoney(parsed.openingBalance).isZero();
      const hasSide = !!parsed.openingBalanceSide;

      if (hasBalance && !hasSide) {
        return res.status(400).json({ message: "Opening balance requires Dr/Cr side" });
      }

      if (!hasBalance && hasSide) {
        return res.status(400).json({ message: "Dr/Cr side requires opening balance amount" });
      }

      const account = await db.transaction(async (tx) => {
        await lockAccountRow(tx, "bank_accounts", id);
        const [existing] = await tx
          .select()
          .from(bankAccounts)
          .where(and(eq(bankAccounts.id, id), eq(bankAccounts.companyId, companyId)));
        if (!existing) throw new BankAccountRouteError(404, "Bank account not found");

        const updates = { ...parsed };
        if (updates.companyId === existing.companyId) delete updates.companyId;
        const after = { ...existing, ...updates };
        const lines = await countAccountLines(tx, [
          ["bank_account_id", id],
          ["ledger_account_id", existing.linkedLedgerId],
        ]);
        assertAccountChangeAllowed({
          role: requestRole(req),
          lines,
          opening: {
            before: { amount: existing.openingBalance, side: existing.openingBalanceSide },
            after: { amount: after.openingBalance, side: after.openingBalanceSide },
            defaultSide: "Dr",
          },
          company: { before: existing.companyId, after: updates.companyId },
        });

        if (updates.code && updates.code !== existing.code) {
          const [duplicate] = await tx
            .select({ id: bankAccounts.id })
            .from(bankAccounts)
            .where(
              and(eq(bankAccounts.code, updates.code), eq(bankAccounts.companyId, companyId), ne(bankAccounts.id, id))
            );
          if (duplicate) throw new BankAccountRouteError(400, "Bank account code already exists in this company");
        }

        const [updated] = await tx
          .update(bankAccounts)
          .set(updates)
          .where(and(eq(bankAccounts.id, id), eq(bankAccounts.companyId, companyId)))
          .returning();
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || "unknown",
            companyId,
            action: "update",
            tableName: "bank_accounts",
            recordId: updated.id,
            recordIdentifier: updated.name,
            changes: buildAuditChanges(existing, updated, [...BANK_ACCOUNT_AUDIT_FIELDS]),
          },
          tx
        );
        return updated;
      });
      res.json(account);
    } catch (error: unknown) {
      const refused = accountHistoryErrorResponse(error);
      if (refused) return res.status(refused.status).json(refused.body);
      if (error instanceof BankAccountRouteError) return res.status(error.status).json({ message: error.message });
      res.status(errorStatus(error, 400)).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/bank-accounts/:id", requireAuth, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const id = parseInt(req.params.id);
      const companyId = req.session.currentCompanyId;
      // Wave 16 (B): checked, retired and audited in one transaction.
      await db.transaction(async (tx) => {
        await lockAccountRow(tx, "bank_accounts", id);
        const [existing] = await tx
          .select()
          .from(bankAccounts)
          .where(and(eq(bankAccounts.id, id), eq(bankAccounts.companyId, companyId)));
        if (!existing) throw new BankAccountRouteError(404, "Bank account not found");
        const lines = await countAccountLines(tx, [["bank_account_id", id]]);
        if (lines.any > 0) {
          throw new BankAccountRouteError(400, `Cannot delete bank account: ${lines.any} voucher entries exist`);
        }
        await tx
          .update(bankAccounts)
          .set({ deletedAt: new Date(), active: false })
          .where(and(eq(bankAccounts.id, id), eq(bankAccounts.companyId, companyId)));
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || "unknown",
            companyId,
            action: "delete",
            tableName: "bank_accounts",
            recordId: existing.id,
            recordIdentifier: existing.name,
            changes: {
              name: { old: existing.name, new: null },
              code: { old: existing.code, new: null },
              openingBalance: { old: existing.openingBalance || "0", new: null },
              openingBalanceSide: { old: existing.openingBalanceSide || null, new: null },
            },
          },
          tx
        );
      });
      res.status(204).send();
    } catch (error: unknown) {
      if (error instanceof BankAccountRouteError) return res.status(error.status).json({ message: error.message });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
