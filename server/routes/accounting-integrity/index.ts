/**
 * Accounting integrity routes (2026-10 accounting audit).
 *
 * The integrity diagnostic and the trial balance are read-only: the diagnostic
 * runs the audit's ledger checks for the current company, and the trial balance
 * reports every posted line and opening balance with any difference shown
 * explicitly, never plugged. The system-account and account-type routes report
 * by GET and change the chart of accounts only by an explicit, audited POST that
 * never alters an existing account's history.
 */

/** Accounts whose type differs from a recognised type only by case or spaces. */
async function miscasedAccounts(companyId: number) {
  const rows = await db
    .select({
      id: ledgerAccounts.id,
      code: ledgerAccounts.code,
      name: ledgerAccounts.name,
      accountType: ledgerAccounts.accountType,
    })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.companyId, companyId), isNull(ledgerAccounts.deletedAt)));
  return rows
    .map((row) => ({ ...row, canonicalType: canonicalAccountType(row.accountType) }))
    .filter((row) => row.canonicalType !== row.accountType);
}
import type { Express } from "express";

import { and, eq, inArray, isNull } from "drizzle-orm";

import { ledgerAccounts } from "@shared/schema";

import { requireAuth, requireRole } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logAudit } from "../_helpers";
import { canonicalAccountType } from "../../services/accounting/accountClassification";
import {
  SYSTEM_ACCOUNTS,
  diagnoseSystemAccounts,
  ensureSystemAccounts,
} from "../../services/accounting/systemAccounts";
import { runAccountingIntegrityDiagnostic } from "../../services/accounting/integrity/accountingIntegrityDiagnostic";
import { buildTrialBalance } from "../../services/accounting/integrity/trialBalance";
import {
  FactoryFxRepairPlanChangedError,
  applyFactoryFxLegacyRepair,
  planFactoryFxLegacyRepair,
} from "../../services/factory/factoryFxLegacyRepair";
import {
  OpeningJournalRefusal,
  applyOpeningInventoryJournal,
  planOpeningInventoryJournal,
} from "../../services/accounting/perpetualInventory/openingJournal";
import { syncFactoryStockJournalTx } from "../../services/accounting/perpetualInventory/factoryStockJournal";
import { listUnpostedFactoryInvoices } from "../../services/accounting/perpetualInventory/factoryInvoice";
import { reconcilePerpetualInventory } from "../../services/accounting/perpetualInventory/reconciliation";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function registerAccountingIntegrityRoutes(app: Express) {
  app.get("/api/accounting/integrity", requireAuth, requireRole("Admin", "Owner"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      res.json(await runAccountingIntegrityDiagnostic(companyId));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/accounting/trial-balance", requireAuth, requireRole("Admin", "Owner"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const asOf = typeof req.query.asOf === "string" && req.query.asOf ? req.query.asOf : null;
      if (asOf && !ISO_DATE.test(asOf)) return res.status(400).json({ message: "Invalid date" });
      res.json(await buildTrialBalance(companyId, asOf));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/accounting/system-accounts", requireAuth, requireRole("Admin", "Owner"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const statuses = await diagnoseSystemAccounts(db, companyId);
      res.json({
        definitions: SYSTEM_ACCOUNTS,
        statuses,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/accounting/system-accounts/ensure", requireAuth, requireRole("Admin", "Owner"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      // Creating accounts is explicit: an empty or malformed request changes nothing.
      if (req.body?.confirm !== true) return res.status(400).json({ message: "Confirmation is required" });
      const known = new Set(SYSTEM_ACCOUNTS.map((definition) => definition.code));
      const codes: unknown = req.body?.codes;
      if (codes !== undefined && (!Array.isArray(codes) || codes.some((code) => !known.has(String(code))))) {
        return res.status(400).json({ message: "Unknown system account code" });
      }
      // Wave 16 (B): the created accounts are audited in the creating transaction.
      const statuses = await db.transaction(async (tx) => {
        const result = await ensureSystemAccounts(tx, companyId, codes === undefined ? undefined : (codes as string[]));
        const created = result.filter((status) => status.state === "created");
        if (created.length > 0) {
          await logAudit(
            {
              userId: req.session.userId!,
              username: req.session.username || "unknown",
              companyId,
              action: "create",
              tableName: "ledger_accounts",
              recordIdentifier: "system-accounts",
              changes: { created: { new: created } },
            },
            tx
          );
        }
        return result;
      });
      res.json({ statuses });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get(
    "/api/accounting/account-types/normalization",
    requireAuth,
    requireRole("Admin", "Owner"),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const accounts = await miscasedAccounts(companyId);
        res.json({
          fixable: accounts.filter((account) => account.canonicalType !== null),
          unknown: accounts.filter((account) => account.canonicalType === null),
        });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // Rewrites only the spelling of a type ('EXPENSE' -> 'Expense'); a type that
  // is genuinely wrong is reported for review, never guessed.
  app.post("/api/accounting/account-types/normalize", requireAuth, requireRole("Admin", "Owner"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (req.body?.confirm !== true) return res.status(400).json({ message: "Confirmation is required" });
      const fixable = (await miscasedAccounts(companyId)).filter((account) => account.canonicalType !== null);
      await db.transaction(async (tx) => {
        for (const account of fixable) {
          await tx
            .update(ledgerAccounts)
            .set({ accountType: account.canonicalType! })
            .where(
              and(
                eq(ledgerAccounts.companyId, companyId),
                inArray(ledgerAccounts.id, [account.id]),
                eq(ledgerAccounts.accountType, account.accountType)
              )
            );
        }
        // Wave 16 (B): audited in the same transaction.
        if (fixable.length > 0) {
          await logAudit(
            {
              userId: req.session.userId!,
              username: req.session.username || "unknown",
              companyId,
              action: "update",
              tableName: "ledger_accounts",
              recordIdentifier: "account-type-normalization",
              changes: {
                accountType: {
                  old: fixable.map((account) => ({ id: account.id, type: account.accountType })),
                  new: fixable.map((account) => ({ id: account.id, type: account.canonicalType })),
                },
              },
            },
            tx
          );
        }
      });
      res.json({ normalized: fixable.length, accounts: fixable });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Legacy factory foreign-currency lines (wave 6): the plan is read-only; the
  // apply converts only lines classified from their own voucher, at that
  // voucher's stored rate, and reports everything else.
  app.get("/api/accounting/factory-fx-repair", requireAuth, requireRole("Admin", "Owner"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      res.json(await planFactoryFxLegacyRepair(companyId));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // The apply re-derives the plan in its transaction and audits it there (wave 14);
  // it needs the reviewed `planHash` (400 without it, wave 17 C) and refuses a
  // plan that changed since (409).
  app.post("/api/accounting/factory-fx-repair/apply", requireAuth, requireRole("Admin", "Owner"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (req.body?.confirm !== true) return res.status(400).json({ message: "Confirmation is required" });
      // The reviewed plan's hash is required (wave 17 C, owner decision 4).
      const expectedPlanHash = typeof req.body?.planHash === "string" ? req.body.planHash.trim() : "";
      if (!expectedPlanHash) {
        return res.status(400).json({
          message: "The reviewed plan's planHash is required to apply the repair",
          code: "FACTORY_FX_REPAIR_PLAN_HASH_REQUIRED",
        });
      }
      const plan = await applyFactoryFxLegacyRepair(companyId, {
        actor: { userId: req.session.userId!, username: req.session.username || "unknown" },
        expectedPlanHash,
      });
      res.json(plan);
    } catch (error: unknown) {
      if (error instanceof FactoryFxRepairPlanChangedError) {
        return res.status(409).json({ message: error.message, code: error.code });
      }
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Perpetual-inventory cut-over (wave 8): the opening inventory journal is
  // planned read-only and applied once per company by an Owner, only when every
  // posting path is converted (PERPETUAL_INVENTORY_POSTING_READY).
  app.get(
    "/api/accounting/perpetual-inventory/opening-plan",
    requireAuth,
    requireRole("Admin", "Owner"),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const effectiveFrom = typeof req.query.effectiveFrom === "string" ? req.query.effectiveFrom : undefined;
        if (effectiveFrom !== undefined && !ISO_DATE.test(effectiveFrom)) {
          return res.status(400).json({ message: "Invalid date" });
        }
        res.json(await planOpeningInventoryJournal(companyId, effectiveFrom));
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // Perpetual inventory (wave 8.4): today's factory stock journal, run now
  // (the scheduler runs it every evening).
  app.post(
    "/api/accounting/perpetual-inventory/factory-stock-journal",
    requireAuth,
    requireRole("Admin", "Owner"),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const result = await db.transaction((tx) => syncFactoryStockJournalTx(tx, companyId));
        res.json(result);
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // Perpetual inventory (wave 8.5): ledger against stock sub-ledgers, account by account.
  app.get(
    "/api/accounting/perpetual-inventory/reconciliation",
    requireAuth,
    requireRole("Admin", "Owner"),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        res.json(await reconcilePerpetualInventory(db, companyId));
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // Factory invoices on or after the cut-over that carry no ledger journal
  // (a currency other than USD has no exchange rate to post at).
  app.get(
    "/api/accounting/perpetual-inventory/unposted-factory-invoices",
    requireAuth,
    requireRole("Admin", "Owner"),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        res.json(await listUnpostedFactoryInvoices(db, companyId));
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.post("/api/accounting/perpetual-inventory/apply", requireAuth, requireRole("Owner"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (req.body?.confirm !== true) return res.status(400).json({ message: "Confirmation is required" });
      const effectiveFrom = req.body?.effectiveFrom;
      if (typeof effectiveFrom !== "string" || !ISO_DATE.test(effectiveFrom)) {
        return res.status(400).json({ message: "Invalid date" });
      }
      const result = await applyOpeningInventoryJournal(companyId, effectiveFrom, req.session.username || "unknown");
      await logAudit({
        userId: req.session.userId!,
        username: req.session.username || "unknown",
        companyId,
        action: "create",
        tableName: "gl_inventory_cutovers",
        recordIdentifier: "perpetual-inventory-cutover",
        changes: { cutover: { new: { effectiveFrom, voucherId: result.voucherId, total: result.plan.total } } },
      });
      res.json(result);
    } catch (error: unknown) {
      if (error instanceof OpeningJournalRefusal) {
        return res.status(error.code === "INVALID_DATE" ? 400 : 409).json({ message: error.message, code: error.code });
      }
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
