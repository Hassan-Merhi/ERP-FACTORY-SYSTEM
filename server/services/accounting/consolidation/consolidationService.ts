/**
 * Group consolidation (accounting audit phase 26, MC-6).
 *
 * Owner decisions (decided by default, owner can override):
 *   - the group is a parent and every company below it through
 *     companies.parent_company_id (MC-7: the one parent model); every child is
 *     owned 100% by its parent, so there is no non-controlling interest and no
 *     investment/equity elimination;
 *   - presentation currency USD (phase 24, MC-5); a company keeping its books
 *     in another currency is translated at its recorded rate on the as-of date
 *     (rateResolver.resolveUnitsPerUsd), every balance at that closing rate
 *     (all companies are USD today; an average-rate P&L and a translation
 *     reserve are future work), and a company with no recorded rate leaves the
 *     consolidation incomplete (listed, never translated at 1);
 *   - eliminations, by pair: (1) intercompany balances — each company's
 *     intercompany accounts with the counterparty company recorded by the
 *     system (transfer links' intercompany ids, POS configs, the PO-import
 *     parent pair, see helpers/groupIntercompany.ts) are eliminated against
 *     the counterparty's; what does not match stays visible as an
 *     "intercompany difference"; (2) intercompany revenue and cost — income
 *     lines of vouchers that also post to an intercompany account with a group
 *     company, against the counterparty's expense lines of vouchers posting to
 *     its intercompany account with the seller, over the fiscal-year window
 *     (calendar year: phase 27 RP-4), up to the smaller of the two;
 *   - unrealized profit in stock still held by the buyer is NOT eliminated
 *     (documented as future work; it needs the buyer's stock at intercompany
 *     cost);
 *   - balance check: every company's own trial balance, the eliminations
 *     (each balanced by construction) and the consolidated trial balance;
 *     `balanced` is false, with the difference, when any of them is not.
 *
 * Every company is read in its own database scope (like group net position);
 * the caller authorizes the user for every company of the group.
 */
import Decimal from "decimal.js";
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { companies, voucherEntries, vouchers } from "@shared/schema";

import { db } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { loadCompanyIntercompanyAccounts, type IntercompanyAccount } from "../../../helpers/groupIntercompany";
import { classifyAccountType } from "../accountClassification";
import { buildTrialBalance, type TrialBalanceRow } from "../integrity/trialBalance";
import { GROUP_PRESENTATION_CURRENCY } from "../fx/groupPresentationCurrency";
import { resolveUnitsPerUsd } from "../fx/rateResolver";
import {
  getCompanyRequestRuntimeContext,
  runWithCompanyRequestRuntimeContext,
} from "../../security/companyRequestRuntimeContext";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../../security/databaseScopeRuntimeContext";

const ZERO = new MoneyDecimal(0);
const money = (value: Decimal) => value.toFixed(2);

export class ConsolidationRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "ConsolidationRefusal";
  }
}

export type ConsolidationClass = "asset" | "liability" | "equity" | "income" | "expense" | "unknown";

export interface ConsolidationRow {
  companyId: number;
  kind: TrialBalanceRow["kind"] | "translationRounding";
  id: number | null;
  code: string | null;
  name: string;
  accountType: string | null;
  accountClass: ConsolidationClass;
  /** Translated closing balance, debit positive. */
  balance: string;
  elimination: string;
  consolidated: string;
}

export interface EliminationLine {
  companyId: number;
  accountId: number;
  accountName: string;
  /** Debit positive. */
  amount: string;
}

export interface Elimination {
  type: "intercompany-balance" | "intercompany-revenue-cost";
  companyIds: [number, number];
  matched: string;
  /** What the pair leaves unmatched (shown, never eliminated). */
  difference: string;
  lines: EliminationLine[];
}

export interface ConsolidationResult {
  parentCompanyId: number;
  asOf: string;
  from: string;
  presentationCurrency: typeof GROUP_PRESENTATION_CURRENCY;
  ownership: { companyId: number; name: string; parentCompanyId: number | null; ownershipPercent: "100" }[];
  companies: {
    companyId: number;
    name: string;
    baseCurrency: string;
    unitsPerUsd: string | null;
    rateDate: string | null;
    translated: boolean;
    trialBalanceBalanced: boolean;
    trialBalanceDifference: string;
  }[];
  rows: ConsolidationRow[];
  eliminations: Elimination[];
  unmatchedIntercompany: {
    companyId: number;
    accountId: number;
    accountName: string;
    balance: string;
    reason: string;
  }[];
  totals: { debit: string; credit: string; difference: string; eliminationsBalanced: boolean };
  balanceSheet: { assets: string; liabilities: string; equity: string; currentEarnings: string; difference: string };
  profitAndLoss: {
    from: string;
    to: string;
    income: string;
    expense: string;
    eliminatedIncome: string;
    eliminatedExpense: string;
    netIncome: string;
  };
  balanced: boolean;
  complete: boolean;
  notes: string[];
}

