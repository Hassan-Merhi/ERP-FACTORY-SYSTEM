/**
 * Net-profit-statement drill-down routes.
 *
 * Account-level breakdowns behind the net profit statement (purchase
 * accounts, direct incomes, direct expenses, indirect expenses). Extracted
 * from reportsRoutes.ts as a sub-registrar. Since wave 13 each lists one
 * section of the net-profit workbook (netProfitSection) and takes an optional
 * startDate / endDate on the engine's date basis.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth, requireNonPOS } from "../auth";
import { vouchers, voucherEntries } from "@shared/schema";
import { _npsCached, _npsSetCache } from "./reportsNetProfitCache";
import { netProfitSection, type NetProfitSection } from "./netProfitExcelSheets";
import { voucherBookedOnSql } from "../services/accounting/balances/partyLineRules";
import { notFiscalClosingVoucherSql } from "../services/accounting/balances/periodReportRules";
import { MoneyDecimal, toMoney } from "../lib/money";

type BreakdownAccount = { id: number; code: string | null; name: string };

/**
 * Per-account debit, credit and balance for the drill-downs, summed as
 * decimals. `normal` is the side the balance is read from (debit for
 * purchases and expenses, credit for incomes); the total is the sum of the
 * shown balances. Accounts with no movement are left out.
 */
function accountBreakdown<T extends BreakdownAccount>(
  ledgerAccounts: T[],
  entries: Array<{ ledgerAccountId: number | null; debitAmount: string | null; creditAmount: string | null }>,
  normal: "debit" | "credit"
) {
  const sums = new Map<
    number,
    { debit: InstanceType<typeof MoneyDecimal>; credit: InstanceType<typeof MoneyDecimal> }
  >();
  for (const entry of entries) {
    if (!entry.ledgerAccountId) continue;
    const current = sums.get(entry.ledgerAccountId) ?? { debit: new MoneyDecimal(0), credit: new MoneyDecimal(0) };
    sums.set(entry.ledgerAccountId, {
      debit: current.debit.plus(toMoney(entry.debitAmount)),
      credit: current.credit.plus(toMoney(entry.creditAmount)),
    });
  }

  let total = new MoneyDecimal(0);
  const accounts = [];
  for (const acc of ledgerAccounts) {
    const sum = sums.get(acc.id);
    if (!sum || (!sum.debit.greaterThan(0) && !sum.credit.greaterThan(0))) continue;
    const balance = normal === "debit" ? sum.debit.minus(sum.credit) : sum.credit.minus(sum.debit);
    total = total.plus(balance);
    accounts.push({
      id: acc.id,
      code: acc.code,
      name: acc.name,
      debit: sum.debit.toNumber(),
      credit: sum.credit.toNumber(),
      balance: balance.toNumber(),
    });
  }
  return { accounts, total: total.toNumber() };
}

function queryDate(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

/**
 * One drill-down for a company over an optional period. Wave 13: the period
 * (startDate / endDate, inclusive) filters on COALESCE(effective_date,
 * voucher_date), the engine's date basis; before, the drill-downs had no date
 * filter at all and always summed every year.
 */
export async function loadNetProfitDrillDown(
  companyId: number,
  section: NetProfitSection,
  normal: "debit" | "credit",
  startDate: string | null,
  endDate: string | null
) {
  const companyAccounts = await storage.getAllLedgerAccounts(companyId, true);
  const importChargesParent = companyAccounts.find((acc) => acc.code === "IMPORT_CHARGES");
  const importChargesIds = new Set<number>();
  if (importChargesParent) {
    importChargesIds.add(importChargesParent.id);
    for (const acc of companyAccounts) if (acc.parentId === importChargesParent.id) importChargesIds.add(acc.id);
  }
  const sectionAccounts = companyAccounts.filter((acc) => netProfitSection(acc, importChargesIds) === section);
  const accountIds = sectionAccounts.map((a) => a.id);
  const conditions = [
    eq(vouchers.companyId, companyId),
    eq(vouchers.optional, false),
    isNull(vouchers.deletedAt),
    // The fiscal closing journal is not period profit (wave 17 A).
    notFiscalClosingVoucherSql,
    inArray(voucherEntries.ledgerAccountId, accountIds),
  ];
  if (startDate) conditions.push(gte(voucherBookedOnSql, startDate));
  if (endDate) conditions.push(lte(voucherBookedOnSql, endDate));
  const entries =
    accountIds.length > 0
      ? await db
          .select({
            ledgerAccountId: voucherEntries.ledgerAccountId,
            debitAmount: sql`COALESCE("voucher_entries"."base_debit_amount", "voucher_entries"."debit_amount")`.mapWith(
              String
            ),
            creditAmount:
              sql`COALESCE("voucher_entries"."base_credit_amount", "voucher_entries"."credit_amount")`.mapWith(String),
          })
          .from(voucherEntries)
          .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
          .where(and(...conditions))
          .execute()
      : [];
  return accountBreakdown(sectionAccounts, entries, normal);
}

/**
 * The handler of one drill-down: the accounts of one net-profit workbook
 * section (netProfitSection: the shared classifier, so a drill-down lists
 * exactly what the workbook sums). Before wave 13 each filtered by exact type
 * strings ("Income" + subType "Direct Income", "Direct Expense", ...), so
 * mis-cased types, plain "Expense" and Government Taxes were in none.
 */
function drillDownHandler(cacheName: string, section: NetProfitSection, normal: "debit" | "credit") {
  return async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const startDate = queryDate(req.query.startDate);
      const endDate = queryDate(req.query.endDate);
      const cacheKey = `${cacheName}:${companyId}:${startDate ?? ""}:${endDate ?? ""}`;
      const cached = _npsCached(cacheKey);
      if (cached) return res.json(cached);
      const { accounts, total } = await loadNetProfitDrillDown(companyId, section, normal, startDate, endDate);
      const result = { accounts, total };
      _npsSetCache(cacheKey, result);
      res.json(result);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  };
}

export function registerReportsNetProfitStatementRoutes(app: Express) {
  // Net Profit Drill-down: Purchase Accounts
  app.get(
    "/api/reports/net-profit-statement/purchase-accounts",
    requireAuth,
    requireNonPOS,
    drillDownHandler("purchase-accounts", "purchase", "debit")
  );

  // Net Profit Drill-down: Direct Incomes
  app.get(
    "/api/reports/net-profit-statement/direct-incomes",
    requireAuth,
    requireNonPOS,
    drillDownHandler("direct-incomes", "directIncome", "credit")
  );

  // Net Profit Drill-down: Direct Expenses
  app.get(
    "/api/reports/net-profit-statement/direct-expenses",
    requireAuth,
    requireNonPOS,
    drillDownHandler("direct-expenses", "directExpense", "debit")
  );

  // Net Profit Drill-down: Indirect Expenses
  app.get(
    "/api/reports/net-profit-statement/indirect-expenses",
    requireAuth,
    requireNonPOS,
    drillDownHandler("indirect-expenses", "indirectExpense", "debit")
  );
}
