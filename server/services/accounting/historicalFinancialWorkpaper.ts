/**
 * Unified Accounting Phase 10 — retrospective as-of financial workpaper.
 *
 * Accounting-effective time != historical system/knowledge time.
 * All financial amounts come from the canonical live-source balance engine,
 * limited to posted effective dates. This service NEVER rewrites originals.
 * A voucher inserted, edited, reversed or retired after the requested date
 * cannot always be reconstructed from the mutable present tables. We expose
 * the observable evidence instead of calling today's retrospective projection
 * an immutable historical snapshot.
 */
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { buildTrialBalance } from "./integrity/trialBalance";
import { loadBalanceRows } from "./balances/ledgerBalanceEngine";
import { financialStatementCategory } from "./unifiedAccountingFoundation";
import { companyBusinessDate } from "./companyBusinessDate";
import { companyStockValuationAsOf } from "../inventory/stockValuation";
import {
  fmt,
  number,
  postingsTx,
  type MatchCounts,
  type HistoricalFinancialWorkpaper,
} from "./historicalFinancialWorkpaperHelpers";
export type { HistoricalEvidenceStatus, HistoricalFinancialWorkpaper } from "./historicalFinancialWorkpaperHelpers";

function asDate(v: string) {
  const value = String(v ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("HISTORICAL_DATE_INVALID");
  const d = new Date(value + "T00:00:00.000Z");
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== value)
    throw new Error("HISTORICAL_DATE_INVALID");
  return value;
}
async function matchingEvidenceTx(tx: DbTransaction, companyId: number, asOfDate: string) {
  // These are operational allocations, not accounting vouchers. Attribution
  // creation and cancellation timestamps are evidence but editing the source
  // invoice after matching still prevents a true historical reconstitution.
  const sources = [
    {
      name: "party_open_item_matches",
      query: sql`
     SELECT COUNT(*)::text AS count,
      COUNT(*) FILTER(WHERE created_at::date>${asOfDate}::date)::text AS late_recorded,
      COUNT(*) FILTER(WHERE voided_at IS NOT NULL)::text AS voided_now,
      COUNT(*) FILTER(WHERE voided_at::date>${asOfDate}::date)::text AS voided_after_asof
     FROM accounting_open_item_matches
     WHERE company_id=${companyId} AND applied_on<=${asOfDate}::date`,
    },
    {
      name: "cash_bank_statement_imports",
      query: sql`
     SELECT COUNT(*)::text AS count,
      COUNT(*) FILTER(WHERE imported_at::date>${asOfDate}::date)::text AS late_recorded,
      '0'::text AS voided_now,'0'::text AS voided_after_asof
     FROM accounting_cash_bank_statements
     WHERE company_id=${companyId} AND period_end<=${asOfDate}::date`,
    },
    {
      name: "realized_fx_recognitions",
      query: sql`
     SELECT COUNT(*)::text AS count,
      COUNT(*) FILTER(WHERE created_at::date>${asOfDate}::date)::text AS late_recorded,
      '0'::text AS voided_now,'0'::text AS voided_after_asof
     FROM accounting_fx_realizations
     WHERE company_id=${companyId} AND recognized_date<=${asOfDate}::date`,
    },
  ];
  const items = [];
  for (const src of sources) {
    const row = resultRows<MatchCounts>(await tx.execute(src.query))[0];
    items.push({
      source: src.name,
      total: number(row?.count),
      recordedAfterAsOf: number(row?.late_recorded),
      voidedCurrently: number(row?.voided_now),
      voidedAfterAsOf: number(row?.voided_after_asof),
    });
  }
  return { items, isPostingLedger: false as const };
}
export async function historicalFinancialWorkpaperTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    asOfDate: string;
    fromDate: string;
  }
): Promise<HistoricalFinancialWorkpaper> {
  if (!Number.isSafeInteger(input.companyId) || input.companyId < 1) throw new Error("HISTORICAL_COMPANY_INVALID");
  const asOfDate = asDate(input.asOfDate),
    fromDate = asDate(input.fromDate);
  if (fromDate > asOfDate) throw new Error("HISTORICAL_PERIOD_INVALID");
  await assertTransactionCompanyScope(tx, input.companyId);
  const businessDate = await companyBusinessDate(input.companyId, tx);
  if (asOfDate > businessDate) throw new Error("HISTORICAL_FUTURE_DATE_REFUSED");
  const [trial, periodBalances, period, postings, matches] = await Promise.all([
    buildTrialBalance(input.companyId, asOfDate, tx),
    loadBalanceRows(tx, { companyId: input.companyId, from: fromDate, asOf: asOfDate }),
    loadBalanceRows(tx, { companyId: input.companyId, from: fromDate, asOf: asOfDate, excludeFiscalClose: true }),
    postingsTx(tx, input.companyId, asOfDate),
    matchingEvidenceTx(tx, input.companyId, asOfDate),
  ]);
  // The existing trial balance's movement columns start at company inception.
  // This Phase 10 view explicitly uses the requested period instead: opening
  // at the day before fromDate (master + prior movements), movement inside
  // [fromDate,asOfDate], and closing at asOfDate. Never change its canonical
  // unexplained-difference calculation or fabricate a balancing journal.
  const trialRows = [] as HistoricalFinancialWorkpaper["balance"]["rows"];
  const sums = {
    openingDebit: new Decimal(0),
    openingCredit: new Decimal(0),
    periodDebit: new Decimal(0),
    periodCredit: new Decimal(0),
    closingDebit: new Decimal(0),
    closingCredit: new Decimal(0),
  };
  for (const row of periodBalances) {
    const brought = row.masterOpening.plus(row.carriedForward);
    const closing = brought.plus(row.periodDebit).minus(row.periodCredit);
    if (brought.isZero() && row.periodDebit.isZero() && row.periodCredit.isZero() && closing.isZero()) continue;
    const od = Decimal.max(brought, 0),
      oc = Decimal.max(brought.negated(), 0);
    const cd = Decimal.max(closing, 0),
      cc = Decimal.max(closing.negated(), 0);
    sums.openingDebit = sums.openingDebit.plus(od);
    sums.openingCredit = sums.openingCredit.plus(oc);
    sums.periodDebit = sums.periodDebit.plus(row.periodDebit);
    sums.periodCredit = sums.periodCredit.plus(row.periodCredit);
    sums.closingDebit = sums.closingDebit.plus(cd);
    sums.closingCredit = sums.closingCredit.plus(cc);
    trialRows.push({
      kind: row.kind,
      id: row.id,
      code: row.code,
      name: row.name,
      accountType: row.accountType,
      deleted: row.deleted,
      openingDebit: fmt(od),
      openingCredit: fmt(oc),
      periodDebit: fmt(row.periodDebit),
      periodCredit: fmt(row.periodCredit),
      closingDebit: fmt(cd),
      closingCredit: fmt(cc),
    });
  }
  trialRows.sort((a, b) => a.kind.localeCompare(b.kind) || (a.code ?? a.name).localeCompare(b.code ?? b.name));
  let income = new Decimal(0),
    cogs = new Decimal(0),
    expenses = new Decimal(0);
  for (const row of period) {
    const role = financialStatementCategory({ code: row.code, accountType: row.accountType });
    const movement = row.periodDebit.minus(row.periodCredit);
    if (role === "income") income = income.minus(movement);
    if (role === "cost_of_sales") cogs = cogs.plus(movement);
    if (role === "expense") expenses = expenses.plus(movement);
  }
  const historic = asOfDate < businessDate;
  const warnings = [
    "Posted effective dates (accounting time) are not immutable system-time snapshots. Later edits, voucher retirements, and master opening changes may change this retrospective view.",
    "Document creation/retirement dates are compared by database calendar date; the company's business timezone can differ. This signal does not prove a backdated or unauthorized posting.",
    "Saved master opening balances and account/party classifications are today's values, not historized versions.",
    "Inventory source replay may be incomplete for historic cost corrections; Factory raw/WIP/bale costs and rental contract terms are mutable and cannot be reconstructed by changing the report date.",
    "Recognition/matching/import timestamps are operational metadata and do not create financial postings.",
  ];
  const blockers = [
    "No immutable historical versions of edited vouchers, voucher entries and master opening amounts for a system-time reconstruction",
    "No complete historical versioning of Factory production costs, rental contract terms or group intercompany ownership links",
  ];
  if (!trial.balanced) blockers.push(`The posted trial balance is out by USD ${trial.unexplainedDifference}`);
  if (postings.totals.lateCreated)
    blockers.push(
      `${postings.totals.lateCreated} document(s) entered after the as-of calendar day with earlier/equal effective dates`
    );
  if (postings.totals.retiredAfterDate)
    blockers.push(
      `${postings.totals.retiredAfterDate} older document(s) were retired after that date; original posting is excluded from the current live ledger`
    );
  if (postings.totals.retiredBeforeDate)
    warnings.push(
      "Some prior-dated vouchers were already retired by the selected date and remain excluded from live balances."
    );
  if (matches.items.some((x) => x.recordedAfterAsOf > 0))
    warnings.push(
      "Some operational allocations/imports/FX recognitions were recorded after their source business date."
    );
  // Retrospective posted-source balances can be reported precisely under
  // today's ledger rules; historic knowledge cannot be certified without a
  // complete immutable version chain.
  return {
    companyId: input.companyId,
    asOfDate,
    fromDate,
    businessDate,
    basis: "RETROSPECTIVE_POSTED_LEDGER",
    balance: {
      balanced: trial.balanced,
      unexplainedDifferenceUsd: trial.unexplainedDifference,
      totals: {
        openingDebit: fmt(sums.openingDebit),
        openingCredit: fmt(sums.openingCredit),
        periodDebit: fmt(sums.periodDebit),
        periodCredit: fmt(sums.periodCredit),
        closingDebit: fmt(sums.closingDebit),
        closingCredit: fmt(sums.closingCredit),
      },
      differenceComponents: trial.differenceComponents,
      openingSidesAssumed: trial.openingSidesAssumed,
      rows: trialRows,
    },
    pnl: {
      incomeUsd: fmt(income),
      costOfSalesUsd: fmt(cogs),
      otherExpensesUsd: fmt(expenses),
      profitBeforeOtherEliminationsUsd: fmt(income.minus(cogs).minus(expenses)),
      excludesClosingJournals: true,
      historicalAccountClassificationVerified: false,
    },
    postingEvidence: postings,
    reconciliationEvidence: matches,
    sourceAvailability: {
      erpInventory: "historical_replay_available_but_requires_cost_evidence_review",
      factoryRawWipBales: "current_mutable_cost_not_historically_reconstructable",
      rentalContracts: "current_terms_not_historical_versions",
      companyOpenings: "current_master_values_not_historical_versions",
      historicalFx: "posted_transaction_rates_only_no_forward_repricing",
      consolidation: "only source-backed member balances; internal profit and investment eliminations unresolved",
    },
    reliability: {
      financialTotals: historic ? "retrospective_only" : "reconstructed_from_posted_source",
      historicalKnowledgeAtDate: "not_reconstructable",
      certified: false,
      blockers,
      warnings,
    },
  };
}
export async function historicalErpStockAtCostTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    asOfDate: string;
  }
) {
  const day = asDate(input.asOfDate);
  await assertTransactionCompanyScope(tx, input.companyId);
  const now = await companyBusinessDate(input.companyId, tx);
  if (day > now) throw new Error("HISTORICAL_FUTURE_DATE_REFUSED");
  // This is the established stock movement replay; no fabricated source
  // values and no mutations to production or original stock movements.
  const report = await companyStockValuationAsOf(tx, input.companyId, day);
  return {
    companyId: input.companyId,
    asOfDate: day,
    mode: "RECORDED_ERP_STOCK_VALUE_REPLAY",
    report,
    certified: false,
    caveats: [
      "ERP total_value movement replay uses stored present stock and recorded subsequent movements; source history may be incomplete after edits or manual repairs.",
      "This is ERP stock cost only. Do not include Factory bale mirror stock or substitute current Factory raw/WIP/bale cost as an as-of amount.",
      "Do not use a reconstructed stock value to generate a historical GL adjustment automatically.",
    ],
  };
}
