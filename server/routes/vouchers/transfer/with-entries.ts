/**
 * voucherTransferRoutes: VoucherWithEntries endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage, errorStatus } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { storage } from "../../../storage";
import { requireAuth } from "../../../auth";
import { voucherMutationBlockReason } from "../../../lib/migratedVoucherGuard";
import { readVoucherAuditState, writeVoucherAuditTx } from "../../helpers/voucherAuditTrail";
import { normalizeVoucherEntryAmounts } from "../../../services/accounting/currencyAmounts";
import { vouchers, voucherEntries, customerBalances, interCompanyTransfers } from "@shared/schema";
import { eq, and, or } from "drizzle-orm";
import { recalculateOrderTotals } from "../../factory/_helpers";
import { customerOrderCharges, customerOrders, factoryDaybookEntries as fde } from "@shared/schema";
import { moveSalesVoucherInventoryLocation } from "./salesLocationInventoryEvidence";
import { syncContainerChargeVoucherEditTx } from "../../../services/containers/offload-lifecycle/charge-voucher-sync";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { MoneyDecimal, sumMoney, toMoney, type MoneyInput } from "../../../lib/money";
import {
  assertValidReplacementEntries,
  linkCustomerLedgerTargets,
  replacementErrorStatus,
  type ReplacementEntryInput,
  type ReplacementEntryTargets,
  voucherTypeRequiresBalance,
} from "../../../services/accounting/voucherEntryReplacement";
import { syncStockAdjustmentInventoryTx } from "../../../services/accounting/perpetualInventory/stockAdjustments";
import { stockVoucherTypeRefusal } from "../../../services/accounting/stockVoucherTypes";
import {
  assertSaleRedateAllowed,
  redateSaleCogsTx,
  SaleDateCrossesCutoverError,
} from "../../../services/accounting/perpetualInventory/saleCogs";

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

      // A balanced-type voucher (Journal, Payment, Sales, ...) cannot be re-typed to
      // a one-sided stock type ("Transfer", "Mixed", ...) that is exempt from the
      // balance rule: that let an edit save unbalanced lines on what was a Journal
      // (wave 9 ledger safety). Changes within the same class keep working, and a
      // change to a balanced type is validated with the balanced rule below.
      const nextVoucherType = voucher.voucherType ?? existingVoucher.voucherType;
      // Wave 12: stock adjustment vouchers are edited only through PUT /api/stock-adjustments/:id,
      // and no voucher may be re-typed to or from a stock adjustment type here.
      const stockTypeRefusal = stockVoucherTypeRefusal(existingVoucher.voucherType, nextVoucherType);
      if (stockTypeRefusal) return res.status(stockTypeRefusal.status).json(stockTypeRefusal.body);
      if (
        nextVoucherType !== existingVoucher.voucherType &&
        voucherTypeRequiresBalance(existingVoucher.voucherType) &&
        !voucherTypeRequiresBalance(nextVoucherType)
      ) {
        return res.status(400).json({
          message: "A balanced voucher cannot be changed to a voucher type that is exempt from balancing",
        });
      }

      // Exact validation of the replacement set: every line posts to exactly one
      // account, amounts are well-formed, and active balanced vouchers balance.
      let replacementTargets: ReplacementEntryTargets[];
      try {
        replacementTargets = assertValidReplacementEntries(nextVoucherType, voucher.optional === true, entries);
      } catch (validationError: unknown) {
        const status = replacementErrorStatus(validationError);
        if (status) return res.status(status).json({ message: getErrorMessage(validationError) });
        throw validationError;
      }
      const totalDebits = sumMoney(
        entries.map((entry: ReplacementEntryInput) => toMoney(entry.debitAmount as MoneyInput))
      );
      const totalCredits = sumMoney(
        entries.map((entry: ReplacementEntryInput) => toMoney(entry.creditAmount as MoneyInput))
      );
      const newTotal = MoneyDecimal.max(totalDebits, totalCredits).toFixed(2);

      let updatedVoucher!: typeof vouchers.$inferSelect;
      const createdEntries: (typeof voucherEntries.$inferSelect)[] = [];
      // The rows replaced by this edit, kept for the audit snapshot below.
      let oldEntries: (typeof voucherEntries.$inferSelect)[] = [];

      const oldLocationId = existingVoucher.locationId;
      const newLocationId = voucher.locationId !== undefined ? voucher.locationId : oldLocationId;
      const locationChanged = oldLocationId !== newLocationId;

      // Wave 15 (M5): refused before anything moves (the location move below commits on its own).
      try {
        await assertSaleRedateAllowed(db, {
          companyId: existingVoucher.companyId,
          saleVoucherId: id,
          voucherType: existingVoucher.voucherType,
          oldDate: existingVoucher.voucherDate,
          newDate: voucher.voucherDate,
        });
      } catch (redateError: unknown) {
        if (!(redateError instanceof SaleDateCrossesCutoverError)) throw redateError;
        return res
          .status(409)
          .json({ code: redateError.code, message: redateError.message, effectiveFrom: redateError.effectiveFrom });
      }

      if (existingVoucher.voucherType === "Sales" && locationChanged && oldLocationId && newLocationId) {
        await db.transaction(async (tx) => {
          await moveSalesVoucherInventoryLocation(tx, existingVoucher, oldLocationId, newLocationId, {
            username: req.session.username,
            reason: `Move sales voucher ${existingVoucher.voucherNumber} from location ${oldLocationId} to ${newLocationId}`,
          });
        });
      }

      // Header, lines and the factory daybook mirror change together or not at
      // all. This used to run as separate autocommit writes with a best-effort
      // restore that could leave a voucher with no lines or half its lines.
      await db.transaction(async (tx) => {
        oldEntries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, id));

        const voucherUpdates: VoucherUpdate = {
          voucherType: voucher.voucherType,
          voucherDate: voucher.voucherDate,
          description: voucher.description !== undefined ? voucher.description || null : existingVoucher.description,
          optional: voucher.optional ?? false,
          totalAmount: newTotal,
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
        [updatedVoucher] = await tx.update(vouchers).set(voucherUpdates).where(eq(vouchers.id, id)).returning();

        if (voucher.voucherDate) {
          await tx
            .update(fde)
            .set({ txDate: voucher.voucherDate })
            .where(and(eq(fde.referenceTable, "vouchers"), eq(fde.referenceId, id)));
          // Wave 15 (M5): a re-dated sale's COGS journal takes the new date.
          await redateSaleCogsTx(tx, {
            companyId: existingVoucher.companyId,
            saleVoucherId: id,
            voucherType: existingVoucher.voucherType,
            oldDate: existingVoucher.voucherDate,
            newDate: voucher.voucherDate,
          });
        }

        const targets = await linkCustomerLedgerTargets(tx, existingVoucher.companyId, replacementTargets);
        await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, id));

        const editVoucherCurrency: string = String(existingVoucher.currency || "USD");
        const editVoucherRate: string | null = existingVoucher.exchangeRate
          ? String(existingVoucher.exchangeRate)
          : null;

        for (const [index, entry] of entries.entries()) {
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
              if (toMoney(debitAmt).plus(toMoney(creditAmt)).greaterThan(0)) {
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

          const [createdEntry] = await tx
            .insert(voucherEntries)
            .values({
              voucherId: id,
              ...targets[index],
              debitAmount: entry.debitAmount || "0",
              creditAmount: entry.creditAmount || "0",
              narration: entry.narration || null,
              ...dualCurrencyFields,
            })
            .returning();
          createdEntries.push(createdEntry);
        }

        await tx
          .update(fde)
          .set({ amountCurrency: newTotal, amountUsd: newTotal })
          .where(and(eq(fde.referenceTable, "vouchers"), eq(fde.referenceId, id)));

        // Perpetual inventory (wave 8.3): a stock adjustment voucher carries its inventory line.
        await syncStockAdjustmentInventoryTx(tx, existingVoucher.companyId, id);

        // Wave 12 (decision 2): full before/after snapshot in this transaction; a
        // failed audit write refuses the edit (it used to be written after commit).
        await writeVoucherAuditTx(tx, {
          actor: {
            userId: req.session.userId,
            username: req.session.username,
            companyId: existingVoucher.companyId,
          },
          action: "update",
          voucherId: id,
          before: { voucher: existingVoucher, entries: oldEntries },
          after: { voucher: updatedVoucher, entries: createdEntries },
        });
      });

      // An edited duty/transport/office charge voucher re-prices the offloaded bales.
      await db.transaction((tx) =>
        syncContainerChargeVoucherEditTx(tx, {
          companyId: existingVoucher.companyId,
          voucherNumber: existingVoucher.voucherNumber,
          oldTotal: existingVoucher.optional ? 0 : existingVoucher.totalAmount,
          newTotal: updatedVoucher.optional ? 0 : updatedVoucher.totalAmount,
        })
      );

      try {
        const [ict] = await db
          .select()
          .from(interCompanyTransfers)
          .where(or(eq(interCompanyTransfers.fromVoucherId, id), eq(interCompanyTransfers.toVoucherId, id)))
          .limit(1);
        if (ict) {
          const otherVoucherId = ict.fromVoucherId === id ? ict.toVoucherId : ict.fromVoucherId;
          if (otherVoucherId) {
            const newTotal = toMoney(updatedVoucher.totalAmount);
            const [otherVoucher] = await db.select().from(vouchers).where(eq(vouchers.id, otherVoucherId));
            if (otherVoucher) {
              const oldTotal = toMoney(otherVoucher.totalAmount);
              const ratio = oldTotal.greaterThan(0) ? newTotal.dividedBy(oldTotal) : new MoneyDecimal(1);
              const otherEntries = await db
                .select()
                .from(voucherEntries)
                .where(eq(voucherEntries.voucherId, otherVoucherId));
              await db.transaction(async (tx) => {
                const auditBefore = await readVoucherAuditState(tx, otherVoucherId);
                for (const e of otherEntries) {
                  await tx
                    .update(voucherEntries)
                    .set({
                      debitAmount: toMoney(e.debitAmount).times(ratio).toFixed(2),
                      creditAmount: toMoney(e.creditAmount).times(ratio).toFixed(2),
                    })
                    .where(eq(voucherEntries.id, e.id));
                }
                await tx
                  .update(vouchers)
                  .set({ totalAmount: newTotal.toFixed(2) })
                  .where(eq(vouchers.id, otherVoucherId));
                // Wave 12: the counterpart's rescaled lines are audited under its own company.
                await writeVoucherAuditTx(tx, {
                  actor: {
                    userId: req.session.userId,
                    username: req.session.username,
                    companyId: otherVoucher.companyId,
                  },
                  action: "update",
                  voucherId: otherVoucherId,
                  before: auditBefore,
                  after: await readVoucherAuditState(tx, otherVoucherId),
                  extra: { interCompanyCounterpartOf: { new: { voucherId: id } } },
                });
              });
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
        const newAmount = MoneyDecimal.max(totalDebits, totalCredits).toNumber();
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
      res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
    }
  });
}
