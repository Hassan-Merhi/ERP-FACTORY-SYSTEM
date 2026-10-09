import type { Express } from "express";
import { getErrorMessage, errorStatus } from "../../lib/httpHandlers";
import { db } from "../../db";
import { voucherMutationBlockReason } from "../../lib/migratedVoucherGuard";
import { requireAuth, requireNonPOS } from "../../auth";
import { syncEmployeeBalancesFromEntries } from "../_helpers";
import { readVoucherAuditState, writeVoucherAuditTx } from "../helpers/voucherAuditTrail";
import { logger } from "../../lib/logger";
import { vouchers, voucherEntries, customerBalances, interCompanyTransfers } from "@shared/schema";
import { eq, and, or, isNull } from "drizzle-orm";
import { checkAccountWhatsAppRule } from "../factoryWhatsappRoutes";

import { recalculateOrderTotals } from "../factory/_helpers";
import {
  customerOrderCharges,
  customerOrders,
  factorySettings as fSettings,
  factoryDaybookEntries as fde,
} from "@shared/schema";
import { normalizeVoucherEntryAmounts, erpRateToDaybookFxRateToUsd } from "../../services/accounting/currencyAmounts";
import { isVoucherAccountType, voucherEntryAccountLink } from "../../services/accounting/voucherEntryAccountLink";
import type Decimal from "decimal.js";
import { MoneyDecimal, parseMoneyInput, toMoney } from "../../lib/money";

/**
 * Transaction-currency debit and credit totals of a journal request. Amounts
 * are read the way the float path read them (a leading number, else 0) but
 * summed exactly.
 */
function journalTotals(entries: Array<{ type?: unknown; amount?: unknown }>): { debits: Decimal; credits: Decimal } {
  let debits = new MoneyDecimal(0);
  let credits = new MoneyDecimal(0);
  for (const entry of entries) {
    const amount = parseMoneyInput(entry.amount || "0") ?? new MoneyDecimal(0);
    if (entry.type === "DR") debits = debits.plus(amount);
    else if (entry.type === "CR") credits = credits.plus(amount);
  }
  return { debits, credits };
}

/** The voucher's CFA-per-USD rate as the float path read it; NaN when unreadable. */
function journalRate(currency: string, rateRaw: string | number | null): Decimal {
  if (currency === "USD" || !rateRaw) return new MoneyDecimal(1);
  return parseMoneyInput(String(rateRaw)) ?? new MoneyDecimal(NaN);
}

/** The historical base (USD) total: the larger side, divided by a positive rate. */
function journalBaseTotal(currency: string, totals: { debits: Decimal; credits: Decimal }, rate: Decimal): Decimal {
  const larger = MoneyDecimal.max(totals.debits, totals.credits);
  return currency !== "USD" && rate.greaterThan(0) ? larger.dividedBy(rate) : larger;
}

/**
 * After saving a journal voucher, if it has a customer entry + a ledger account entry,
 * look for order charges linked to that ledger account for that customer.
 * If exactly one charge is found, update its amount and recalculate the order totals.
 */

