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
import { vouchers, voucherEntries } from "@shared/schema";
import { eq, and, isNull, inArray, isNotNull, gte, lte } from "drizzle-orm";
import { classifyAccountType, expenseCategory, isIndirectIncome } from "../accounting/accountClassification";
import {
  buildClassifiedBalanceSheet,
  type ClassifiedBalanceSheet,
  type ClassifiedLine,
} from "../accounting/reporting/classifiedBalanceSheet";
import { voucherBookedOnSql } from "../accounting/balances/partyLineRules";
import { notFiscalClosingVoucherSql } from "../accounting/balances/periodReportRules";

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
  /** Phase 27 (RP-11): exact statement sections, 2-decimal strings. */
  sections: ProfitLossSections;
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
    sections: profitLossSections(incomeAccounts, expenseAccounts, exactBalances),
    startDate: startDate || null,
    endDate: endDate || null,
  };
}

/**
 * Statement sections of the P&L (phase 27, RP-11), on the classifier:
 *   - revenue: income accounts other than indirect income;
 *   - cost of sales: COGS and Direct Expense accounts (the net-profit
 *     workbook's direct expenses), so gross profit = revenue − cost of sales;
 *   - other income: indirect income; operating expenses: every other expense.
 * The ratios' gross margin is taken from here, not from sales_items.
 */
export interface ProfitLossSections {
  revenue: string;
  costOfSales: string;
  grossProfit: string;
  otherIncome: string;
  operatingExpenses: string;
  netProfit: string;
}

type ClassifiedAccount = { id: number; accountType: string; subType?: string | null };

function profitLossSections(
  incomeAccounts: ClassifiedAccount[],
  expenseAccounts: ClassifiedAccount[],
  creditBalances: Map<number, Decimal>
): ProfitLossSections {
  let revenue: Decimal = new MoneyDecimal(0);
  let otherIncome: Decimal = new MoneyDecimal(0);
  let costOfSales: Decimal = new MoneyDecimal(0);
  let operatingExpenses: Decimal = new MoneyDecimal(0);
  for (const account of incomeAccounts) {
    const balance = creditBalances.get(account.id) ?? new MoneyDecimal(0);
    if (isIndirectIncome(account.accountType, account.subType)) otherIncome = otherIncome.plus(balance);
    else revenue = revenue.plus(balance);
  }
  for (const account of expenseAccounts) {
    const balance = (creditBalances.get(account.id) ?? new MoneyDecimal(0)).negated();
    const category = expenseCategory(account.accountType, account.subType);
    if (category === "COGS" || category === "Direct Expense") costOfSales = costOfSales.plus(balance);
    else operatingExpenses = operatingExpenses.plus(balance);
  }
  const grossProfit = revenue.minus(costOfSales);
  return {
    revenue: revenue.toFixed(2),
    costOfSales: costOfSales.toFixed(2),
    grossProfit: grossProfit.toFixed(2),
    otherIncome: otherIncome.toFixed(2),
    operatingExpenses: operatingExpenses.toFixed(2),
    netProfit: grossProfit.plus(otherIncome).minus(operatingExpenses).toFixed(2),
  };
}

// ---------------------------------------------------------------------------
// getBalanceSheet — /api/reports/balance-sheet
//
// Built on the trial balance (wave 9), so every figure is a posted line of a
// live, non-optional voucher or an opening balance with its own side, and the
// statement balances exactly when the ledger does. Every ledger row is
// classified by classifyAccountType (wave 13, R1), the classifier the P&L
// uses, so the current earnings line is the P&L's net profit to the same date:
//   - asset class: assets; liability class: liabilities; equity class
//     (Equity, Profit): equity; income and expense classes (Revenue,
//     Indirect Income, Government Taxes, COGS, ...): current earnings;
//   - party class (Intercompany, Customer, Supplier ledger accounts) by the
//     side of its balance: an asset in debit, a liability in credit;
//   - an unknown type is listed as unclassified, never guessed;
//   - bank accounts and fixed assets are assets;
//   - customers, suppliers, employees and factory suppliers count on the side
//     their balance falls (a supplier in debit is an asset, a customer in
//     credit a liability). Since wave 10 a customer's row also carries the
//     lines of its linked ledger account (CUST-*), which has no row of its own,
//     and its opening is the customer's, so a customer's advance is a
//     liability instead of netting into an asset account;
//   - vouchers count from COALESCE(effective_date, voucher_date);
//   - lines on missing accounts or on no account are listed as unclassified;
//   - `difference` is assets − (liabilities + equity + current earnings +
//     unclassified), which is the trial balance's unexplained difference
//     (unbalanced openings, single-sided stock vouchers), never plugged.
// Before wave 13 the statement kept its own type sets: Government Taxes was a
// liability (the P&L treats it as an expense) and Profit was in current
// earnings (the classifier calls it equity). Phase 27 builds it on the engine
// rows directly (classifiedBalanceSheet.ts; same rows as the trial balance).
// ---------------------------------------------------------------------------
export interface BalanceSheetLine {
  kind: string;
  id: number | null;
  code: string | null;
  name: string;
  accountType: string | null;
  balance: string;
  /** Phase 27: current / non-current section and whether the line is cash. */
  section?: ClassifiedLine["section"];
  cash?: boolean;
}

