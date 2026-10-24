import {
  assertLockedZmwVoucherEdit,
  assertResolvedZmwVoucherEntriesTx,
} from "../../../services/accounting/zambiaVoucherRatePolicy";
/**
 * voucherTransferRoutes: VoucherWithEntries endpoints.
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
import {
  assertVoucherEditableTx,
  recordVoucherEditAuditTx,
  sendVoucherCorrectionRefusal,
} from "../../../services/accounting/voucherCorrection";
import { rebalanceVoucherRoundingTx } from "../../../services/accounting/engineRounding";
import { syncFactoryChargeVoucherEditTx } from "./factoryChargeVoucherSync";
import {
  assertNotIntercompanyTransferLeg,
  sendIntercompanyTransferLegRefusal,
} from "../../../services/accounting/intercompanyTransferLegGuard";
import { normalizeVoucherEntryAmounts } from "../../../services/accounting/currencyAmounts";
import { vouchers, voucherEntries } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { factoryDaybookEntries as fde } from "@shared/schema";
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
      // No edit may silently change an already-posted Kwacha voucher's
      // original currency, accounting date, or historical rate.
      assertLockedZmwVoucherEdit(existingVoucher, voucher);
      if (existingVoucher.currency === "ZMW") {
        await db.transaction(async (tx) => {
          const originalLines = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, id));
          await assertResolvedZmwVoucherEntriesTx(tx, existingVoucher.companyId, originalLines);
        });
      }
      // Phase 19 C (MC-2): an intercompany transfer leg is not edited here (409);
      // the transfer is deleted (both legs) and recorded again. This editor used
      // to rescale the other company's voucher after commit, outside a
      // transaction, debit/credit only, with any failure hidden.
      try {
        await assertNotIntercompanyTransferLeg(id);
      } catch (legError: unknown) {
        if (sendIntercompanyTransferLegRefusal(res, legError)) return;
        throw legError;
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
      // The editor supplies original ZMW amounts, but voucher.total_amount
      // remains the historical USD base. Preserve cent precision here.
      const baseEditRate =
        existingVoucher.currency === "ZMW" ? toMoney(existingVoucher.exchangeRate) : new MoneyDecimal(1);
      const newTotal =
        existingVoucher.currency === "ZMW"
          ? MoneyDecimal.max(totalDebits, totalCredits).dividedBy(baseEditRate).toFixed(6)
          : MoneyDecimal.max(totalDebits, totalCredits).toFixed(2);

      let updatedVoucher!: typeof vouchers.$inferSelect;
      const createdEntries: (typeof voucherEntries.$inferSelect)[] = [];

      const oldLocationId = existingVoucher.locationId;
      const newLocationId = voucher.locationId !== undefined ? voucher.locationId : oldLocationId;
      const locationChanged = oldLocationId !== newLocationId;

      // Phase 22 (B): the correction policy refuses first (closed period, reversed
      // voucher), before the location move below commits on its own.
      await db.transaction((tx) =>
        assertVoucherEditableTx(tx, id, {
          companyId: existingVoucher.companyId,
          newVoucherDate: voucher.voucherDate ?? null,
        })
      );

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
        // Phase 22 (B), PE9/G4: the correction policy. An open-period edit is
        // audited in this transaction; a voucher dated (or re-dated) in a closed
        // period is refused with 409 VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD.
        const editContext = await assertVoucherEditableTx(tx, id, {
          companyId: existingVoucher.companyId,
          newVoucherDate: voucher.voucherDate ?? null,
        });
        // Revalidate native lines under the edit transaction, including only
        // recognized engine USD rounding entries as valid exceptions.
        if (existingVoucher.currency === "ZMW") {
          const originalLines = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, id));
          await assertResolvedZmwVoucherEntriesTx(tx, existingVoucher.companyId, originalLines);
        }

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
          if (editVoucherCurrency === "ZMW") {
            // The old edit UI uses debitAmount/creditAmount as native entry
            // amounts. Never let a request validate one amount, but post an
            // unrelated transactionDebitAmount/transactionCreditAmount.
            if (
              (entry.transactionDebitAmount != null &&
                !toMoney(entry.transactionDebitAmount).eq(toMoney(entry.debitAmount))) ||
              (entry.transactionCreditAmount != null &&
                !toMoney(entry.transactionCreditAmount).eq(toMoney(entry.creditAmount)))
            ) {
              throw new Error("ZMW voucher base/transaction amount conflict; reload the original currency amounts.");
            }
            if (entry.transactionCurrency && String(entry.transactionCurrency).toUpperCase() !== "ZMW") {
              throw new Error("ZMW voucher entry currency must match its original voucher currency.");
            }
            // Build both native and base amounts from the locked original rate
            // and typed native amounts. Untrusted base/rate inputs cannot alter it.
            const norm = normalizeVoucherEntryAmounts({
              transactionCurrency: "ZMW",
              baseCurrency: "USD",
              transactionDebitAmount: String(entry.debitAmount ?? "0"),
              transactionCreditAmount: String(entry.creditAmount ?? "0"),
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
              debitAmount: norm.debitAmount,
              creditAmount: norm.creditAmount,
            };
          } else if (entry.transactionCurrency) {
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
          .set({
            amountCurrency:
              editVoucherCurrency === "ZMW" ? MoneyDecimal.max(totalDebits, totalCredits).toFixed(6) : newTotal,
            amountUsd: newTotal,
          })
          .where(and(eq(fde.referenceTable, "vouchers"), eq(fde.referenceId, id)));

        // Perpetual inventory (wave 8.3): a stock adjustment voucher carries its inventory line.
        await syncStockAdjustmentInventoryTx(tx, existingVoucher.companyId, id);

        // Phase 22 A (D3): an engine voucher balances exactly; the rounding
        // remainder of the new lines goes to its ROUNDING line.
        await rebalanceVoucherRoundingTx(tx, { companyId: existingVoucher.companyId, voucherId: id });

        // Phase 22 (B), PE10: the order-charge and container-charge syncs commit
        // with the edit (they used to run after it, on the pool).
        // An edited duty/transport/office charge voucher re-prices the offloaded bales.
        await syncContainerChargeVoucherEditTx(tx, {
          companyId: existingVoucher.companyId,
          voucherNumber: existingVoucher.voucherNumber,
          oldTotal: existingVoucher.optional ? 0 : existingVoucher.totalAmount,
          newTotal: updatedVoucher.optional ? 0 : updatedVoucher.totalAmount,
        });
        await syncFactoryChargeVoucherEditTx(tx, {
          companyId: existingVoucher.companyId,
          voucher: existingVoucher,
          description: updatedVoucher.description,
          newAmount:
            editVoucherCurrency === "ZMW" ? new MoneyDecimal(newTotal) : MoneyDecimal.max(totalDebits, totalCredits),
        });

        // Wave 12 / phase 22 B: full before/after snapshot in this transaction; a
        // failed audit write refuses the edit.
        const audited = await recordVoucherEditAuditTx(tx, {
          voucherId: id,
          before: editContext.before,
          actor: {
            userId: req.session.userId,
            username: req.session.username,
            companyId: existingVoucher.companyId,
          },
          reason: "Voucher edit (with entries)",
        });
        createdEntries.splice(0, createdEntries.length, ...audited.entries);
      });

      res.json({ voucher: updatedVoucher, entries: createdEntries });
    } catch (error: unknown) {
      if (sendVoucherCorrectionRefusal(res, error)) return;
      res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
    }
  });
}
