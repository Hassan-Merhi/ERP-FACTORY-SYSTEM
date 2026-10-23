/**
 * Phase 9: intercompany reconciliation and provisional financial consolidation.
 *
 * Read-only and base USD only. Reuses the canonical per-company balance
 * engine, owner-recorded intercompany links, and the group pair matcher.
 * Elimination adjustments exist only in this report, NEVER in vouchers.
 *
 * Financial statements remain PROVISIONAL until every company is certified,
 * period locks, internal sales/expenses and investment/equity eliminations
 * have been reviewed. Do not conflate this GL report with Group Net Position.
 */
import Decimal from "decimal.js";
import { db } from "../../db";
import { storage } from "../../storage";
import { getHistoricalCurrencyReadiness } from "./historicalCurrencyReadiness";
import { loadBalanceRows, toPartyBalance, type BalanceRowKind } from "./balances/ledgerBalanceEngine";
import { financialStatementCategory } from "./unifiedAccountingFoundation";
import { loadCompanyIntercompanyAccounts } from "../../helpers/groupIntercompany";
import { pairIntercompanyBalances, runWithGroupCompanyScope } from "../../helpers/groupNetPosition";

export type FinancialClass =
  "asset" | "liability" | "equity" | "income" | "expense" | "cost_of_sales" | "party" | "unknown";
