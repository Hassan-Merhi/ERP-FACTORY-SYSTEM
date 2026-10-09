/**
 * server/services/pos/postSaleAccounting.ts
 *
 * PHASE 19 structural split — moved (unchanged) from server/routes/pos/posSalesRoutes.ts:
 *   - Sales revenue account resolution
 *   - Supplier-partner accounting context precompute
 *   - Debit/credit voucher entries (normal ERP and supplier-partner split accounting)
 *
 * Phase 15 update: voucher entries now carry all 7 dual-currency fields via
 * normalizeVoucherEntryAmounts(). The backward-compatible debitAmount / creditAmount
 * columns always store the historical base (USD) value so legacy queries keep working.
 */
import { db } from "../../db";
import type { DbTransaction } from "../../db";
import { logger } from "../../lib/logger";
import { storage } from "../../storage";
import { ledgerAccounts, voucherEntries } from "@shared/schema";

/**
 * The voucher-entry row a POS sale inserts. The account key is filled in after
 * construction (ledger, bank, or customer), so it starts out partial.
 */
type PosVoucherEntryValues = typeof voucherEntries.$inferInsert;
import { eq, and, isNull } from "drizzle-orm";
import type {
  HandlerErrorResult,
  PosLedgerAccount,
  PosLocation,
  SupplierPartnerAccountingContext,
  ValidatedInventoryItem,
} from "./posSaleTypes";
import { findLinkedCustomerId } from "./updateCustomerBalance";
import { normalizeVoucherEntryAmounts } from "../../services/accounting/currencyAmounts";
import { sumMoney } from "../../lib/money";
import { saleTotalCents, spDeductionAmount as spDeductionAmountFor, spPayableAfterDeduction } from "./spDeduction";

/**
 * Get or create SALES revenue account (outside transaction for simplicity).
 * Use getOrCreateLedgerAccount so soft-deleted duplicates don't cause a
 * unique-constraint crash — it handles the 23505 error and falls back to
 * fetching the existing (possibly soft-deleted) row.
 */
export async function getOrCreateSalesRevenueAccount(
  companyId: number
): Promise<{ salesAccount: PosLedgerAccount } | { error: HandlerErrorResult }> {
  const salesAccount = await storage.getOrCreateLedgerAccount({
    companyId,
    code: "SALES",
    name: "Sales Revenue",
    accountType: "Income",
    openingBalance: "0",
    active: true,
  });

  if (salesAccount.accountType !== "Income") {
    // Validate that Sales account is of type Income for proper import cycle balance
    logger.warn(
      `[POS Sale] WARNING: SALES account has type "${salesAccount.accountType}" instead of "Income". This will cause import cycle imbalance!`
    );
    return {
      error: {
        status: 400,
        body: {
          message: `The SALES account is configured with type "${salesAccount.accountType}" but must be type "Income" for POS sales to work correctly. Please update the SALES account type in Accounts page.`,
        },
      },
    };
  }

  return { salesAccount };
}

/** ── SP company: fetch configured POS accounts & pre-compute supplier cost ── */
export async function fetchSupplierPartnerAccountingContext(
  isSpCompany: boolean,
  companyId: number,
  location: PosLocation,
  inventoryValidation: ValidatedInventoryItem[]
): Promise<SupplierPartnerAccountingContext | { error: HandlerErrorResult }> {
  // Per-qty deduction that silently reduces Supplier Cash Payable (not income/expense)
  const spPosDeductionPerQty = isSpCompany
    ? parseFloat(String(location.supplierPartnerPayableDeductionPerQty ?? "0")) || 0
    : 0;
  const spPosTotalQtySold = isSpCompany ? sumMoney(inventoryValidation.map((v) => v.saleQty)).toNumber() : 0;

  if (!isSpCompany) {
    return {
      isSpCompany,
      spPosPayableAccountId: null,
      spPosProfitAccountId: null,
      spPosCostClrAccountId: null,
      spPosDeductionClrAccountId: null,
      totalSupplierCost: 0,
      spPosDeductionPerQty,
      spPosTotalQtySold,
    };
  }

  const spSettings = await storage.getCompanySettings(companyId);
  const spPosPayableAccountId = spSettings?.spPosPayableAccountId ?? null;
  const spPosProfitAccountId = spSettings?.spPosProfitAccountId ?? null;
  if (!spPosPayableAccountId || !spPosProfitAccountId) {
    return {
      error: {
        status: 400,
        body: { message: "Supplier POS payable/profit accounts are not configured. Go to SP Setup to set them up." },
      },
    };
  }

  // Look up Stock Cost Payable Clearing account (sp_cost_clearing subType)
  const [clrAcct] = await db
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.subType, "sp_cost_clearing"),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .limit(1);
  const spPosCostClrAccountId = clrAcct?.id ?? null;

  // Look up Supplier Payable Deduction Clearing account (sp_pay_deduction_clearing subType)
  const [ddcAcct] = await db
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.subType, "sp_pay_deduction_clearing"),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .limit(1);
  const spPosDeductionClrAccountId = ddcAcct?.id ?? null;

  // Pre-compute total supplier cost from inventory averageRate (includes landed/offloading cost)
  const totalSupplierCost = inventoryValidation.reduce((sum, v) => sum + v.saleQty * v.currentRate, 0);

  return {
    isSpCompany,
    spPosPayableAccountId,
    spPosProfitAccountId,
    spPosCostClrAccountId,
    spPosDeductionClrAccountId,
    totalSupplierCost,
    spPosDeductionPerQty,
    spPosTotalQtySold,
  };
}

