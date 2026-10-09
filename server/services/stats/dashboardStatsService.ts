// ---------------------------------------------------------------------------
// Dashboard Stats Service
// Extracted from server/routes/stats/statsDataRoutes.ts (Phase 9 refactor).
// Routes keep: auth, validation, req/res handling.
// This service: orchestrates storage/DB calls, returns plain data.
// API contracts (URL, params, response shape) are unchanged.
// ---------------------------------------------------------------------------

import { db } from "../../db";
import { storage } from "../../storage";
import { vouchers, voucherEntries } from "@shared/schema";
import { eq, and, isNull, inArray, gte, sql } from "drizzle-orm";
import { classifyAccountType, expenseCategory } from "../accounting/accountClassification";
import { voucherBookedOnSql } from "../accounting/balances/partyLineRules";
import { notFiscalClosingVoucherSql } from "../accounting/balances/periodReportRules";
import { _getCached, _setCached } from "../shared/ttlCache";
import { loadBalanceRows } from "../accounting/balances/ledgerBalanceEngine";
import { MoneyDecimal, toMoney } from "../../lib/money";
import type Decimal from "decimal.js";

// ---------------------------------------------------------------------------
// getMonthlyData — /api/stats/monthly-data
// Returns last 6 months of sales volume and profit for dashboard charts.
//
// Wave 13 (R3), on the same rules as the P&L (getProfitLoss):
//   - months are bucketed by year and month (`yearMonth`, "2026-10"); before,
//     the bucket was the month name, so October of last year was added into
//     this October;
//   - a voucher counts from COALESCE(effective_date, voucher_date);
//   - amounts are the posted base amounts (debit_amount / credit_amount, USD);
//     `sales` used to be the Sales vouchers' totalAmount in each voucher's
//     own currency. It is now the net income-class credit of Sales vouchers;
//   - income and expense accounts by classifyAccountType, so every
//     expense-class account (Purchases, Government Taxes, COGS, mis-cased
//     types) counts as the P&L counts it; the old code/name exclusion list of
//     "capitalised" import charges is gone: if those accounts are typed as
//     expenses in the ledger, the P&L counts them, and so does the dashboard.
// `profit` for a month is therefore getProfitLoss's net profit for that month.
// ---------------------------------------------------------------------------
function yearMonthOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export async function getMonthlyData(
  companyId: number
): Promise<Array<{ month: string; yearMonth: string; sales: number; profit: number }>> {
  const companyAccounts = await storage.getAllLedgerAccounts(companyId, true); // Include hidden accounts for financial calculations
  const classOf = new Map(
    companyAccounts.map((acc) => [acc.id, classifyAccountType(acc.accountType, acc.subType)] as const)
  );
  const plAccountIds = [...classOf].filter(([, c]) => c === "income" || c === "expense").map(([id]) => id);

  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthlyData = new Map<string, { month: string; sales: Decimal; profit: Decimal }>();
  const currentDate = new Date();
  for (let i = 5; i >= 0; i--) {
    const date = new Date(currentDate.getFullYear(), currentDate.getMonth() - i, 1);
    monthlyData.set(yearMonthOf(date), {
      month: monthNames[date.getMonth()],
      sales: new MoneyDecimal(0),
      profit: new MoneyDecimal(0),
    });
  }
  const firstMonth = [...monthlyData.keys()][0];

  const entries =
    plAccountIds.length === 0
      ? []
      : await db
          .select({
            ledgerAccountId: voucherEntries.ledgerAccountId,
            debitAmount: voucherEntries.debitAmount,
            creditAmount: voucherEntries.creditAmount,
            voucherType: vouchers.voucherType,
            bookedOn: sql`${voucherBookedOnSql}::text`.mapWith(String),
          })
          .from(voucherEntries)
          .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
          .where(
            and(
              eq(vouchers.companyId, companyId),
              eq(vouchers.optional, false),
              isNull(vouchers.deletedAt),
              // The fiscal closing journal is not a month's profit (wave 17 A).
              notFiscalClosingVoucherSql,
              gte(voucherBookedOnSql, `${firstMonth}-01`),
              inArray(voucherEntries.ledgerAccountId, plAccountIds)
            )
          )
          .execute();

  for (const entry of entries) {
    const data = monthlyData.get(String(entry.bookedOn ?? "").slice(0, 7));
    if (!data || entry.ledgerAccountId === null) continue;
    const credit = toMoney(entry.creditAmount).minus(toMoney(entry.debitAmount));
    const accountClass = classOf.get(entry.ledgerAccountId);
    if (accountClass === "income") {
      data.profit = data.profit.plus(credit);
      if (entry.voucherType === "Sales") data.sales = data.sales.plus(credit);
    } else if (accountClass === "expense") {
      data.profit = data.profit.plus(credit);
    }
  }

  return Array.from(monthlyData.entries()).map(([yearMonth, data]) => ({
    month: data.month,
    yearMonth,
    sales: data.sales.toNumber(),
    profit: data.profit.toNumber(),
  }));
}

