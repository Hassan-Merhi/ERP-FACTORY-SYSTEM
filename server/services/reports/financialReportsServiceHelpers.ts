// Extracted from ./financialReportsService.ts
import { db } from "../../db";
import type Decimal from "decimal.js";
import { ledgerAccounts } from "@shared/schema";
import { eq } from "drizzle-orm";

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
// earnings (the classifier calls it equity).
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

export const PARTY_KINDS = new Set(["customer", "supplier", "employee", "factorySupplier"]);

/** sub_type of the company's ledger accounts, so a row is classified as the P&L classifies it. */
export async function ledgerSubTypes(companyId: number): Promise<Map<number, string | null>> {
  const rows = await db
    .select({ id: ledgerAccounts.id, subType: ledgerAccounts.subType })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.companyId, companyId))
    .execute();
  return new Map(rows.map((row) => [row.id, row.subType ?? null] as const));
}

// ---------------------------------------------------------------------------
// getFinancialRatios — /api/reports/ratios (wave 13, R4)
//
// Built on the two statements, so a ratio never disagrees with them:
//   - income, expenses and net profit are getProfitLoss over the range
//     (classifier, live non-optional vouchers, COALESCE(effective_date,
//     voucher_date));
//   - assets and liabilities are the balance sheet's totals at the range's end
//     (closing balances including openings, banks, fixed assets and parties
//     by side); equity is assets − liabilities (net assets) as before;
//   - sales and cost are the sales items of live, non-optional vouchers in the
//     range on the same date basis.
// Before, the route matched only the exact types "Income" / "Expense" /
// "Asset" / "Liability", read deleted and optional vouchers, summed period
// movements of asset and liability accounts as if they were balances (no
// openings, no banks or parties) and filtered by voucher_date.
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
  };
  filters: { startDate: string | null; endDate: string | null };
}

export function percentOf(numerator: Decimal, denominator: Decimal): number {
  return denominator.isZero() ? 0 : numerator.div(denominator).times(100).toNumber();
}