interface CompanyRow {
  id: number;
  name: string;
  code: string;
  parentCompanyId: number | null;
  baseCurrency: string | null;
  active: boolean;
}

/** The parent and every company below it (cycle-safe). */
export function groupCompanies(all: readonly CompanyRow[], parentCompanyId: number): CompanyRow[] {
  const byParent = new Map<number, CompanyRow[]>();
  for (const company of all) {
    if (!company.parentCompanyId) continue;
    byParent.set(company.parentCompanyId, [...(byParent.get(company.parentCompanyId) ?? []), company]);
  }
  const root = all.find((company) => company.id === parentCompanyId);
  if (!root) return [];
  const seen = new Set<number>([root.id]);
  const out = [root];
  for (let index = 0; index < out.length; index += 1) {
    for (const child of byParent.get(out[index].id) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child);
    }
  }
  return out;
}

function inCompanyScope<T>(companyId: number, groupIds: readonly number[], run: () => Promise<T>): Promise<T> {
  const others = groupIds.filter((id) => id !== companyId);
  const scope = createTenantDatabaseScope(companyId, others, "active-company");
  const request = getCompanyRequestRuntimeContext();
  const inDb = () => runWithDatabaseScopeRuntimeContext(scope, run);
  if (!request) return inDb();
  return runWithCompanyRequestRuntimeContext({ ...request, companyId, authorizedCompanyIds: others }, inDb);
}

function rowClass(row: TrialBalanceRow, signed: Decimal): ConsolidationClass {
  if (row.kind === "ledger") {
    const accountClass = classifyAccountType(row.accountType);
    if (accountClass === "party") return signed.isNegative() ? "liability" : "asset";
    return accountClass;
  }
  if (row.kind === "bank" || row.kind === "fixedAsset") return "asset";
  if (row.kind === "missingAccount" || row.kind === "unassigned") return "unknown";
  // Parties (customers, suppliers, employees, factory suppliers): by balance.
  return signed.isNegative() ? "liability" : "asset";
}

/** Eliminates `target` (signed) from `accounts`; the whole side when it equals their total. */
function eliminateSide(accounts: readonly IntercompanyAccount[], target: Decimal): Map<number, Decimal> {
  const out = new Map<number, Decimal>();
  const total = accounts.reduce((sum, account) => sum.plus(account.balance), ZERO);
  if (target.isZero()) return out;
  if (target.equals(total)) {
    for (const account of accounts) out.set(account.accountId, toMoney(account.balance).negated());
    return out;
  }
  let remaining = target.abs();
  const sign = target.isNegative() ? -1 : 1;
  for (const account of [...accounts].sort((a, b) => a.accountId - b.accountId)) {
    const balance = toMoney(account.balance);
    if (remaining.isZero() || balance.isZero() || (balance.isNegative() ? -1 : 1) !== sign) continue;
    const take = Decimal.min(remaining, balance.abs());
    out.set(account.accountId, take.times(-sign));
    remaining = remaining.minus(take);
  }
  return out;
}

interface IcPnl {
  /** seller → buyer → accountId → income (credit positive) */
  income: Map<number, Map<number, Map<number, Decimal>>>;
  /** buyer → seller → accountId → expense (debit positive) */
  expense: Map<number, Map<number, Map<number, Decimal>>>;
}

function addNested(map: Map<number, Map<number, Map<number, Decimal>>>, a: number, b: number, id: number, v: Decimal) {
  const level1 = map.get(a) ?? new Map<number, Map<number, Decimal>>();
  const level2 = level1.get(b) ?? new Map<number, Decimal>();
  level2.set(id, (level2.get(id) ?? ZERO).plus(v));
  level1.set(b, level2);
  map.set(a, level1);
}

