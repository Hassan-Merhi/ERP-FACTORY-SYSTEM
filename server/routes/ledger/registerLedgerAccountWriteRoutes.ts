// Extracted from ./write.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { errorStatus, getErrorMessage, HttpError } from "../../lib/httpHandlers";
import { db } from "../../db";
import { storage } from "../../storage";
import { masterDataDbErrorResponse } from "../../lib/masterDataDbError";
import { requireAuth, requireNonPOS, requireRole } from "../../auth";
import { logAudit } from "../_helpers";
import { insertLedgerAccountSchema, ledgerAccounts } from "@shared/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { toMoney } from "../../lib/money";
import { isSystemResolvedAccountCode } from "../../services/accounting/systemAccounts";
import {
  SYSTEM_ACCOUNT_CODE_RESERVED_CODE,
  SYSTEM_ACCOUNT_CODE_RESERVED_MESSAGE,
  VALID_LEDGER_SUBTYPES,
  ledgerParentErrorResponse,
} from "./ledgerParentErrorResponse";
import { registerLedgerAccountWriteRoutesPart1 } from "./registerLedgerAccountWriteRoutesPart1";

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
      const dbError = masterDataDbErrorResponse(error, "ledger-account", req.session.currentCompanyId);
      if (dbError) return res.status(dbError.status).json(dbError.body);
      res.status(errorStatus(error, 400)).json({ message: getErrorMessage(error) });
    }
  });

  registerLedgerAccountWriteRoutesPart1(app);

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