async function syncJournalToOrderCharge(
  companyId: number,
  savedEntries: Array<{
    customerId: number | null;
    ledgerAccountId: number | null;
    debitAmount: string | null;
    creditAmount: string | null;
  }>,
  voucherId?: number
) {
  const customerEntry = savedEntries.find((e) => e.customerId !== null);
  if (!customerEntry) return;

  const ledgerCrEntries = savedEntries.filter(
    (e) => e.ledgerAccountId !== null && e.customerId === null && toMoney(e.creditAmount).greaterThan(0)
  );
  if (ledgerCrEntries.length === 0) return;

  for (const ledgerEntry of ledgerCrEntries) {
    const newAmount = toMoney(ledgerEntry.creditAmount);
    if (newAmount.lessThanOrEqualTo(0)) continue;

    let matchingCharges: { id: number; orderId: number; amount: string; chargeType: string }[] = [];

    // Priority 1: find by direct voucher link (exact match, no ambiguity)
    if (voucherId) {
      matchingCharges = await db
        .select({
          id: customerOrderCharges.id,
          orderId: customerOrderCharges.orderId,
          amount: customerOrderCharges.amount,
          chargeType: customerOrderCharges.chargeType,
        })
        .from(customerOrderCharges)
        .innerJoin(
          customerOrders,
          and(eq(customerOrderCharges.orderId, customerOrders.id), eq(customerOrders.companyId, companyId))
        )
        .where(
          and(
            eq(customerOrderCharges.voucherId, voucherId),
            eq(customerOrderCharges.ledgerAccountId, ledgerEntry.ledgerAccountId!)
          )
        );
    }

    // Priority 2: fall back to ledger account match (only if exactly one unlinked result)
    if (matchingCharges.length === 0) {
      const byLedger = await db
        .select({
          id: customerOrderCharges.id,
          orderId: customerOrderCharges.orderId,
          amount: customerOrderCharges.amount,
          chargeType: customerOrderCharges.chargeType,
        })
        .from(customerOrderCharges)
        .innerJoin(
          customerOrders,
          and(
            eq(customerOrderCharges.orderId, customerOrders.id),
            eq(customerOrders.customerId, customerEntry.customerId!),
            eq(customerOrders.companyId, companyId)
          )
        )
        .where(
          and(
            eq(customerOrderCharges.ledgerAccountId, ledgerEntry.ledgerAccountId!),
            isNull(customerOrderCharges.voucherId)
          )
        );

      if (byLedger.length === 1) {
        matchingCharges = byLedger;
      }
    }

    if (matchingCharges.length === 0) continue;

    const charge = matchingCharges[0];
    const amountChanged = toMoney(charge.amount).minus(newAmount).abs().greaterThanOrEqualTo(0.01);

    // Atomically: update charge amount, recalc order totals, sync customerBalances.
    // Without a transaction a crash between the three writes leaves the order's grand
    // total inconsistent with the underlying charge rows.
    await db.transaction(async (tx) => {
      // Update charge amount and stamp voucherId for direct future lookups
      await tx
        .update(customerOrderCharges)
        .set({
          amount: newAmount.toFixed(2),
          ...(voucherId ? { voucherId } : {}),
        })
        .where(eq(customerOrderCharges.id, charge.id));

      if (!amountChanged) return; // voucherId stamp done, but no recalc needed

      // Recalculate and save order totals
      await recalculateOrderTotals(tx, charge.orderId);

      // Also sync the invoice debit in customerBalances
      const [updatedOrder] = await tx
        .select({ grandTotal: customerOrders.grandTotal })
        .from(customerOrders)
        .where(eq(customerOrders.id, charge.orderId));

      if (updatedOrder) {
        await tx
          .update(customerBalances)
          .set({ debitAmount: updatedOrder.grandTotal, balance: updatedOrder.grandTotal })
          .where(
            and(
              eq(customerBalances.companyId, companyId),
              eq(customerBalances.referenceId, charge.orderId),
              eq(customerBalances.referenceType, "INVOICE")
            )
          );
      }
    });
  }
}

