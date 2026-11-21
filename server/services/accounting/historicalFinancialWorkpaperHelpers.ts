// Extracted from ./historicalFinancialWorkpaper.ts
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { type BalanceRowKind } from "./balances/ledgerBalanceEngine";

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

export type MatchCounts = Record<string, unknown> & {
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

export const fmt = (v: Decimal) => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

export const number = (v: unknown) => Number(String(v ?? "0"));

export async function postingsTx(tx: DbTransaction, companyId: number, asOfDate: string) {
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
