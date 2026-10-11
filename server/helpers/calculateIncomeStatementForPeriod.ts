/**
 * Calculate Income Statement for a specific date range.
 *
 * Pulls only the voucher entries that fall WITHIN fromDate..toDate
 * (not cumulative) so each monthly sheet can show "what happened this month"
 * rather than the cumulative balance-sheet snapshot.
 */

import { db } from "../db";
import { storage } from "../storage";
import { vouchers, voucherEntries } from "@shared/schema";
import { eq, and, isNull, lte, gte } from "drizzle-orm";
import { round2 } from "../netPositionHelper";
import { toMoney } from "../lib/money";

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
        gte(vouchers.voucherDate, fromDate),
        lte(vouchers.voucherDate, toDate)
      )
    )
    .execute();

  // Sum debits and credits per account
  const accountActivity = new Map<number, { debit: number; credit: number }>();
  for (const e of periodEntries) {
    if (!e.ledgerAccountId) continue;
    const d = toMoney(e.debitAmount).toNumber();
    const c = toMoney(e.creditAmount).toNumber();
    const cur = accountActivity.get(e.ledgerAccountId) || { debit: 0, credit: 0 };
    accountActivity.set(e.ledgerAccountId, { debit: cur.debit + d, credit: cur.credit + c });
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
    const type = acc.accountType || "";

    if (type === "Income" || type === "Profit") {
      // Income accounts: credits increase revenue
      const net = round2(activity.credit - activity.debit);
      if (net !== 0) {
        revenueLines.push({ label: acc.name, value: net, category: type });
      }
    } else if (type === "Direct Expense") {
      // Direct expenses: debits increase expense
      const net = round2(activity.debit - activity.credit);
      if (net !== 0) {
        directExpLines.push({ label: acc.name, value: net, category: "Direct Expense" });
      }
    } else if (type === "Indirect Expense") {
      const net = round2(activity.debit - activity.credit);
      if (net !== 0) {
        indirectExpLines.push({ label: acc.name, value: net, category: "Indirect Expense" });
      }
    } else if (type === "Expense") {
      const net = round2(activity.debit - activity.credit);
      if (net !== 0) {
        generalExpLines.push({ label: acc.name, value: net, category: "Expense" });
      }
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
