/**
 * voucherSalesUpdateRoutes: VoucherUpdate endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage, errorStatus } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { storage } from "../../../storage";
import { requireAuth } from "../../../auth";
import { voucherMutationBlockReason } from "../../../lib/migratedVoucherGuard";
import { syncEmployeeBalancesFromEntries } from "../../_helpers";
import { readVoucherAuditState, writeVoucherAuditTx } from "../../helpers/voucherAuditTrail";
import { vouchers, voucherEntries } from "@shared/schema";
import { eq } from "drizzle-orm";
import { applyVoucherOptionalInventoryChange } from "./optionalInventoryEvidence";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import {
  assertReplacementEntryAmounts,
  assertValidReplacementEntries,
  linkCustomerLedgerTargets,
  replacementErrorStatus,
  storedEntriesAsAmountInput,
  type ReplacementEntryInput,
  type ReplacementEntryTargets,
} from "../../../services/accounting/voucherEntryReplacement";
import { syncStockAdjustmentInventoryTx } from "../../../services/accounting/perpetualInventory/stockAdjustments";
import { stockVoucherTypeRefusal } from "../../../services/accounting/stockVoucherTypes";
import {
  redateSaleCogsTx,
  SaleDateCrossesCutoverError,
} from "../../../services/accounting/perpetualInventory/saleCogs";
import { sendBaleMirrorMovementRefusal } from "../../../services/accounting/perpetualInventory/cutoverRefusal";

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
          // Wave 12: the POS date edit is audited in its own transaction (it was unaudited).
          await db.transaction(async (tx) => {
            const before = await readVoucherAuditState(tx, id);
            await tx.update(vouchers).set(updates).where(eq(vouchers.id, id));
            const after = await readVoucherAuditState(tx, id);
            await writeVoucherAuditTx(tx, {
              actor: {
                userId: req.session.userId,
                username: req.session.username,
                companyId: existingVoucher.companyId,
              },
              action: "update",
              voucherId: id,
              before,
              after,
              extra: { posDateEdit: { new: true } },
            });
          });
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
      const willBeOptional = req.body.optional !== undefined ? req.body.optional === true : wasOptional;
      const replacesEntries = Array.isArray(req.body.entries);
      // Wave 12: a stock adjustment voucher's lines are replaced only through PUT /api/stock-adjustments/:id.
      const stockTypeRefusal = replacesEntries ? stockVoucherTypeRefusal(existingVoucher.voucherType) : null;
      if (stockTypeRefusal) return res.status(stockTypeRefusal.status).json(stockTypeRefusal.body);

      // Lines are replaced only when the request sends them. A header-only edit
      // (date, description, optional flag) used to delete every line.
      let replacementTargets: ReplacementEntryTargets[] = [];
      try {
        if (replacesEntries) {
          replacementTargets = assertValidReplacementEntries(
            existingVoucher.voucherType,
            willBeOptional,
            req.body.entries
          );
        } else if (wasOptional && !willBeOptional) {
          // Activating an optional voucher posts its existing lines.
          assertReplacementEntryAmounts(existingVoucher.voucherType, false, storedEntriesAsAmountInput(oldEntries));
        }
      } catch (validationError: unknown) {
        const status = replacementErrorStatus(validationError);
        if (status) return res.status(status).json({ message: getErrorMessage(validationError) });
        throw validationError;
      }

      const { updated, newEntries } = await db.transaction(async (tx) => {
        const before = await readVoucherAuditState(tx, id);
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

        if (Object.keys(voucherUpdates).length > 0) {
          await tx.update(vouchers).set(voucherUpdates).where(eq(vouchers.id, id));
        }
        // Wave 15 (M5): a re-dated sale's COGS journal takes the new date.
        if (req.body.voucherDate !== undefined) {
          await redateSaleCogsTx(tx, {
            companyId: existingVoucher.companyId,
            saleVoucherId: id,
            voucherType: existingVoucher.voucherType,
            oldDate: existingVoucher.voucherDate,
            newDate: req.body.voucherDate,
          });
        }

        if (replacesEntries) {
          const targets = await linkCustomerLedgerTargets(tx, existingVoucher.companyId, replacementTargets);
          await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, id));
          for (const [index, entry] of (req.body.entries as ReplacementEntryInput[]).entries()) {
            await tx.insert(voucherEntries).values({
              voucherId: id,
              ...targets[index],
              debitAmount: String(entry.debitAmount || "0"),
              creditAmount: String(entry.creditAmount || "0"),
              narration: typeof entry.narration === "string" ? entry.narration : "",
            });
          }
        }

        // Perpetual inventory (wave 8.3): a stock adjustment voucher carries its inventory line.
        await syncStockAdjustmentInventoryTx(tx, existingVoucher.companyId, id);

        const after = await readVoucherAuditState(tx, id);
        if (!after.voucher) throw new Error("Voucher not found after update");

        // Wave 12: employee balances move in this transaction (they used to be
        // written on the pool after commit).
        if (!wasOptional) {
          await syncEmployeeBalancesFromEntries(before.entries, existingVoucher.companyId, true, tx);
        }
        if (!after.voucher.optional) {
          await syncEmployeeBalancesFromEntries(after.entries, existingVoucher.companyId, false, tx);
        }

        // Wave 12 (decision 2): full before/after snapshot in the same transaction;
        // a failed audit write refuses the edit.
        await writeVoucherAuditTx(tx, {
          actor: {
            userId: req.session.userId,
            username: req.session.username,
            companyId: existingVoucher.companyId,
          },
          action: "update",
          voucherId: id,
          before,
          after,
        });
        return { updated: after.voucher, newEntries: after.entries };
      });

      res.json({ ...updated, entries: newEntries });
    } catch (error: unknown) {
      if (sendBaleMirrorMovementRefusal(res, error)) return;
      if (error instanceof SaleDateCrossesCutoverError) {
        return res.status(409).json({ code: error.code, message: error.message, effectiveFrom: error.effectiveFrom });
      }
      res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
    }
  });

  class _ValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ValidationError";
    }
  }
}