/**
 * Normalize a single entry amount and return the dual-currency fields ready for insert.
 *
 * Uses the voucher's stored currency and historical exchange rate so that:
 *   - CFA entries store the original CFA amount in transactionDebitAmount / transactionCreditAmount
 *   - The historical USD base is stored in baseDebitAmount / baseCreditAmount
 *   - The backward-compatible debitAmount / creditAmount always equal the base USD amounts
 *
 * Amounts must be >= 0 with exactly one side > 0 (the function enforces this).
 */
function normalizePosEntry(
  debitAmt: number,
  creditAmt: number,
  currency: string,
  exchangeRate: string | null | undefined
): {
  debitAmount: string;
  creditAmount: string;
  transactionCurrency: string;
  transactionDebitAmount: string;
  transactionCreditAmount: string;
  baseDebitAmount: string;
  baseCreditAmount: string;
  historicalExchangeRate: string;
  rateConvention: string;
} {
  try {
    const norm = normalizeVoucherEntryAmounts({
      transactionCurrency: currency || "USD",
      baseCurrency: "USD",
      transactionDebitAmount: String(Math.abs(debitAmt)),
      transactionCreditAmount: String(Math.abs(creditAmt)),
      historicalRate: exchangeRate,
    });
    return {
      debitAmount: norm.debitAmount,
      creditAmount: norm.creditAmount,
      transactionCurrency: norm.transactionCurrency,
      transactionDebitAmount: norm.transactionDebitAmount,
      transactionCreditAmount: norm.transactionCreditAmount,
      baseDebitAmount: norm.baseDebitAmount,
      baseCreditAmount: norm.baseCreditAmount,
      historicalExchangeRate: norm.historicalExchangeRate,
      rateConvention: norm.rateConvention,
    };
  } catch (e) {
    // Fallback for legacy paths: if normalization fails (missing rate etc.) store as-is
    logger.warn("[POS] normalizeVoucherEntryAmounts failed, using legacy storage:", {
      error: (e as { message: unknown })?.message,
    });
    const dStr = Math.abs(debitAmt).toFixed(2);
    const cStr = Math.abs(creditAmt).toFixed(2);
    return {
      debitAmount: dStr,
      creditAmount: cStr,
      transactionCurrency: currency || "USD",
      transactionDebitAmount: dStr,
      transactionCreditAmount: cStr,
      baseDebitAmount: dStr,
      baseCreditAmount: cStr,
      historicalExchangeRate: "1.0000000000",
      rateConvention: "IDENTITY",
    };
  }
}

