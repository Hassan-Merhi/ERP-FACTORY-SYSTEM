/**
 * ledgerRoutesLegacy: LedgerAccountWrite endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { errorStatus, getErrorMessage, HttpError } from "../../lib/httpHandlers";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireNonPOS, requireRole } from "../../auth";
import { logAudit } from "../_helpers";
import { ledgerAccounts, customers, insertLedgerAccountSchema, updateLedgerAccountSchema } from "@shared/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { toMoney } from "../../lib/money";
import { buildAuditChanges } from "../../services/audit";
import { defaultOpeningSide } from "../../services/accounting/accountClassification";
import { isSystemResolvedAccountCode } from "../../services/accounting/systemAccounts";
import {
  ACCOUNT_HISTORY_EDIT_ROLES,
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

export const LEDGER_ACCOUNT_DELETE_VIA_EDIT_CODE = "LEDGER_ACCOUNT_DELETE_VIA_EDIT_REFUSED" as const;
export const LEDGER_ACCOUNT_DELETE_VIA_EDIT_MESSAGE =
  "An account is deleted with the delete action, not by editing it.";
export const LEDGER_ACCOUNT_CODE_ACTIVE_FORBIDDEN_CODE = "LEDGER_ACCOUNT_CODE_ACTIVE_CHANGE_FORBIDDEN" as const;
export const LEDGER_ACCOUNT_CODE_ACTIVE_FORBIDDEN_MESSAGE =
  "Only an Admin or Owner can change an account's code or active status.";
export const SYSTEM_ACCOUNT_CODE_RESERVED_CODE = "SYSTEM_ACCOUNT_CODE_RESERVED" as const;
export const SYSTEM_ACCOUNT_CODE_RESERVED_MESSAGE =
  "The system finds an account by this code, so an account cannot be re-coded to it or away from it.";

// Phase 19 (B), C6: the accounts the system resolves by code (registry, RETAIL-*,
// literal look-ups) keep their code and their name.
export const SYSTEM_ACCOUNT_RENAME_REFUSED_CODE = "SYSTEM_ACCOUNT_RENAME_REFUSED" as const;
export const SYSTEM_ACCOUNT_RENAME_REFUSED_MESSAGE = "This is a system account: its name cannot be changed.";
// Phase 19 (B), C5: the tree guard (ledgerIntegrityGuard.ts) refuses the link.
export const LEDGER_ACCOUNT_PARENT_INVALID_CODE = "LEDGER_ACCOUNT_PARENT_INVALID" as const;
export const LEDGER_ACCOUNT_PARENT_INVALID_MESSAGE =
  "The parent must be another live account of this company and of the same class, and not one of its sub-accounts.";

/** The tree guard's refusal as a 409 body, or null for any other error. */
export function ledgerParentErrorResponse(
  error: unknown
): { status: 409; body: { message: string; code: string; detail: string } } | null {
  // A database error may arrive wrapped (drizzle's query error keeps it as the cause).
  const cause = (error as { cause?: unknown } | null)?.cause;
  const detail = [getErrorMessage(error), cause ? getErrorMessage(cause) : ""].find((message) =>
    message.includes(LEDGER_ACCOUNT_PARENT_INVALID_CODE)
  );
  if (!detail) return null;
  return {
    status: 409,
    body: { message: LEDGER_ACCOUNT_PARENT_INVALID_MESSAGE, code: LEDGER_ACCOUNT_PARENT_INVALID_CODE, detail },
  };
}

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

      // Phase 19 (B), C6: a code the system resolves accounts by is the
      // registry's to create (ensureSystemAccounts), never a user's.
      if (parsed.code && isSystemResolvedAccountCode(parsed.code)) {
        return res
          .status(409)
          .json({ message: SYSTEM_ACCOUNT_CODE_RESERVED_MESSAGE, code: SYSTEM_ACCOUNT_CODE_RESERVED_CODE });
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
        while (
          isSystemResolvedAccountCode(code) ||
          (await storage.getLedgerAccountByCode(code, req.session.currentCompanyId!))
        ) {
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
      const parentRefused = ledgerParentErrorResponse(error);
      if (parentRefused) return res.status(parentRefused.status).json(parentRefused.body);
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

      // Wave 18 (B): deletedAt is never written by an edit (the delete route
      // retires and audits an account); code and active are Admin/Owner only,
      // and a code the system resolves accounts by cannot be taken or given up.
      if (req.body && typeof req.body === "object" && "deletedAt" in req.body) {
        return res
          .status(400)
          .json({ message: LEDGER_ACCOUNT_DELETE_VIA_EDIT_MESSAGE, code: LEDGER_ACCOUNT_DELETE_VIA_EDIT_CODE });
      }

      const parsed = updateLedgerAccountSchema.parse({
        ...req.body,
        id: accountId,
      });

      const codeChanges = parsed.code !== undefined && parsed.code !== existingAccount.code;
      const activeChanges = parsed.active !== undefined && parsed.active !== existingAccount.active;
      if ((codeChanges || activeChanges) && !ACCOUNT_HISTORY_EDIT_ROLES.has(String(requestRole(req) ?? ""))) {
        return res.status(403).json({
          message: LEDGER_ACCOUNT_CODE_ACTIVE_FORBIDDEN_MESSAGE,
          code: LEDGER_ACCOUNT_CODE_ACTIVE_FORBIDDEN_CODE,
        });
      }
      if (
        codeChanges &&
        (isSystemResolvedAccountCode(parsed.code) || isSystemResolvedAccountCode(existingAccount.code))
      ) {
        return res
          .status(409)
          .json({ message: SYSTEM_ACCOUNT_CODE_RESERVED_MESSAGE, code: SYSTEM_ACCOUNT_CODE_RESERVED_CODE });
      }

      // Phase 19 (B), C6: a system account keeps its name (the close, the
      // registry and the name-based readers depend on it); a rename must not
      // take another live account's name.
      if (parsed.name !== undefined && parsed.name.trim() !== existingAccount.name.trim()) {
        if (isSystemResolvedAccountCode(existingAccount.code)) {
          return res
            .status(409)
            .json({ message: SYSTEM_ACCOUNT_RENAME_REFUSED_MESSAGE, code: SYSTEM_ACCOUNT_RENAME_REFUSED_CODE });
        }
        const sameName = await storage.getLedgerAccountByName(parsed.name, req.session.currentCompanyId!);
        if (sameName && sameName.id !== accountId) {
          return res.status(400).json({
            message: "Duplicate ledger: A ledger account with this name already exists",
          });
        }
      }

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
      delete updates.deletedAt;
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
      const parentRefused = ledgerParentErrorResponse(error);
      if (parentRefused) return res.status(parentRefused.status).json(parentRefused.body);
      res.status(errorStatus(error, 400)).json({ message: getErrorMessage(error) });
    }
  });

  // Bulk-assign parentId to multiple ledger accounts. Phase 19 (B), C5: Admin
  // or Owner, every account of this company, one transaction with each
  // account's audit row; the tree guard refuses a parent of another company or
  // class, a deleted parent and a cycle (nothing is changed then).
  app.patch(
    "/api/ledger-accounts/bulk-assign-parent",
    requireAuth,
    requireNonPOS,
    requireRole("Admin", "Owner"),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) {
          return res.status(400).json({ message: "No company selected" });
        }
        const { accountIds, parentId } = req.body ?? {};
        if (!Array.isArray(accountIds) || accountIds.length === 0) {
          return res.status(400).json({ message: "accountIds must be a non-empty array" });
        }
        const ids = [...new Set(accountIds.map(Number))];
        if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
          return res.status(400).json({ message: "accountIds must be a non-empty array" });
        }
        const newParentId = parentId === null || parentId === undefined || parentId === "" ? null : Number(parentId);
        if (newParentId !== null && (!Number.isSafeInteger(newParentId) || newParentId <= 0)) {
          return res.status(400).json({ message: `Parent account ${parentId} not found` });
        }
        const results = await db.transaction(async (tx) => {
          const locked = await tx
            .select()
            .from(ledgerAccounts)
            .where(
              and(
                inArray(ledgerAccounts.id, ids),
                eq(ledgerAccounts.companyId, companyId),
                isNull(ledgerAccounts.deletedAt)
              )
            )
            .for("update");
          if (locked.length !== ids.length) {
            throw new HttpError(404, "Account not found");
          }
          if (newParentId !== null) {
            const [parent] = await tx
              .select({ id: ledgerAccounts.id })
              .from(ledgerAccounts)
              .where(
                and(
                  eq(ledgerAccounts.id, newParentId),
                  eq(ledgerAccounts.companyId, companyId),
                  isNull(ledgerAccounts.deletedAt)
                )
              );
            if (!parent) throw new HttpError(400, `Parent account ${newParentId} not found`);
          }
          const updatedRows = [];
          for (const before of locked) {
            if (before.parentId === newParentId) {
              updatedRows.push(before);
              continue;
            }
            const [updated] = await tx
              .update(ledgerAccounts)
              .set({ parentId: newParentId })
              .where(eq(ledgerAccounts.id, before.id))
              .returning();
            await logAudit(
              {
                userId: req.session.userId!,
                username: req.session.username || "unknown",
                companyId,
                action: "update",
                tableName: "ledger_accounts",
                recordId: updated.id,
                recordIdentifier: updated.name,
                changes: {
                  parentId: { old: before.parentId ?? null, new: updated.parentId ?? null },
                  reason: { new: "bulk-assign-parent" },
                },
              },
              tx
            );
            updatedRows.push(updated);
          }
          return updatedRows;
        });
        res.json(results);
      } catch (error: unknown) {
        const parentRefused = ledgerParentErrorResponse(error);
        if (parentRefused) return res.status(parentRefused.status).json(parentRefused.body);
        res.status(errorStatus(error, 400)).json({ message: getErrorMessage(error) });
      }
    }
  );
}