/** Income and expense lines of a company's vouchers that also post to an intercompany account with a group company. */
async function loadIcPnlLines(
  companyId: number,
  icAccounts: readonly IntercompanyAccount[],
  accountClassById: ReadonlyMap<number, ConsolidationClass>,
  window: { from: string; to: string },
  pnl: IcPnl
): Promise<void> {
  const counterpartyByAccount = new Map<number, number>();
  for (const account of icAccounts) {
    if (account.counterpartyCompanyIds.length === 1) {
      counterpartyByAccount.set(account.accountId, account.counterpartyCompanyIds[0]);
    }
  }
  if (counterpartyByAccount.size === 0) return;
  const booked = sql`COALESCE(${vouchers.effectiveDate}, ${vouchers.voucherDate})`;
  const icLines = await db
    .select({ voucherId: voucherEntries.voucherId, ledgerAccountId: voucherEntries.ledgerAccountId })
    .from(voucherEntries)
    .innerJoin(vouchers, eq(vouchers.id, voucherEntries.voucherId))
    .where(
      and(
        eq(vouchers.companyId, companyId),
        isNull(vouchers.deletedAt),
        sql`COALESCE(${vouchers.optional}, false) = false`,
        inArray(voucherEntries.ledgerAccountId, [...counterpartyByAccount.keys()]),
        gte(booked, window.from),
        lte(booked, window.to)
      )
    );
  const counterpartyByVoucher = new Map<number, number>();
  for (const line of icLines) {
    const counterparty = counterpartyByAccount.get(Number(line.ledgerAccountId));
    if (counterparty !== undefined && !counterpartyByVoucher.has(line.voucherId)) {
      counterpartyByVoucher.set(line.voucherId, counterparty);
    }
  }
  if (counterpartyByVoucher.size === 0) return;
  const lines = await db
    .select({
      voucherId: voucherEntries.voucherId,
      ledgerAccountId: voucherEntries.ledgerAccountId,
      debit: voucherEntries.debitAmount,
      credit: voucherEntries.creditAmount,
    })
    .from(voucherEntries)
    .where(inArray(voucherEntries.voucherId, [...counterpartyByVoucher.keys()]));
  for (const line of lines) {
    const accountId = Number(line.ledgerAccountId);
    if (!accountId) continue;
    const counterparty = counterpartyByVoucher.get(line.voucherId)!;
    const net = toMoney(line.debit).minus(toMoney(line.credit));
    const accountClass = accountClassById.get(accountId);
    if (accountClass === "income") addNested(pnl.income, companyId, counterparty, accountId, net.negated());
    if (accountClass === "expense") addNested(pnl.expense, companyId, counterparty, accountId, net);
  }
}

/** Takes `target` from the per-account amounts (positive), in account order. */
function allocate(amounts: ReadonlyMap<number, Decimal>, target: Decimal): Map<number, Decimal> {
  const out = new Map<number, Decimal>();
  let remaining = target;
  for (const [accountId, amount] of [...amounts.entries()].sort((a, b) => a[0] - b[0])) {
    if (!remaining.gt(0) || !amount.gt(0)) continue;
    const take = Decimal.min(remaining, amount);
    out.set(accountId, take);
    remaining = remaining.minus(take);
  }
  return out;
}

