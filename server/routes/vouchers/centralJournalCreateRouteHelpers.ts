// Extracted from ./centralJournalCreateRoute.ts
import { and, eq, isNull } from "drizzle-orm";
import {
  customerBalances,
  customerOrderCharges,
  customerOrders,
  factoryDaybookEntries,
  factorySettings,
} from "@shared/schema";
import { db } from "../../db";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { PostingValidationError, type CentralPostingResult } from "../../services/accounting/centralPostingEngine";
import { erpRateToDaybookFxRateToUsd } from "../../services/accounting/currencyAmounts";
import { recalculateOrderTotals } from "../factory/_helpers";
import type { PostedVoucher, PostedVoucherEntry } from "../../services/accounting/accountingTypes";

export const GC_OWNER_WITHDRAWAL_TEMPLATE_CONFIRM = "GC_OWNER_WITHDRAWAL_TEMPLATE_CONFIRM";

export const GC_OWNER_WITHDRAWAL_TEMPLATE_MESSAGE =
  "This journal is a Golden Coast owner withdrawal. Press OK to post the owner-withdrawal template (Dr owner equity, Dr GC Sales Cash, Cr GC Owner Withdrawal Clearing at twice the amount), or Cancel to post it exactly as entered.";

/** What postBalancedVoucherTx returns: the persisted voucher and its entry rows. */
type PersistedPostingResult = CentralPostingResult<PostedVoucher, PostedVoucherEntry>;

export async function syncJournalToOrderCharge(
  companyId: number,
  savedEntries: Array<{
    customerId: number | null;
    ledgerAccountId: number | null;
    debitAmount: string | null;
    creditAmount: string | null;
  }>,
  voucherId: number
): Promise<void> {
  const customerEntry = savedEntries.find((entry) => entry.customerId !== null);
  if (!customerEntry) return;

  const ledgerCreditEntries = savedEntries.filter(
    (entry) => entry.ledgerAccountId !== null && entry.customerId === null && toMoney(entry.creditAmount).greaterThan(0)
  );

  for (const ledgerEntry of ledgerCreditEntries) {
    const newAmount = toMoney(ledgerEntry.creditAmount);
    if (newAmount.lessThanOrEqualTo(0)) continue;

    let matchingCharges: Array<{
      id: number;
      orderId: number;
      amount: string;
      chargeType: string;
    }> = await db
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

      if (byLedger.length === 1) matchingCharges = byLedger;
    }

    if (matchingCharges.length === 0) continue;
    const charge = matchingCharges[0];
    const amountChanged = toMoney(charge.amount).minus(newAmount).abs().greaterThanOrEqualTo(0.01);

    await db.transaction(async (tx) => {
      await tx
        .update(customerOrderCharges)
        .set({ amount: newAmount.toFixed(2), voucherId })
        .where(eq(customerOrderCharges.id, charge.id));

      if (!amountChanged) return;
      await recalculateOrderTotals(tx, charge.orderId);

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

export async function writeFactoryDaybook(result: PersistedPostingResult, companyId: number): Promise<void> {
  const [settings] = await db
    .select({ companyId: factorySettings.companyId })
    .from(factorySettings)
    .where(eq(factorySettings.companyId, companyId))
    .limit(1);
  if (!settings) return;

  const currency = result.voucher.currency || "USD";
  // Taken exactly: the float product of 1.13 x 1.5 was 1.6949999999999998,
  // which the cents column stored as 1.69 instead of 1.70.
  const baseTotal = toMoney(result.voucher.totalAmount);
  const rate = result.voucher.exchangeRate ? toMoney(result.voucher.exchangeRate) : new MoneyDecimal(1);
  const transactionTotal = currency !== "USD" && rate.greaterThan(0) ? baseTotal.times(rate) : baseTotal;

  await db.insert(factoryDaybookEntries).values({
    companyId,
    txDate: result.voucher.voucherDate,
    txType: "JOURNAL",
    referenceId: result.voucher.id,
    referenceTable: "vouchers",
    description: result.voucher.description || `Journal voucher #${result.voucher.voucherNumber}`,
    currencyCode: currency,
    amountCurrency: transactionTotal.toFixed(),
    fxRateToUsd: erpRateToDaybookFxRateToUsd(currency, "USD", result.voucher.exchangeRate),
    amountUsd: baseTotal.toFixed(),
    createdBy: null,
  });
}

export function postingStatus(error: PostingValidationError): number {
  return error.code === "POSTING_IDEMPOTENCY_CORRUPT" ? 409 : 400;
}
