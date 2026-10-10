/**
 * voucherEntryRoutes: VoucherEntryWrite endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage, errorStatus } from "../../lib/httpHandlers";
import { db, type DbTransaction } from "../../db";
import { storage } from "../../storage";
import { requireAuth } from "../../auth";
import { voucherMutationBlockReason } from "../../lib/migratedVoucherGuard";
import { autoReallocateLoansAccounts } from "../../lib/transporterAllocation";
import { voucherEntries } from "@shared/schema";
import { eq } from "drizzle-orm";
import {
  assertReplacementEntryAmounts,
  assertValidReplacementEntries,
  linkCustomerLedgerTargets,
  replacementErrorStatus,
  storedEntriesAsAmountInput,
} from "../../services/accounting/voucherEntryReplacement";
import { syncStockAdjustmentInventoryTx } from "../../services/accounting/perpetualInventory/stockAdjustments";
import { stockVoucherTypeRefusal } from "../../services/accounting/stockVoucherTypes";
import { logAudit } from "../_helpers";

/**
 * After a single-line write, the voucher's stored lines must still satisfy the
 * rules for its type and state (an active balanced voucher must balance).
 */
async function assertStoredVoucherLinesValid(
  tx: DbTransaction,
  voucher: { id: number; voucherType: string; optional: boolean }
): Promise<void> {
  const lines = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucher.id));
  assertReplacementEntryAmounts(voucher.voucherType, voucher.optional, storedEntriesAsAmountInput(lines));
}

/** The fields of a line an audit row records. */
function lineAuditSnapshot(line: typeof voucherEntries.$inferSelect | undefined) {
  if (!line) return null;
  return {
    entryId: line.id,
    ledgerAccountId: line.ledgerAccountId,
    bankAccountId: line.bankAccountId,
    fixedAssetId: line.fixedAssetId,
    supplierId: line.supplierId,
    employeeId: line.employeeId,
    customerId: line.customerId,
    factorySupplierId: line.factorySupplierId,
    debitAmount: line.debitAmount,
    creditAmount: line.creditAmount,
    narration: line.narration,
  };
}