// ---------------------------------------------------------------------------
// getStockSummary — /api/stats/stock-summary
// Returns total stock items count, low-stock list, critical count for dashboard KPIs.
// ---------------------------------------------------------------------------
export async function getStockSummary(companyId: number): Promise<{
  totalStockItems: number;
  lowStockCount: number;
  criticalCount: number;
  lowStockItems: Array<{ name: string; stock: number; location: string }>;
}> {
  // Get total stock items count
  const stockItemList = await storage.getAllStockItems(companyId);
  const totalStockItems = stockItemList.length;

  // Get all inventory for the company
  const inventory = await storage.getCompanyInventory(companyId);

  // Calculate low stock items (quantity < 20)
  const lowStockThreshold = 20;
  const lowStockItems = inventory
    .filter((item) => toMoney(item.quantity).lt(lowStockThreshold) && toMoney(item.quantity).gt(0))
    .map((item) => ({
      name: item.stockItemName ?? "Unknown",
      stock: toMoney(item.quantity).toNumber(),
      location: item.locationName || "Unknown",
    }))
    .sort((a, b) => a.stock - b.stock) // Sort by lowest stock first
    .slice(0, 10); // Limit to top 10 low stock items

  // Count critical items (quantity < 5)
  const criticalThreshold = 5;
  const criticalCount = inventory.filter(
    (item) => toMoney(item.quantity).lt(criticalThreshold) && toMoney(item.quantity).gt(0)
  ).length;

  return {
    totalStockItems,
    lowStockCount: lowStockItems.length,
    criticalCount,
    lowStockItems,
  };
}

// ---------------------------------------------------------------------------
// getExpenseBreakdown — /api/stats/expense-breakdown
// Expense totals by category for the dashboard donut chart, on the balance
// engine (wave 17 A), consistent with the P&L (getProfitLoss):
//   - each expense-class account's net debit − credit over the period
//     (startDate..endDate, both optional, COALESCE(effective_date,
//     voucher_date)), so reversals and refunds reduce the category (before,
//     every line with a net credit was dropped and the range was all time);
//   - the fiscal closing journal is left out (periodReportRules.ts);
//   - hidden accounts count, as in the P&L (they were left out here);
//   - this company's vouchers on its own accounts (engine rule 4).
// A category whose net is zero is left out; a net-credit category is
// returned with its negative value.
// Uses TTL cache (30 s) per company and range.
// ---------------------------------------------------------------------------
export async function getExpenseBreakdown(
  companyId: number,
  range: { startDate?: string | null; endDate?: string | null } = {}
): Promise<Array<{ name: string; value: number }> | null> {
  const startDate = range.startDate ?? null;
  const endDate = range.endDate ?? null;
  const _ebCacheKey = `expense-breakdown:${companyId}:${startDate ?? ""}:${endDate ?? ""}`;
  const _ebCached = _getCached(_ebCacheKey);
  // Only this function writes this cache key, always as Array<{name, value}>.
  if (_ebCached) return _ebCached as Array<{ name: string; value: number }>;

  // Every expense-class account by the shared classifier, hidden ones included
  // (the P&L's rule), bucketed by expenseCategory.
  const allAccounts = await storage.getAllLedgerAccounts(companyId, true);
  const categoryOf = new Map<number, string>();
  for (const acc of allAccounts) {
    if (classifyAccountType(acc.accountType, acc.subType) !== "expense") continue;
    categoryOf.set(acc.id, expenseCategory(acc.accountType, acc.subType) ?? "Expense");
  }
  if (categoryOf.size === 0) {
    _setCached(_ebCacheKey, []);
    return [];
  }

  const rows = await loadBalanceRows(db, {
    companyId,
    kind: "ledger",
    ids: [...categoryOf.keys()],
    from: startDate,
    asOf: endDate,
    excludeFiscalClose: true,
  });

  const expenseByType = new Map<string, Decimal>();
  for (const row of rows) {
    const category = row.id === null ? undefined : categoryOf.get(row.id);
    if (!category) continue;
    const net = row.periodDebit.minus(row.periodCredit);
    expenseByType.set(category, (expenseByType.get(category) ?? new MoneyDecimal(0)).plus(net));
  }

  const result = Array.from(expenseByType.entries())
    .filter(([, value]) => !value.isZero())
    .map(([name, value]) => ({
      name: name.replace(" Expense", ""),
      value: value.toDecimalPlaces(2).toNumber(),
    }))
    .sort((a, b) => b.value - a.value);

  _setCached(_ebCacheKey, result);
  return result;
}
