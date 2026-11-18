import type Decimal from "decimal.js";
import { and, eq } from "drizzle-orm";
import { retailPosSales, voucherEntries } from "@shared/schema";
import type { DbTransaction } from "../../db";
import { toMoney } from "../../lib/money";
import { postBalancedVoucherTx } from "../accounting/centralPostingEngine";
import { companyBusinessDate } from "../accounting/companyBusinessDate";

import { ensureRetailAccountingSettingsTx } from "./retailAccountingSettingsService";
import {
  accountingMoney,
  allocatePaymentLines,
  companyCurrency,
  exactMoney,
  includedTax,
  postingDependencies,
  type RetailResolvedPayment,
} from "./validateRetailShiftTx";
export { deriveRetailIdempotencyKey, validateRetailShiftTx } from "./validateRetailShiftTx";
export type { RetailPaymentInput, RetailResolvedPayment } from "./validateRetailShiftTx";
export { settleRetailSaleTx } from "./settleRetailSaleTx";
export { refundRetailPaymentsTx } from "./refundRetailPaymentsTx";

// The Retail accounting settings (defaults, conflicts, save) live in
// retailAccountingSettingsService.ts; re-exported for existing importers.
export {
  ensureRetailAccountingSettingsTx,
  getRetailAccountingSettings,
  RetailAccountConflictError,
  saveRetailAccountingSettings,
  type RetailAccountConflict,
  type RetailAccountingSettingsPatch,
  type RetailAccountingSettingsResolved,
} from "./retailAccountingSettingsService";

/**
 * Find the *original* sale's posted inventory/COGS pair. Returns must reverse
 * what that sale actually journalled, not assume every historic sale did so.
 * Keep the original account IDs even if default settings changed later.
 */
async function originalSaleCostAccountsTx(tx: DbTransaction, voucherId: number, saleId: number) {
  const lines = await tx
    .select({
      ledgerAccountId: voucherEntries.ledgerAccountId,
      narration: voucherEntries.narration,
      debitAmount: voucherEntries.debitAmount,
      creditAmount: voucherEntries.creditAmount,
    })
    .from(voucherEntries)
    .where(eq(voucherEntries.voucherId, voucherId));
  const inventory = lines.find(
    (line) =>
      line.narration === `Retail sale #${saleId} · inventory` &&
      line.ledgerAccountId != null &&
      toMoney(line.creditAmount).isPositive()
  );
  const cogs = lines.find(
    (line) =>
      line.narration === `Retail sale #${saleId} · COGS` &&
      line.ledgerAccountId != null &&
      toMoney(line.debitAmount).isPositive()
  );
  if (!inventory?.ledgerAccountId || !cogs?.ledgerAccountId) return null;
  return { inventoryLedgerAccountId: inventory.ledgerAccountId, cogsLedgerAccountId: cogs.ledgerAccountId };
}