export function registerVoucherEntryWriteRoutes(app: Express) {
  // Create a new voucher entry
  app.post("/api/voucher-entries", requireAuth, async (req, res) => {
    try {
      // Verify the voucher exists and belongs to current company
      if (!req.body.voucherId) {
        return res.status(400).json({ message: "Voucher ID is required" });
      }

      const voucher = await storage.getVoucherById(req.body.voucherId);
      if (!voucher) {
        return res.status(404).json({ message: "Voucher not found" });
      }

      // Verify voucher belongs to current company
      if (voucher.companyId !== req.session.currentCompanyId) {
        return res.status(403).json({
          message: "Access denied: Voucher belongs to a different company",
        });
      }

      const blockedVoucherReason = voucherMutationBlockReason(voucher);
      if (blockedVoucherReason) {
        return res.status(403).json({ message: blockedVoucherReason });
      }
      // Wave 12: a stock adjustment voucher's lines are written only by the stock adjustment writers.
      const stockTypeRefusal = stockVoucherTypeRefusal(voucher.voucherType);
      if (stockTypeRefusal) return res.status(stockTypeRefusal.status).json(stockTypeRefusal.body);

      // Check permissions based on role (same logic as voucher edit)
      const userRole = req.session.currentRole;
      if (!userRole) {
        return res.status(403).json({ message: "User role not found" });
      }

      // Admin and Owner can create entries for all vouchers
      if (userRole !== "Admin" && userRole !== "Owner" && userRole !== "Developer") {
        // Manager can only create entries for today's vouchers
        if (userRole === "Manager") {
          const voucherDate = new Date(voucher.voucherDate);
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          voucherDate.setHours(0, 0, 0, 0);

          if (voucherDate.getTime() !== today.getTime()) {
            return res.status(403).json({
              message: "Managers can only create entries for today's vouchers",
            });
          }
        } else {
          // Other roles cannot create entries
          return res.status(403).json({
            message: "Insufficient permissions to create voucher entries",
          });
        }
      }

      // The line is written and the voucher re-validated in one transaction: a
      // single added line must post to exactly one account and must not leave an
      // active balanced voucher out of balance (it used to insert req.body as is).
      let entry: typeof voucherEntries.$inferSelect;
      try {
        const [target] = assertValidReplacementEntries(voucher.voucherType, true, [req.body]);
        entry = await db.transaction(async (tx) => {
          const [linked] = await linkCustomerLedgerTargets(tx, voucher.companyId, [target]);
          const [created] = await tx
            .insert(voucherEntries)
            .values({
              voucherId: voucher.id,
              ...linked,
              debitAmount: String(req.body.debitAmount || "0"),
              creditAmount: String(req.body.creditAmount || "0"),
              narration: typeof req.body.narration === "string" ? req.body.narration : null,
            })
            .returning();
          // Perpetual inventory (wave 8.3): a stock adjustment voucher carries its inventory line.
          await syncStockAdjustmentInventoryTx(tx, voucher.companyId, voucher.id);
          await assertStoredVoucherLinesValid(tx, voucher);
          // Wave 16 (B): audited in the writing transaction.
          await logAudit(
            {
              userId: req.session.userId!,
              username: req.session.username || "unknown",
              companyId: voucher.companyId,
              action: "update",
              tableName: "vouchers",
              recordId: voucher.id,
              recordIdentifier: voucher.voucherNumber,
              changes: { entryAdded: { new: lineAuditSnapshot(created) } },
            },
            tx
          );
          return created;
        });
      } catch (validationError: unknown) {
        const status = replacementErrorStatus(validationError);
        if (status) return res.status(status).json({ message: getErrorMessage(validationError) });
        throw validationError;
      }

      // Fire-and-forget: auto-rerun FIFO allocation if a Loans account was touched
      if (entry.ledgerAccountId && req.session.currentCompanyId) {
        autoReallocateLoansAccounts(req.session.currentCompanyId, [entry.ledgerAccountId]).catch(() => {});
      }

      res.json(entry);
    } catch (error: unknown) {
      res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
    }
  });

  // Update a voucher entry
  app.patch("/api/voucher-entries/:id", requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ message: "Invalid voucher entry ID" });
      }

      // Get the existing entry to find its voucher
      const existingEntry = await db.query.voucherEntries.findFirst({
        where: eq(voucherEntries.id, id),
      });

      if (!existingEntry) {
        return res.status(404).json({ message: "Voucher entry not found" });
      }

      // Get the voucher to check company and permissions
      const voucher = await storage.getVoucherById(existingEntry.voucherId);
      if (!voucher) {
        return res.status(404).json({ message: "Associated voucher not found" });
      }

      // Verify voucher belongs to current company
      if (voucher.companyId !== req.session.currentCompanyId) {
        return res.status(403).json({
          message: "Access denied: Voucher belongs to a different company",
        });
      }

      const blockedVoucherReason = voucherMutationBlockReason(voucher);
      if (blockedVoucherReason) {
        return res.status(403).json({ message: blockedVoucherReason });
      }
      // Wave 12: a stock adjustment voucher's lines are written only by the stock adjustment writers.
      const stockTypeRefusal = stockVoucherTypeRefusal(voucher.voucherType);
      if (stockTypeRefusal) return res.status(stockTypeRefusal.status).json(stockTypeRefusal.body);

      // Check edit permissions based on role (same logic as voucher edit)
      const userRole = req.session.currentRole;
      if (!userRole) {
        return res.status(403).json({ message: "User role not found" });
      }

      // Admin and Owner can edit all vouchers
      if (userRole !== "Admin" && userRole !== "Owner" && userRole !== "Developer") {
        // Manager can only edit today's vouchers
        if (userRole === "Manager") {
          const voucherDate = new Date(voucher.voucherDate);
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          voucherDate.setHours(0, 0, 0, 0);

          if (voucherDate.getTime() !== today.getTime()) {
            return res.status(403).json({ message: "Managers can only edit today's vouchers" });
          }
        } else {
          // Other roles cannot edit
          return res.status(403).json({
            message: "Insufficient permissions to edit voucher entries",
          });
        }
      }

      // Only allow updating debit/credit amounts and narration
      const allowedUpdates: Partial<{
        voucherId: number;
        narration?: string | null | undefined;
        transactionCurrency?: string | null | undefined;
        transactionDebitAmount?: string | null | undefined;
        transactionCreditAmount?: string | null | undefined;
        baseDebitAmount?: string | null | undefined;
        baseCreditAmount?: string | null | undefined;
        historicalExchangeRate?: string | null | undefined;
        rateConvention?: string | null | undefined;
        ledgerAccountId?: number | undefined;
        bankAccountId?: number | undefined;
        fixedAssetId?: number | undefined;
        supplierId?: number | undefined;
        employeeId?: number | undefined;
        customerId?: number | undefined;
        factorySupplierId?: number | undefined;
        debitAmount?: string | undefined;
        creditAmount?: string | undefined;
      }> = {};
      if (req.body.debitAmount !== undefined) allowedUpdates.debitAmount = req.body.debitAmount;
      if (req.body.creditAmount !== undefined) allowedUpdates.creditAmount = req.body.creditAmount;
      if (req.body.narration !== undefined) allowedUpdates.narration = req.body.narration;

      let updated: typeof voucherEntries.$inferSelect | undefined;
      try {
        updated = await db.transaction(async (tx) => {
          const [row] = await tx
            .update(voucherEntries)
            .set(allowedUpdates)
            .where(eq(voucherEntries.id, id))
            .returning();
          // Perpetual inventory (wave 8.3): a stock adjustment voucher carries its inventory line.
          await syncStockAdjustmentInventoryTx(tx, voucher.companyId, voucher.id);
          await assertStoredVoucherLinesValid(tx, voucher);
          // Wave 16 (B): audited in the writing transaction.
          await logAudit(
            {
              userId: req.session.userId!,
              username: req.session.username || "unknown",
              companyId: voucher.companyId,
              action: "update",
              tableName: "vouchers",
              recordId: voucher.id,
              recordIdentifier: voucher.voucherNumber,
              changes: { entryChanged: { old: lineAuditSnapshot(existingEntry), new: lineAuditSnapshot(row) } },
            },
            tx
          );
          return row;
        });
      } catch (validationError: unknown) {
        const status = replacementErrorStatus(validationError);
        if (status) return res.status(status).json({ message: getErrorMessage(validationError) });
        throw validationError;
      }

      // Fire-and-forget: auto-rerun FIFO allocation if a Loans account was touched
      if (existingEntry.ledgerAccountId && req.session.currentCompanyId) {
        autoReallocateLoansAccounts(req.session.currentCompanyId, [existingEntry.ledgerAccountId]).catch(() => {});
      }

      res.json(updated);
    } catch (error: unknown) {
      res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
    }
  });
}
