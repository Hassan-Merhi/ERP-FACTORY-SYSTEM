/**
 * Calculate Income Statement for a specific date range.
 *
 * Pulls only the voucher entries that fall WITHIN fromDate..toDate
 * (not cumulative) so each monthly sheet can show "what happened this month"
 * rather than the cumulative balance-sheet snapshot. A voucher counts from
 * COALESCE(effective_date, voucher_date), the balance engine's date basis.
 */

import { db } from "../db";
import { storage } from "../storage";
import { vouchers, voucherEntries } from "@shared/schema";
import { eq, and, isNull, lte, gte } from "drizzle-orm";
import type Decimal from "decimal.js";
import { round2 } from "../netPositionHelper";
import { MoneyDecimal, toMoney } from "../lib/money";
import { classifyAccountType, expenseCategory } from "../services/accounting/accountClassification";
import { voucherBookedOnSql } from "../services/accounting/balances/partyLineRules";
import { notFiscalClosingVoucherSql } from "../services/accounting/balances/periodReportRules";

export interface IncomeLineItem {
  label: string;
  value: number; // always positive
  category: string;
}

export interface IncomeStatement {
  // Revenue
  totalRevenue: number;
  revenueLines: IncomeLineItem[];

  // Direct expenses (COGS, purchases, etc.)
  totalDirectExp: number;
  directExpLines: IncomeLineItem[];

  // Indirect / operating expenses
  totalIndirectExp: number;
  indirectExpLines: IncomeLineItem[];

  // General expenses (type = "Expense")
  totalGeneralExp: number;
  generalExpLines: IncomeLineItem[];

  // Totals
  totalExpenses: number;
  grossProfit: number; // Revenue - DirectExp
  netProfit: number; // Revenue - ALL expenses
}

export async function calculateIncomeStatementForPeriod(
  companyId: number,
  fromDate: string, // YYYY-MM-DD  (inclusive)
  toDate: string // YYYY-MM-DD  (inclusive)
): Promise<IncomeStatement> {
  const companyAccounts = await storage.getAllLedgerAccounts(companyId, true);

  // Fetch entries within the period only
  const periodEntries = await db
    .select({
      ledgerAccountId: voucherEntries.ledgerAccountId,
      debitAmount: voucherEntries.debitAmount,
      creditAmount: voucherEntries.creditAmount,
    })
    .from(voucherEntries)
    .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
    .where(
      and(
        eq(vouchers.companyId, companyId),
        eq(vouchers.optional, false),
        isNull(vouchers.deletedAt),
        // The fiscal closing journal is not period activity (wave 17 A).
        notFiscalClosingVoucherSql,
        // One date basis with the engine (wave 13, R2).
        gte(voucherBookedOnSql, fromDate),
        lte(voucherBookedOnSql, toDate)
      )
    )
    .execute();

  // Sum debits and credits per account, exact
  const accountActivity = new Map<number, { debit: Decimal; credit: Decimal }>();
  for (const e of periodEntries) {
    if (!e.ledgerAccountId) continue;
    const cur = accountActivity.get(e.ledgerAccountId) ?? { debit: new MoneyDecimal(0), credit: new MoneyDecimal(0) };
    accountActivity.set(e.ledgerAccountId, {
      debit: cur.debit.plus(toMoney(e.debitAmount)),
      credit: cur.credit.plus(toMoney(e.creditAmount)),
    });
  }

  // Build account lookup
  const accountMap = new Map(companyAccounts.map((a) => [a.id, a]));

  const revenueLines: IncomeLineItem[] = [];
  const directExpLines: IncomeLineItem[] = [];
  const indirectExpLines: IncomeLineItem[] = [];
  const generalExpLines: IncomeLineItem[] = [];

  for (const [accId, activity] of accountActivity) {
    const acc = accountMap.get(accId);
    if (!acc) continue;
    // Shared classifier: Income, Revenue and Indirect Income (either storage
    // form) are revenue; "Profit" is equity (capital / retained profit), not
    // revenue. Expenses are bucketed by expenseCategory, which reads both the
    // "Direct Expense" type and "Expense" + subType "Direct Expense".
    if (classifyAccountType(acc.accountType, acc.subType) === "income") {
      // Income accounts: credits increase revenue
      const net = round2(activity.credit.minus(activity.debit).toNumber());
      if (net !== 0) {
        revenueLines.push({ label: acc.name, value: net, category: acc.accountType || "Income" });
      }
      continue;
    }
    const category = expenseCategory(acc.accountType, acc.subType);
    if (!category) continue;
    // Expenses: debits increase expense
    const net = round2(activity.debit.minus(activity.credit).toNumber());
    if (net === 0) continue;
    if (category === "Direct Expense" || category === "COGS") {
      directExpLines.push({ label: acc.name, value: net, category });
    } else if (category === "Indirect Expense") {
      indirectExpLines.push({ label: acc.name, value: net, category });
    } else {
      generalExpLines.push({ label: acc.name, value: net, category });
    }
  }

  // Sort descending by value
  const sortDesc = (a: IncomeLineItem, b: IncomeLineItem) => b.value - a.value;
  revenueLines.sort(sortDesc);
  directExpLines.sort(sortDesc);
  indirectExpLines.sort(sortDesc);
  generalExpLines.sort(sortDesc);

  const totalRevenue = round2(revenueLines.reduce((s, l) => s + l.value, 0));
  const totalDirectExp = round2(directExpLines.reduce((s, l) => s + l.value, 0));
  const totalIndirectExp = round2(indirectExpLines.reduce((s, l) => s + l.value, 0));
  const totalGeneralExp = round2(generalExpLines.reduce((s, l) => s + l.value, 0));
  const totalExpenses = round2(totalDirectExp + totalIndirectExp + totalGeneralExp);
  const grossProfit = round2(totalRevenue - totalDirectExp);
  const netProfit = round2(totalRevenue - totalExpenses);

  return {
    totalRevenue,
    revenueLines,
    totalDirectExp,
    directExpLines,
    totalIndirectExp,
    indirectExpLines,
    totalGeneralExp,
    generalExpLines,
    totalExpenses,
    grossProfit,
    netProfit,
  };
}
