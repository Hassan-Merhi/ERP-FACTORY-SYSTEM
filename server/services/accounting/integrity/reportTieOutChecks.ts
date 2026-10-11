/**
 * Report tie-outs (accounting audit phase 27, RP-14). Read-only, listed.
 *
 *   report_tieout_balance_sheet_earnings_vs_pl — the balance sheet's current
 *     fiscal-year earnings plus what a fiscal close moved out of the year's
 *     income/expense accounts against the P&L's net profit for the same range
 *     (a P&L account the P&L does not read, a type read differently).
 *   report_tieout_aging_vs_control — each aging (customers, suppliers, factory
 *     suppliers, employees) against its control figure, the engine's rows of
 *     the kind (the trial balance's party detail).
 *   report_tieout_net_position_vs_balance_sheet — the dated net position
 *     against the balance sheet's net assets, after its labelled memo lines;
 *     the remainder is listed.
 * Each check is "warn" when it does not tie (amount = the difference) and
 * "pass" when it does. All on the company's business date.
 */
import { db } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { getProfitLoss } from "../../reports/financialReportsService";
import { AGING_KINDS, getAgingReport } from "../../reports/agingReport";
import { calculateNetPositionAsOf } from "../../../helpers/calculateNetPositionAsOf";
import { companyBusinessDate } from "../companyBusinessDate";
import { loadBalanceRows } from "../balances/ledgerBalanceEngine";
import { buildClassifiedBalanceSheet, ledgerSubTypeMap, rowSubType } from "../reporting/classifiedBalanceSheet";
import { fiscalYearStart, rowAccountClass } from "../reporting/classificationMap";
import { reconcileNetPosition, netPositionMemoLines } from "../reporting/netPositionReconciliation";
import type { IntegrityCheck } from "./accountingIntegrityDiagnostic";

function tieCheck(
  key: string,
  difference: { isZero(): boolean; abs(): { toFixed(dp: number): string } },
  explanation: string,
  samples: Record<string, unknown>[],
  count = samples.length
): IntegrityCheck {
  const tied = difference.isZero();
  return {
    key,
    status: tied ? "pass" : "warn",
    count: tied ? 0 : count,
    amount: tied ? null : difference.abs().toFixed(2),
    explanation,
    samples: tied ? [] : samples.slice(0, 20),
  };
}

async function earningsCheck(companyId: number, asOf: string): Promise<IntegrityCheck> {
  const from = fiscalYearStart(asOf);
  const [sheet, profitLoss, withoutClose, subTypes] = await Promise.all([
    buildClassifiedBalanceSheet(companyId, asOf),
    getProfitLoss(companyId, from, asOf),
    loadBalanceRows(db, { companyId, asOf, from, excludeFiscalClose: true }),
    ledgerSubTypeMap(companyId),
  ]);
  // The year's earnings with the closing journals left out, on the engine rows.
  let engineEarnings = new MoneyDecimal(0);
  for (const row of withoutClose) {
    const accountClass = rowAccountClass({
      kind: row.kind,
      accountType: row.accountType,
      subType: rowSubType(row, subTypes),
    });
    if (accountClass === "income" || accountClass === "expense") {
      engineEarnings = engineEarnings.minus(row.periodDebit.minus(row.periodCredit));
    }
  }
  const balanceSheetEarnings = toMoney(sheet.equity.currentEarnings);
  const closedInYear = engineEarnings.minus(balanceSheetEarnings);
  const plNetProfit = toMoney(profitLoss.sections.netProfit);
  const difference = engineEarnings.minus(plNetProfit);
  return tieCheck(
    "report_tieout_balance_sheet_earnings_vs_pl",
    difference,
    "Balance-sheet current-year earnings (plus what a fiscal close moved out of the year) against the P&L's net profit for the fiscal year to the business date. A difference is a P&L-class account the P&L does not read (for example a deleted account still holding lines) or a type classified differently.",
    [
      {
        fiscalYearStart: from,
        asOf,
        balanceSheetCurrentEarnings: balanceSheetEarnings.toFixed(2),
        closedByFiscalClose: closedInYear.toFixed(2),
        engineEarnings: engineEarnings.toFixed(2),
        profitAndLossNetProfit: plNetProfit.toFixed(2),
        difference: difference.toFixed(2),
      },
    ],
    1
  );
}

async function agingCheck(companyId: number, asOf: string): Promise<IntegrityCheck> {
  const samples: Record<string, unknown>[] = [];
  let total = new MoneyDecimal(0);
  for (const kind of AGING_KINDS) {
    const report = await getAgingReport(companyId, kind, asOf);
    const tie = report.controlTieOut;
    const difference = toMoney(tie.difference);
    if (!difference.isZero()) {
      total = total.plus(difference.abs());
      samples.push({ kind, agingTotal: tie.agingTotal, controlTotal: tie.engineTotal, difference: tie.difference });
    }
  }
  return tieCheck(
    "report_tieout_aging_vs_control",
    total,
    "Each aging total (customers, suppliers, factory suppliers, employees) against its control figure: the engine's rows of that kind, which the trial balance shows under the control account. A difference is an aging bucket that does not add up to the ledger.",
    samples
  );
}

async function netPositionCheck(companyId: number, asOf: string): Promise<IntegrityCheck> {
  const [snapshot, sheet] = await Promise.all([
    calculateNetPositionAsOf(companyId, asOf),
    buildClassifiedBalanceSheet(companyId, asOf),
  ]);
  const equityContribution = Number(
    toMoney(String(snapshot.netPosition)).minus(String(snapshot.forUsTotal)).plus(String(snapshot.onUsTotal))
  );
  const reconciliation = reconcileNetPosition(
    asOf,
    String(snapshot.netPosition),
    sheet.totals.netAssets,
    netPositionMemoLines(snapshot.forUsLines, snapshot.onUsLines, equityContribution)
  );
  return tieCheck(
    "report_tieout_net_position_vs_balance_sheet",
    toMoney(reconciliation.unexplained),
    "The dated net position against the balance sheet's net assets (assets − liabilities) after its labelled memo lines (stock at operational valuation, containers on the way, supplier-partner equity). The remainder is what the net position classifies differently (accounts it leaves out); listed, never plugged.",
    [{ ...reconciliation }],
    1
  );
}

/** A check that could not run is listed as a warning with its error, never dropped. */
async function guarded(key: string, run: () => Promise<IntegrityCheck>): Promise<IntegrityCheck> {
  try {
    return await run();
  } catch (error: unknown) {
    return {
      key,
      status: "warn",
      count: 1,
      amount: null,
      explanation: "The tie-out could not be computed.",
      samples: [{ error: error instanceof Error ? error.message : String(error) }],
    };
  }
}

export async function reportTieOutChecks(companyId: number): Promise<IntegrityCheck[]> {
  const asOf = await companyBusinessDate(companyId);
  return [
    await guarded("report_tieout_balance_sheet_earnings_vs_pl", () => earningsCheck(companyId, asOf)),
    await guarded("report_tieout_aging_vs_control", () => agingCheck(companyId, asOf)),
    await guarded("report_tieout_net_position_vs_balance_sheet", () => netPositionCheck(companyId, asOf)),
  ];
}