export interface BalanceSheet {
  asOfDate: string | null;
  assets: { lines: BalanceSheetLine[]; total: string };
  liabilities: { lines: BalanceSheetLine[]; total: string };
  equity: {
    lines: BalanceSheetLine[];
    /** Phase 27: income/expense movement of the fiscal year (calendar year) to the date. */
    currentEarnings: string;
    /** Phase 27: income/expense balances from before the fiscal year not yet closed. */
    retainedEarnings: string;
    total: string;
  };
  unclassified: { lines: BalanceSheetLine[]; total: string };
  /** Assets − (liabilities + equity + unclassified). Zero when the ledger balances. */
  difference: string;
  balanced: boolean;
  /** Phase 27 (RP-4/RP-6): the classified statement the totals above are built from. */
  fiscalYear: { start: string; end: string } | null;
  classified: Pick<
    ClassifiedBalanceSheet,
    "currentAssets" | "nonCurrentAssets" | "currentLiabilities" | "nonCurrentLiabilities" | "totals"
  >;
}

function legacyLine(line: ClassifiedLine): BalanceSheetLine {
  return {
    kind: line.kind,
    id: line.id,
    code: line.code,
    name: line.name,
    accountType: line.accountType,
    balance: line.balance,
    section: line.section,
    cash: line.cash,
  };
}

/**
 * Phase 27 (RP-4/RP-6): on the classified balance sheet
 * (accounting/reporting/classifiedBalanceSheet.ts). The rows and their
 * classes are the wave 13 rules above with two changes: an overdrawn bank (a
 * bank account or Cash/Bank ledger account in credit) is a current liability,
 * no longer a negative asset; and earnings are split at the fiscal year
 * (calendar year): `currentEarnings` is the year's income/expense movement to
 * the date, `retainedEarnings` what those accounts held before the year and no
 * close has moved yet. Their sum is the former all-time current earnings, so
 * the totals and `difference` are unchanged.
 */
export async function getBalanceSheet(companyId: number, asOfDate: string | undefined): Promise<BalanceSheet> {
  const sheet = await buildClassifiedBalanceSheet(companyId, asOfDate ?? null);
  const assets = [...sheet.currentAssets.lines, ...sheet.nonCurrentAssets.lines].map(legacyLine);
  const liabilities = [...sheet.currentLiabilities.lines, ...sheet.nonCurrentLiabilities.lines].map(legacyLine);
  return {
    asOfDate: asOfDate ?? null,
    assets: { lines: assets, total: sheet.totals.assets },
    liabilities: { lines: liabilities, total: sheet.totals.liabilities },
    equity: {
      lines: sheet.equity.lines.map(legacyLine),
      currentEarnings: sheet.equity.currentEarnings,
      retainedEarnings: sheet.equity.retainedEarnings,
      total: sheet.equity.total,
    },
    unclassified: { lines: sheet.unclassified.lines.map(legacyLine), total: sheet.unclassified.total },
    difference: sheet.difference,
    balanced: sheet.balanced,
    fiscalYear: sheet.fiscalYear,
    classified: {
      currentAssets: sheet.currentAssets,
      nonCurrentAssets: sheet.nonCurrentAssets,
      currentLiabilities: sheet.currentLiabilities,
      nonCurrentLiabilities: sheet.nonCurrentLiabilities,
      totals: sheet.totals,
    },
  };
}

