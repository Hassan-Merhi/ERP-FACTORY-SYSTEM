// Extracted from ./creditNoteRoutes.ts to keep that module under the source-size cap.
import type Decimal from "decimal.js";
import { inventoryMoney, toInventoryDecimal } from "../lib/inventoryMath";
import { type DatabaseOrTransaction, db } from "../db";
import { normalizeVoucherEntryAmounts } from "../services/accounting/currencyAmounts";
import type { LockedPosCurrency } from "../services/pos/posZmwRatePolicy";
import { ledgerAccounts } from "@shared/schema";
import { and, eq, ilike, or } from "drizzle-orm";
import { createDatabaseStockMovementAdapter } from "../services/inventory/databaseStockMovementAdapter";

export type CreditNoteItemInput = {
  stockItemId?: unknown;
  quantity?: unknown;
  rate?: unknown;
  refundRate?: unknown;
};

export async function getOrCreateSalesReturnsAccount(
  companyId: number,
  txOrDb: DatabaseOrTransaction = db
): Promise<number | null> {
  const byName = await txOrDb
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        or(ilike(ledgerAccounts.name, "%sales return%"), ilike(ledgerAccounts.name, "%return%allowance%"))
      )
    )
    .limit(1);
  if (byName.length > 0) return byName[0].id;

  const byCode = await txOrDb
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.code, "SALES-RETURNS")))
    .limit(1);
  if (byCode.length > 0) return byCode[0].id;

  const [created] = await txOrDb
    .insert(ledgerAccounts)
    .values({
      companyId,
      code: "SALES-RETURNS",
      name: "Sales Returns & Allowances",
      accountType: "Income",
      active: true,
      isHidden: false,
    })
    .returning({ id: ledgerAccounts.id });
  return created?.id ?? null;
}

export function normEntryAmounts(
  debit: Decimal.Value,
  credit: Decimal.Value,
  nativeRefund?: LockedPosCurrency
): Record<string, string> {
  const dStr = toInventoryDecimal(debit).toFixed(6);
  const cStr = toInventoryDecimal(credit).toFixed(6);
  const foreign = nativeRefund?.currency === "ZMW";
  const rate = foreign ? nativeRefund!.exchangeRate! : "1";
  try {
    const norm = normalizeVoucherEntryAmounts({
      transactionCurrency: foreign ? "ZMW" : "USD",
      baseCurrency: "USD",
      transactionDebitAmount: foreign ? toInventoryDecimal(dStr).mul(rate).toFixed(6) : dStr,
      transactionCreditAmount: foreign ? toInventoryDecimal(cStr).mul(rate).toFixed(6) : cStr,
      historicalRate: rate,
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
  } catch (error) {
    // Existing USD legacy fallback stays unchanged. A ZMW refund must NEVER
    // silently lose its original currency or lock rate on a failed conversion.
    if (foreign) throw error;
    return { debitAmount: inventoryMoney(debit), creditAmount: inventoryMoney(credit) };
  }
}

export const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();
