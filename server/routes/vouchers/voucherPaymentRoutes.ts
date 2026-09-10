import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { voucherMutationBlockReason } from "../../lib/migratedVoucherGuard";
import { requireAuth, requireNonPOS } from "../../auth";
import {
  logAudit,
  syncEmployeeBalancesFromEntries,
  snapshotVoucherEntries,
  buildVoucherChangesForCreate,
  buildVoucherChangesForUpdate,
} from "../_helpers";
import { triggerIntercompanyNotifications } from "../intercompanyNotificationRoutes";
import { autoReallocateLoansAccounts } from "../../lib/transporterAllocation";
import { vouchers, voucherEntries, customers, ledgerAccounts } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { checkAccountWhatsAppRule } from "../factoryWhatsappRoutes";

import { factorySettings as fSettings, factoryDaybookEntries as fde } from "@shared/schema";
import { normalizeVoucherEntryAmounts, erpRateToDaybookFxRateToUsd } from "../../services/accounting/currencyAmounts";
import { isVoucherAccountType, voucherEntryAccountLink } from "../../services/accounting/voucherEntryAccountLink";

/**
 * After saving a journal voucher, if it has a customer entry + a ledger account entry,
 * look for order charges linked to that ledger account for that customer.
 * If exactly one charge is found, update its amount and recalculate the order totals.
 */

