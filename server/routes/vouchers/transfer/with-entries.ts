/**
 * voucherTransferRoutes: VoucherWithEntries endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { storage } from "../../../storage";
import { requireAuth } from "../../../auth";
import { voucherMutationBlockReason } from "../../../lib/migratedVoucherGuard";
import { logAudit, snapshotVoucherEntries, buildVoucherChangesForUpdate } from "../../_helpers";
import { normalizeVoucherEntryAmounts } from "../../../services/accounting/currencyAmounts";
import { vouchers, voucherEntries, customerBalances, interCompanyTransfers } from "@shared/schema";
import { eq, and, or } from "drizzle-orm";
import { recalculateOrderTotals } from "../../factory/_helpers";
import { customerOrderCharges, customerOrders, factoryDaybookEntries as fde } from "@shared/schema";
import { moveSalesVoucherInventoryLocation } from "./salesLocationInventoryEvidence";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";

/** The columns a voucher edit may set, checked against the vouchers table. */
type VoucherUpdate = PgUpdateSetSource<typeof vouchers>;

export function registerVoucherWithEntriesRoutes(app: Express) {
  // Update a voucher with all entries (completely replace entries)
  app.put("/api/vouchers/:id/with-entries", requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ message: "Invalid voucher ID" });
      }

      const { voucher, entries } = req.body;

      if (!voucher || !entries || !Array.isArray(entries) || entries.length === 0) {
        return res.status(400).json({ message: "Voucher and entries are required" });
      }

      const existingVoucher = await storage.getVoucherById(id);
      if (!existingVoucher) return res.status(404).json({ message: "Voucher not found" });
      const blockedVoucherReason = voucherMutationBlockReason(existingVoucher);
      if (blockedVoucherReason) {
        return res.status(403).json({ message: blockedVoucherReason });
      }
      if (existingVoucher.companyId !== req.session.currentCompanyId) {
        return res.status(403).json({ message: "Access denied: Voucher belongs to a different company" });
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

      const totalDebits = entries.reduce((sum: number, entry) => sum + parseFloat(entry.debitAmount || "0"), 0);
      const totalCredits = entries.reduce((sum: number, entry) => sum + parseFloat(entry.creditAmount || "0"), 0);
      if (!voucher.optional && Math.abs(totalDebits - totalCredits) >= 0.01) {
        return res.status(400).json({ message: "Total debits must equal total credits for active vouchers" });
      }

      let updatedVoucher;
      const createdEntries = [];
      // The rows replaced by this edit, kept for the audit snapshot below.
      let oldEntries: (typeof voucherEntries.$inferSelect)[] = [];

      const oldLocationId = existingVoucher.locationId;
      const newLocationId = voucher.locationId !== undefined ? voucher.locationId : oldLocationId;
      const locationChanged = oldLocationId !== newLocationId;

      if (existingVoucher.voucherType === "Sales" && locationChanged && oldLocationId && newLocationId) {
        await db.transaction(async (tx) => {
          await moveSalesVoucherInventoryLocation(tx, existingVoucher, oldLocationId, newLocationId, {
            username: req.session.username,
            reason: `Move sales voucher ${existingVoucher.voucherNumber} from location ${oldLocationId} to ${newLocationId}`,
          });
        });
      }

      try {
        oldEntries = await db.select().from(voucherEntries).where(eq(voucherEntries.voucherId, id));

        const voucherUpdates: VoucherUpdate = {
          voucherType: voucher.voucherType,
          voucherDate: voucher.voucherDate,
          description: voucher.description !== undefined ? voucher.description || null : existingVoucher.description,
          optional: voucher.optional ?? false,
          totalAmount: Math.max(totalDebits, totalCredits).toFixed(2),
        };
        if (voucher.locationId !== undefined) {
          voucherUpdates.locationId = voucher.locationId;
          if (voucher.locationId) {
            const location = await storage.getLocationById(voucher.locationId);
            if (location) voucherUpdates.locationName = location.name;
          } else {
            voucherUpdates.locationName = null;
          }
        }
        [updatedVoucher] = await db.update(vouchers).set(voucherUpdates).where(eq(vouchers.id, id)).returning();

        if (voucher.voucherDate) {
          await db
            .update(fde)
            .set({ txDate: voucher.voucherDate })
            .where(and(eq(fde.referenceTable, "vouchers"), eq(fde.referenceId, id)));
        }

        await db.delete(voucherEntries).where(eq(voucherEntries.voucherId, id));

        const editVoucherCurrency: string = String(existingVoucher.currency || "USD");
        const editVoucherRate: string | null = existingVoucher.exchangeRate
          ? String(existingVoucher.exchangeRate)
          : null;

        for (const entry of entries) {
          let dualCurrencyFields: Record<string, unknown> = {};
          if (entry.transactionCurrency) {
            try {
              const norm = normalizeVoucherEntryAmounts({
                transactionCurrency: entry.transactionCurrency,
                baseCurrency: "USD",
                transactionDebitAmount: String(entry.debitAmount || "0"),
                transactionCreditAmount: String(entry.creditAmount || "0"),
                historicalRate: entry.historicalExchangeRate ? String(entry.historicalExchangeRate) : editVoucherRate,
              });
              dualCurrencyFields = {
                transactionCurrency: norm.transactionCurrency,
                transactionDebitAmount: norm.transactionDebitAmount,
                transactionCreditAmount: norm.transactionCreditAmount,
                baseDebitAmount: norm.baseDebitAmount,
                baseCreditAmount: norm.baseCreditAmount,
                historicalExchangeRate: norm.historicalExchangeRate,
                rateConvention: norm.rateConvention,
              };
            } catch {
              // Non-fatal: entry will be stored with legacy columns only.
            }
          } else if (editVoucherCurrency !== "USD" && editVoucherRate) {
            try {
              const debitAmt = String(entry.debitAmount || "0");
              const creditAmt = String(entry.creditAmount || "0");
              if (parseFloat(debitAmt) + parseFloat(creditAmt) > 0) {
                const norm = normalizeVoucherEntryAmounts({
                  transactionCurrency: editVoucherCurrency,
                  baseCurrency: "USD",
                  transactionDebitAmount: debitAmt,
                  transactionCreditAmount: creditAmt,
                  historicalRate: editVoucherRate,
                });
                dualCurrencyFields = {
                  transactionCurrency: norm.transactionCurrency,
                  transactionDebitAmount: norm.transactionDebitAmount,
                  transactionCreditAmount: norm.transactionCreditAmount,
                  baseDebitAmount: norm.baseDebitAmount,
                  baseCreditAmount: norm.baseCreditAmount,
                  historicalExchangeRate: norm.historicalExchangeRate,
                  rateConvention: norm.rateConvention,
                };
              }
            } catch {
              // Non-fatal.
            }
          }

          const [createdEntry] = await db
            .insert(voucherEntries)
            .values({
              voucherId: id,
              ledgerAccountId: entry.ledgerAccountId || null,
              bankAccountId: entry.bankAccountId || null,
              fixedAssetId: entry.fixedAssetId || null,
              supplierId: entry.supplierId || null,
              employeeId: entry.employeeId || null,
              factorySupplierId: entry.factorySupplierId || null,
              debitAmount: entry.debitAmount || "0",
              creditAmount: entry.creditAmount || "0",
              narration: entry.narration || null,
              ...dualCurrencyFields,
            })
            .returning();
          createdEntries.push(createdEntry);
        }

        const newTotal = Math.max(totalDebits, totalCredits).toFixed(2);
        await db
          .update(fde)
          .set({ amountCurrency: newTotal, amountUsd: newTotal })
          .where(and(eq(fde.referenceTable, "vouchers"), eq(fde.referenceId, id)));
      } catch (error: unknown) {
        if (oldEntries.length > 0 && createdEntries.length === 0) {
          for (const oldEntry of oldEntries) {
            await db
              .insert(voucherEntries)
              .values({
                voucherId: oldEntry.voucherId,
                ledgerAccountId: oldEntry.ledgerAccountId,
                bankAccountId: oldEntry.bankAccountId,
                fixedAssetId: oldEntry.fixedAssetId,
                supplierId: oldEntry.supplierId,
                employeeId: oldEntry.employeeId,
                debitAmount: oldEntry.debitAmount,
                creditAmount: oldEntry.creditAmount,
                narration: oldEntry.narration,
                transactionCurrency: oldEntry.transactionCurrency,
                transactionDebitAmount: oldEntry.transactionDebitAmount,
                transactionCreditAmount: oldEntry.transactionCreditAmount,
                baseDebitAmount: oldEntry.baseDebitAmount,
                baseCreditAmount: oldEntry.baseCreditAmount,
                historicalExchangeRate: oldEntry.historicalExchangeRate,
                rateConvention: oldEntry.rateConvention,
              })
              .catch(() => {});
          }
        }
        throw error;
      }

      const _oldEntriesSnap = await snapshotVoucherEntries(oldEntries).catch(() => []);
      const _newEntriesSnap = await snapshotVoucherEntries(createdEntries).catch(() => []);
      await logAudit({
        userId: req.session.userId!,
        username: req.session.username || "unknown",
        companyId: req.session.currentCompanyId!,
        action: "update",
        tableName: "vouchers",
        recordId: id,
        recordIdentifier: updatedVoucher.voucherNumber,
        changes: buildVoucherChangesForUpdate(existingVoucher, updatedVoucher, _oldEntriesSnap, _newEntriesSnap),
      });

      try {
        const [ict] = await db
          .select()
          .from(interCompanyTransfers)
          .where(or(eq(interCompanyTransfers.fromVoucherId, id), eq(interCompanyTransfers.toVoucherId, id)))
          .limit(1);
        if (ict) {
          const otherVoucherId = ict.fromVoucherId === id ? ict.toVoucherId : ict.fromVoucherId;
          if (otherVoucherId) {
            const newTotal = parseFloat(updatedVoucher.totalAmount || "0");
            const [otherVoucher] = await db.select().from(vouchers).where(eq(vouchers.id, otherVoucherId));
            if (otherVoucher) {
              const oldTotal = parseFloat(otherVoucher.totalAmount || "0");
              const ratio = oldTotal > 0 ? newTotal / oldTotal : 1;
              const otherEntries = await db
                .select()
                .from(voucherEntries)
                .where(eq(voucherEntries.voucherId, otherVoucherId));
              for (const e of otherEntries) {
                await db
                  .update(voucherEntries)
                  .set({
                    debitAmount: (parseFloat(e.debitAmount || "0") * ratio).toFixed(2),
                    creditAmount: (parseFloat(e.creditAmount || "0") * ratio).toFixed(2),
                  })
                  .where(eq(voucherEntries.id, e.id));
              }
              await db
                .update(vouchers)
                .set({ totalAmount: newTotal.toFixed(2) })
                .where(eq(vouchers.id, otherVoucherId));
              await db
                .update(fde)
                .set({ amountCurrency: newTotal.toFixed(2), amountUsd: newTotal.toFixed(2) })
                .where(and(eq(fde.referenceTable, "vouchers"), eq(fde.referenceId, otherVoucherId)));
            }
          }
        }
      } catch (ictErr: unknown) {
        logger.error("[ICT sync] Counterpart update failed (non-fatal):", { error: getErrorMessage(ictErr) });
      }

      const chargeMatch = existingVoucher.voucherNumber?.match(/^CHARGE-.+-(\d+)-\d+$/);
      if (chargeMatch && existingVoucher.sourceModule === "FACTORY") {
        const chargeId = parseInt(chargeMatch[1]);
        const newAmount = Math.max(totalDebits, totalCredits);
        const [charge] = await db
          .select({ orderId: customerOrderCharges.orderId })
          .from(customerOrderCharges)
          .where(eq(customerOrderCharges.id, chargeId));
        if (charge) {
          const chargeUpdate: { amount: string; name?: string } = { amount: String(newAmount) };
          if (updatedVoucher.description?.trim()) chargeUpdate.name = updatedVoucher.description.trim();
          await db.update(customerOrderCharges).set(chargeUpdate).where(eq(customerOrderCharges.id, chargeId));
          await recalculateOrderTotals(db, charge.orderId);
          const [updatedOrd] = await db
            .select({ grandTotal: customerOrders.grandTotal, status: customerOrders.status })
            .from(customerOrders)
            .where(eq(customerOrders.id, charge.orderId));
          if (updatedOrd?.status === "FINALIZED") {
            await db
              .update(customerBalances)
              .set({ debitAmount: String(updatedOrd.grandTotal), balance: String(updatedOrd.grandTotal) })
              .where(
                and(eq(customerBalances.referenceId, charge.orderId), eq(customerBalances.referenceType, "INVOICE"))
              );
          }
        }
      }

      res.json({ voucher: updatedVoucher, entries: createdEntries });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
