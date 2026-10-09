/**
 * ledgerRoutesLegacy: LedgerAccountWrite endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { errorStatus, getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireNonPOS } from "../../auth";
import { logAudit } from "../_helpers";
import { ledgerAccounts, customers, insertLedgerAccountSchema, updateLedgerAccountSchema } from "@shared/schema";
import { eq } from "drizzle-orm";
import { toMoney } from "../../lib/money";
import { buildAuditChanges } from "../../services/audit";
import { defaultOpeningSide } from "../../services/accounting/accountClassification";
import {
  accountHistoryErrorResponse,
  assertAccountChangeAllowed,
  countAccountLines,
  lockAccountRow,
  requestRole,
} from "../../services/accounting/accountHistoryPolicy";

const VALID_LEDGER_SUBTYPES: Record<string, string[]> = {
  Expense: ["Direct Expense", "Indirect Expense"],
  Liability: [
    "Current Liability",
    "Long-term Liability",
    "Loans Payable",
    "Output Tax",
    "Tax Payable",
    "sp_otw_clearing",
    "sp_cost_clearing",
    "sp_pay_deduction_clearing",
    "sp_payable",
  ],
  Asset: [
    "Current Asset",
    "Fixed Asset",
    "Input Tax",
    "Tax Receivable",
    "sp_goods_otw",
    "sp_prepaid",
    "sp_stock",
    "sp_prepaid_expenses",
  ],
  "Direct Expense": ["sp_cogs", "sp_shared_charges"],
  Income: ["Direct Income", "Indirect Income", "sp_sales"],
  Equity: ["sp_opnbal", "gc_partner_capital", "gc_owner_capital", "gc_profit_pending_distribution"],
  Loans: ["gc_hassan_savings"],
  Intercompany: ["sp_hadi_intercompany", "hadi_sp_intercompany"],
};

export function registerLedgerAccountWriteRoutes(app: Express) {
  app.post("/api/ledger-accounts", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const parsed = insertLedgerAccountSchema.parse(req.body);
      if (parsed.companyId !== companyId) {
        return res.status(403).json({
          message: "Access denied: Ledger account belongs to a different company",
        });
      }

      // Check for duplicate name within the same company
      const existingByName = await storage.getLedgerAccountByName(parsed.name, parsed.companyId);
      if (existingByName) {
        return res.status(400).json({
          message: "Duplicate ledger: A ledger account with this name already exists",
        });
      }

      // Auto-generate code from name if not provided
      if (!parsed.code) {
        // Generate code from name: take first 3 letters of each word, uppercase
        const words = parsed.name
          .trim()
          .split(/\s+/)
          .filter((w) => w.length > 0);
        let baseCode = words
          .map((w) => w.substring(0, 3))
          .join("")
          .toUpperCase();

        // Fallback if baseCode is empty (shouldn't happen with validation, but be safe)
        if (!baseCode || baseCode.length === 0) {
          baseCode = "ACC";
        }

        // Ensure uniqueness by adding suffix if needed
        let code = baseCode;
        let suffix = 1;
        while (await storage.getLedgerAccountByCode(code, req.session.currentCompanyId!)) {
          code = `${baseCode}${suffix}`;
          suffix++;
        }
        parsed.code = code;
      } else {
        // Check for duplicate code if manually provided
        const existing = await storage.getLedgerAccountByCode(parsed.code, req.session.currentCompanyId!);
        if (existing) {
          return res.status(400).json({ message: "Ledger account code already exists" });
        }
      }

      // Validate opening balance amount and side must both be present or both absent
      const hasBalance = parsed.openingBalance && !toMoney(parsed.openingBalance).isZero();
      const hasSide = parsed.openingBalanceSide && (parsed.openingBalanceSide as string) !== "";

      if (hasBalance && !hasSide) {
        return res.status(400).json({ message: "Opening balance requires Dr/Cr side" });
      }

      // Validate subType based on accountType
      // "Group" is a universal special subType used to mark an account as a parent group
      // and bypasses the per-type validation intentionally.
      if (parsed.subType && parsed.subType !== "Group" && VALID_LEDGER_SUBTYPES[parsed.accountType]) {
        if (!VALID_LEDGER_SUBTYPES[parsed.accountType].includes(parsed.subType)) {
          return res.status(400).json({
            message: `Invalid subType "${parsed.subType}" for accountType "${parsed.accountType}". Valid options: ${VALID_LEDGER_SUBTYPES[parsed.accountType].join(", ")}`,
          });
        }
      }

      // Wave 16 (B): created and audited in one transaction.
      const account = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(ledgerAccounts)
          .values({ ...parsed, code: parsed.code || `LA-${Date.now()}` })
          .returning();
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || "unknown",
            companyId: parsed.companyId,
            action: "create",
            tableName: "ledger_accounts",
            recordId: created.id,
            recordIdentifier: created.name,
            changes: {
              name: { new: created.name },
              code: { new: created.code },
              accountType: { new: created.accountType },
              subType: { new: created.subType || null },
              openingBalance: { new: created.openingBalance || "0" },
              openingBalanceSide: { new: created.openingBalanceSide || null },
            },
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

  app.put("/api/ledger-accounts/:id", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const accountId = parseInt(req.params.id);
      if (isNaN(accountId)) {
        return res.status(400).json({ message: "Invalid account ID" });
      }

      // Verify account exists and belongs to current company
      const existingAccount = await storage.getLedgerAccountById(accountId);
      if (!existingAccount) {
        return res.status(404).json({ message: "Account not found" });
      }
      if (existingAccount.companyId !== req.session.currentCompanyId) {
        return res.status(403).json({
          message: "Access denied: Account belongs to a different company",
        });
      }

      const parsed = updateLedgerAccountSchema.parse({
        ...req.body,
        id: accountId,
      });

      // Check for duplicate code if code is being changed
      if (parsed.code && parsed.code !== existingAccount.code) {
        const duplicate = await storage.getLedgerAccountByCode(parsed.code, req.session.currentCompanyId!);
        if (duplicate) {
          return res.status(400).json({ message: "Ledger account code already exists" });
        }
      }

      // Validate opening balance amount and side must both be present or both absent
      const hasBalance = parsed.openingBalance && !toMoney(parsed.openingBalance).isZero();
      const hasSide = parsed.openingBalanceSide && (parsed.openingBalanceSide as string) !== "";

      if (hasBalance && !hasSide) {
        return res.status(400).json({ message: "Opening balance requires Dr/Cr side" });
      }

      // Validate subType based on accountType if accountType is being updated
      const accountType = parsed.accountType || existingAccount.accountType;
      if (parsed.subType && parsed.subType !== "Group" && VALID_LEDGER_SUBTYPES[accountType]) {
        const allowedAccountTypes = parsed.subType === "sp_payable" ? ["Liability", "Accounts Payable"] : [accountType];
        if (
          !VALID_LEDGER_SUBTYPES[accountType].includes(parsed.subType) ||
          !allowedAccountTypes.includes(accountType)
        ) {
          return res.status(400).json({
            message: `Invalid subType "${parsed.subType}" for accountType "${accountType}". Valid options: ${VALID_LEDGER_SUBTYPES[accountType].join(", ")}`,
          });
        }
      }

      // Atomic: ledger update + reverse-sync to linked customer must succeed
      // together or both roll back. Wave 16 (B): the account is locked, the
      // history rules applied (an account with posted lines changes its opening
      // only by an Admin or Owner, keeps its type category and its company),
      // and the audit row is written in the same transaction.
      const updates: Partial<typeof parsed> = { ...parsed };
      delete updates.id;
      if (updates.companyId === existingAccount.companyId) delete updates.companyId;
      const updatedAccount = await db.transaction(async (tx) => {
        await lockAccountRow(tx, "ledger_accounts", accountId);
        const [before] = await tx.select().from(ledgerAccounts).where(eq(ledgerAccounts.id, accountId));
        if (!before) throw new Error("Account not found");
        const after = { ...before, ...updates };
        assertAccountChangeAllowed({
          role: requestRole(req),
          lines: await countAccountLines(tx, [["ledger_account_id", accountId]]),
          opening: {
            before: { amount: before.openingBalance, side: before.openingBalanceSide },
            after: { amount: after.openingBalance, side: after.openingBalanceSide },
            defaultSide: defaultOpeningSide(before.accountType) ?? "Dr",
          },
          type: {
            before: { accountType: before.accountType, subType: before.subType },
            after: { accountType: after.accountType, subType: after.subType },
          },
          company: { before: before.companyId, after: updates.companyId },
        });

        const [updated] = await tx
          .update(ledgerAccounts)
          .set(updates)
          .where(eq(ledgerAccounts.id, accountId))
          .returning();

        if (parsed.openingBalance !== undefined || parsed.openingBalanceSide !== undefined) {
          const [linkedCust] = await tx
            .select({
              id: customers.id,
              legalName: customers.legalName,
              openingBalance: customers.openingBalance,
              openingBalanceSide: customers.openingBalanceSide,
            })
            .from(customers)
            .where(eq(customers.ledgerAccountId, accountId))
            .limit(1);
          if (linkedCust) {
            const update: { openingBalance?: string; openingBalanceSide?: string } = {};
            if (parsed.openingBalance !== undefined) {
              update.openingBalance = updated.openingBalance ?? "0";
            }
            if (parsed.openingBalanceSide !== undefined) {
              update.openingBalanceSide = updated.openingBalanceSide ?? "Dr";
            }
            if (Object.keys(update).length > 0) {
              const changes = buildAuditChanges(linkedCust, { ...linkedCust, ...update }, [
                "openingBalance",
                "openingBalanceSide",
              ]);
              await tx.update(customers).set(update).where(eq(customers.id, linkedCust.id));
              if (Object.keys(changes).length > 0) {
                await logAudit(
                  {
                    userId: req.session.userId!,
                    username: req.session.username || "unknown",
                    companyId: req.session.currentCompanyId!,
                    action: "update",
                    tableName: "customers",
                    recordId: linkedCust.id,
                    recordIdentifier: linkedCust.legalName,
                    changes,
                  },
                  tx
                );
              }
            }
          }
        }

        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || "unknown",
            companyId: req.session.currentCompanyId!,
            action: "update",
            tableName: "ledger_accounts",
            recordId: updated.id,
            recordIdentifier: updated.name,
            changes: buildAuditChanges(before, updated, [
              "name",
              "code",
              "companyId",
              "accountType",
              "subType",
              "parentId",
              "openingBalance",
              "openingBalanceSide",
              "openingBalanceCurrency",
              "openingBalanceHistoricalRate",
              "openingBalanceBaseAmount",
              "active",
            ]),
          },
          tx
        );
        return updated;
      });

      res.json(updatedAccount);
    } catch (error: unknown) {
      const refused = accountHistoryErrorResponse(error);
      if (refused) return res.status(refused.status).json(refused.body);
      res.status(errorStatus(error, 400)).json({ message: getErrorMessage(error) });
    }
  });

  // Bulk-assign parentId to multiple ledger accounts
  app.patch("/api/ledger-accounts/bulk-assign-parent", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const { accountIds, parentId } = req.body;
      if (!Array.isArray(accountIds) || accountIds.length === 0) {
        return res.status(400).json({ message: "accountIds must be a non-empty array" });
      }
      const companyId = req.session.currentCompanyId;
      const results = [];
      for (const id of accountIds) {
        const account = await storage.getLedgerAccountById(id);
        if (!account || account.companyId !== companyId) continue;
        if (parentId !== null && parentId !== undefined) {
          const parent = await storage.getLedgerAccountById(parentId);
          if (!parent || parent.companyId !== companyId) {
            return res.status(400).json({ message: `Parent account ${parentId} not found` });
          }
        }
        const updated = await storage.updateLedgerAccount({ id, parentId: parentId ?? null });
        results.push(updated);
      }
      res.json(results);
    } catch (error: unknown) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
