import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { voucherEntries, vouchers } from "@shared/schema";

import { db } from "../../db";
import { storage } from "../../storage";

type BalanceAggregate = {
  key: number | null;
  netAmount: string | null;
  baseNetAmount: string | null;
};

function toBalanceMap(rows: BalanceAggregate[]): {
  net: Map<number, number>;
  base: Map<number, number>;
} {
  const net = new Map<number, number>();
  const base = new Map<number, number>();

  for (const row of rows) {
    if (!row.key) continue;
    net.set(row.key, Number.parseFloat(row.netAmount || "0"));
    base.set(row.key, Number.parseFloat(row.baseNetAmount || "0"));
  }

  return { net, base };
}

const netBalanceSql = sql<string>`COALESCE(SUM(
  CASE
    WHEN CAST(${voucherEntries.debitAmount} AS numeric) > 0
      AND CAST(${voucherEntries.creditAmount} AS numeric) = 0
    THEN CAST(${voucherEntries.debitAmount} AS numeric)
    WHEN CAST(${voucherEntries.creditAmount} AS numeric) > 0
      AND CAST(${voucherEntries.debitAmount} AS numeric) = 0
    THEN -CAST(${voucherEntries.creditAmount} AS numeric)
    ELSE 0
  END
), 0)`;

const historicalBaseBalanceSql = sql<string>`COALESCE(SUM(
  CASE
    WHEN COALESCE(CAST(${voucherEntries.baseDebitAmount} AS numeric), CAST(${voucherEntries.debitAmount} AS numeric), 0) > 0
      AND COALESCE(CAST(${voucherEntries.baseCreditAmount} AS numeric), CAST(${voucherEntries.creditAmount} AS numeric), 0) = 0
    THEN COALESCE(CAST(${voucherEntries.baseDebitAmount} AS numeric), CAST(${voucherEntries.debitAmount} AS numeric), 0)
    WHEN COALESCE(CAST(${voucherEntries.baseCreditAmount} AS numeric), CAST(${voucherEntries.creditAmount} AS numeric), 0) > 0
      AND COALESCE(CAST(${voucherEntries.baseDebitAmount} AS numeric), CAST(${voucherEntries.debitAmount} AS numeric), 0) = 0
    THEN -COALESCE(CAST(${voucherEntries.baseCreditAmount} AS numeric), CAST(${voucherEntries.creditAmount} AS numeric), 0)
    ELSE 0
  END
), 0)`;

export async function getCustomersWithBalances(companyId: number) {
  const customers = await storage.getAllCustomers(companyId);
  if (customers.length === 0) return [];

  const ledgerAccountIds = customers
    .filter((customer) => customer.ledgerAccountId)
    .map((customer) => customer.ledgerAccountId as number);
  const customerOnlyIds = customers.filter((customer) => !customer.ledgerAccountId).map((customer) => customer.id);

  const [ledgerRows, customerRows] = await Promise.all([
    ledgerAccountIds.length > 0
      ? db
          .select({
            key: voucherEntries.ledgerAccountId,
            netAmount: netBalanceSql,
            baseNetAmount: historicalBaseBalanceSql,
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
          .groupBy(voucherEntries.ledgerAccountId)
      : Promise.resolve([] as BalanceAggregate[]),
    customerOnlyIds.length > 0
      ? db
          .select({
            key: voucherEntries.customerId,
            netAmount: netBalanceSql,
            baseNetAmount: historicalBaseBalanceSql,
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
          .groupBy(voucherEntries.customerId)
      : Promise.resolve([] as BalanceAggregate[]),
  ]);

  const ledgerBalances = toBalanceMap(ledgerRows as BalanceAggregate[]);
  const customerBalances = toBalanceMap(customerRows as BalanceAggregate[]);

  return customers.map((customer) => {
    const openingBalance = Number.parseFloat(customer.openingBalance || "0");
    const openingNet = (customer.openingBalanceSide || "Dr") === "Dr" ? openingBalance : -openingBalance;
    const transactionNet = customer.ledgerAccountId
      ? (ledgerBalances.net.get(customer.ledgerAccountId) ?? 0)
      : (customerBalances.net.get(customer.id) ?? 0);
    const balance = openingNet + transactionNet;

    return {
      ...customer,
      balance: Math.abs(balance),
      balanceSide: balance >= 0 ? "Dr" : "Cr",
      historicalBaseBalance:
        openingNet +
        (customer.ledgerAccountId
          ? (ledgerBalances.base.get(customer.ledgerAccountId) ?? 0)
          : (customerBalances.base.get(customer.id) ?? 0)),
    };
  });
}
