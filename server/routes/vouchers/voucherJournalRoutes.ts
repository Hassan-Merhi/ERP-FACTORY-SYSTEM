import {
  assertApprovedZmwVoucherRate,
  assertLockedZmwVoucherEdit,
  assertResolvedZmwVoucherEntriesTx,
} from "../../services/accounting/zambiaVoucherRatePolicy";
import type { Express } from "express";
import { getErrorMessage, errorStatus } from "../../lib/httpHandlers";
import { db } from "../../db";
import { voucherMutationBlockReason } from "../../lib/migratedVoucherGuard";
import { requireAuth, requireNonPOS } from "../../auth";
import { syncEmployeeBalancesFromEntries } from "../_helpers";
import { writeVoucherAuditTx } from "../helpers/voucherAuditTrail";
import {
  erpRequestSourceId,
  postManualVoucherTx,
  sessionPostingActor,
} from "../../services/accounting/erpVoucherPosting";
import {
  assertNotIntercompanyTransferLeg,
  sendIntercompanyTransferLegRefusal,
} from "../../services/accounting/intercompanyTransferLegGuard";
import { logger } from "../../lib/logger";
import { vouchers, voucherEntries, customerBalances } from "@shared/schema";
import { eq, and, isNull, sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import {
  assertVoucherEditableTx,
  recordVoucherEditAuditTx,
  sendVoucherCorrectionRefusal,
} from "../../services/accounting/voucherCorrection";
import { rebalanceVoucherRoundingTx } from "../../services/accounting/engineRounding";
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
  tx: DbTransaction,
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
      matchingCharges = await tx
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
      const byLedger = await tx
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
    const amountChanged = !toMoney(charge.amount).equals(newAmount.toDecimalPlaces(2));

    // Phase 22 (B), PE10: in the journal's own transaction (it ran after the
    // commit, its failure swallowed): charge amount, order totals and the
    // invoice balance commit with the journal or not at all.
    {
      // Update charge amount and stamp voucherId for direct future lookups
      await tx
        .update(customerOrderCharges)
        .set({
          amount: newAmount.toFixed(2),
          ...(voucherId ? { voucherId } : {}),
        })
        .where(eq(customerOrderCharges.id, charge.id));

      if (!amountChanged) continue; // voucherId stamp done, but no recalc needed

      // DI7: the order is locked before its totals are recalculated.
      await tx.execute(sql`SELECT id FROM customer_orders WHERE id = ${charge.orderId} FOR UPDATE`);
      // Recalculate and save order totals
      await recalculateOrderTotals(tx, charge.orderId);

      // Also sync the invoice debit in customerBalances
      const [updatedOrder] = await tx
        .select({ grandTotal: customerOrders.grandTotal })
        .from(customerOrders)
        .where(eq(customerOrders.id, charge.orderId));

      if (updatedOrder) {
        // DI7: the invoice balance row is locked before it is rewritten.
        await tx.execute(sql`
          SELECT id FROM customer_balances
           WHERE company_id = ${companyId} AND reference_id = ${charge.orderId} AND reference_type = 'INVOICE'
           FOR UPDATE
        `);
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
    }
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
      const vRateRaw = await assertApprovedZmwVoucherRate(
        req.session.currentCompanyId!,
        voucherDate,
        vCurrency,
        exchangeRate
      );
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

      // Use database transaction for atomic operation
      const result = await db.transaction(async (tx) => {
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

        // Phase 22 (B): an active journal posts through the central engine (number
        // allocated there); an optional one keeps a direct insert with an
        // allocated number (it is off the ledger and may be unbalanced).
        const posted = await postManualVoucherTx(tx, {
          companyId: req.session.currentCompanyId!,
          voucherType: "Journal",
          voucherDate,
          description: notes || null,
          currency: vCurrency,
          exchangeRate: vRateRaw ? String(vRateRaw) : null,
          effectiveDate: effectiveDate || null,
          optional: optional === true,
          optionalTotalAmount: baseTotalMax.toFixed(6),
          entries: voucherEntriesToCreate,
          source: { type: "manual-journal-legacy", id: `${req.session.currentCompanyId}:${erpRequestSourceId(req)}` },
          actor: sessionPostingActor(req, "Journal creation"),
        });
        if (posted.replayed) return { voucher: posted.voucher, entries: posted.entries };
        const createdVoucher = posted.voucher;
        const createdEntries = posted.entries;
        // Sync order charges automatically, in this transaction.
        await syncJournalToOrderCharge(tx, req.session.currentCompanyId!, createdEntries, createdVoucher.id);

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

      // Phase 19 C (MC-2): an intercompany transfer leg (a Payment, Receipt or
      // draft journal reaching this legacy editor) is not edited here (409): the
      // transfer is deleted (both legs) and recorded again. This editor used to
      // rescale the other company's voucher after commit, outside a transaction.
      try {
        await assertNotIntercompanyTransferLeg(voucherId);
      } catch (legError: unknown) {
        if (sendIntercompanyTransferLegRefusal(res, legError)) return;
        throw legError;
      }

      // Determine voucher currency and rate for the PATCH handler.
      // currency/exchangeRate may not be sent on a PATCH (preserve existing values).
      const [priorVoucher] = await db
        .select()
        .from(vouchers)
        .where(and(eq(vouchers.id, voucherId), eq(vouchers.companyId, req.session.currentCompanyId!)))
        .limit(1);
      if (!priorVoucher) return res.status(404).json({ message: "Voucher not found" });
      assertLockedZmwVoucherEdit(priorVoucher, { voucherDate, currency, exchangeRate });
      // Only a posted Kwacha voucher locks its currency and rate on edit; the
      // existing USD/CFA PATCH contract (caller-supplied currency/rate) is kept.
      const priorIsZmw = String(priorVoucher.currency || "USD").toUpperCase() === "ZMW";
      const vCurrencyPatch = priorIsZmw ? "ZMW" : (currency as string | undefined) || "USD";
      const vRateRawPatch = priorIsZmw
        ? String(priorVoucher.exchangeRate)
        : (exchangeRate as string | number | undefined) || null;
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
        // Phase 22 (B), PE9/G4: open-period edit, audited below; closed period → 409.
        const editContext = await assertVoucherEditableTx(tx, voucherId, {
          companyId: existingVoucher.companyId,
          newVoucherDate: voucherDate,
          newEffectiveDate: effectiveDate || null,
        });

        // Recheck the immutable FX header under the write transaction; a
        // second editor must not be able to alter it between read and save.
        assertLockedZmwVoucherEdit(existingVoucher, { voucherDate, currency, exchangeRate });
        // Get existing entries before deleting (for balance sync)
        const oldEntries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));
        if (existingVoucher.currency === "ZMW") {
          await assertResolvedZmwVoucherEntriesTx(tx, existingVoucher.companyId, oldEntries);
        }

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
        const insertedEntries = await tx.insert(voucherEntries).values(voucherEntriesToCreate).returning();
        // Phase 22 A (D3): the rounding remainder of an engine voucher's new lines.
        await rebalanceVoucherRoundingTx(tx, { companyId: existingVoucher.companyId, voucherId });

        // Wave 12: employee balances move in this transaction (reverse the old
        // lines, apply the new), and the edit is audited with the full
        // before/after snapshot before it commits.
        if (!existingVoucher.optional) {
          await syncEmployeeBalancesFromEntries(oldEntries, req.session.currentCompanyId!, true, tx);
        }
        if (!updatedVoucher.optional) {
          await syncEmployeeBalancesFromEntries(insertedEntries, req.session.currentCompanyId!, false, tx);
        }
        // Sync order charges: a customer line + a CR ledger line matching a charge
        // on one of their orders updates that charge, in this transaction.
        await syncJournalToOrderCharge(tx, req.session.currentCompanyId!, insertedEntries, voucherId);
        const audited = await recordVoucherEditAuditTx(tx, {
          voucherId,
          before: editContext.before,
          actor: {
            userId: req.session.userId,
            username: req.session.username,
            companyId: req.session.currentCompanyId,
          },
          reason: "Journal voucher update",
        });
        const createdEntries = audited.entries;

        return {
          voucher: updatedVoucher,
          entries: createdEntries,
          oldEntries,
          existingVoucher,
          wasOptional: existingVoucher.optional,
        };
      });

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
      if (sendVoucherCorrectionRefusal(res, error)) return;
      res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
    }
  });
}
