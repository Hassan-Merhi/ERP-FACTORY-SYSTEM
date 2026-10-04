/**
 * voucherEntryRoutes: VoucherEntryWrite endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage, errorStatus } from "../../lib/httpHandlers";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth } from "../../auth";
import { voucherMutationBlockReason } from "../../lib/migratedVoucherGuard";
import { autoReallocateLoansAccounts } from "../../lib/transporterAllocation";
import { voucherEntries } from "@shared/schema";
import { eq } from "drizzle-orm";

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

      const entry = await storage.createVoucherEntry(req.body);

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

      const updated = await storage.updateVoucherEntry(id, allowedUpdates);

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