/** Insert the Dr (payment) + Cr (Sales revenue, or SP-split) voucher entries for a POS sale. */
export async function insertSaleAccountingEntries(
  tx: DbTransaction,
  params: {
    txVoucherId: number;
    voucherNumber: string;
    grandTotal: number;
    isCreditSale: boolean | null | undefined;
    accountType: "cash" | "bank" | "credit";
    accountId: number;
    location: PosLocation;
    customerAccount: PosLedgerAccount | null;
    companyId: number;
    isSpCompany: boolean;
    salesAccount: PosLedgerAccount;
    spCtx: SupplierPartnerAccountingContext;
    /** Voucher transaction currency (e.g. "CFA", "USD"). Defaults to "USD". */
    currency?: string | null;
    /** Historical exchange rate at time of sale (CFA per USD for TRANSACTION_PER_BASE). */
    exchangeRate?: string | null;
  }
): Promise<void> {
  const {
    txVoucherId,
    voucherNumber,
    grandTotal,
    isCreditSale,
    accountType,
    accountId,
    location,
    customerAccount,
    companyId,
    isSpCompany,
    salesAccount,
    spCtx,
    currency,
    exchangeRate,
  } = params;

  /**
   * The frontend always converts item rates to USD before sending them, so
   * `grandTotal` (= sum of qty × rate) is always in USD — even when the
   * voucher currency is "CFA".  `normalizeVoucherEntryAmounts` divides the
   * transaction amount by the exchange rate to produce the USD base amount,
   * so if we pass the already-USD grandTotal it gets divided again, yielding
   * a fraction of the correct value (e.g. $430.75 / 49.34 ≈ $8.73).
   *
   * Fix: multiply grandTotal back into the transaction currency before handing
   * it to normalizePosEntry.  The normalization then divides by the same rate
   * and recovers the correct USD base.  For USD sales the factor is 1 (no-op).
   */
  const txRate = exchangeRate ? parseFloat(exchangeRate) : 1;
  const needsTxConversion = !!(currency && currency !== "USD" && exchangeRate && txRate > 0);
  /** Convert a USD amount → transaction-currency amount for normalizePosEntry. */
  function toTxAmt(usdAmt: number): number {
    return needsTxConversion ? usdAmt * txRate : usdAmt;
  }

  const creditSaleNarration = isCreditSale
    ? `Credit Invoice Sale at ${location.name} - ${customerAccount?.name ?? ""}`
    : `POS Sale - ${voucherNumber}`;

  // Debit entry (cash / bank / receivable account)
  const normDR = normalizePosEntry(toTxAmt(Math.abs(grandTotal)), 0, currency || "USD", exchangeRate);
  const debitEntry: PosVoucherEntryValues = {
    voucherId: txVoucherId,
    debitAmount: grandTotal >= 0 ? normDR.debitAmount : "0",
    creditAmount: grandTotal < 0 ? normDR.debitAmount : "0", // reversals have opposite sign
    transactionCurrency: normDR.transactionCurrency,
    transactionDebitAmount: grandTotal >= 0 ? normDR.transactionDebitAmount : "0",
    transactionCreditAmount: grandTotal < 0 ? normDR.transactionDebitAmount : "0",
    baseDebitAmount: grandTotal >= 0 ? normDR.baseDebitAmount : "0",
    baseCreditAmount: grandTotal < 0 ? normDR.baseDebitAmount : "0",
    historicalExchangeRate: normDR.historicalExchangeRate,
    rateConvention: normDR.rateConvention,
    narration: creditSaleNarration,
  };

  if (isCreditSale || accountType === "cash" || accountType === "credit") {
    debitEntry.ledgerAccountId = accountId;
    if (isCreditSale && accountType === "credit") {
      const linkedCustId = await findLinkedCustomerId(tx, companyId, accountId);
      if (linkedCustId !== undefined) {
        debitEntry.customerId = linkedCustId;
      }
    }
    logger.info("[POS Sale] Using ledgerAccountId for cash/credit:", { accountId: accountId });
  } else {
    debitEntry.bankAccountId = accountId;
    logger.info("[POS Sale] Using bankAccountId for bank:", { accountId: accountId });
  }

  logger.info("[POS Sale] Debit entry:", { entry: debitEntry });
  await tx.insert(voucherEntries).values(debitEntry);

  if (!isSpCompany) {
    // Normal ERP: credit the full sale amount to the Sales Revenue account
    const normCR = normalizePosEntry(0, toTxAmt(Math.abs(grandTotal)), currency || "USD", exchangeRate);
    await tx.insert(voucherEntries).values({
      voucherId: txVoucherId,
      ledgerAccountId: salesAccount.id,
      debitAmount: grandTotal < 0 ? normCR.creditAmount : "0",
      creditAmount: grandTotal >= 0 ? normCR.creditAmount : "0",
      transactionCurrency: normCR.transactionCurrency,
      transactionDebitAmount: grandTotal < 0 ? normCR.transactionCreditAmount : "0",
      transactionCreditAmount: grandTotal >= 0 ? normCR.transactionCreditAmount : "0",
      baseDebitAmount: grandTotal < 0 ? normCR.baseCreditAmount : "0",
      baseCreditAmount: grandTotal >= 0 ? normCR.baseCreditAmount : "0",
      historicalExchangeRate: normCR.historicalExchangeRate,
      rateConvention: normCR.rateConvention,
      narration: creditSaleNarration,
    });
    return;
  }

  // Supplier Partner accounting:
  //   Dr Cash                           = grandTotal  (debit entry already written above)
  //   Cr Supplier Cash Payable          = grandTotal − deductionAmount
  //   Cr Deduction Clearing (hidden)    = deductionAmount          (if deduction > 0)
  const grandTotalRounded = saleTotalCents(grandTotal);
  const spDeductionAmount = spDeductionAmountFor(spCtx.spPosTotalQtySold, spCtx.spPosDeductionPerQty);
  if (spDeductionAmount > Math.abs(grandTotalRounded)) {
    throw new Error(
      `Supplier payable deduction (${spDeductionAmount}) exceeds the sale total (${grandTotalRounded}). ` +
        `Adjust the deduction per qty setting on this location.`
    );
  }
  const spPayableAmount = spPayableAfterDeduction(grandTotalRounded, spDeductionAmount);

  if (grandTotalRounded > 0) {
    if (spPayableAmount > 0) {
      const normSP = normalizePosEntry(0, toTxAmt(spPayableAmount), currency || "USD", exchangeRate);
      await tx.insert(voucherEntries).values({
        voucherId: txVoucherId,
        ledgerAccountId: spCtx.spPosPayableAccountId!,
        debitAmount: "0",
        creditAmount: normSP.creditAmount,
        transactionCurrency: normSP.transactionCurrency,
        transactionDebitAmount: "0",
        transactionCreditAmount: normSP.transactionCreditAmount,
        baseDebitAmount: "0",
        baseCreditAmount: normSP.baseCreditAmount,
        historicalExchangeRate: normSP.historicalExchangeRate,
        rateConvention: normSP.rateConvention,
        narration: `Supplier Cash Payable — ${voucherNumber}`,
      });
    }
    if (spDeductionAmount > 0 && spCtx.spPosDeductionClrAccountId) {
      const normDD = normalizePosEntry(0, toTxAmt(spDeductionAmount), currency || "USD", exchangeRate);
      await tx.insert(voucherEntries).values({
        voucherId: txVoucherId,
        ledgerAccountId: spCtx.spPosDeductionClrAccountId,
        debitAmount: "0",
        creditAmount: normDD.creditAmount,
        transactionCurrency: normDD.transactionCurrency,
        transactionDebitAmount: "0",
        transactionCreditAmount: normDD.transactionCreditAmount,
        baseDebitAmount: "0",
        baseCreditAmount: normDD.baseCreditAmount,
        historicalExchangeRate: normDD.historicalExchangeRate,
        rateConvention: normDD.rateConvention,
        narration: `Supplier Payable Deduction (${spCtx.spPosTotalQtySold} qty × ${spCtx.spPosDeductionPerQty}) — ${voucherNumber}`,
      });
    }
  } else if (grandTotalRounded < 0) {
    // Reversal: Dr Supplier Cash Payable
    if (spPayableAmount < 0) {
      const normSPR = normalizePosEntry(toTxAmt(Math.abs(spPayableAmount)), 0, currency || "USD", exchangeRate);
      await tx.insert(voucherEntries).values({
        voucherId: txVoucherId,
        ledgerAccountId: spCtx.spPosPayableAccountId!,
        debitAmount: normSPR.debitAmount,
        creditAmount: "0",
        transactionCurrency: normSPR.transactionCurrency,
        transactionDebitAmount: normSPR.transactionDebitAmount,
        transactionCreditAmount: "0",
        baseDebitAmount: normSPR.baseDebitAmount,
        baseCreditAmount: "0",
        historicalExchangeRate: normSPR.historicalExchangeRate,
        rateConvention: normSPR.rateConvention,
        narration: `Supplier Cash Payable reversal — ${voucherNumber}`,
      });
    }
    if (spDeductionAmount > 0 && spCtx.spPosDeductionClrAccountId) {
      const normDDR = normalizePosEntry(toTxAmt(spDeductionAmount), 0, currency || "USD", exchangeRate);
      await tx.insert(voucherEntries).values({
        voucherId: txVoucherId,
        ledgerAccountId: spCtx.spPosDeductionClrAccountId,
        debitAmount: normDDR.debitAmount,
        creditAmount: "0",
        transactionCurrency: normDDR.transactionCurrency,
        transactionDebitAmount: normDDR.transactionDebitAmount,
        transactionCreditAmount: "0",
        baseDebitAmount: normDDR.baseDebitAmount,
        baseCreditAmount: "0",
        historicalExchangeRate: normDDR.historicalExchangeRate,
        rateConvention: normDDR.rateConvention,
        narration: `Supplier Payable Deduction reversal — ${voucherNumber}`,
      });
    }
  }
}
