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
import { loadBalanceRows, type BalanceRowKind } from "./balances/ledgerBalanceEngine";
import { financialStatementCategory } from "./unifiedAccountingFoundation";
import { companyBusinessDate } from "./companyBusinessDate";
import { companyStockValuationAsOf } from "../inventory/stockValuation";

type PostEvidence = Record<string, unknown> & {
  id: number;
  voucher_number: string;
  voucher_type: string;
  booked_on: string;
  created_on: string;
  deleted_on: string | null;
  currency: string;
  source_module: string | null;
  debit_base: string;
  credit_base: string;
  posted_now: boolean;
  late_created: boolean;
  later_retired: boolean;
};
type CountsRow = Record<string, unknown> & {
  documents: string;
  currently_live: string;
  late_created: string;
  retired_after_date: string;
  already_retired: string;
  late_created_debit_usd: string;
  late_created_credit_usd: string;
  posted_debit_usd: string;
  posted_credit_usd: string;
};
type MatchCounts = Record<string, unknown> & {
  source: string;
  count: string;
  late_recorded: string;
  voided_now: string;
  voided_after_asof: string;
};
export type HistoricalEvidenceStatus =
  "reconstructed_from_posted_source" | "retrospective_only" | "not_reconstructable";
export interface HistoricalFinancialWorkpaper {
  companyId: number;
  asOfDate: string;
  fromDate: string;
  businessDate: string;
  basis: "RETROSPECTIVE_POSTED_LEDGER";
  balance: {
    balanced: boolean;
    unexplainedDifferenceUsd: string;
    totals: {
      openingDebit: string;
      openingCredit: string;
      periodDebit: string;
      periodCredit: string;
      closingDebit: string;
      closingCredit: string;
    };
    differenceComponents: {
      openingBalances: string;
      singleSidedStockVouchers: string;
      otherUnbalancedVouchers: string;
    };
    openingSidesAssumed: number;
    rows: Array<{
      kind: BalanceRowKind;
      id: number | null;
      code: string | null;
      name: string;
      accountType: string | null;
      openingDebit: string;
      openingCredit: string;
      periodDebit: string;
      periodCredit: string;
      closingDebit: string;
      closingCredit: string;
      deleted: boolean;
    }>;
  };
  pnl: {
    incomeUsd: string;
    costOfSalesUsd: string;
    otherExpensesUsd: string;
    profitBeforeOtherEliminationsUsd: string;
    excludesClosingJournals: true;
    historicalAccountClassificationVerified: false;
  };
  postingEvidence: {
    totals: {
      documents: number;
      currentlyLive: number;
      lateCreated: number;
      retiredAfterDate: number;
      retiredBeforeDate: number;
      lateCreatedDebitsUsd: string;
      lateCreatedCreditsUsd: string;
      currentlyLiveDebitsUsd: string;
      currentlyLiveCreditsUsd: string;
    };
    documents: PostEvidence[];
    sampleLimit: number;
    truncated: boolean;
  };
  reconciliationEvidence: {
    items: Array<{
      source: string;
      total: number;
      recordedAfterAsOf: number;
      voidedCurrently: number;
      voidedAfterAsOf: number;
    }>;
    isPostingLedger: false;
  };
  sourceAvailability: {
    erpInventory: "historical_replay_available_but_requires_cost_evidence_review";
    factoryRawWipBales: "current_mutable_cost_not_historically_reconstructable";
    rentalContracts: "current_terms_not_historical_versions";
    companyOpenings: "current_master_values_not_historical_versions";
    historicalFx: "posted_transaction_rates_only_no_forward_repricing";
    consolidation: "only source-backed member balances; internal profit and investment eliminations unresolved";
  };
  reliability: {
    financialTotals: HistoricalEvidenceStatus;
    historicalKnowledgeAtDate: "not_reconstructable";
    certified: false;
    blockers: string[];
    warnings: string[];
  };
}
const n = (v: unknown) => new Decimal(String(v ?? "0"));
const fmt = (v: Decimal) => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
const number = (v: unknown) => Number(String(v ?? "0"));
function asDate(v: string) {
  const value = String(v ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("HISTORICAL_DATE_INVALID");
  const d = new Date(value + "T00:00:00.000Z");
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== value)
    throw new Error("HISTORICAL_DATE_INVALID");
  return value;
}
async function postingsTx(tx: DbTransaction, companyId: number, asOfDate: string) {
  // Include retired historical vouchers as *evidence* (never in the ledger
  // balance). This counts distinct documents before looking at their lines.
  // created_at is wall clock, whereas posting is a company-local business day:
  // this is a warning signal, NOT proof of manipulation or historical state.
  const counts = resultRows<CountsRow>(
    await tx.execute(sql`
 WITH docs AS (
   SELECT v.id,v.deleted_at,v.optional,v.created_at,
    COALESCE(v.effective_date,v.voucher_date) AS booked_on,
    COALESCE(lines.dr,0) AS dr, COALESCE(lines.cr,0) AS cr
   FROM vouchers v
   LEFT JOIN LATERAL(
    SELECT COALESCE(SUM(COALESCE(e.base_debit_amount,e.debit_amount,0)),0) AS dr,
           COALESCE(SUM(COALESCE(e.base_credit_amount,e.credit_amount,0)),0) AS cr
    FROM voucher_entries e WHERE e.voucher_id=v.id
   ) lines ON true
   WHERE v.company_id=${companyId}
   AND COALESCE(v.effective_date,v.voucher_date)<=${asOfDate}::date
 )
 SELECT COUNT(*)::text AS documents,
   COUNT(*) FILTER(WHERE deleted_at IS NULL AND optional=false)::text AS currently_live,
   COUNT(*) FILTER(WHERE created_at::date>${asOfDate}::date)::text AS late_created,
   COUNT(*) FILTER(WHERE deleted_at::date>${asOfDate}::date)::text AS retired_after_date,
   COUNT(*) FILTER(WHERE deleted_at::date<=${asOfDate}::date)::text AS already_retired,
   COALESCE(SUM(dr) FILTER(WHERE created_at::date>${asOfDate}::date),0)::text AS late_created_debit_usd,
   COALESCE(SUM(cr) FILTER(WHERE created_at::date>${asOfDate}::date),0)::text AS late_created_credit_usd,
   COALESCE(SUM(dr) FILTER(WHERE deleted_at IS NULL AND optional=false),0)::text AS posted_debit_usd,
   COALESCE(SUM(cr) FILTER(WHERE deleted_at IS NULL AND optional=false),0)::text AS posted_credit_usd
 FROM docs
 `)
  )[0];
  const sample = resultRows<PostEvidence>(
    await tx.execute(sql`
 SELECT v.id,v.voucher_number,v.voucher_type,
  COALESCE(v.effective_date,v.voucher_date)::text AS booked_on,
  v.created_at::text AS created_on,v.deleted_at::text AS deleted_on,
  v.currency,v.source_module,
  COALESCE(lines.dr,0)::text AS debit_base,
  COALESCE(lines.cr,0)::text AS credit_base,
  (v.deleted_at IS NULL AND v.optional=false) AS posted_now,
  (v.created_at::date>${asOfDate}::date) AS late_created,
  (v.deleted_at::date>${asOfDate}::date) AS later_retired
 FROM vouchers v
 LEFT JOIN LATERAL(
   SELECT COALESCE(SUM(COALESCE(e.base_debit_amount,e.debit_amount,0)),0) AS dr,
    COALESCE(SUM(COALESCE(e.base_credit_amount,e.credit_amount,0)),0) AS cr
   FROM voucher_entries e WHERE e.voucher_id=v.id
 ) lines ON true
 WHERE v.company_id=${companyId}
   AND COALESCE(v.effective_date,v.voucher_date)<=${asOfDate}::date
   AND (v.created_at::date>${asOfDate}::date OR v.deleted_at IS NOT NULL OR v.optional=true)
 ORDER BY v.created_at DESC,v.id DESC LIMIT 101
 `)
  );
  return {
    totals: {
      documents: number(counts?.documents),
      currentlyLive: number(counts?.currently_live),
      lateCreated: number(counts?.late_created),
      retiredAfterDate: number(counts?.retired_after_date),
      retiredBeforeDate: number(counts?.already_retired),
      lateCreatedDebitsUsd: fmt(n(counts?.late_created_debit_usd)),
      lateCreatedCreditsUsd: fmt(n(counts?.late_created_credit_usd)),
      currentlyLiveDebitsUsd: fmt(n(counts?.posted_debit_usd)),
      currentlyLiveCreditsUsd: fmt(n(counts?.posted_credit_usd)),
    },
    documents: sample.slice(0, 100),
    sampleLimit: 100,
    truncated: sample.length > 100,
  };
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
