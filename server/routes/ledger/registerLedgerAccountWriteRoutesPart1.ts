// Extracted from ./registerLedgerAccountWriteRoutes.ts
import type { Express } from "express";
import { errorStatus, getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireNonPOS } from "../../auth";
import { logAudit } from "../_helpers";
import { customers, ledgerAccounts, updateLedgerAccountSchema } from "@shared/schema";
import { eq } from "drizzle-orm";
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
import {
  LEDGER_ACCOUNT_CODE_ACTIVE_FORBIDDEN_CODE,
  LEDGER_ACCOUNT_CODE_ACTIVE_FORBIDDEN_MESSAGE,
  LEDGER_ACCOUNT_DELETE_VIA_EDIT_CODE,
  LEDGER_ACCOUNT_DELETE_VIA_EDIT_MESSAGE,
  SYSTEM_ACCOUNT_CODE_RESERVED_CODE,
  SYSTEM_ACCOUNT_CODE_RESERVED_MESSAGE,
  SYSTEM_ACCOUNT_RENAME_FORBIDDEN_CODE,
  SYSTEM_ACCOUNT_RENAME_FORBIDDEN_MESSAGE,
  VALID_LEDGER_SUBTYPES,
  ledgerParentErrorResponse,
} from "./ledgerParentErrorResponse";

export function registerLedgerAccountWriteRoutesPart1(app: Express) {
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

      // The account code (not the display name) is the stable accounting identity.
      // Permit an audited system-account rename for privileged roles while still
      // refusing duplicate names within the company.
      if (parsed.name !== undefined && parsed.name.trim() !== existingAccount.name.trim()) {
        if (
          isSystemResolvedAccountCode(existingAccount.code) &&
          !ACCOUNT_HISTORY_EDIT_ROLES.has(String(requestRole(req) ?? ""))
        ) {
          return res.status(403).json({
            message: SYSTEM_ACCOUNT_RENAME_FORBIDDEN_MESSAGE,
            code: SYSTEM_ACCOUNT_RENAME_FORBIDDEN_CODE,
          });
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
}
