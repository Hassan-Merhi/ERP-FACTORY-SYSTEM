// ---------------------------------------------------------------------------
// Financial Reports Service
// Extracted from server/routes/stats/statsSalesRoutes.ts (Phase 9 refactor).
// Routes keep: auth, validation, req/res handling.
// This service: orchestrates storage/DB calls, returns plain data.
// API contracts (URL, params, response shape) are unchanged.
// ---------------------------------------------------------------------------

import { db } from "../../db";
import type Decimal from "decimal.js";
import { MoneyDecimal, sumMoney, toMoney } from "../../lib/money";
import { storage } from "../../storage";
import { vouchers, voucherEntries, salesItems } from "@shared/schema";
import { eq, and, isNull, inArray, isNotNull, gte, lte } from "drizzle-orm";
import { buildTrialBalance } from "../accounting/integrity/trialBalance";
import { classifyAccountType } from "../accounting/accountClassification";
import { voucherBookedOnSql } from "../accounting/balances/partyLineRules";
import { notFiscalClosingVoucherSql } from "../accounting/balances/periodReportRules";
import {
  PARTY_KINDS,
  ledgerSubTypes,
  percentOf,
  type BalanceSheetLine,
  type BalanceSheet,
  type FinancialRatios,
} from "./financialReportsServiceHelpers";
export type { BalanceSheetLine, BalanceSheet, FinancialRatios } from "./financialReportsServiceHelpers";

// ---------------------------------------------------------------------------
// getProfitLoss — /api/reports/profit-loss
// Returns income/expense breakdown and net profit for the given date range.
// ---------------------------------------------------------------------------
export async function getProfitLoss(
  companyId: number,
  startDate: string | undefined,
  endDate: string | undefined
): Promise<{
  incomeItems: Array<{ id: number; code: string; name: string; accountType: string; balance: number }>;
  expenseItems: Array<{ id: number; code: string; name: string; accountType: string; balance: number }>;
  totalIncome: number;
  totalExpenses: number;
  netProfit: number;
  startDate: string | null;
  endDate: string | null;
}> {
  // Get all ledger accounts for this company
  const companyAccounts = await storage.getAllLedgerAccounts(companyId, true); // Include hidden accounts for financial calculations

  // Classified by the shared classifier: Indirect Income (either storage form),
  // Revenue and mis-cased types are income; Government Taxes is an expense;
  // Profit is equity, not income.
  const incomeAccounts = companyAccounts.filter(
    (acc) => classifyAccountType(acc.accountType, acc.subType) === "income"
  );
  const expenseAccounts = companyAccounts.filter(
    (acc) => classifyAccountType(acc.accountType, acc.subType) === "expense"
  );

  const incomeAccountIds = incomeAccounts.map((acc) => acc.id);
  const expenseAccountIds = expenseAccounts.map((acc) => acc.id);

  // The fiscal closing journal is not period profit (wave 17 A): a closed year
  // still shows the profit it made. The balance sheet keeps it.
  const plConditions = [
    eq(vouchers.companyId, companyId),
    eq(vouchers.optional, false),
    isNull(vouchers.deletedAt),
    notFiscalClosingVoucherSql,
  ];
  // One date basis with the engine (wave 13, R2): a voucher counts from
  // COALESCE(effective_date, voucher_date).
  if (startDate) {
    plConditions.push(gte(voucherBookedOnSql, startDate));
  }
  if (endDate) {
    plConditions.push(lte(voucherBookedOnSql, endDate));
  }

  // Single JOIN query — replaces two-step (fetch voucher IDs → inArray entries)
  // Only fetch entries for income/expense accounts to avoid reading the whole table
  const allAccountIds = [...incomeAccountIds, ...expenseAccountIds];
  const companyEntries =
    allAccountIds.length > 0
      ? await db
          .select({
            ledgerAccountId: voucherEntries.ledgerAccountId,
            debitAmount: voucherEntries.debitAmount,
            creditAmount: voucherEntries.creditAmount,
          })
          .from(voucherEntries)
          .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
          .where(
            and(
              ...plConditions,
              isNotNull(voucherEntries.ledgerAccountId),
              inArray(voucherEntries.ledgerAccountId, allAccountIds)
            )
          )
          .execute()
      : [];

  // Calculate balances for each account
  const exactBalances = new Map<number, Decimal>();

  for (const entry of companyEntries) {
    if (entry.ledgerAccountId) {
      const currentBalance = exactBalances.get(entry.ledgerAccountId) ?? new MoneyDecimal(0);
      exactBalances.set(
        entry.ledgerAccountId,
        currentBalance.plus(toMoney(entry.creditAmount)).minus(toMoney(entry.debitAmount))
      );
    }
  }
  // Exact sums, so an account whose entries cancel reads 0 rather than a float residue.
  const accountBalances = new Map(Array.from(exactBalances, ([id, balance]) => [id, balance.toNumber()] as const));

  // Build income statement
  const incomeItems = incomeAccounts
    .map((acc) => ({
      id: acc.id,
      code: acc.code,
      name: acc.name,
      accountType: acc.accountType,
      balance: accountBalances.get(acc.id) || 0,
    }))
    .filter((item) => item.balance !== 0);

  // Expenses are read debit-minus-credit (wave 13). They used to carry the
  // credit-minus-debit balance of the income side, so totalExpenses was
  // negative and netProfit (income − expenses) added the expenses instead of
  // subtracting them.
  const expenseItems = expenseAccounts
    .map((acc) => ({
      id: acc.id,
      code: acc.code,
      name: acc.name,
      accountType: acc.accountType,
      balance: exactBalances.get(acc.id)?.negated().toNumber() || 0,
    }))
    .filter((item) => item.balance !== 0);

  const totalIncomeExact = sumMoney(incomeItems.map((item) => exactBalances.get(item.id)));
  const totalExpensesExact = sumMoney(expenseItems.map((item) => exactBalances.get(item.id)?.negated()));
  const totalIncome = totalIncomeExact.toNumber();
  const totalExpenses = totalExpensesExact.toNumber();
  const netProfit = totalIncomeExact.minus(totalExpensesExact).toNumber();

  return {
    incomeItems,
    expenseItems,
    totalIncome,
    totalExpenses,
    netProfit,
    startDate: startDate || null,
    endDate: endDate || null,
  };
}

