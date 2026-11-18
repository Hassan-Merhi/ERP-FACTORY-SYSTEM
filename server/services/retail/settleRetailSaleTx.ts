// Extracted from ./retailFinancialService.ts to keep that module under the source-size cap.
import type Decimal from "decimal.js";
import { and, eq } from "drizzle-orm";
import { retailInventoryOpenings, retailPosPayments, retailPosSales } from "@shared/schema";
import type { DbTransaction } from "../../db";
import { MoneyDecimal } from "../../lib/money";
import { postBalancedVoucherTx } from "../accounting/centralPostingEngine";
import { companyBusinessDate } from "../accounting/companyBusinessDate";
import { resolveRetailPaymentAccountTx } from "./retailPaymentAccounts";
import { ensureRetailAccountingSettingsTx } from "./retailAccountingSettingsService";
import {
  accountingMoney,
  allocatePaymentLines,
  companyCurrency,
  deriveRetailIdempotencyKey,
  exactMoney,
  includedTax,
  money,
  normalizePayments,
  paymentTarget,
  postingDependencies,
  resolvedPayment,
  validateRetailShiftTx,
  type RetailPaymentInput,
  type RetailResolvedPayment,
} from "./validateRetailShiftTx";

export async function settleRetailSaleTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    locationId: number;
    saleId: number;
    saleIdempotencyKey: string;
    totalAmount: Decimal.Value;
    /** Tax included in totalAmount; credited to tax payable instead of revenue. */
    taxAmount?: Decimal.Value;
    totalCost: Decimal.Value;
    userId: string;
    username?: string | null;
    shiftId?: number | null;
    customerId?: number | null;
    payments?: RetailPaymentInput[];
  }
): Promise<{ payments: RetailResolvedPayment[]; voucherId: number | null }> {
  const shift = await validateRetailShiftTx(tx, input);
  const settings = await ensureRetailAccountingSettingsTx(tx, input.companyId, input.locationId);
  const saleTotal = exactMoney(input.totalAmount, "Retail sale total");
  const totalCost = exactMoney(input.totalCost, "Retail sale cost");
  const requested = normalizePayments(saleTotal, input.payments);
  if (requested.some((payment) => payment.method === "credit") && !input.customerId) {
    throw new Error("A selected customer is required for Retail credit sales");
  }
  const resolved: RetailResolvedPayment[] = [];

  for (const [index, payment] of requested.entries()) {
    const explicitAccount = payment.ledgerAccountId != null || payment.bankAccountId != null;
    if (payment.method === "credit" && explicitAccount) {
      throw new Error("Customer credit must post to the selected customer's ledger");
    }
    const explicitTarget = explicitAccount ? await resolveRetailPaymentAccountTx(tx, input.companyId, payment) : null;
    if (explicitTarget && payment.method !== explicitTarget.method) {
      throw new Error("Selected Retail account does not match the payment type");
    }
    const target = explicitTarget ?? paymentTarget(settings, payment.method, shift?.cashAccountId ?? null);
    const amount = payment.amount;
    const tendered = payment.tenderedAmount;
    const change =
      payment.method === "cash" && tendered ? MoneyDecimal.max(0, tendered.minus(amount)) : new MoneyDecimal(0);
    const key = deriveRetailIdempotencyKey(input.saleIdempotencyKey, `payment:${index}`);
    const [inserted] = await tx
      .insert(retailPosPayments)
      .values({
        companyId: input.companyId,
        saleId: input.saleId,
        locationId: input.locationId,
        shiftId: shift?.id ?? null,
        paymentType: "payment",
        method: payment.method,
        amount: money(amount),
        tenderedAmount: tendered ? money(tendered) : null,
        changeAmount: money(change),
        reference: payment.reference?.trim() || null,
        ledgerAccountId: target.ledgerAccountId,
        bankAccountId: target.bankAccountId,
        idempotencyKey: key,
        createdBy: input.userId,
      })
      .onConflictDoNothing()
      .returning();
    const row =
      inserted ??
      (
        await tx
          .select()
          .from(retailPosPayments)
          .where(and(eq(retailPosPayments.companyId, input.companyId), eq(retailPosPayments.idempotencyKey, key)))
          .limit(1)
      )[0];
    if (!row) throw new Error("Retail payment could not be persisted");
    resolved.push(resolvedPayment(row));
  }

  // Retail stock is tracked independently of its ledger valuation until the
  // owner deliberately applies a perpetual-inventory opening. Otherwise a
  // sale creates a negative "Retail Inventory Asset" with no opening/receipt
  // debit (and the customer's money is mistakenly perceived to be there).
  // Keep the item's cost snapshot for reports and future supplier settlement.
  const [inventoryOpening] = await tx
    .select({ companyId: retailInventoryOpenings.companyId })
    .from(retailInventoryOpenings)
    .where(eq(retailInventoryOpenings.companyId, input.companyId))
    .limit(1);
  if (saleTotal.isZero() && (!inventoryOpening || totalCost.isZero())) {
    return { payments: resolved, voucherId: null };
  }

  const saleAccountingAmount = accountingMoney(saleTotal);
  const costAccountingAmount = accountingMoney(inventoryOpening ? totalCost : 0);
  const taxAccountingAmount = includedTax(saleAccountingAmount, input.taxAmount, "Retail sale tax");
  const revenueAccountingAmount = saleAccountingAmount.minus(taxAccountingAmount);
  const entries = [
    ...allocatePaymentLines(resolved, saleAccountingAmount).map(({ payment, amount }) => ({
      ...(payment.method === "credit"
        ? { customerId: input.customerId! }
        : payment.bankAccountId
          ? { bankAccountId: payment.bankAccountId }
          : { ledgerAccountId: payment.ledgerAccountId }),
      debitAmount: amount.toFixed(2),
      creditAmount: "0",
      narration: `Retail sale #${input.saleId} · ${payment.method === "credit" ? "customer receivable" : payment.method}`,
    })),
    ...(revenueAccountingAmount.isZero()
      ? []
      : [
          {
            ledgerAccountId: settings.salesRevenueLedgerAccountId,
            debitAmount: "0",
            creditAmount: revenueAccountingAmount.toFixed(2),
            narration: `Retail sale #${input.saleId} · revenue`,
          },
        ]),
    ...(taxAccountingAmount.isZero()
      ? []
      : [
          {
            ledgerAccountId: settings.taxPayableLedgerAccountId,
            debitAmount: "0",
            creditAmount: taxAccountingAmount.toFixed(2),
            narration: `Retail sale #${input.saleId} · tax`,
          },
        ]),
    ...(costAccountingAmount.isZero()
      ? []
      : [
          {
            ledgerAccountId: settings.cogsLedgerAccountId,
            debitAmount: costAccountingAmount.toFixed(2),
            creditAmount: "0",
            narration: `Retail sale #${input.saleId} · COGS`,
          },
          {
            ledgerAccountId: settings.inventoryAssetLedgerAccountId,
            debitAmount: "0",
            creditAmount: costAccountingAmount.toFixed(2),
            narration: `Retail sale #${input.saleId} · inventory`,
          },
        ]),
  ];
  const debitTotal = saleAccountingAmount.plus(costAccountingAmount);
  const currency = await companyCurrency(tx, input.companyId);
  const sourceKey = `retail-pos-sale:${input.saleId}`;
  const posted = await postBalancedVoucherTx(
    tx,
    {
      voucher: {
        companyId: input.companyId,
        voucherNumber: `RETAIL-SALE-${input.saleId}`,
        voucherType: "Journal",
        // The company's business date (its timezone), not the UTC date.
        voucherDate: await companyBusinessDate(input.companyId, tx),
        totalAmount: debitTotal.toFixed(2),
        description: `Retail POS sale #${input.saleId}`,
        locationId: input.locationId,
        currency,
        sourceModule: "Retail",
      },
      entries,
      source: {
        sourceType: "retail-pos-sale",
        sourceId: String(input.saleId),
        idempotencyKey: sourceKey,
      },
      actor: { userId: input.userId, username: input.username ?? null, reason: "Retail POS sale settlement" },
    },
    postingDependencies
  );
  await tx
    .update(retailPosSales)
    .set({ accountingVoucherId: posted.voucher.id, shiftId: shift?.id ?? input.shiftId ?? null, updatedAt: new Date() })
    .where(and(eq(retailPosSales.id, input.saleId), eq(retailPosSales.companyId, input.companyId)));
  return { payments: resolved, voucherId: posted.voucher.id };
}