export async function buildConsolidation(input: {
  parentCompanyId: number;
  asOf: string;
  from?: string | null;
  /** Companies the user may read; every group company must be in it. */
  allowedCompanyIds?: ReadonlySet<number>;
}): Promise<ConsolidationResult> {
  const allCompanies = (await db
    .select({
      id: companies.id,
      name: companies.name,
      code: companies.code,
      parentCompanyId: companies.parentCompanyId,
      baseCurrency: companies.baseCurrency,
      active: companies.active,
    })
    .from(companies)) as CompanyRow[];
  const group = groupCompanies(allCompanies, input.parentCompanyId).filter((company) => company.active !== false);
  if (group.length === 0)
    throw new ConsolidationRefusal(404, "CONSOLIDATION_PARENT_NOT_FOUND", "Parent company not found");
  const groupIds = group.map((company) => company.id);
  if (input.allowedCompanyIds) {
    const missing = groupIds.filter((id) => !input.allowedCompanyIds!.has(id));
    if (missing.length > 0) {
      throw new ConsolidationRefusal(403, "CONSOLIDATION_ACCESS_DENIED", "No access to every company of the group", {
        companyIds: missing,
      });
    }
  }
  const from = input.from || `${input.asOf.slice(0, 4)}-01-01`;
  const window = { from, to: input.asOf };
  const notes: string[] = [
    "Every subsidiary is owned 100% by its parent: no non-controlling interest.",
    "Unrealized profit on intercompany stock still held by the buyer is not eliminated (future work).",
  ];

  const rows: ConsolidationRow[] = [];
  const companyInfo: ConsolidationResult["companies"] = [];
  const icByCompany = new Map<number, IntercompanyAccount[]>();
  const classByCompany = new Map<number, Map<number, ConsolidationClass>>();
  const factorByCompany = new Map<number, Decimal | null>();
  const pnl: IcPnl = { income: new Map(), expense: new Map() };
  let complete = true;

  for (const company of group) {
    await inCompanyScope(company.id, groupIds, async () => {
      const baseCurrency = String(company.baseCurrency || "USD").toUpperCase();
      const rate =
        baseCurrency === GROUP_PRESENTATION_CURRENCY
          ? { unitsPerUsd: "1", effectiveDate: input.asOf }
          : await resolveUnitsPerUsd(db, company.id, baseCurrency, input.asOf);
      const factor = rate ? new MoneyDecimal(1).div(toMoney(rate.unitsPerUsd)) : null;
      factorByCompany.set(company.id, factor);
      if (!factor) complete = false;
      const trialBalance = await buildTrialBalance(company.id, input.asOf);
      companyInfo.push({
        companyId: company.id,
        name: company.name,
        baseCurrency,
        unitsPerUsd: rate?.unitsPerUsd ?? null,
        rateDate: rate?.effectiveDate ?? null,
        translated: !!factor,
        trialBalanceBalanced: trialBalance.balanced,
        trialBalanceDifference: trialBalance.unexplainedDifference,
      });
      const classes = new Map<number, ConsolidationClass>();
      let translatedNet = ZERO;
      for (const row of trialBalance.rows) {
        const signed = toMoney(row.closingDebit).minus(toMoney(row.closingCredit));
        const translated = factor ? signed.times(factor).toDecimalPlaces(2, Decimal.ROUND_HALF_UP) : ZERO;
        translatedNet = translatedNet.plus(translated);
        const accountClass = rowClass(row, signed);
        if (row.kind === "ledger" && row.id) classes.set(row.id, accountClass);
        rows.push({
          companyId: company.id,
          kind: row.kind,
          id: row.id,
          code: row.code,
          name: row.name,
          accountType: row.accountType,
          accountClass,
          balance: money(translated),
          elimination: "0.00",
          consolidated: money(translated),
        });
      }
      // Rounding of the per-row translation, so a balanced company stays balanced.
      const ownNet = toMoney(trialBalance.totals.closingDebit).minus(toMoney(trialBalance.totals.closingCredit));
      const expectedNet = factor ? ownNet.times(factor).toDecimalPlaces(2, Decimal.ROUND_HALF_UP) : ZERO;
      const rounding = expectedNet.minus(translatedNet);
      if (factor && !rounding.isZero()) {
        rows.push({
          companyId: company.id,
          kind: "translationRounding",
          id: null,
          code: null,
          name: "Translation rounding",
          accountType: null,
          accountClass: "equity",
          balance: money(rounding),
          elimination: "0.00",
          consolidated: money(rounding),
        });
      }
      classByCompany.set(company.id, classes);
      const icAccounts = (await loadCompanyIntercompanyAccounts(company, allCompanies, input.asOf)).map((account) => ({
        ...account,
        counterpartyCompanyIds: account.counterpartyCompanyIds.filter((id) => groupIds.includes(id)),
        balance: factor
          ? money(toMoney(account.balance).times(factor).toDecimalPlaces(2, Decimal.ROUND_HALF_UP))
          : "0.00",
      }));
      icByCompany.set(company.id, icAccounts);
      if (factor) await loadIcPnlLines(company.id, icAccounts, classes, window, pnl);
    });
  }

  const rowIndex = new Map<string, ConsolidationRow>();
  for (const row of rows) if (row.kind === "ledger" && row.id) rowIndex.set(`${row.companyId}:${row.id}`, row);
  const eliminations: Elimination[] = [];
  const unmatched: ConsolidationResult["unmatchedIntercompany"] = [];
  const applyLine = (companyId: number, accountId: number, amount: Decimal, lines: EliminationLine[]) => {
    if (amount.isZero()) return;
    const row = rowIndex.get(`${companyId}:${accountId}`);
    if (!row) return;
    row.elimination = money(toMoney(row.elimination).plus(amount));
    row.consolidated = money(toMoney(row.balance).plus(row.elimination));
    lines.push({ companyId, accountId, accountName: row.name, amount: money(amount) });
  };

  // (1) Intercompany balances, by pair.
  for (const [companyId, accounts] of icByCompany) {
    for (const account of accounts) {
      if (account.counterpartyCompanyIds.length !== 1 && !toMoney(account.balance).isZero()) {
        unmatched.push({
          companyId,
          accountId: account.accountId,
          accountName: account.accountName,
          balance: account.balance,
          reason:
            account.counterpartyCompanyIds.length === 0
              ? "No counterparty company recorded for this intercompany account."
              : "The account is recorded with more than one counterparty company.",
        });
      }
    }
  }
  for (let i = 0; i < groupIds.length; i += 1) {
    for (let j = i + 1; j < groupIds.length; j += 1) {
      const a = groupIds[i];
      const b = groupIds[j];
      const sideA = (icByCompany.get(a) ?? []).filter(
        (x) => x.counterpartyCompanyIds.length === 1 && x.counterpartyCompanyIds[0] === b
      );
      const sideB = (icByCompany.get(b) ?? []).filter(
        (x) => x.counterpartyCompanyIds.length === 1 && x.counterpartyCompanyIds[0] === a
      );
      if (sideA.length === 0 && sideB.length === 0) continue;
      const totalA = sideA.reduce((sum, x) => sum.plus(x.balance), ZERO);
      const totalB = sideB.reduce((sum, x) => sum.plus(x.balance), ZERO);
      const opposite = !totalA.isZero() && !totalB.isZero() && totalA.isNegative() !== totalB.isNegative();
      const matched = opposite ? Decimal.min(totalA.abs(), totalB.abs()) : ZERO;
      const lines: EliminationLine[] = [];
      if (matched.gt(0)) {
        const targetA = totalA.isNegative() ? matched.negated() : matched;
        const targetB = targetA.negated();
        for (const [accountId, amount] of eliminateSide(sideA, targetA)) applyLine(a, accountId, amount, lines);
        for (const [accountId, amount] of eliminateSide(sideB, targetB)) applyLine(b, accountId, amount, lines);
      }
      eliminations.push({
        type: "intercompany-balance",
        companyIds: [a, b],
        matched: money(matched),
        difference: money(totalA.plus(totalB)),
        lines,
      });
    }
  }

  // (2) Intercompany revenue and cost, by seller → buyer.
  let eliminatedIncome = ZERO;
  let eliminatedExpense = ZERO;
  for (const [seller, byBuyer] of pnl.income) {
    for (const [buyer, incomeByAccount] of byBuyer) {
      const expenseByAccount = pnl.expense.get(buyer)?.get(seller);
      if (!expenseByAccount) continue;
      const income = [...incomeByAccount.values()].reduce((sum, v) => sum.plus(v), ZERO);
      const expense = [...expenseByAccount.values()].reduce((sum, v) => sum.plus(v), ZERO);
      const matched = Decimal.min(income, expense);
      if (!matched.gt(0)) continue;
      const lines: EliminationLine[] = [];
      for (const [accountId, amount] of allocate(incomeByAccount, matched)) applyLine(seller, accountId, amount, lines);
      for (const [accountId, amount] of allocate(expenseByAccount, matched))
        applyLine(buyer, accountId, amount.negated(), lines);
      eliminatedIncome = eliminatedIncome.plus(matched);
      eliminatedExpense = eliminatedExpense.plus(matched);
      eliminations.push({
        type: "intercompany-revenue-cost",
        companyIds: [seller, buyer],
        matched: money(matched),
        difference: money(income.minus(expense)),
        lines,
      });
    }
  }

  const eliminationsBalanced = eliminations.every((elimination) =>
    elimination.lines.reduce((sum, line) => sum.plus(line.amount), ZERO).isZero()
  );
  let debit = ZERO;
  let credit = ZERO;
  const byClass = new Map<ConsolidationClass, Decimal>();
  for (const row of rows) {
    const value = toMoney(row.consolidated);
    if (value.isNegative()) credit = credit.plus(value.negated());
    else debit = debit.plus(value);
    byClass.set(row.accountClass, (byClass.get(row.accountClass) ?? ZERO).plus(value));
  }
  const cls = (key: ConsolidationClass) => byClass.get(key) ?? ZERO;
  const assets = cls("asset");
  const liabilities = cls("liability").negated();
  const equity = cls("equity").negated();
  const currentEarnings = cls("income").negated().minus(cls("expense"));
  const unknown = cls("unknown");
  if (!unknown.isZero())
    notes.push(`Rows of unknown class (missing accounts, unassigned lines) total ${money(unknown)}.`);
  const companiesBalanced = companyInfo.every((company) => company.trialBalanceBalanced);
  const difference = debit.minus(credit);

  // The P&L window: income and expense lines booked in [from, asOf] (translated).
  const pnlTotals = await periodPnl(group, factorByCompany, classByCompany, window, groupIds);

  return {
    parentCompanyId: input.parentCompanyId,
    asOf: input.asOf,
    from,
    presentationCurrency: GROUP_PRESENTATION_CURRENCY,
    ownership: group.map((company) => ({
      companyId: company.id,
      name: company.name,
      parentCompanyId: company.id === input.parentCompanyId ? null : company.parentCompanyId,
      ownershipPercent: "100" as const,
    })),
    companies: companyInfo,
    rows,
    eliminations,
    unmatchedIntercompany: unmatched,
    totals: { debit: money(debit), credit: money(credit), difference: money(difference), eliminationsBalanced },
    balanceSheet: {
      assets: money(assets),
      liabilities: money(liabilities),
      equity: money(equity),
      currentEarnings: money(currentEarnings),
      difference: money(assets.minus(liabilities).minus(equity).minus(currentEarnings).minus(unknown)),
    },
    profitAndLoss: {
      from,
      to: input.asOf,
      income: money(pnlTotals.income),
      expense: money(pnlTotals.expense),
      eliminatedIncome: money(eliminatedIncome),
      eliminatedExpense: money(eliminatedExpense),
      netIncome: money(pnlTotals.income.minus(eliminatedIncome).minus(pnlTotals.expense.minus(eliminatedExpense))),
    },
    balanced: difference.isZero() && eliminationsBalanced && companiesBalanced && complete,
    complete,
    notes,
  };
}