export function registerVoucherJournalRoutes(app: Express) {
  app.post("/api/vouchers/journal", requireAuth, requireNonPOS, async (req, res) => {
    const _t = Date.now();
    const _uid = req.session.userId;
    const _cid = req.session.currentCompanyId;
    try {
      logger.info("journal voucher create started", {
        module: "vouchers",
        action: "createJournal",
        userId: _uid,
        companyId: _cid,
      });
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const {
        voucherDate,
        entries, // Array of { type: "DR" | "CR", accountType, accountId, accountName, amount }
        notes,
        optional,
        currency,
        exchangeRate,
        effectiveDate,
        mainAccountId, // optional: ledger account ID to use for WhatsApp auto-statement
        mainAccountType, // optional: account type for the main account (default: "ledger")
      } = req.body;

      // Validate required fields
      if (!voucherDate || !entries || !Array.isArray(entries) || entries.length === 0) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      // Determine voucher currency and rate (CFA per USD convention for non-USD).
      // totalDebits/totalCredits below are in the voucher's transaction currency (e.g. CFA).
      const vCurrency = (currency as string | undefined) || "USD";
      const vRateRaw = (exchangeRate as string | number | undefined) || null;
      const cfaPerUsd = journalRate(vCurrency, vRateRaw);

      // Calculate total debits and credits in transaction currency
      const totals = journalTotals(entries);

      // Validate debits equal credits (for non-optional vouchers)
      if (!optional && totals.debits.minus(totals.credits).abs().greaterThanOrEqualTo(0.01)) {
        return res.status(400).json({ message: "Total debits must equal total credits" });
      }

      // vouchers.totalAmount stores the historical base (USD) amount.
      // For CFA: baseTotalMax = max(totalDebits, totalCredits) / cfaPerUsd
      const baseTotalMax = journalBaseTotal(vCurrency, totals, cfaPerUsd);

      // Generate voucher number
      const voucherNumber = `JOURNAL-${Date.now()}`;

      // Use database transaction for atomic operation
      const result = await db.transaction(async (tx) => {
        // Create journal voucher
        const [createdVoucher] = await tx
          .insert(vouchers)
          .values({
            companyId: req.session.currentCompanyId!,
            voucherNumber,
            voucherType: "Journal",
            voucherDate,
            description: notes || null,
            // Store historical base-currency (USD) total.
            totalAmount: baseTotalMax.toFixed(6),
            optional: optional ?? false,
            currency: vCurrency,
            exchangeRate: vRateRaw ? String(vRateRaw) : null,
            effectiveDate: effectiveDate || null,
          })
          .returning();

        const voucherEntriesToCreate = [];

        // Create entries.
        // Each entry.amount is the original transaction-currency (CFA) value.
        // normalizeVoucherEntryAmounts() produces the historical base (USD) amounts
        // for debitAmount / creditAmount (backward compat) and fills all new fields.
        for (const entry of entries) {
          const amount: string = entry.amount;
          const narration = entry.narration || null;

          // Determine account field
          const accountField = isVoucherAccountType(entry.accountType)
            ? voucherEntryAccountLink(entry.accountType, entry.accountId)
            : {};

          const norm = normalizeVoucherEntryAmounts({
            transactionCurrency: vCurrency,
            baseCurrency: "USD",
            transactionDebitAmount: entry.type === "DR" ? amount : "0",
            transactionCreditAmount: entry.type === "CR" ? amount : "0",
            historicalRate: vRateRaw,
          });

          voucherEntriesToCreate.push({
            voucherId: createdVoucher.id,
            ...accountField,
            debitAmount: norm.debitAmount,
            creditAmount: norm.creditAmount,
            transactionCurrency: norm.transactionCurrency,
            transactionDebitAmount: norm.transactionDebitAmount,
            transactionCreditAmount: norm.transactionCreditAmount,
            baseDebitAmount: norm.baseDebitAmount,
            baseCreditAmount: norm.baseCreditAmount,
            historicalExchangeRate: norm.historicalExchangeRate,
            rateConvention: norm.rateConvention,
            narration,
          });
        }

        // Batch insert all voucher entries
        const createdEntries = await tx.insert(voucherEntries).values(voucherEntriesToCreate).returning();

        // Wave 12: employee balances and the audit row are written in this transaction.
        if (!createdVoucher.optional) {
          await syncEmployeeBalancesFromEntries(createdEntries, req.session.currentCompanyId!, false, tx);
        }
        await writeVoucherAuditTx(tx, {
          actor: {
            userId: req.session.userId,
            username: req.session.username,
            companyId: req.session.currentCompanyId,
          },
          action: "create",
          voucherId: createdVoucher.id,
          before: null,
          after: { voucher: createdVoucher, entries: createdEntries },
        });

        return { voucher: createdVoucher, entries: createdEntries };
      });

      // Sync order charges automatically (non-fatal)
      await syncJournalToOrderCharge(req.session.currentCompanyId!, result.entries, result.voucher.id).catch(() => {});

      // Write to factory daybook if this company has factory settings
      try {
        const cid = req.session.currentCompanyId!;
        const [fSetting] = await db.select().from(fSettings).where(eq(fSettings.companyId, cid));
        if (fSetting) {
          const daybookCurrencyJ = result.voucher.currency || "USD";
          // vouchers.totalAmount now stores the historical base (USD) amount.
          const daybookBaseTotalJ = toMoney(result.voucher.totalAmount);
          const daybookRateJ = result.voucher.exchangeRate ? toMoney(result.voucher.exchangeRate) : new MoneyDecimal(1);
          // Reconstruct the original CFA total: base × rate (TRANSACTION_PER_BASE).
          const daybookAmtCurrencyJ =
            daybookCurrencyJ !== "USD" && daybookRateJ.greaterThan(0)
              ? daybookBaseTotalJ.times(daybookRateJ)
              : daybookBaseTotalJ;
          // factory_daybook_entries.fx_rate_to_usd expects USD-per-foreign-unit.
          // The ERP voucher stores CFA-per-USD, so we store the inverse.
          const daybookFxRateToUsdJ = erpRateToDaybookFxRateToUsd(daybookCurrencyJ, "USD", result.voucher.exchangeRate);
          await db.insert(fde).values({
            companyId: cid,
            txDate: result.voucher.voucherDate,
            txType: "JOURNAL",
            referenceId: result.voucher.id,
            referenceTable: "vouchers",
            description: result.voucher.description || `Journal voucher #${result.voucher.voucherNumber}`,
            currencyCode: daybookCurrencyJ,
            amountCurrency: daybookAmtCurrencyJ.toFixed(),
            fxRateToUsd: daybookFxRateToUsdJ,
            amountUsd: daybookBaseTotalJ.toFixed(),
            createdBy: null,
          });
        }
      } catch (dbErr) {
        logger.error("Factory daybook write failed (non-fatal):", { error: dbErr });
      }

      // WhatsApp rule check — prompt the frontend instead of auto-sending
      // Resolve main account: prefer explicitly passed mainAccountId,
      // fallback to first ledger-type DR entry in entries array.
      let waJournalResult: { prompt: boolean; accountId?: number; voucherDate?: string; month?: string } = {
        prompt: false,
      };
      try {
        let waAccountId = mainAccountId ? Number(mainAccountId) : null;
        let waAccountType = mainAccountType ? String(mainAccountType) : "ledger";
        if (!waAccountId) {
          const firstLedgerDr = entries.find(
            (e) => e.accountType === "ledger" && e.type === "DR" && Number(e.accountId) > 0
          );
          if (firstLedgerDr) {
            waAccountId = Number(firstLedgerDr.accountId);
            waAccountType = "ledger";
          }
        }
        if (waAccountId) {
          waJournalResult = await checkAccountWhatsAppRule({
            companyId: req.session.currentCompanyId!,
            accountId: waAccountId,
            accountType: waAccountType,
            voucherType: "Journal",
            voucherDate: voucherDate,
          });
        }
      } catch (waErr: unknown) {
        logger.error("WhatsApp rule check error (non-fatal):", { error: waErr });
      }

      logger.info("journal voucher create succeeded", {
        module: "vouchers",
        action: "createJournal",
        userId: _uid,
        companyId: _cid,
        voucherId: result.voucher.id,
        durationMs: Date.now() - _t,
      });
      res.json({ ...result, whatsapp: waJournalResult });
    } catch (error: unknown) {
      logger.error("journal voucher create failed", {
        module: "vouchers",
        action: "createJournal",
        userId: _uid,
        companyId: _cid,
        durationMs: Date.now() - _t,
        error,
      });
      logger.error("Error creating journal voucher:", { error: error });
      res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
    }
  });

  // Update Journal voucher with all entries in one batch
  app.patch("/api/vouchers/:id/journal", requireAuth, requireNonPOS, async (req, res) => {
    const _t = Date.now();
    const _uid = req.session.userId;
    const _cid = req.session.currentCompanyId;
    try {
      logger.info("journal voucher update started", {
        module: "vouchers",
        action: "updateJournal",
        userId: _uid,
        companyId: _cid,
      });
      const voucherId = parseInt(req.params.id);
      if (isNaN(voucherId)) {
        return res.status(400).json({ message: "Invalid voucher ID" });
      }

      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const {
        voucherDate,
        entries,
        notes,
        optional,
        currency,
        exchangeRate,
        effectiveDate,
        mainAccountId: mainAccountIdPatch,
        mainAccountType: mainAccountTypePatch,
      } = req.body;

      // Validate required fields
      if (!voucherDate || !entries || !Array.isArray(entries) || entries.length === 0) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      // Determine voucher currency and rate for the PATCH handler.
      // currency/exchangeRate may not be sent on a PATCH (preserve existing values).
      const vCurrencyPatch = (currency as string | undefined) || "USD";
      const vRateRawPatch = (exchangeRate as string | number | undefined) || null;
      const cfaPerUsdPatch = journalRate(vCurrencyPatch, vRateRawPatch);

      // Calculate total debits and credits in transaction currency
      const totals = journalTotals(entries);

      // Validate debits equal credits (for non-optional vouchers)
      if (!optional && totals.debits.minus(totals.credits).abs().greaterThanOrEqualTo(0.01)) {
        return res.status(400).json({ message: "Total debits must equal total credits" });
      }

      // vouchers.totalAmount stores the historical base (USD) amount.
      const baseTotalMaxPatch = journalBaseTotal(vCurrencyPatch, totals, cfaPerUsdPatch);

      // Use database transaction for atomic operation
      const result = await db.transaction(async (tx) => {
        // Verify voucher exists and belongs to current company
        const [existingVoucher] = await tx.select().from(vouchers).where(eq(vouchers.id, voucherId));

        if (!existingVoucher) {
          throw new Error("Voucher not found");
        }

        if (existingVoucher.companyId !== req.session.currentCompanyId) {
          throw new Error("Access denied: Voucher belongs to a different company");
        }

        const blockedVoucherReason = voucherMutationBlockReason(existingVoucher);
        if (blockedVoucherReason) {
          throw new Error(blockedVoucherReason);
        }

        // Get existing entries before deleting (for balance sync)
        const oldEntries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));

        // Update voucher
        const [updatedVoucher] = await tx
          .update(vouchers)
          .set({
            voucherDate,
            description: notes || null,
            // Store historical base (USD) total.
            totalAmount: baseTotalMaxPatch.toFixed(6),
            optional: optional ?? false,
            effectiveDate: effectiveDate || null,
          })
          .where(eq(vouchers.id, voucherId))
          .returning();

        // Delete existing voucher entries
        await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));

        const voucherEntriesToCreate = [];

        // Create new entries with dual-currency normalization.
        for (const entry of entries) {
          const amount: string = entry.amount;
          const narration = entry.narration || null;

          // Determine account field
          const accountField = isVoucherAccountType(entry.accountType)
            ? voucherEntryAccountLink(entry.accountType, entry.accountId)
            : {};

          const norm = normalizeVoucherEntryAmounts({
            transactionCurrency: vCurrencyPatch,
            baseCurrency: "USD",
            transactionDebitAmount: entry.type === "DR" ? amount : "0",
            transactionCreditAmount: entry.type === "CR" ? amount : "0",
            historicalRate: vRateRawPatch,
          });

          voucherEntriesToCreate.push({
            voucherId: updatedVoucher.id,
            ...accountField,
            debitAmount: norm.debitAmount,
            creditAmount: norm.creditAmount,
            transactionCurrency: norm.transactionCurrency,
            transactionDebitAmount: norm.transactionDebitAmount,
            transactionCreditAmount: norm.transactionCreditAmount,
            baseDebitAmount: norm.baseDebitAmount,
            baseCreditAmount: norm.baseCreditAmount,
            historicalExchangeRate: norm.historicalExchangeRate,
            rateConvention: norm.rateConvention,
            narration,
          });
        }

        // Batch insert all new voucher entries
        const createdEntries = await tx.insert(voucherEntries).values(voucherEntriesToCreate).returning();

        // Wave 12: employee balances move in this transaction (reverse the old
        // lines, apply the new), and the edit is audited with the full
        // before/after snapshot before it commits.
        if (!existingVoucher.optional) {
          await syncEmployeeBalancesFromEntries(oldEntries, req.session.currentCompanyId!, true, tx);
        }
        if (!updatedVoucher.optional) {
          await syncEmployeeBalancesFromEntries(createdEntries, req.session.currentCompanyId!, false, tx);
        }
        await writeVoucherAuditTx(tx, {
          actor: {
            userId: req.session.userId,
            username: req.session.username,
            companyId: req.session.currentCompanyId,
          },
          action: "update",
          voucherId,
          before: { voucher: existingVoucher, entries: oldEntries },
          after: { voucher: updatedVoucher, entries: createdEntries },
        });

        return {
          voucher: updatedVoucher,
          entries: createdEntries,
          oldEntries,
          existingVoucher,
          wasOptional: existingVoucher.optional,
        };
      });

      // Sync order charges: if the journal has a customer entry + a CR ledger entry
      // that matches a charge on one of their orders, update that charge automatically
      await syncJournalToOrderCharge(req.session.currentCompanyId!, result.entries, result.voucher.id).catch(() => {});

      // ── Intercompany counterpart sync ─────────────────────────────────────
      // If this voucher is one side of an intercompany transfer pair, scale the
      // counterpart voucher's totalAmount and entries to match the new amount.
      try {
        const [ict] = await db
          .select()
          .from(interCompanyTransfers)
          .where(
            or(eq(interCompanyTransfers.fromVoucherId, voucherId), eq(interCompanyTransfers.toVoucherId, voucherId))
          )
          .limit(1);
        if (ict) {
          const otherVoucherId = ict.fromVoucherId === voucherId ? ict.toVoucherId : ict.fromVoucherId;
          if (otherVoucherId) {
            const newTotal = toMoney(result.voucher.totalAmount);
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
                  extra: { interCompanyCounterpartOf: { new: { voucherId } } },
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

      // WhatsApp rule check — prompt the frontend instead of auto-sending
      let waJournalPatch: { prompt: boolean; accountId?: number; voucherDate?: string; month?: string } = {
        prompt: false,
      };
      try {
        let waAccountId = mainAccountIdPatch ? Number(mainAccountIdPatch) : null;
        let waAccountType = mainAccountTypePatch ? String(mainAccountTypePatch) : "ledger";
        if (!waAccountId) {
          const firstLedgerDr = entries.find(
            (e) => e.accountType === "ledger" && e.type === "DR" && Number(e.accountId) > 0
          );
          if (firstLedgerDr) {
            waAccountId = Number(firstLedgerDr.accountId);
            waAccountType = "ledger";
          }
        }
        if (waAccountId) {
          waJournalPatch = await checkAccountWhatsAppRule({
            companyId: req.session.currentCompanyId!,
            accountId: waAccountId,
            accountType: waAccountType,
            voucherType: "Journal",
            voucherDate: voucherDate,
          });
        }
      } catch (waErr: unknown) {
        logger.error("WhatsApp rule check error (non-fatal):", { error: waErr });
      }

      logger.info("journal voucher update succeeded", {
        module: "vouchers",
        action: "updateJournal",
        userId: _uid,
        companyId: _cid,
        voucherId: result.voucher.id,
        durationMs: Date.now() - _t,
      });
      res.json({ voucher: result.voucher, entries: result.entries, whatsapp: waJournalPatch });
    } catch (error: unknown) {
      logger.error("journal voucher update failed", {
        module: "vouchers",
        action: "updateJournal",
        userId: _uid,
        companyId: _cid,
        durationMs: Date.now() - _t,
        error,
      });
      logger.error("Error updating journal voucher:", { error: error });
      res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
    }
  });
}