export async function getBalanceSheet(companyId: number, asOfDate: string | undefined): Promise<BalanceSheet> {
  const [trialBalance, subTypes] = await Promise.all([
    buildTrialBalance(companyId, asOfDate ?? null),
    ledgerSubTypes(companyId),
  ]);
  const assets: BalanceSheetLine[] = [];
  const liabilities: BalanceSheetLine[] = [];
  const equity: BalanceSheetLine[] = [];
  const unclassified: BalanceSheetLine[] = [];
  let currentEarnings: Decimal = new MoneyDecimal(0);

  for (const row of trialBalance.rows) {
    // Debit-positive closing balance.
    const debit = toMoney(row.closingDebit).minus(toMoney(row.closingCredit));
    if (debit.isZero()) continue;
    const line = (balance: Decimal): BalanceSheetLine => ({
      kind: row.kind,
      id: row.id,
      code: row.code,
      name: row.name,
      accountType: row.accountType,
      balance: balance.toFixed(2),
    });
    const bySign = () => (debit.isPositive() ? assets.push(line(debit)) : liabilities.push(line(debit.negated())));
    if (row.kind === "bank" || row.kind === "fixedAsset") {
      assets.push(line(debit));
      continue;
    }
    if (PARTY_KINDS.has(row.kind)) {
      bySign();
      continue;
    }
    const accountClass =
      row.kind === "ledger"
        ? classifyAccountType(row.accountType, row.id === null ? null : subTypes.get(row.id))
        : "unknown";
    switch (accountClass) {
      case "asset":
        assets.push(line(debit));
        break;
      case "liability":
        liabilities.push(line(debit.negated()));
        break;
      case "equity":
        equity.push(line(debit.negated()));
        break;
      case "income":
      case "expense":
        currentEarnings = currentEarnings.minus(debit);
        break;
      case "party":
        bySign();
        break;
      default:
        // Credit-positive, like the right-hand side it is compared with.
        unclassified.push(line(debit.negated()));
    }
  }

  const total = (lines: BalanceSheetLine[]) =>
    lines.reduce((sum, item) => sum.plus(toMoney(item.balance)), new MoneyDecimal(0));
  const assetsTotal = total(assets);
  const liabilitiesTotal = total(liabilities);
  const equityTotal = total(equity).plus(currentEarnings);
  const unclassifiedTotal = total(unclassified);
  const difference = assetsTotal.minus(liabilitiesTotal).minus(equityTotal).minus(unclassifiedTotal);

  return {
    asOfDate: asOfDate ?? null,
    assets: { lines: assets, total: assetsTotal.toFixed(2) },
    liabilities: { lines: liabilities, total: liabilitiesTotal.toFixed(2) },
    equity: { lines: equity, currentEarnings: currentEarnings.toFixed(2), total: equityTotal.toFixed(2) },
    unclassified: { lines: unclassified, total: unclassifiedTotal.toFixed(2) },
    difference: difference.toFixed(2),
    balanced: difference.isZero(),
  };
}

