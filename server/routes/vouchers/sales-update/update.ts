/**
 * voucherSalesUpdateRoutes: VoucherUpdate endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { storage } from "../../../storage";
import { requireAuth } from "../../../auth";
import { voucherMutationBlockReason } from "../../../lib/migratedVoucherGuard";
import { logAudit, syncEmployeeBalancesFromEntries, buildVoucherChangesForUpdate } from "../../_helpers";
import { vouchers, voucherEntries } from "@shared/schema";
import { eq } from "drizzle-orm";
import { applyVoucherOptionalInventoryChange } from "./optionalInventoryEvidence";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";

/** The columns a voucher edit may set, checked against the vouchers table. */
type VoucherUpdate = PgUpdateSetSource<typeof vouchers>;

export function registerVoucherUpdateRoutes(app: Express) {
  app.patch("/api/vouchers/:id", requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid voucher ID" });

      const existingVoucher = await storage.getVoucherById(id);
      if (!existingVoucher) return res.status(404).json({ message: "Voucher not found" });
      const blockedVoucherReason = voucherMutationBlockReason(existingVoucher);
      if (blockedVoucherReason) {
        return res.status(403).json({ message: blockedVoucherReason });
      }

      const effectiveCompanyId = req.session.currentCompanyId || req.session.factoryCompanyId;
      if (existingVoucher.companyId !== effectiveCompanyId) {
        return res.status(403).json({ message: "Access denied: Voucher belongs to a different company" });
      }

      const isPOS = req.session.currentRole === "POS";
      if (isPOS) {
        if (existingVoucher.voucherType !== "Stock Transfer") {
          return res.status(403).json({ message: "Access denied: This resource is not available for POS users" });
        }
        const updates: VoucherUpdate = {};
        if (req.body.voucherDate !== undefined) updates.voucherDate = req.body.voucherDate;
        if (Object.keys(updates).length > 0) {
          await db.update(vouchers).set(updates).where(eq(vouchers.id, id));
        }
        return res.json({ id, ...updates });
      }

      const userRole = req.session.currentRole;
      if (!userRole) return res.status(403).json({ message: "User role not found" });
      if (userRole !== "Admin" && userRole !== "Owner" && userRole !== "Developer") {
        if (userRole === "Manager") {
          const existingDate = new Date(existingVoucher.voucherDate);
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          existingDate.setHours(0, 0, 0, 0);
          if (existingDate.getTime() !== today.getTime()) {
            return res.status(403).json({ message: "Managers can only edit today's vouchers" });
          }
        } else {
          return res.status(403).json({ message: "Insufficient permissions to edit vouchers" });
        }
      }

      const oldEntries = await storage.getVoucherEntriesByVoucher(id);
      const wasOptional = existingVoucher.optional;

      await db.transaction(async (tx) => {
        const voucherUpdates: VoucherUpdate = {};
        if (req.body.voucherDate !== undefined) voucherUpdates.voucherDate = req.body.voucherDate;
        if (req.body.description !== undefined) voucherUpdates.description = req.body.description;
        if (req.body.optional !== undefined) voucherUpdates.optional = req.body.optional;

        if (req.body.optional !== undefined && existingVoucher.optional !== req.body.optional) {
          await applyVoucherOptionalInventoryChange(tx, existingVoucher, req.body.optional, {
            username: req.session.username,
            reason: `${req.body.optional ? "Suspend" : "Activate"} voucher ${existingVoucher.voucherNumber}`,
          });
        }

        await tx.update(vouchers).set(voucherUpdates).where(eq(vouchers.id, id));
        await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, id));

        if (req.body.entries && Array.isArray(req.body.entries)) {
          for (const entry of req.body.entries) {
            await tx.insert(voucherEntries).values({
              voucherId: id,
              ledgerAccountId: entry.ledgerAccountId || null,
              bankAccountId: entry.bankAccountId || null,
              supplierId: entry.supplierId || null,
              employeeId: entry.employeeId || null,
              fixedAssetId: entry.fixedAssetId || null,
              debitAmount: entry.debitAmount || "0",
              creditAmount: entry.creditAmount || "0",
              narration: entry.narration || "",
            });
          }
        }
      });

      const updated = await storage.getVoucherById(id);
      if (!updated) return res.status(404).json({ message: "Voucher not found after update" });
      const newEntries = await storage.getVoucherEntriesByVoucher(id);

      if (!wasOptional && req.session.currentCompanyId) {
        await syncEmployeeBalancesFromEntries(
          oldEntries.map((e) => ({
            ledgerAccountId: e.ledgerAccountId,
            employeeId: e.employeeId,
            debitAmount: e.debitAmount,
            creditAmount: e.creditAmount,
          })),
          req.session.currentCompanyId,
          true
        );
      }

      const isNowOptional = req.body.optional !== undefined ? req.body.optional : wasOptional;
      if (!isNowOptional && req.session.currentCompanyId) {
        await syncEmployeeBalancesFromEntries(
          newEntries.map((e) => ({
            ledgerAccountId: e.ledgerAccountId,
            employeeId: e.employeeId,
            debitAmount: e.debitAmount,
            creditAmount: e.creditAmount,
          })),
          req.session.currentCompanyId
        );
      }

      try {
        await logAudit({
          userId: req.session.userId!,
          username: req.session.username || "unknown",
          companyId: req.session.currentCompanyId!,
          action: "update",
          tableName: "vouchers",
          recordId: updated.id,
          recordIdentifier: updated.voucherNumber,
          changes: buildVoucherChangesForUpdate(existingVoucher, updated, oldEntries, newEntries),
        });
      } catch {
        /* non-fatal */
      }
      res.json({ ...updated, entries: newEntries });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  class _ValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ValidationError";
    }
  }
}
