/**
 * Cash flow statement, indirect method (accounting audit phase 27, RP-2).
 *
 * Owner decision (decided by default, owner can override): cash is the bank
 * accounts and the Cash/Bank ledger accounts of class asset
 * (classificationMap.isCashRow). An overdraft is negative cash here (it is a
 * current liability on the balance sheet).
 *
 * One engine scan (loadBalanceRows) over [from, to] with the fiscal closing
 * journals left out (they move profit to retained earnings and touch no cash),
 * so net profit is the P&L's for the same range:
 *   - operating: net profit (income/expense rows), depreciation added back
 *     (expense rows typed or sub-typed depreciation/amortisation), then the
 *     change of every current non-cash row (receivables, inventory, payables,
 *     parties, current liabilities): cash effect = −(debit movement);
 *   - investing: the change of non-current assets, net of the depreciation
 *     added back;
 *   - financing: the change of non-current liabilities and equity;
 *   - unclassified: rows of an unknown type and lines on missing or no accounts.
 * The computed net change is compared with the cash rows' actual movement;
 * the difference is the period's unbalanced lines (single-sided vouchers),
 * reported, never plugged.
 */
import type Decimal from "decimal.js";

import { db, type DatabaseOrTransaction } from "../../../db";
import { MoneyDecimal } from "../../../lib/money";
import { loadBalanceRows } from "../balances/ledgerBalanceEngine";
import { cashFlowActivityOf, fiscalYearStart, isDepreciationRow } from "./classificationMap";
import { ledgerSubTypeMap, rowSubType } from "./classifiedBalanceSheet";
import { resolveReportDate } from "./reportDates";

export interface CashFlowLine {
  kind: string;
  id: number | null;
  code: string | null;
  name: string;
  accountType: string | null;
  /** Cash effect (positive = cash in). */
  amount: string;
}

export interface CashFlowSection {
  lines: CashFlowLine[];
  total: string;
}

export interface CashFlowStatement {
  companyId: number;
  from: string;
  to: string;
  toDefaulted: boolean;
  method: "indirect";
  cashDefinition: "bank accounts + Cash/Bank ledger accounts (class asset)";
  operating: {
    netProfit: string;
    depreciation: CashFlowSection;
    workingCapital: CashFlowSection;
    total: string;
  };
  investing: CashFlowSection;
  financing: CashFlowSection;
  unclassified: CashFlowSection;
  computedNetChange: string;
  cash: { opening: string; closing: string; netChange: string; accounts: CashFlowLine[] };
  /** cash.netChange − computedNetChange: unbalanced lines of the period. Never plugged. */
  difference: string;
  balanced: boolean;
}

const ZERO = new MoneyDecimal(0);

function section(lines: CashFlowLine[]): CashFlowSection {
  const sorted = [...lines].sort((a, b) => (a.code ?? a.name).localeCompare(b.code ?? b.name));
  return { lines: sorted, total: lines.reduce((sum, line) => sum.plus(line.amount), new MoneyDecimal(0)).toFixed(2) };
}

export interface CashFlowQuery {
  companyId: number;
  from?: string | null;
  to?: string | null;
  executor?: DatabaseOrTransaction;
}

export async function buildCashFlowStatement(query: CashFlowQuery): Promise<CashFlowStatement> {
  const executor = query.executor ?? db;
  const { companyId } = query;
  const resolved = await resolveReportDate(companyId, query.to ?? null, executor);
  const to = resolved.asOf;
  const from = query.from ?? fiscalYearStart(to);
  if (from > to) throw new RangeError("Period start is after its end");
  const [rows, subTypes] = await Promise.all([
    loadBalanceRows(executor, { companyId, asOf: to, from, excludeFiscalClose: true }),
    ledgerSubTypeMap(companyId, executor),
  ]);

  let netProfit: Decimal = ZERO;
  let cashOpening: Decimal = ZERO;
  let cashMovement: Decimal = ZERO;
  const cashAccounts: CashFlowLine[] = [];
  const depreciation: CashFlowLine[] = [];
  const workingCapital: CashFlowLine[] = [];
  const investing: CashFlowLine[] = [];
  const financing: CashFlowLine[] = [];
  const unclassified: CashFlowLine[] = [];
  let depreciationTotal: Decimal = ZERO;

  for (const row of rows) {
    const classifiable = { kind: row.kind, accountType: row.accountType, subType: rowSubType(row, subTypes) };
    const movement = row.periodDebit.minus(row.periodCredit);
    const activity = cashFlowActivityOf(classifiable);
    const line = (amount: Decimal): CashFlowLine => ({
      kind: row.kind,
      id: row.id,
      code: row.code,
      name: row.name,
      accountType: row.accountType,
      amount: amount.toFixed(2),
    });
    if (activity === "cash") {
      const opening = row.masterOpening.plus(row.carriedForward);
      cashOpening = cashOpening.plus(opening);
      cashMovement = cashMovement.plus(movement);
      if (!opening.isZero() || !movement.isZero()) cashAccounts.push(line(opening.plus(movement)));
      continue;
    }
    if (movement.isZero()) continue;
    if (activity === "earnings") {
      netProfit = netProfit.minus(movement);
      if (isDepreciationRow(classifiable)) {
        depreciation.push(line(movement));
        depreciationTotal = depreciationTotal.plus(movement);
      }
      continue;
    }
    const effect = movement.negated();
    if (activity === "operating") workingCapital.push(line(effect));
    else if (activity === "investing") investing.push(line(effect));
    else if (activity === "financing") financing.push(line(effect));
    else unclassified.push(line(effect));
  }

  const depreciationSection = section(depreciation);
  const workingCapitalSection = section(workingCapital);
  const operatingTotal = netProfit.plus(depreciationSection.total).plus(workingCapitalSection.total);
  // The depreciation added back in operating is the credit side of the fixed
  // asset movement in investing: take it out there so it is counted once.
  if (!depreciationTotal.isZero()) {
    investing.push({
      kind: "adjustment",
      id: null,
      code: null,
      name: "Depreciation and amortisation (non-cash, added back in operating activities)",
      accountType: null,
      amount: depreciationTotal.negated().toFixed(2),
    });
  }
  const investingSection = section(investing);
  const financingSection = section(financing);
  const unclassifiedSection = section(unclassified);
  const computed = operatingTotal
    .plus(investingSection.total)
    .plus(financingSection.total)
    .plus(unclassifiedSection.total);
  const difference = cashMovement.minus(computed);

  return {
    companyId,
    from,
    to,
    toDefaulted: resolved.defaulted,
    method: "indirect",
    cashDefinition: "bank accounts + Cash/Bank ledger accounts (class asset)",
    operating: {
      netProfit: netProfit.toFixed(2),
      depreciation: depreciationSection,
      workingCapital: workingCapitalSection,
      total: operatingTotal.toFixed(2),
    },
    investing: investingSection,
    financing: financingSection,
    unclassified: unclassifiedSection,
    computedNetChange: computed.toFixed(2),
    cash: {
      opening: cashOpening.toFixed(2),
      closing: cashOpening.plus(cashMovement).toFixed(2),
      netChange: cashMovement.toFixed(2),
      accounts: cashAccounts.sort((a, b) => (a.code ?? a.name).localeCompare(b.code ?? b.name)),
    },
    difference: difference.toFixed(2),
    balanced: difference.isZero(),
  };
}