export async function postRetailRefundAccountingTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    locationId: number;
    saleId: number;
    sourceType: "retail-pos-return" | "retail-pos-cancel";
    sourceId: string;
    idempotencyKey: string;
    refundAmount: Decimal.Value;
    /** Tax included in refundAmount; debited to tax payable instead of revenue. */
    refundTaxAmount?: Decimal.Value;
    restoredCost: Decimal.Value;
    refunds: RetailResolvedPayment[];
    userId: string;
    username?: string | null;
  }
): Promise<{ voucherId: number | null; costReversed: boolean }> {
  const [originalSale] = await tx
    .select({
      accountingVoucherId: retailPosSales.accountingVoucherId,
      customerId: retailPosSales.customerId,
    })
    .from(retailPosSales)
    .where(and(eq(retailPosSales.companyId, input.companyId), eq(retailPosSales.id, input.saleId)))
    .limit(1);
  // Do not invent a reversal for pre-Wave-1 sales that never had an accounting
  // posting. Their synthetic legacy payment exists only to make the operational
  // refund safe; reconciliation continues to flag the missing historical journal.
  if (!originalSale?.accountingVoucherId) return { voucherId: null, costReversed: false };
  if (
    input.refunds.some((payment) => payment.method === "credit" || payment.method === "store_credit") &&
    !originalSale.customerId
  ) {
    throw new Error("Cannot reverse a credit sale without its original customer");
  }

  const refundTotal = exactMoney(input.refundAmount, "Retail refund amount");
  const restoredCost = exactMoney(input.restoredCost, "Retail restored cost");
  const originalCostAccounts = await originalSaleCostAccountsTx(tx, originalSale.accountingVoucherId, input.saleId);
  if (refundTotal.isZero() && (!originalCostAccounts || restoredCost.isZero())) {
    return { voucherId: null, costReversed: false };
  }
  const settings = await ensureRetailAccountingSettingsTx(tx, input.companyId, input.locationId);
  const refundAccountingAmount = accountingMoney(refundTotal);
  const restoredCostAccountingAmount = accountingMoney(originalCostAccounts ? restoredCost : 0);
  const refundTaxAccountingAmount = includedTax(refundAccountingAmount, input.refundTaxAmount, "Retail refund tax");
  const refundRevenueAccountingAmount = refundAccountingAmount.minus(refundTaxAccountingAmount);
  const entries = [
    ...(refundAccountingAmount.isZero()
      ? []
      : [
          ...(refundRevenueAccountingAmount.isZero()
            ? []
            : [
                {
                  ledgerAccountId: settings.salesRevenueLedgerAccountId,
                  debitAmount: refundRevenueAccountingAmount.toFixed(2),
                  creditAmount: "0",
                  narration: `Retail sale #${input.saleId} · refund revenue reversal`,
                },
              ]),
          ...(refundTaxAccountingAmount.isZero()
            ? []
            : [
                {
                  ledgerAccountId: settings.taxPayableLedgerAccountId,
                  debitAmount: refundTaxAccountingAmount.toFixed(2),
                  creditAmount: "0",
                  narration: `Retail sale #${input.saleId} · refund tax reversal`,
                },
              ]),
          ...allocatePaymentLines(input.refunds, refundAccountingAmount).map(({ payment, amount }) => ({
            ...(payment.method === "credit" || payment.method === "store_credit"
              ? { customerId: originalSale.customerId! }
              : payment.bankAccountId
                ? { bankAccountId: payment.bankAccountId }
                : { ledgerAccountId: payment.ledgerAccountId }),
            debitAmount: "0",
            creditAmount: amount.toFixed(2),
            narration: `Retail sale #${input.saleId} · ${payment.method === "credit" ? "receivable reversal" : payment.method === "store_credit" ? "customer account credit" : payment.method + " refund"}`,
          })),
        ]),
    ...(restoredCostAccountingAmount.isZero()
      ? []
      : [
          {
            ledgerAccountId: originalCostAccounts!.inventoryLedgerAccountId,
            debitAmount: restoredCostAccountingAmount.toFixed(2),
            creditAmount: "0",
            narration: `Retail sale #${input.saleId} · inventory restored`,
          },
          {
            ledgerAccountId: originalCostAccounts!.cogsLedgerAccountId,
            debitAmount: "0",
            creditAmount: restoredCostAccountingAmount.toFixed(2),
            narration: `Retail sale #${input.saleId} · COGS reversed`,
          },
        ]),
  ];
  const total = refundAccountingAmount.plus(restoredCostAccountingAmount);
  const currency = await companyCurrency(tx, input.companyId);
  const posted = await postBalancedVoucherTx(
    tx,
    {
      voucher: {
        companyId: input.companyId,
        voucherNumber: `RETAIL-${input.sourceType === "retail-pos-cancel" ? "CANCEL" : "RETURN"}-${input.sourceId}`,
        voucherType: "Journal",
        voucherDate: await companyBusinessDate(input.companyId, tx),
        totalAmount: total.toFixed(2),
        description:
          input.sourceType === "retail-pos-cancel"
            ? `Retail cancellation for sale #${input.saleId}`
            : `Retail return for sale #${input.saleId}`,
        locationId: input.locationId,
        currency,
        sourceModule: "Retail",
      },
      entries,
      source: {
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        idempotencyKey: input.idempotencyKey,
      },
      actor: { userId: input.userId, username: input.username ?? null, reason: "Retail POS refund/reversal" },
    },
    postingDependencies
  );
  return { voucherId: posted.voucher.id, costReversed: !restoredCostAccountingAmount.isZero() };
}
