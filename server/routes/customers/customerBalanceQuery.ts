import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { voucherEntries, vouchers } from "@shared/schema";

import { db } from "../../db";
import { storage } from "../../storage";

function addNetBalance(balances: Map<number, number>, key: number, entry: ({ ledgerAccountId: number | null; debitAmount: string | null; creditAmount: string | null; transactionCurrency: string | null; transactionDebitAmount: string | null; transactionCreditAmount: string | null; baseDebitAmount: string | null; baseCreditAmount: string | null; }) | ({ customerId: number | null; debitAmount: string | null; creditAmount: string | null; transactionCurrency: string | null; transactionDebitAmount: string | null; transactionCreditAmount: string | null; baseDebitAmount: string | null; baseCreditAmount: string | null; })): void {
  const debit = Number.parseFloat(entry.debitAmount || "0");
  const credit = Number.parseFloat(entry.creditAmount || "0");
  const current = balances.get(key) ?? 0;
  if (debit > 0 && credit === 0) balances.set(key, current + debit);
  else if (credit > 0 && debit === 0) balances.set(key, current - credit);
}

function addHistoricalBaseBalance(balances: Map<number, number>, key: number, entry: ({ ledgerAccountId: number | null; debitAmount: string | null; creditAmount: string | null; transactionCurrency: string | null; transactionDebitAmount: string | null; transactionCreditAmount: string | null; baseDebitAmount: string | null; baseCreditAmount: string | null; }) | ({ customerId: number | null; debitAmount: string | null; creditAmount: string | null; transactionCurrency: string | null; transactionDebitAmount: string | null; transactionCreditAmount: string | null; baseDebitAmount: string | null; baseCreditAmount: string | null; })): void {
  const debit = Number.parseFloat(entry.baseDebitAmount ?? entry.debitAmount ?? "0");
  const credit = Number.parseFloat(entry.baseCreditAmount ?? entry.creditAmount ?? "0");
  const current = balances.get(key) ?? 0;
  if (debit > 0 && credit === 0) balances.set(key, current + debit);
  else if (credit > 0 && debit === 0) balances.set(key, current - credit);
}

export async function getCustomersWithBalances(companyId: number) {
  const customers = await storage.getAllCustomers(companyId);
  if (customers.length === 0) return [];

  const ledgerAccountIds = customers
    .filter((customer) => customer.ledgerAccountId)
    .map((customer) => customer.ledgerAccountId as number);
  const customerOnlyIds = customers.filter((customer) => !customer.ledgerAccountId).map((customer) => customer.id);

  const [ledgerEntries, customerEntries] = await Promise.all([
    ledgerAccountIds.length > 0
      ? db
          .select({
            ledgerAccountId: voucherEntries.ledgerAccountId,
            debitAmount: voucherEntries.debitAmount,
            creditAmount: voucherEntries.creditAmount,
            transactionCurrency: voucherEntries.transactionCurrency,
            transactionDebitAmount: voucherEntries.transactionDebitAmount,
            transactionCreditAmount: voucherEntries.transactionCreditAmount,
            baseDebitAmount: voucherEntries.baseDebitAmount,
            baseCreditAmount: voucherEntries.baseCreditAmount,
          })
          .from(voucherEntries)
          .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
          .where(
            and(
              eq(vouchers.companyId, companyId),
              isNull(vouchers.deletedAt),
              isNotNull(voucherEntries.ledgerAccountId),
              inArray(voucherEntries.ledgerAccountId, ledgerAccountIds)
            )
          )
          .execute()
      : Promise.resolve(([])),
    customerOnlyIds.length > 0
      ? db
          .select({
            customerId: voucherEntries.customerId,
            debitAmount: voucherEntries.debitAmount,
            creditAmount: voucherEntries.creditAmount,
            transactionCurrency: voucherEntries.transactionCurrency,
            transactionDebitAmount: voucherEntries.transactionDebitAmount,
            transactionCreditAmount: voucherEntries.transactionCreditAmount,
            baseDebitAmount: voucherEntries.baseDebitAmount,
            baseCreditAmount: voucherEntries.baseCreditAmount,
          })
          .from(voucherEntries)
          .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
          .where(
            and(
              eq(vouchers.companyId, companyId),
              isNull(vouchers.deletedAt),
              isNotNull(voucherEntries.customerId),
              inArray(voucherEntries.customerId, customerOnlyIds)
            )
          )
          .execute()
      : Promise.resolve(([])),
  ]);

  const ledgerNet = new Map<number, number>();
  const ledgerBase = new Map<number, number>();
  for (const entry of ledgerEntries) {
    if (!entry.ledgerAccountId) continue;
    addNetBalance(ledgerNet, entry.ledgerAccountId, entry);
    addHistoricalBaseBalance(ledgerBase, entry.ledgerAccountId, entry);
  }

  const customerNet = new Map<number, number>();
  const customerBase = new Map<number, number>();
  for (const entry of customerEntries) {
    const customerId = entry.customerId;
    if (!customerId) continue;
    addNetBalance(customerNet, customerId, entry);
    addHistoricalBaseBalance(customerBase, customerId, entry);
  }

  return customers.map((customer) => {
    const openingBalance = Number.parseFloat(customer.openingBalance || "0");
    const openingNet = (customer.openingBalanceSide || "Dr") === "Dr" ? openingBalance : -openingBalance;
    const transactionNet = customer.ledgerAccountId
      ? (ledgerNet.get(customer.ledgerAccountId) ?? 0)
      : (customerNet.get(customer.id) ?? 0);
    const balance = openingNet + transactionNet;
    return {
      ...customer,
      balance: Math.abs(balance),
      balanceSide: balance >= 0 ? "Dr" : "Cr",
      historicalBaseBalance:
        openingNet +
        (customer.ledgerAccountId
          ? (ledgerBase.get(customer.ledgerAccountId) ?? 0)
          : (customerBase.get(customer.id) ?? 0)),
    };
  });
}