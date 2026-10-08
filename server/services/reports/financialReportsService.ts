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
import { eq, and, isNull, inArray, isNotNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { buildTrialBalance } from "../accounting/integrity/trialBalance";
import {
  canonicalAccountType,
  classifyAccountType,
  PROFIT_AND_LOSS_ACCOUNT_TYPES,
} from "../accounting/accountClassification";

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

  const plConditions = [eq(vouchers.companyId, companyId), eq(vouchers.optional, false), isNull(vouchers.deletedAt)];
  if (startDate) {
    plConditions.push(sql`${vouchers.voucherDate} >= ${startDate}`);
  }
  if (endDate) {
    plConditions.push(sql`${vouchers.voucherDate} <= ${endDate}`);
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

  const expenseItems = expenseAccounts
    .map((acc) => ({
      id: acc.id,
      code: acc.code,
      name: acc.name,
      accountType: acc.accountType,
      balance: accountBalances.get(acc.id) || 0,
    }))
    .filter((item) => item.balance !== 0);

  const totalIncomeExact = sumMoney(incomeItems.map((item) => exactBalances.get(item.id)));
  const totalExpensesExact = sumMoney(expenseItems.map((item) => exactBalances.get(item.id)));
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

// ---------------------------------------------------------------------------
// getBalanceSheet — /api/reports/balance-sheet
//
// Built on the trial balance (wave 9), so every figure is a posted line of a
// live, non-optional voucher or an opening balance with its own side, and the
// statement balances exactly when the ledger does:
//   - ledger accounts by type: asset types are assets, liability types are
//     liabilities, Equity is equity, income-statement types make the current
//     earnings line; any other type is listed as unclassified;
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
// ---------------------------------------------------------------------------
export interface BalanceSheetLine {
  kind: string;
  id: number | null;
  code: string | null;
  name: string;
  accountType: string | null;
  balance: string;
}

export interface BalanceSheet {
  asOfDate: string | null;
  assets: { lines: BalanceSheetLine[]; total: string };
  liabilities: { lines: BalanceSheetLine[]; total: string };
  equity: { lines: BalanceSheetLine[]; currentEarnings: string; total: string };
  unclassified: { lines: BalanceSheetLine[]; total: string };
  /** Assets − (liabilities + equity + unclassified). Zero when the ledger balances. */
  difference: string;
  balanced: boolean;
}

const BALANCE_SHEET_ASSET_TYPES = new Set(["Asset", "Current Asset", "Fixed Asset", "Bank", "Cash", "Customer"]);
const BALANCE_SHEET_LIABILITY_TYPES = new Set([
  "Liability",
  "Loan",
  "Loans",
  "Duty Agent",
  "Transporter Agent",
  "Accounts Payable",
  "Supplier",
  "Government Taxes",
  "Intercompany",
]);
const BALANCE_SHEET_EARNINGS_TYPES = new Set([...PROFIT_AND_LOSS_ACCOUNT_TYPES, "Revenue", "Profit"]);
const PARTY_KINDS = new Set(["customer", "supplier", "employee", "factorySupplier"]);

export async function getBalanceSheet(companyId: number, asOfDate: string | undefined): Promise<BalanceSheet> {
  const trialBalance = await buildTrialBalance(companyId, asOfDate ?? null);
  const assets: BalanceSheetLine[] = [];
  const liabilities: BalanceSheetLine[] = [];
  const equity: BalanceSheetLine[] = [];
  const unclassified: BalanceSheetLine[] = [];
  let currentEarnings: Decimal = new MoneyDecimal(0);

  for (const row of trialBalance.rows) {
    // Debit-positive closing balance.
    const debit = toMoney(row.closingDebit).minus(toMoney(row.closingCredit));
    if (debit.isZero()) continue;
    const type = canonicalAccountType(row.accountType) ?? row.accountType ?? null;
    const line = (balance: Decimal): BalanceSheetLine => ({
      kind: row.kind,
      id: row.id,
      code: row.code,
      name: row.name,
      accountType: row.accountType,
      balance: balance.toFixed(2),
    });
    if (row.kind === "bank" || row.kind === "fixedAsset") {
      assets.push(line(debit));
    } else if (PARTY_KINDS.has(row.kind)) {
      if (debit.isPositive()) assets.push(line(debit));
      else liabilities.push(line(debit.negated()));
    } else if (row.kind === "ledger" && type && BALANCE_SHEET_ASSET_TYPES.has(type)) {
      assets.push(line(debit));
    } else if (row.kind === "ledger" && type && BALANCE_SHEET_LIABILITY_TYPES.has(type)) {
      liabilities.push(line(debit.negated()));
    } else if (row.kind === "ledger" && type === "Equity") {
      equity.push(line(debit.negated()));
    } else if (row.kind === "ledger" && type && BALANCE_SHEET_EARNINGS_TYPES.has(type)) {
      currentEarnings = currentEarnings.minus(debit);
    } else {
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