async function periodPnl(
  group: readonly CompanyRow[],
  factorByCompany: ReadonlyMap<number, Decimal | null>,
  classByCompany: ReadonlyMap<number, ReadonlyMap<number, ConsolidationClass>>,
  window: { from: string; to: string },
  groupIds: readonly number[]
): Promise<{ income: Decimal; expense: Decimal }> {
  let income = ZERO;
  let expense = ZERO;
  for (const company of group) {
    const factor = factorByCompany.get(company.id);
    const classes = classByCompany.get(company.id);
    if (!factor || !classes) continue;
    const pnlIds = [...classes.entries()]
      .filter(([, accountClass]) => accountClass === "income" || accountClass === "expense")
      .map(([id]) => id);
    if (pnlIds.length === 0) continue;
    await inCompanyScope(company.id, groupIds, async () => {
      const booked = sql`COALESCE(${vouchers.effectiveDate}, ${vouchers.voucherDate})`;
      const lines = await db
        .select({
          ledgerAccountId: voucherEntries.ledgerAccountId,
          debit: sql`COALESCE(SUM(${voucherEntries.debitAmount}), 0)`.mapWith(String),
          credit: sql`COALESCE(SUM(${voucherEntries.creditAmount}), 0)`.mapWith(String),
        })
        .from(voucherEntries)
        .innerJoin(vouchers, eq(vouchers.id, voucherEntries.voucherId))
        .where(
          and(
            eq(vouchers.companyId, company.id),
            isNull(vouchers.deletedAt),
            sql`COALESCE(${vouchers.optional}, false) = false`,
            inArray(voucherEntries.ledgerAccountId, pnlIds),
            gte(booked, window.from),
            lte(booked, window.to)
          )
        )
        .groupBy(voucherEntries.ledgerAccountId);
      for (const line of lines) {
        const net = toMoney(line.debit).minus(toMoney(line.credit)).times(factor);
        if (classes.get(Number(line.ledgerAccountId)) === "income") income = income.minus(net);
        else expense = expense.plus(net);
      }
    });
  }
  return { income: income.toDecimalPlaces(2), expense: expense.toDecimalPlaces(2) };
}
