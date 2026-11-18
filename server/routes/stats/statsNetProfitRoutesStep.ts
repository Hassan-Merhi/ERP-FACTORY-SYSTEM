// Extracted from ./statsNetProfitRoutes.ts: a stage of statsNetProfitRoutes.
import { isExcludedFromCompany12ManagementReports } from "../../lib/payrollOverpaymentReporting";
import { db } from "../../db";
import { exchangeRates } from "@shared/schema";
import { eq, and, desc } from "drizzle-orm";
import { classifyEquityAccounts, classifyNetPositionAccounts } from "../../netPositionHelper";
import { _getCached } from "../../services/shared/ttlCache";
import { loadNetProfitData } from "./netProfitDataLoad";
import { getNetPositionCurrencySummary } from "../../services/accounting/netPositionCurrency";
import { loadNetPositionParties } from "../../services/accounting/balances/netPositionParties";
import { storage } from "../../storage";
import { isInventoryValuationOnlyAccount } from "../../lib/inventoryPnlAccounts";
import { ledgerCarriesStock } from "../../services/accounting/perpetualInventory/reportBasis";
import { minusMoney, roundCents, toMoney } from "../../lib/money";
import type { Request, Response } from "express";

export async function statsNetProfitRoutesStep({ req, res }: { req: Request; res: Response }) {
  const companyId = req.session.currentCompanyId;
  if (!companyId) {
    return { done: true as const, value: res.status(400).json({ message: "No company selected" }) };
  }

  // Balance-sheet "as of" date — cumulative approach (everything up to toDate)
  // fromDate is accepted but intentionally ignored for balance-sheet accounts;
  // the balance sheet is always a point-in-time snapshot (as of toDate), not a period.
  const toDate = req.query.toDate ? String(req.query.toDate) : null;

  // Rounding helper — defined early so it is available throughout the handler
  const round2 = roundCents;

  // Fetch company to know its base currency (CFA vs USD)
  // Check the 30-second TTL cache before touching the DB
  // Monthly SP display uses the business day rather than the Render server's
  // UTC midnight. GC operates in Lebanon unless a company timezone is set.
  const localDateParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Beirut",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const localPart = (key: string) => localDateParts.find((part) => part.type === key)?.value || "";
  const businessToday = `${localPart("year")}-${localPart("month")}-${localPart("day")}`;
  const _cacheKey = `net-profit:${companyId}:${toDate || ""}:${toDate ? "historical" : businessToday.slice(0, 7)}`;
  // Live financial USD presentation depends on a company-specific dated
  // rate that may have been saved on another Render worker. A process-
  // local TTL is not a reliable rate revision fence; rebuild live reads.
  // Dated historical snapshots use locked posted USD and may remain cached.
  const _cached = toDate ? _getCached(_cacheKey) : null;
  if (_cached) return { done: true as const, value: res.json(_cached) };
  if (!toDate) res.setHeader?.("Cache-Control", "private, no-store");

  // All the report's raw inputs - company row, ledger accounts and the three
  // grouped balance maps - are loaded in ./netProfitDataLoad.
  const [netPositionCurrency, reportData, companySettings] = await Promise.all([
    getNetPositionCurrencySummary(companyId, toDate),
    // Live P&L is as-of the Beirut business day. All-time supplier/creditor
    // and balance-sheet maps remain unchanged in the data loader.
    loadNetProfitData(companyId, toDate, businessToday),
    storage.getCompanySettings(companyId),
  ]);
  const { companyRecord, companyAccounts, companyBaseCurrency, accountBalances, profitAndLossBalances } = reportData;

  // ============ NET POSITION CALCULATION ============
  // Uses shared helper (netPositionHelper.ts) – single source of truth for
  // the asset vs liability classification formula used by both ERP and Factory.

  // One supplier-inclusion rule (wave 13, owner decision 2): supplier payables
  // count in the posting company, parent link or not.
  const shouldIncludeSuppliers = true; // ERP_NET_POSITION_INCLUDES_SUPPLIERS (netPositionParties.ts)
  // Build excluded-from-expenses set (needed for the P&L expense pass below)
  const importChargesParent = companyAccounts.find((acc) => acc.code === "IMPORT_CHARGES");
  const excludedFromExpenses = new Set<number>();
  if (importChargesParent) {
    excludedFromExpenses.add(importChargesParent.id);
    for (const acc of companyAccounts) {
      if (acc.parentId === importChargesParent.id) excludedFromExpenses.add(acc.id);
    }
  }
  for (const acc of companyAccounts) {
    if (acc.code === "PURCHASES" || acc.code?.startsWith("PURCHASES_") || isInventoryValuationOnlyAccount(acc)) {
      excludedFromExpenses.add(acc.id);
    }
  }

  // 1. Classify balance-sheet accounts (assets vs liabilities) via shared helper.
  // SP formula: What We Have = Cash + Customer A/R + Stock (from inventory table); What We Owe includes supplier cash payable and Loan/Loans balances.
  // Other SP ledger accounts (OTW, prepaid, intercompany, clearing accounts, etc.) remain excluded unless explicitly part of the formula.
  // For non-SP: exclude sp_stock (inventory table is authoritative) and sp_cost_clearing (double-counts).
  const isSupplierPartner = companyRecord?.companyType === "supplier_partner";
  const equityIncludedInNetPosition = isSupplierPartner;
  // Customers, suppliers and employees come from the one balance engine
  // (services/accounting/balances/netPositionParties.ts): effective-date
  // basis, master openings with their side, each line counted once.
  // Supplier-partner companies exclude customers by design. Amounts not in
  // the ledger are reported in `notInLedger`, never in the totals.
  const parties = await loadNetPositionParties(companyId, {
    asOf: toDate,
    customers: !isSupplierPartner,
    suppliers: shouldIncludeSuppliers,
    factorySuppliers: false,
    employees: "erp",
    codes: "erp",
    payrollCurrentBalanceMemo: true,
    banks: true,
    missingAccounts: false,
  });
  // Ledger accounts a customer owns are left out: the engine rolls them
  // into the customer line added below.
  const accountsForClassify = (
    isSupplierPartner
      ? companyAccounts.filter(
          (a) =>
            a.accountType === "Cash" ||
            a.accountType === "Loan" ||
            a.accountType === "Loans" ||
            a.subType === "sp_payable"
        )
      : companyAccounts.filter((a) => a.subType !== "sp_stock" && a.subType !== "sp_cost_clearing")
  ).filter((a) => !parties.customerLedgerIds.has(a.id) && !isExcludedFromCompany12ManagementReports(companyId, a));
  // Perpetual inventory (wave 8.5): from the cut-over the ledger carries the stock.
  const ledgerStock = !isSupplierPartner && (await ledgerCarriesStock(companyId, toDate));
  const classified = classifyNetPositionAccounts(accountsForClassify, accountBalances, {
    includeSupplierTypeAccounts: shouldIncludeSuppliers,
    ledgerStockAccounts: ledgerStock,
  });
  const equity = classifyEquityAccounts(companyAccounts, accountBalances);
  let forUsTotal = classified.forUsTotal;
  let onUsTotal = classified.onUsTotal;
  const forUsAccounts = classified.forUsAccounts;
  const onUsAccounts = classified.onUsAccounts;
  const categoryTotals = classified.categoryTotals;

  // Exclude ledger-based "Accrued Rent Payable" — the computed rentPayable
  // (expected − paid up to asOf) is always more accurate than the accrual-
  // scheduler-dependent ledger account. Strip it here before any totals are used.
  for (let i = onUsAccounts.length - 1; i >= 0; i--) {
    const a = onUsAccounts[i];
    const nameLower = (a.name || "").toLowerCase();
    const code = (a.code || "").toUpperCase();
    if (nameLower.includes("accrued rent") || code === "ACCR-RENT-PAY" || code === "ACCRUED_RENT_PAYABLE") {
      onUsTotal = round2(minusMoney(onUsTotal, a.value));
      const catKey = `liability_${a.category || a.name}`;
      if (categoryTotals[catKey] !== undefined) {
        categoryTotals[catKey] = round2(minusMoney(categoryTotals[catKey], a.value));
        if (Math.abs(categoryTotals[catKey]) < 0.01) delete categoryTotals[catKey];
      }
      onUsAccounts.splice(i, 1);
    }
  }

  // Exclude ledger-based "Prepaid Rent" accounts — the rental-shops calculation
  // below (propertyContracts: paid − expected) is always the authoritative source
  // for prepaid rent. Keeping both would double-count it.
  for (let i = forUsAccounts.length - 1; i >= 0; i--) {
    const a = forUsAccounts[i];
    const nameLower = (a.name || "").toLowerCase();
    if (nameLower.includes("prepaid rent")) {
      forUsTotal = round2(minusMoney(forUsTotal, a.value));
      // Subtract from whichever category bucket it landed in (typically "asset_Asset")
      const catKey = `asset_${a.category}`;
      if (categoryTotals[catKey] !== undefined) {
        categoryTotals[catKey] = round2(minusMoney(categoryTotals[catKey], a.value));
        if (Math.abs(categoryTotals[catKey]) < 0.01) delete categoryTotals[catKey];
      }
      forUsAccounts.splice(i, 1);
    }
  }

  // CFA revaluation: Cash accounts hold physical CFA units whose USD worth changes with the rate.
  // Expenses, loans, receivables are locked at their historical CFA values — do NOT revalue them.
  // Only revalue if this company's base currency IS CFA (not a USD company that happens to have
  // a CFA exchange rate stored for reference/inter-company purposes).
  const cfaRateRows =
    companyBaseCurrency === "CFA"
      ? await db
          .select({ rate: exchangeRates.rate })
          .from(exchangeRates)
          .where(
            and(
              eq(exchangeRates.companyId, companyId),
              eq(exchangeRates.fromCurrency, "USD"),
              eq(exchangeRates.toCurrency, "CFA")
            )
          )
          .orderBy(desc(exchangeRates.effectiveDate))
          .limit(1)
      : [];
  const currentCfaRate = cfaRateRows.length > 0 ? toMoney(cfaRateRows[0].rate).toNumber() : 0;

  // Legacy non-base balances are intentionally not revalued here. Only the
  // dedicated cash/bank middleware may apply the current rate, and it
  // exposes null/provisional values when the native history is unresolved.

  // 2. Process income and expense accounts for the P&L breakdown (ERP-specific)
  //    The helper skips expense/income types; we handle them here, classified
  //    by the shared classifier (Indirect Income in either storage form,
  //    Revenue and mis-cased types are income; Government Taxes is an expense).
  let expensesTotal = 0;
  let incomeTotal = 0;
  const expensesAccounts: { id: number; name: string; code: string; value: number; category: string }[] = [];
  const incomeAccounts: { id: number; name: string; code: string; value: number; category: string }[] = [];

  return {
    done: false as const,
    companyId,
    toDate,
    round2,
    businessToday,
    _cacheKey,
    netPositionCurrency,
    companySettings,
    companyRecord,
    companyAccounts,
    accountBalances,
    profitAndLossBalances,
    excludedFromExpenses,
    equityIncludedInNetPosition,
    parties,
    ledgerStock,
    equity,
    forUsTotal,
    onUsTotal,
    forUsAccounts,
    onUsAccounts,
    categoryTotals,
    currentCfaRate,
    expensesTotal,
    incomeTotal,
    expensesAccounts,
    incomeAccounts,
  };
}