// ---------------------------------------------------------------------------
// getFinancialRatios — /api/reports/ratios (wave 13, R4; phase 27, RP-4/RP-11)
//
// Built on the two statements, so a ratio never disagrees with them:
//   - income, expenses and net profit are getProfitLoss over the range
//     (classifier, live non-optional vouchers, COALESCE(effective_date,
//     voucher_date), fiscal closing journals left out);
//   - the gross margin is the P&L's gross profit over its revenue (revenue
//     less cost of sales, phase 27): `totalSales` / `totalCost` are now those
//     ledger figures, no longer the sales_items of the range;
//   - the current ratio is current assets ÷ current liabilities of the
//     classified balance sheet at the range's end (it was total assets ÷
//     total liabilities); assets and liabilities are its totals; equity is
//     assets − liabilities (net assets) as before.
// ---------------------------------------------------------------------------
export interface FinancialRatios {
  ratios: { grossProfitMargin: number; netProfitMargin: number; currentRatio: number; debtToEquity: number };
  underlying: {
    totalIncome: number;
    totalExpenses: number;
    totalSales: number;
    totalCost: number;
    grossProfit: number;
    netProfit: number;
    totalAssets: number;
    totalLiabilities: number;
    totalEquity: number;
    currentAssets: number;
    currentLiabilities: number;
  };
  /** Exact figures (2-decimal strings) behind the numbers above. */
  exact: {
    revenue: string;
    costOfSales: string;
    grossProfit: string;
    netProfit: string;
    currentAssets: string;
    currentLiabilities: string;
    totalAssets: string;
    totalLiabilities: string;
    netAssets: string;
  };
  marginBasis: "ledger";
  fiscalYear: { start: string; end: string } | null;
  filters: { startDate: string | null; endDate: string | null };
}

function percentOf(numerator: Decimal, denominator: Decimal): number {
  return denominator.isZero() ? 0 : numerator.div(denominator).times(100).toNumber();
}

export async function getFinancialRatios(
  companyId: number,
  startDate: string | undefined,
  endDate: string | undefined
): Promise<FinancialRatios> {
  const [profitLoss, balanceSheet] = await Promise.all([
    getProfitLoss(companyId, startDate, endDate),
    getBalanceSheet(companyId, endDate),
  ]);
  const sections = profitLoss.sections;
  const totalIncome = toMoney(profitLoss.totalIncome);
  const totalExpenses = toMoney(profitLoss.totalExpenses);
  const netProfit = toMoney(sections.netProfit);
  const revenue = toMoney(sections.revenue);
  const costOfSales = toMoney(sections.costOfSales);
  const grossProfit = toMoney(sections.grossProfit);
  const totals = balanceSheet.classified.totals;
  const totalAssets = toMoney(totals.assets);
  const totalLiabilities = toMoney(totals.liabilities);
  const currentAssets = toMoney(balanceSheet.classified.currentAssets.total);
  const currentLiabilities = toMoney(balanceSheet.classified.currentLiabilities.total);
  const totalEquity = totalAssets.minus(totalLiabilities);
  return {
    ratios: {
      grossProfitMargin: percentOf(grossProfit, revenue),
      netProfitMargin: percentOf(netProfit, totalIncome),
      currentRatio: currentLiabilities.isPositive() ? currentAssets.div(currentLiabilities).toNumber() : 0,
      debtToEquity: totalEquity.isPositive() ? totalLiabilities.div(totalEquity).toNumber() : 0,
    },
    underlying: {
      totalIncome: totalIncome.toNumber(),
      totalExpenses: totalExpenses.toNumber(),
      totalSales: revenue.toNumber(),
      totalCost: costOfSales.toNumber(),
      grossProfit: grossProfit.toNumber(),
      netProfit: netProfit.toNumber(),
      totalAssets: totalAssets.toNumber(),
      totalLiabilities: totalLiabilities.toNumber(),
      totalEquity: totalEquity.toNumber(),
      currentAssets: currentAssets.toNumber(),
      currentLiabilities: currentLiabilities.toNumber(),
    },
    exact: {
      revenue: sections.revenue,
      costOfSales: sections.costOfSales,
      grossProfit: sections.grossProfit,
      netProfit: sections.netProfit,
      currentAssets: currentAssets.toFixed(2),
      currentLiabilities: currentLiabilities.toFixed(2),
      totalAssets: totals.assets,
      totalLiabilities: totals.liabilities,
      netAssets: totals.netAssets,
    },
    marginBasis: "ledger",
    fiscalYear: balanceSheet.fiscalYear,
    filters: { startDate: startDate || null, endDate: endDate || null },
  };
}