export async function getFinancialRatios(
  companyId: number,
  startDate: string | undefined,
  endDate: string | undefined
): Promise<FinancialRatios> {
  const salesConditions = [eq(vouchers.companyId, companyId), eq(vouchers.optional, false), isNull(vouchers.deletedAt)];
  if (startDate) salesConditions.push(gte(voucherBookedOnSql, startDate));
  if (endDate) salesConditions.push(lte(voucherBookedOnSql, endDate));
  const [profitLoss, balanceSheet, salesData] = await Promise.all([
    getProfitLoss(companyId, startDate, endDate),
    getBalanceSheet(companyId, endDate),
    db
      .select({ totalSales: salesItems.totalSales, totalCost: salesItems.totalCost })
      .from(salesItems)
      .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
      .where(and(...salesConditions))
      .execute(),
  ]);
  const totalIncome = toMoney(profitLoss.totalIncome);
  const totalExpenses = toMoney(profitLoss.totalExpenses);
  const netProfit = totalIncome.minus(totalExpenses);
  const totalSales = sumMoney(salesData.map((sale) => sale.totalSales));
  const totalCost = sumMoney(salesData.map((sale) => sale.totalCost));
  const grossProfit = totalSales.minus(totalCost);
  const totalAssets = toMoney(balanceSheet.assets.total);
  const totalLiabilities = toMoney(balanceSheet.liabilities.total);
  const totalEquity = totalAssets.minus(totalLiabilities);
  return {
    ratios: {
      grossProfitMargin: percentOf(grossProfit, totalSales),
      netProfitMargin: percentOf(netProfit, totalIncome),
      currentRatio: totalLiabilities.isPositive() ? totalAssets.div(totalLiabilities).toNumber() : 0,
      debtToEquity: totalEquity.isPositive() ? totalLiabilities.div(totalEquity).toNumber() : 0,
    },
    underlying: {
      totalIncome: totalIncome.toNumber(),
      totalExpenses: totalExpenses.toNumber(),
      totalSales: totalSales.toNumber(),
      totalCost: totalCost.toNumber(),
      grossProfit: grossProfit.toNumber(),
      netProfit: netProfit.toNumber(),
      totalAssets: totalAssets.toNumber(),
      totalLiabilities: totalLiabilities.toNumber(),
      totalEquity: totalEquity.toNumber(),
    },
    filters: { startDate: startDate || null, endDate: endDate || null },
  };
}