export interface ConsolidatedRow {
  companyId: number;
  companyName: string;
  companyCode: string;
  accountKind: BalanceRowKind;
  accountId: number | null;
  code: string | null;
  name: string;
  accountType: string | null;
  financialClass: FinancialClass;
  openingSideAssumed: boolean;
  bookedUsd: string;
  periodMovementUsd: string;
  eliminationUsd: string;
  adjustedUsd: string;
}
export interface ConsolidationElimination {
  pairCompanyIds: number[];
  debitCompanyId: number;
  debitAccountId: number;
  creditCompanyId: number;
  creditAccountId: number;
  amountUsd: string;
  narrative: string;
  kind: "intercompany_balance";
  posted: false;
}
export interface ConsolidationPair {
  companyIds: number[];
  companyNames: string[];
  status: string;
  receivables: string;
  payables: string;
  matchedUsd: string;
  differenceUsd: string;
  appliedUsd: string;
  reason: string | null;
}
export interface ConsolidatedCompany {
  companyId: number;
  companyName: string;
  companyCode: string;
  companyType: string;
  baseCurrency: string;
  parentCompanyId: number | null;
  balances: number;
  historicalFxReady: boolean;
  unresolvedCurrencyCount: number;
}
export interface ConsolidationReport {
  asOfDate: string;
  fromDate: string;
  currency: "USD";
  mode: "PROVISIONAL_LEDGER_CONSOLIDATION";
  companies: ConsolidatedCompany[];
  rows: ConsolidatedRow[];
  pairs: ConsolidationPair[];
  eliminations: ConsolidationElimination[];
  totals: {
    grossDebitUsd: string;
    grossCreditUsd: string;
    grossUnbalancedUsd: string;
    eliminationDebitUsd: string;
    eliminationCreditUsd: string;
    adjustedDebitUsd: string;
    adjustedCreditUsd: string;
    adjustedUnbalancedUsd: string;
    assetsUsd: string;
    liabilitiesUsd: string;
    equityUsd: string;
    periodIncomeUsd: string;
    periodCostOfSalesUsd: string;
    periodOperatingExpensesUsd: string;
    periodResultBeforeInternalSalesEliminationUsd: string;
    unmatchedIntercompanyUsd: string;
  };
  certification: {
    historicalFxResolved: boolean;
    unknownBalanceRows: number;
    unknownAmountUsd: string;
    unpairedOrMismatchedPairs: number;
    blockedEliminationPairs: number;
    bookBalanced: boolean;
    certified: false;
    blockers: string[];
  };
  policy: {
    balanceBasis: string;
    eliminationBasis: string;
    unmatched: string;
    internalSales: string;
    fx: string;
    ownership: string;
    netPosition: string;
    period: string;
    status: string;
  };
}
type Company = Awaited<ReturnType<typeof storage.getAllCompanies>>[number];
const decimal = (v: Decimal.Value) => new Decimal(v);
const money = (v: Decimal) => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
const absolute = (v: Decimal) => v.abs();
function classify(kind: BalanceRowKind, type: string | null, code: string | null, signed: Decimal): FinancialClass {
  if (kind === "missingAccount" || kind === "unassigned") return "unknown";
  if (kind === "bank" || kind === "fixedAsset") return "asset";
  if (kind === "customer" || kind === "supplier" || kind === "factorySupplier" || kind === "employee")
    return signed.gte(0) ? "asset" : "liability";
  const category = financialStatementCategory({ code, accountType: type });
  return category === "party" ? (signed.gte(0) ? "asset" : "liability") : category;
}
function statementTotals(rows: ConsolidatedRow[]) {
  const sums = {
    assets: decimal(0),
    liabilities: decimal(0),
    equity: decimal(0),
    income: decimal(0),
    costOfSales: decimal(0),
    expenses: decimal(0),
    unknown: decimal(0),
  };
  for (const item of rows) {
    const closing = decimal(item.adjustedUsd);
    switch (item.financialClass) {
      case "asset":
        if (closing.gte(0)) sums.assets = sums.assets.plus(closing);
        else sums.liabilities = sums.liabilities.plus(closing.negated());
        break;
      case "liability":
        if (closing.lte(0)) sums.liabilities = sums.liabilities.plus(closing.negated());
        else sums.assets = sums.assets.plus(closing);
        break;
      case "equity":
        sums.equity = sums.equity.minus(closing);
        break;
      case "income":
        sums.income = sums.income.minus(item.periodMovementUsd);
        break;
      case "cost_of_sales":
        sums.costOfSales = sums.costOfSales.plus(item.periodMovementUsd);
        break;
      case "expense":
        sums.expenses = sums.expenses.plus(item.periodMovementUsd);
        break;
      case "unknown":
        sums.unknown = sums.unknown.plus(closing);
        break;
    }
  }
  return sums;
}
function splitDebits(rows: ConsolidatedRow[], adjusted: boolean) {
  return rows.reduce(
    (acc, r) => {
      const v = decimal(adjusted ? r.adjustedUsd : r.bookedUsd);
      if (v.gt(0)) acc.debit = acc.debit.plus(v);
      else acc.credit = acc.credit.plus(v.negated());
      return acc;
    },
    { debit: decimal(0), credit: decimal(0) }
  );
}
export async function consolidatedAccountingReport(input: {
  asOfDate: string;
  fromDate: string;
  selectedCompanyIds: readonly number[];
  allowedCompanyIds: ReadonlySet<number>;
}): Promise<ConsolidationReport> {
  const { asOfDate, fromDate } = input;
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const valid = (s: string) =>
    iso.test(s) &&
    !Number.isNaN(new Date(s + "T00:00:00Z").valueOf()) &&
    new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
  if (!valid(asOfDate) || !valid(fromDate) || fromDate > asOfDate)
    throw new Error("Consolidation period must contain two valid dates, fromDate <= asOfDate");
  const ids = [...new Set(input.selectedCompanyIds)];
  if (
    ids.length === 0 ||
    ids.length > 50 ||
    ids.some((id) => !Number.isSafeInteger(id) || id <= 0 || !input.allowedCompanyIds.has(id))
  )
    throw new Error("Select between 1 and 50 companies that you are authorized to view");
  const allCompanies = await storage.getAllCompanies();
  const allowed = allCompanies.filter((c) => input.allowedCompanyIds.has(c.id));
  const members = ids.map((id) => allowed.find((c) => c.id === id));
  if (members.some((m) => !m)) throw new Error("One selected company is not accessible");
  const companies = members as Company[];
  const badCurrency = companies.find((c) => (c.baseCurrency ?? "USD").trim().toUpperCase() !== "USD");
  if (badCurrency)
    throw new Error(
      `Cannot consolidate ${badCurrency.name}: USD functional currency required; translated group base not certified`
    );
  const rows: ConsolidatedRow[] = [];
  const origins: ConsolidatedCompany[] = [];
  const links: Awaited<ReturnType<typeof loadCompanyIntercompanyAccounts>> = [];
  // Serialize member reads. Every member independently re-roots its request
  // and PostgreSQL RLS contexts, never SELECTs sister-company private data
  // while executing under a different member's transaction scope.
  for (const c of companies) {
    const collected = await runWithGroupCompanyScope(c.id, input.allowedCompanyIds, async () => {
      // The balance sheet includes period-close transfers into retained
      // earnings. Period P&L must exclude those *same* closing journals, using
      // the canonical engine's established excludeFiscalClose switch.
      const [balance, incomePeriod, ic, readiness] = await Promise.all([
        loadBalanceRows(db, { companyId: c.id, from: fromDate, asOf: asOfDate }),
        loadBalanceRows(db, { companyId: c.id, from: fromDate, asOf: asOfDate, excludeFiscalClose: true }),
        loadCompanyIntercompanyAccounts(c, companies, asOfDate, { includeExplicitLinks: true }),
        getHistoricalCurrencyReadiness(c.id, asOfDate),
      ]);
      return { balance, incomePeriod, ic, readiness };
    });
    const pnlByKey = new Map(
      collected.incomePeriod.map((r) => [`${r.kind}:${r.id ?? "-"}`, r.periodDebit.minus(r.periodCredit)])
    );
    for (const record of collected.balance) {
      const snapshot = toPartyBalance(record);
      const signed = decimal(snapshot.historicalBaseClosing);
      rows.push({
        companyId: c.id,
        companyName: c.name,
        companyCode: c.code,
        accountKind: record.kind,
        accountId: record.id,
        code: record.code,
        name: record.name,
        accountType: record.accountType,
        financialClass: classify(record.kind, record.accountType, record.code, signed),
        openingSideAssumed: record.openingSideAssumed,
        bookedUsd: money(signed),
        periodMovementUsd: money(pnlByKey.get(`${record.kind}:${record.id ?? "-"}`) ?? decimal(0)),
        eliminationUsd: "0.00",
        adjustedUsd: money(signed),
      });
    }
    links.push(...collected.ic);
    origins.push({
      companyId: c.id,
      companyName: c.name,
      companyCode: c.code,
      companyType: c.companyType,
      baseCurrency: c.baseCurrency ?? "USD",
      parentCompanyId: c.parentCompanyId ?? null,
      balances: collected.balance.length,
      historicalFxReady: collected.readiness.ready,
      unresolvedCurrencyCount:
        collected.readiness.unresolvedEntryCount +
        collected.readiness.unresolvedLedgerOpeningCount +
        collected.readiness.unresolvedBankOpeningCount +
        collected.readiness.unresolvedCustomerOpeningCount +
        collected.readiness.unresolvedSupplierOpeningCount +
        collected.readiness.unresolvedEmployeeOpeningCount +
        collected.readiness.unresolvedFixedAssetCount,
    });
  }
  const balanceByKey = new Map(
    rows
      .filter((r) => r.accountKind === "ledger" && r.accountId !== null)
      .map((r) => [`${r.companyId}:${r.accountId}`, r])
  );
  const paired = pairIntercompanyBalances(
    links.map((account) => ({ ...account, value: Number(account.balance) })),
    companies
  );
  const eliminations: ConsolidationElimination[] = [];
  const pairs: ConsolidationPair[] = [];
  let blocked = 0;
  for (const pair of paired.pairs) {
    let reason: string | null = null,
      applied = decimal(0);
    const matched = decimal(pair.eliminated);
    if (pair.companyIds.length !== 2)
      reason = "Unpaired or multi-company account relationships cannot be safely journal-matched";
    else if (matched.lte(0))
      reason = pair.status === "matched" ? null : "No opposite-side receivable/payable amount to eliminate";
    else {
      // Never assume a negative and positive account in the SAME company are
      // counterparties, and never hide an unknown/misclassified account.
      const entries = pair.accounts.map((a) => {
        const row = balanceByKey.get(`${a.companyId}:${a.accountId}`);
        return { ...a, row, signed: decimal(row?.bookedUsd ?? a.balance) };
      });
      if (entries.some((a) => !a.row || a.row.financialClass === "unknown"))
        reason = "Paired account is not a resolvable ledger financial row";
      else if (entries.some((a) => absolute(a.signed.minus(a.balance)).gt("0.01")))
        reason = "Group linked-account balance disagrees with the canonical trial balance";
      else if (
        pair.companyIds.some((id) => {
          const s = entries.filter((e) => e.companyId === id).map((e) => e.signed);
          return s.some((x) => x.gt(0)) && s.some((x) => x.lt(0));
        })
      )
        reason = "Mixed receivable and payable sides within one company require document-level attribution";
      else {
        let remaining = matched;
        const debtors = entries
          .filter((e) => e.signed.gt(0))
          .sort((a, b) => a.companyId - b.companyId || a.accountId - b.accountId);
        const creditors = entries
          .filter((e) => e.signed.lt(0))
          .sort((a, b) => a.companyId - b.companyId || a.accountId - b.accountId);
        const debitAvail = new Map(debtors.map((e) => [`${e.companyId}:${e.accountId}`, e.signed]));
        const creditAvail = new Map(creditors.map((e) => [`${e.companyId}:${e.accountId}`, e.signed.negated()]));
        for (const debit of debtors) {
          for (const credit of creditors) {
            if (remaining.lte(0)) break;
            if (debit.companyId === credit.companyId) continue;
            const debitKey = `${debit.companyId}:${debit.accountId}`,
              creditKey = `${credit.companyId}:${credit.accountId}`;
            const amount = Decimal.min(remaining, debitAvail.get(debitKey) ?? 0, creditAvail.get(creditKey) ?? 0);
            if (amount.lte(0)) continue;
            eliminations.push({
              pairCompanyIds: pair.companyIds,
              debitCompanyId: credit.companyId,
              debitAccountId: credit.accountId,
              creditCompanyId: debit.companyId,
              creditAccountId: debit.accountId,
              amountUsd: money(amount),
              narrative: `Consolidation-only: Dr intercompany payable ${credit.companyId}/${credit.accountId}, Cr intercompany receivable ${debit.companyId}/${debit.accountId}`,
              kind: "intercompany_balance",
              posted: false,
            });
            debitAvail.set(debitKey, (debitAvail.get(debitKey) ?? decimal(0)).minus(amount));
            creditAvail.set(creditKey, (creditAvail.get(creditKey) ?? decimal(0)).minus(amount));
            remaining = remaining.minus(amount);
            applied = applied.plus(amount);
          }
        }
        if (remaining.gt("0.01")) reason = "Cannot fully map paired elimination into distinct company ledger lines";
      }
    }
    if (reason && matched.gt(0)) applied = decimal(0); // Failed pair: do not claim a partial hypothetical journal
    pairs.push({
      companyIds: pair.companyIds,
      companyNames: pair.companyNames,
      status: pair.status,
      receivables: money(decimal(pair.receivables)),
      payables: money(decimal(pair.payables)),
      matchedUsd: money(matched),
      differenceUsd: money(decimal(pair.difference)),
      appliedUsd: money(applied),
      reason,
    });
    if (reason && matched.gt(0)) blocked++;
  }
  // Apply only balanced dual-leg presentation entries; source company books
  // stay exactly as posted. If a pair couldn't be fully mapped, discard all
  // of its hypothetical entries and report the gap explicitly.
  const blockedPairKeys = new Set(
    pairs.filter((p) => p.reason && decimal(p.matchedUsd).gt(0)).map((p) => p.companyIds.join(":"))
  );
  const retained = eliminations.filter((e) => !blockedPairKeys.has(e.pairCompanyIds.join(":")));
  const delta = new Map<string, Decimal>();
  for (const item of retained) {
    const debitKey = `${item.debitCompanyId}:${item.debitAccountId}`;
    const creditKey = `${item.creditCompanyId}:${item.creditAccountId}`;
    const n = decimal(item.amountUsd);
    delta.set(debitKey, (delta.get(debitKey) ?? decimal(0)).plus(n));
    delta.set(creditKey, (delta.get(creditKey) ?? decimal(0)).minus(n));
  }
  for (const r of rows) {
    const change = r.accountKind === "ledger" ? (delta.get(`${r.companyId}:${r.accountId}`) ?? decimal(0)) : decimal(0);
    r.eliminationUsd = money(change);
    r.adjustedUsd = money(decimal(r.bookedUsd).plus(change));
  }
  const gross = splitDebits(rows, false),
    net = splitDebits(rows, true);
  const summary = statementTotals(rows);
  const unmatched = paired.pairs.reduce((n, p) => n.plus(absolute(decimal(p.difference))), decimal(0));
  const unknownRows = rows.filter((r) => r.financialClass === "unknown" && decimal(r.bookedUsd).abs().gt("0.005"));
  const unresolved = unknownRows.reduce((n, r) => n.plus(absolute(decimal(r.bookedUsd))), decimal(0));
  const fxReady = origins.every((c) => c.historicalFxReady);
  const problems: string[] = [];
  if (!fxReady) problems.push("Unresolved historical currency columns or openings in one or more companies");
  if (unknownRows.length) problems.push("Unattributed/unknown-class trial-balance lines remain");
  if (blocked) problems.push("Some intercompany matches cannot be safely attributed to their GL account sides");
  if (pairs.some((p) => p.status !== "matched"))
    problems.push("Unpaired or mismatched intercompany balances remain visible");
  if (absolute(gross.debit.minus(gross.credit)).gt("0.01"))
    problems.push("Gross trial balance does not reconcile to zero");
  problems.push(
    "Intercompany sales, COGS, income/expense, investment-in-subsidiary and equity eliminations require source-document mapping; NOT automatically posted or assumed"
  );
  problems.push("Financial statements remain provisional; as-of historical openings may have been subsequently edited");
  return {
    asOfDate,
    fromDate,
    currency: "USD",
    mode: "PROVISIONAL_LEDGER_CONSOLIDATION" as const,
    companies: origins,
    rows,
    pairs,
    eliminations: retained,
    totals: {
      grossDebitUsd: money(gross.debit),
      grossCreditUsd: money(gross.credit),
      grossUnbalancedUsd: money(gross.debit.minus(gross.credit)),
      eliminationDebitUsd: money(retained.reduce((n, e) => n.plus(e.amountUsd), decimal(0))),
      eliminationCreditUsd: money(retained.reduce((n, e) => n.plus(e.amountUsd), decimal(0))),
      adjustedDebitUsd: money(net.debit),
      adjustedCreditUsd: money(net.credit),
      adjustedUnbalancedUsd: money(net.debit.minus(net.credit)),
      assetsUsd: money(summary.assets),
      liabilitiesUsd: money(summary.liabilities),
      equityUsd: money(summary.equity),
      periodIncomeUsd: money(summary.income),
      periodCostOfSalesUsd: money(summary.costOfSales),
      periodOperatingExpensesUsd: money(summary.expenses),
      periodResultBeforeInternalSalesEliminationUsd: money(
        summary.income.minus(summary.costOfSales).minus(summary.expenses)
      ),
      unmatchedIntercompanyUsd: money(unmatched),
    },
    certification: {
      historicalFxResolved: fxReady,
      unknownBalanceRows: unknownRows.length,
      unknownAmountUsd: money(unresolved),
      unpairedOrMismatchedPairs: pairs.filter((p) => p.status !== "matched").length,
      blockedEliminationPairs: blocked,
      bookBalanced: absolute(gross.debit.minus(gross.credit)).lte("0.01"),
      certified: false as const,
      blockers: problems,
    },
    policy: {
      balanceBasis:
        "One canonical company-scoped trial-balance read per selected company; historical booked USD debit positive, including master openings.",
      eliminationBasis:
        "Only verified two-company same-pair intercompany receivable/payable opposite balances are offset through read-only matched debit/credit presentation entries. No posted vouchers.",
      unmatched:
        "Every residual and unpaired external or ambiguous relationship remains visible; unsupported matching is excluded rather than forced to zero.",
      internalSales:
        "Income, internal sales/profits, intercompany COGS, stock profit and fixed-asset/ownership eliminations are not certified by balance-pair matching.",
      fx: "Company functional/base currency must be USD; historical FX readiness is reported. No revaluation or foreign-currency restatement is written.",
      ownership:
        "Selected active authorized companies only, independently scoped with each company RLS, no accidental group company inclusion.",
      netPosition:
        "Not the existing Group Net Position. That management report has different company/type exclusions and presentation FX rules; no second elimination is applied to it.",
      period:
        "P&L totals use posted period activity from fromDate to asOfDate. Balance sheet and trial balance use booked USD balances through asOfDate.",
      status:
        "Informational consolidation workpaper, NOT a legally certified consolidated set of financial statements.",
    },
  };
}