export function registerVoucherPaymentRoutes(app: Express) {
  app.post("/api/vouchers/payment-receipt", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const {
        voucherType, // "Payment" or "Receipt"
        voucherDate,
        paymentAccountType, // "ledger", "bank", "supplier", "employee", "fixedAsset"
        paymentAccountId,
        paymentAccountName: _paymentAccountName,
        entries, // Array of { accountType, accountId, accountName, amount }
        notes,
        optional,
        currency,
        exchangeRate,
        effectiveDate,
      } = req.body;

      // Validate required fields
      if (
        !voucherType ||
        !voucherDate ||
        !paymentAccountId ||
        !entries ||
        !Array.isArray(entries) ||
        entries.length === 0
      ) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      if (voucherType !== "Payment" && voucherType !== "Receipt") {
        return res.status(400).json({ message: "voucherType must be 'Payment' or 'Receipt'" });
      }

      // Determine voucher currency and rate (CFA per USD convention for non-USD).
      // transactionTotal is in the voucher's transaction currency (e.g. CFA).
      // baseTotal is the historical base-currency (USD) equivalent stored on the voucher.
      const vCurrency = (currency as string | undefined) || "USD";
      const vRateRaw = (exchangeRate as string | number | undefined) || null;
      const cfaPerUsd = vCurrency !== "USD" && vRateRaw ? parseFloat(String(vRateRaw)) : 1;
      const transactionTotal = entries.reduce((sum: number, entry) => sum + parseFloat(entry.amount || "0"), 0);
      // For CFA vouchers: baseTotal = transactionTotal / cfaPerUsd (CFA ÷ rate = USD)
      // For USD vouchers: baseTotal = transactionTotal (no conversion)
      const baseTotal = vCurrency !== "USD" && cfaPerUsd > 0 ? transactionTotal / cfaPerUsd : transactionTotal;

      // Generate voucher number
      const voucherNumber = `${voucherType.toUpperCase()}-${Date.now()}`;

      // Use database transaction for atomic operation
      const companyId = req.session.currentCompanyId!;

      // Helper: build the voucher-entry account field set for a given
      // (accountType, accountId).  Handles three things in one place:
      //   1. Validates the referenced row belongs to the current company
      //      (security: prevents cross-company injection).
      //   2. For accountType === "customer", also stamps ledgerAccountId
      //      from the linked customer ledger so the row shows up in BOTH
      //      the Customers view and the linked-ledger view (Phase 4).
      //   3. For accountType === "ledger" where the ledger is linked to a
      //      customer, also stamps customerId for the same reason.
      // The OR clause in factoryCustomerLedger.buildFactoryCustomerLedgerEntries
      // makes this denormalization safe (no double-counting).
      const buildAccountField = async (accountType: string, accountId: number): Promise<Record<string, number>> => {
        const field: Record<string, number> = {};
        if (accountType === "ledger") {
          const [acct] = await db
            .select({ id: ledgerAccounts.id, companyId: ledgerAccounts.companyId })
            .from(ledgerAccounts)
            .where(eq(ledgerAccounts.id, accountId))
            .limit(1);
          if (!acct || acct.companyId !== companyId) {
            throw new Error(`Ledger account ${accountId} not found in current company.`);
          }
          field.ledgerAccountId = accountId;
          // Auto-fill customerId if this ledger is customer-linked
          const [linkedCust] = await db
            .select({ id: customers.id })
            .from(customers)
            .where(and(eq(customers.ledgerAccountId, accountId), eq(customers.companyId, companyId)))
            .limit(1);
          if (linkedCust) field.customerId = linkedCust.id;
        } else if (accountType === "customer") {
          const [cust] = await db
            .select({ id: customers.id, ledgerAccountId: customers.ledgerAccountId })
            .from(customers)
            .where(and(eq(customers.id, accountId), eq(customers.companyId, companyId)))
            .limit(1);
          if (!cust) {
            throw new Error(`Customer ${accountId} not found in current company.`);
          }
          field.customerId = accountId;
          if (cust.ledgerAccountId) field.ledgerAccountId = cust.ledgerAccountId;
        } else if (accountType === "bank") {
          field.bankAccountId = accountId;
        } else if (accountType === "supplier") {
          field.supplierId = accountId;
        } else if (accountType === "factorySupplier") {
          field.factorySupplierId = accountId;
        } else if (accountType === "employee") {
          field.employeeId = accountId;
        } else if (accountType === "fixedAsset") {
          field.fixedAssetId = accountId;
        }
        return field;
      };

      const result = await db.transaction(async (tx) => {
        // Create voucher
        const [createdVoucher] = await tx
          .insert(vouchers)
          .values({
            companyId,
            voucherNumber,
            voucherType,
            voucherDate,
            description: notes || null,
            // Store historical base-currency (USD) total (baseTotal = transactionTotal for USD vouchers).
            totalAmount: baseTotal.toFixed(6),
            optional: optional ?? false,
            currency: vCurrency,
            exchangeRate: vRateRaw ? String(vRateRaw) : null,
            effectiveDate: effectiveDate || null,
          })
          .returning();

        const voucherEntriesToCreate = [];

        // Pre-compute the payment-account field once (same for every entry)
        const paymentAccountField = await buildAccountField(paymentAccountType, paymentAccountId);

        // Create entries based on voucher type.
        // Each entry amount is the original transaction-currency (CFA) value as typed.
        // normalizeVoucherEntryAmounts() converts it to historical base (USD) for
        // debitAmount / creditAmount (backward-compat columns) and fills all new fields.
        for (const entry of entries) {
          const amount: string = entry.amount;
          const narration = notes || null;

          const entryAccountField = await buildAccountField(entry.accountType, entry.accountId);

          const isLiabilityPaymentAccount =
            paymentAccountType === "supplier" ||
            paymentAccountType === "factorySupplier" ||
            paymentAccountType === "employee";

          // Normalize the transaction amount once per entry (DR side and CR side).
          // normDR: this entry carries the debit leg; normCR: the credit leg.
          const normDR = normalizeVoucherEntryAmounts({
            transactionCurrency: vCurrency,
            baseCurrency: "USD",
            transactionDebitAmount: amount,
            transactionCreditAmount: "0",
            historicalRate: vRateRaw,
          });
          const normCR = normalizeVoucherEntryAmounts({
            transactionCurrency: vCurrency,
            baseCurrency: "USD",
            transactionDebitAmount: "0",
            transactionCreditAmount: amount,
            historicalRate: vRateRaw,
          });

          if (voucherType === "Payment") {
            if (isLiabilityPaymentAccount) {
              // Payment from liability account (supplier/employee):
              // DR payment account (reduce liability)
              // CR contra account
              voucherEntriesToCreate.push({
                voucherId: createdVoucher.id,
                ...paymentAccountField,
                debitAmount: normDR.debitAmount,
                creditAmount: normDR.creditAmount,
                transactionCurrency: normDR.transactionCurrency,
                transactionDebitAmount: normDR.transactionDebitAmount,
                transactionCreditAmount: normDR.transactionCreditAmount,
                baseDebitAmount: normDR.baseDebitAmount,
                baseCreditAmount: normDR.baseCreditAmount,
                historicalExchangeRate: normDR.historicalExchangeRate,
                rateConvention: normDR.rateConvention,
                narration,
              });
              voucherEntriesToCreate.push({
                voucherId: createdVoucher.id,
                ...entryAccountField,
                debitAmount: normCR.debitAmount,
                creditAmount: normCR.creditAmount,
                transactionCurrency: normCR.transactionCurrency,
                transactionDebitAmount: normCR.transactionDebitAmount,
                transactionCreditAmount: normCR.transactionCreditAmount,
                baseDebitAmount: normCR.baseDebitAmount,
                baseCreditAmount: normCR.baseCreditAmount,
                historicalExchangeRate: normCR.historicalExchangeRate,
                rateConvention: normCR.rateConvention,
                narration,
              });
            } else {
              // Payment from asset account (cash/bank/ledger):
              // DR contra account (expense/asset purchased)
              // CR payment account (cash goes out)
              voucherEntriesToCreate.push({
                voucherId: createdVoucher.id,
                ...entryAccountField,
                debitAmount: normDR.debitAmount,
                creditAmount: normDR.creditAmount,
                transactionCurrency: normDR.transactionCurrency,
                transactionDebitAmount: normDR.transactionDebitAmount,
                transactionCreditAmount: normDR.transactionCreditAmount,
                baseDebitAmount: normDR.baseDebitAmount,
                baseCreditAmount: normDR.baseCreditAmount,
                historicalExchangeRate: normDR.historicalExchangeRate,
                rateConvention: normDR.rateConvention,
                narration,
              });
              voucherEntriesToCreate.push({
                voucherId: createdVoucher.id,
                ...paymentAccountField,
                debitAmount: normCR.debitAmount,
                creditAmount: normCR.creditAmount,
                transactionCurrency: normCR.transactionCurrency,
                transactionDebitAmount: normCR.transactionDebitAmount,
                transactionCreditAmount: normCR.transactionCreditAmount,
                baseDebitAmount: normCR.baseDebitAmount,
                baseCreditAmount: normCR.baseCreditAmount,
                historicalExchangeRate: normCR.historicalExchangeRate,
                rateConvention: normCR.rateConvention,
                narration,
              });
            }
          } else {
            if (isLiabilityPaymentAccount) {
              // Receipt into liability account (supplier/employee):
              // DR contra account (source, e.g. loans)
              // CR payment account (increase liability)
              voucherEntriesToCreate.push({
                voucherId: createdVoucher.id,
                ...entryAccountField,
                debitAmount: normDR.debitAmount,
                creditAmount: normDR.creditAmount,
                transactionCurrency: normDR.transactionCurrency,
                transactionDebitAmount: normDR.transactionDebitAmount,
                transactionCreditAmount: normDR.transactionCreditAmount,
                baseDebitAmount: normDR.baseDebitAmount,
                baseCreditAmount: normDR.baseCreditAmount,
                historicalExchangeRate: normDR.historicalExchangeRate,
                rateConvention: normDR.rateConvention,
                narration,
              });
              voucherEntriesToCreate.push({
                voucherId: createdVoucher.id,
                ...paymentAccountField,
                debitAmount: normCR.debitAmount,
                creditAmount: normCR.creditAmount,
                transactionCurrency: normCR.transactionCurrency,
                transactionDebitAmount: normCR.transactionDebitAmount,
                transactionCreditAmount: normCR.transactionCreditAmount,
                baseDebitAmount: normCR.baseDebitAmount,
                baseCreditAmount: normCR.baseCreditAmount,
                historicalExchangeRate: normCR.historicalExchangeRate,
                rateConvention: normCR.rateConvention,
                narration,
              });
            } else {
              // Receipt into asset account (cash/bank/ledger):
              // DR payment account (cash comes in)
              // CR contra account (income/liability)
              voucherEntriesToCreate.push({
                voucherId: createdVoucher.id,
                ...paymentAccountField,
                debitAmount: normDR.debitAmount,
                creditAmount: normDR.creditAmount,
                transactionCurrency: normDR.transactionCurrency,
                transactionDebitAmount: normDR.transactionDebitAmount,
                transactionCreditAmount: normDR.transactionCreditAmount,
                baseDebitAmount: normDR.baseDebitAmount,
                baseCreditAmount: normDR.baseCreditAmount,
                historicalExchangeRate: normDR.historicalExchangeRate,
                rateConvention: normDR.rateConvention,
                narration,
              });
              voucherEntriesToCreate.push({
                voucherId: createdVoucher.id,
                ...entryAccountField,
                debitAmount: normCR.debitAmount,
                creditAmount: normCR.creditAmount,
                transactionCurrency: normCR.transactionCurrency,
                transactionDebitAmount: normCR.transactionDebitAmount,
                transactionCreditAmount: normCR.transactionCreditAmount,
                baseDebitAmount: normCR.baseDebitAmount,
                baseCreditAmount: normCR.baseCreditAmount,
                historicalExchangeRate: normCR.historicalExchangeRate,
                rateConvention: normCR.rateConvention,
                narration,
              });
            }
          }
        }

        // Batch insert all voucher entries
        const createdEntries = await tx.insert(voucherEntries).values(voucherEntriesToCreate).returning();

        return { voucher: createdVoucher, entries: createdEntries };
      });

      // Sync employee balances from voucher entries (only for non-optional vouchers)
      if (!result.voucher.optional) {
        await syncEmployeeBalancesFromEntries(
          result.entries.map((e) => ({
            ledgerAccountId: e.ledgerAccountId,
            employeeId: e.employeeId,
            debitAmount: e.debitAmount,
            creditAmount: e.creditAmount,
          })),
          req.session.currentCompanyId!
        );
      }

      // Write to factory daybook if this company has factory settings
      try {
        const cid = req.session.currentCompanyId!;
        const [fSetting] = await db.select().from(fSettings).where(eq(fSettings.companyId, cid));
        if (fSetting) {
          const vType = result.voucher.voucherType;
          const txType = vType === "Payment" ? "PAYMENT" : vType === "Receipt" ? "RECEIPT" : "JOURNAL";
          const daybookCurrency = result.voucher.currency || "USD";
          // vouchers.totalAmount now stores the historical base (USD) amount.
          // transactionTotal (CFA) = baseTotal * cfaPerUsd for non-USD vouchers.
          const daybookBaseTotal = parseFloat(result.voucher.totalAmount || "0");
          const daybookRate = result.voucher.exchangeRate ? parseFloat(result.voucher.exchangeRate) : 1;
          // Reconstruct the original CFA total: base × rate (TRANSACTION_PER_BASE).
          const daybookAmtCurrency =
            daybookCurrency !== "USD" && daybookRate > 0 ? daybookBaseTotal * daybookRate : daybookBaseTotal;
          // factory_daybook_entries.fx_rate_to_usd expects USD-per-foreign-unit.
          // The ERP voucher stores CFA-per-USD (TRANSACTION_PER_BASE), so we invert.
          const daybookFxRateToUsd = erpRateToDaybookFxRateToUsd(daybookCurrency, "USD", result.voucher.exchangeRate);
          await db.insert(fde).values({
            companyId: cid,
            txDate: result.voucher.voucherDate,
            txType,
            referenceId: result.voucher.id,
            referenceTable: "vouchers",
            description: result.voucher.description || `${vType} voucher #${result.voucher.voucherNumber}`,
            currencyCode: daybookCurrency,
            amountCurrency: String(daybookAmtCurrency),
            fxRateToUsd: daybookFxRateToUsd,
            amountUsd: String(daybookBaseTotal),
            createdBy: null,
            effectiveDate: result.voucher.effectiveDate || null,
          });
        }
      } catch (dbErr) {
        logger.error("Factory daybook write failed (non-fatal):", { error: dbErr });
      }

      // WhatsApp rule check — prompt the frontend instead of auto-sending
      let waResult: { prompt: boolean; accountId?: number; voucherDate?: string; month?: string } = { prompt: false };
      try {
        waResult = await checkAccountWhatsAppRule({
          companyId: req.session.currentCompanyId!,
          accountId: paymentAccountId,
          accountType: paymentAccountType,
          voucherType: voucherType as "Payment" | "Receipt",
          voucherDate: voucherDate,
        });
      } catch (waErr: unknown) {
        logger.error("WhatsApp rule check error (non-fatal):", { error: waErr });
      }

      // Log the payment/receipt creation
      try {
        const _prEntriesSnap = await snapshotVoucherEntries(result.entries);
        await logAudit({
          userId: req.session.userId!,
          username: req.session.username || "unknown",
          companyId: req.session.currentCompanyId!,
          action: "create",
          tableName: "vouchers",
          recordId: result.voucher.id,
          recordIdentifier: result.voucher.voucherNumber,
          changes: buildVoucherChangesForCreate(result.voucher, _prEntriesSnap),
        });
      } catch {
        /* non-fatal */
      }

      // Fire-and-forget intercompany notification check (Payment/Receipt only)
      triggerIntercompanyNotifications(
        req.session.currentCompanyId!,
        result.voucher.id,
        result.voucher.voucherNumber,
        result.voucher.voucherDate,
        result.voucher.totalAmount || "0",
        result.voucher.description,
        result.entries.map((e) => e.ledgerAccountId),
        result.voucher.voucherType
      ).catch(() => {});

      // Fire-and-forget: auto-rerun FIFO allocation for any Loans accounts touched
      autoReallocateLoansAccounts(
        req.session.currentCompanyId!,
        result.entries.map((e) => e.ledgerAccountId)
      ).catch(() => {});

      res.json({ ...result, whatsapp: waResult });
    } catch (error: unknown) {
      logger.error("Error creating payment/receipt voucher:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Update Payment or Receipt voucher with all entries in one batch
  app.patch("/api/vouchers/:id/payment-receipt", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const voucherId = parseInt(req.params.id);
      if (isNaN(voucherId)) {
        return res.status(400).json({ message: "Invalid voucher ID" });
      }

      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const {
        voucherType, // "Payment" or "Receipt"
        voucherDate,
        paymentAccountType,
        paymentAccountId,
        paymentAccountName: _paymentAccountName,
        entries,
        notes,
        optional,
        currency,
        exchangeRate,
        effectiveDate,
      } = req.body;

      // Validate required fields
      if (
        !voucherType ||
        !voucherDate ||
        !paymentAccountId ||
        !entries ||
        !Array.isArray(entries) ||
        entries.length === 0
      ) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      if (voucherType !== "Payment" && voucherType !== "Receipt") {
        return res.status(400).json({ message: "voucherType must be 'Payment' or 'Receipt'" });
      }

      // Determine currency/rate for the PATCH (may preserve existing if not re-sent).
      const pCurrency = (currency as string | undefined) || "USD";
      const pRateRaw = (exchangeRate as string | number | undefined) || null;
      const pCfaPerUsd = pCurrency !== "USD" && pRateRaw ? parseFloat(String(pRateRaw)) : 1;
      // Transaction total (voucher currency, e.g. CFA)
      const pTransactionTotal = entries.reduce((sum: number, e) => sum + parseFloat(e.amount || "0"), 0);
      // Base total (historical USD) — stored in vouchers.totalAmount
      const pBaseTotal = pCurrency !== "USD" && pCfaPerUsd > 0 ? pTransactionTotal / pCfaPerUsd : pTransactionTotal;

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

        // Update voucher — store historical base (USD) total
        const [updatedVoucher] = await tx
          .update(vouchers)
          .set({
            voucherType,
            voucherDate,
            description: notes || null,
            totalAmount: pBaseTotal.toFixed(6),
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
          const narration = notes || null;

          // Determine account field for entry account
          const entryAccountField = isVoucherAccountType(entry.accountType)
            ? voucherEntryAccountLink(entry.accountType, entry.accountId)
            : {};

          // Determine account field for payment account
          const paymentAccountField = isVoucherAccountType(paymentAccountType)
            ? voucherEntryAccountLink(paymentAccountType, paymentAccountId)
            : {};

          const isLiabilityPaymentAccount =
            paymentAccountType === "supplier" ||
            paymentAccountType === "factorySupplier" ||
            paymentAccountType === "employee";

          // Normalize once; debit/credit fields determined by voucher type below
          const normDR = normalizeVoucherEntryAmounts({
            transactionCurrency: pCurrency,
            baseCurrency: "USD",
            transactionDebitAmount: amount,
            transactionCreditAmount: "0",
            historicalRate: pRateRaw,
          });
          const normCR = normalizeVoucherEntryAmounts({
            transactionCurrency: pCurrency,
            baseCurrency: "USD",
            transactionDebitAmount: "0",
            transactionCreditAmount: amount,
            historicalRate: pRateRaw,
          });

          const mkDR = (acctField: Record<string, unknown>) => ({
            voucherId: updatedVoucher.id,
            ...acctField,
            debitAmount: normDR.debitAmount,
            creditAmount: normDR.creditAmount,
            transactionCurrency: normDR.transactionCurrency,
            transactionDebitAmount: normDR.transactionDebitAmount,
            transactionCreditAmount: normDR.transactionCreditAmount,
            baseDebitAmount: normDR.baseDebitAmount,
            baseCreditAmount: normDR.baseCreditAmount,
            historicalExchangeRate: normDR.historicalExchangeRate,
            rateConvention: normDR.rateConvention,
            narration,
          });
          const mkCR = (acctField: Record<string, unknown>) => ({
            voucherId: updatedVoucher.id,
            ...acctField,
            debitAmount: normCR.debitAmount,
            creditAmount: normCR.creditAmount,
            transactionCurrency: normCR.transactionCurrency,
            transactionDebitAmount: normCR.transactionDebitAmount,
            transactionCreditAmount: normCR.transactionCreditAmount,
            baseDebitAmount: normCR.baseDebitAmount,
            baseCreditAmount: normCR.baseCreditAmount,
            historicalExchangeRate: normCR.historicalExchangeRate,
            rateConvention: normCR.rateConvention,
            narration,
          });

          if (voucherType === "Payment") {
            if (isLiabilityPaymentAccount) {
              voucherEntriesToCreate.push(mkDR(paymentAccountField));
              voucherEntriesToCreate.push(mkCR(entryAccountField));
            } else {
              voucherEntriesToCreate.push(mkDR(entryAccountField));
              voucherEntriesToCreate.push(mkCR(paymentAccountField));
            }
          } else {
            if (isLiabilityPaymentAccount) {
              voucherEntriesToCreate.push(mkDR(entryAccountField));
              voucherEntriesToCreate.push(mkCR(paymentAccountField));
            } else {
              voucherEntriesToCreate.push(mkDR(paymentAccountField));
              voucherEntriesToCreate.push(mkCR(entryAccountField));
            }
          }
        }

        // Batch insert all new voucher entries
        const createdEntries = await tx.insert(voucherEntries).values(voucherEntriesToCreate).returning();

        return {
          voucher: updatedVoucher,
          entries: createdEntries,
          oldEntries,
          existingVoucher,
          wasOptional: existingVoucher.optional,
        };
      });

      // Sync employee balances: reverse old entries if voucher was non-optional
      if (!result.wasOptional) {
        await syncEmployeeBalancesFromEntries(
          result.oldEntries.map((e) => ({
            ledgerAccountId: e.ledgerAccountId,
            employeeId: e.employeeId,
            debitAmount: e.debitAmount,
            creditAmount: e.creditAmount,
          })),
          req.session.currentCompanyId!,
          true // reverse
        );
      }

      // Apply new entries if voucher is non-optional
      if (!result.voucher.optional) {
        await syncEmployeeBalancesFromEntries(
          result.entries.map((e) => ({
            ledgerAccountId: e.ledgerAccountId,
            employeeId: e.employeeId,
            debitAmount: e.debitAmount,
            creditAmount: e.creditAmount,
          })),
          req.session.currentCompanyId!
        );
      }

      // WhatsApp rule check — prompt the frontend instead of auto-sending
      let waResultPatch: { prompt: boolean; accountId?: number; voucherDate?: string; month?: string } = {
        prompt: false,
      };
      try {
        waResultPatch = await checkAccountWhatsAppRule({
          companyId: req.session.currentCompanyId!,
          accountId: paymentAccountId,
          accountType: paymentAccountType,
          voucherType: voucherType as "Payment" | "Receipt",
          voucherDate: voucherDate,
        });
      } catch (waErr: unknown) {
        logger.error("WhatsApp rule check error (non-fatal):", { error: waErr });
      }

      try {
        const _oldSnap = await snapshotVoucherEntries(result.oldEntries);
        const _newSnap = await snapshotVoucherEntries(result.entries);
        await logAudit({
          userId: req.session.userId!,
          username: req.session.username || "unknown",
          companyId: req.session.currentCompanyId!,
          action: "update",
          tableName: "vouchers",
          recordId: result.voucher.id,
          recordIdentifier: result.voucher.voucherNumber,
          changes: buildVoucherChangesForUpdate(
            {
              voucherType: result.existingVoucher.voucherType,
              voucherDate: result.existingVoucher.voucherDate,
              totalAmount: result.existingVoucher.totalAmount,
              description: result.existingVoucher.description,
              optional: result.existingVoucher.optional,
            },
            {
              voucherType: result.voucher.voucherType,
              voucherDate: result.voucher.voucherDate,
              totalAmount: result.voucher.totalAmount,
              description: result.voucher.description,
              optional: result.voucher.optional,
            },
            _oldSnap,
            _newSnap
          ),
        });
      } catch {
        /* non-fatal */
      }
      res.json({ voucher: result.voucher, entries: result.entries, whatsapp: waResultPatch });
    } catch (error: unknown) {
      logger.error("Error updating payment/receipt voucher:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Create Journal voucher with all entries in one batch
}
