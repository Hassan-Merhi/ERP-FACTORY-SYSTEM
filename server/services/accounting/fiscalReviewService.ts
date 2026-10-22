/**
 * Phase 13 fiscal period close readiness, immutable-source checks and review.
 *
 * Technical close remains the existing fiscal-periods writer. This service
 * creates no financial transactions, opens no periods, and never uses a
 * fiscal-lock bypass. A reviewed close verifies evidence under the writer's
 * exclusive per-company advisory lock to avoid time-of-check/time-of-use races.
 */
import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { companyBusinessDate } from "./companyBusinessDate";
import { buildTrialBalance } from "./integrity/trialBalance";
import { financialStatementCategory } from "./unifiedAccountingFoundation";
import { writeAuditEvent } from "../audit";
import { CLOSED_PERIOD_LOCK_NAMESPACE } from "./closedPeriodGuard";
import { OPENING_BALANCE_LOCK_TABLES, openingBalanceLockTriggerName } from "./openingBalanceLock";

export type ReviewKind = "ACCOUNTING" | "OWNER";
export interface Reviewer {
  userId: string;
  username: string;
}
export class FiscalReviewError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409
  ) {
    super(message);
    this.name = "FiscalReviewError";
  }
}
type Row = Record<string, unknown>;
type EvidenceRow = Row & {
  posted_vouchers: string;
  posted_lines: string;
  lines_digest: string;
  missing_ledger_targets: string;
  unbalanced_balanced_type: string;
  non_usd_untranslated: string;
  pnl_base_mismatch: string;
  optional_vouchers: string;
  latest_entry_id: string | null;
  postings_without_actor: string;
};
type ClosureRow = Row & {
  id: number;
  period_start_date: string;
  period_end_date: string;
  closing_voucher_id: number;
  status: string;
  net_income: string;
};
type Signoff = Row & {
  id: number;
  company_id: number;
  period_start_date: string;
  period_end_date: string;
  retained_earnings_account_id: number;
  evidence_hash: string;
  review_kind: ReviewKind;
  reviewer_id: string;
  reviewer_name: string;
  reviewed_at: string;
  note: string;
  revoked_at: string | null;
};
export interface FiscalReadiness {
  companyId: number;
  periodStartDate: string;
  periodEndDate: string;
  retainedEarningsAccountId: number;
  businessDate: string;
  evidenceHash: string;
  reviewedCloseReady: boolean;
  eligibleForSignoff: boolean;
  trialBalance: {
    balanced: boolean;
    differenceUsd: string;
    openingDifferenceUsd: string;
    singleSidedStockDifferenceUsd: string;
    otherDifferenceUsd: string;
    assumedOpeningSides: number;
  };
  source: {
    postedVouchers: number;
    postedVoucherLines: number;
    sourceDigest: string;
    balancedVoucherErrors: number;
    missingLedgerTargets: number;
    nonUsdUntranslatedLines: number;
    pnlBaseAmountMismatchLines: number;
    optionalVouchers: number;
    postingsWithoutActor: number;
  };
  history: {
    latestClosedEnd: string | null;
    expectedNextStart: string | null;
    closedPeriods: Array<{ id: number; from: string; to: string; voucherId: number; netIncomeUsd: string }>;
    historicalScope: "live_source_as_of";
  };
  protections: {
    voucherDateGuardInstalled: boolean;
    entryDateGuardInstalled: boolean;
    auditChainInstalled: boolean;
    openingBalanceGuardInstalled: boolean;
    reviewMetadataCompanyRlsInstalled: boolean;
  };
  signoffs: Array<{
    id: number;
    kind: ReviewKind;
    reviewerId: string;
    reviewerName: string;
    reviewedAt: string;
    note: string;
    current: boolean;
  }>;
  blockers: string[];
  warnings: string[];
  certified: false;
}
function day(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new FiscalReviewError("FISCAL_DATE_INVALID", "Invalid ISO fiscal period date", 400);
  const parsed = new Date(value + "T00:00:00.000Z");
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value)
    throw new FiscalReviewError("FISCAL_DATE_INVALID", "Invalid calendar date", 400);
  return value;
}
function num(v: unknown) {
  return Number(String(v ?? "0"));
}
function positive(v: number, name: string) {
  if (!Number.isSafeInteger(v) || v < 1)
    throw new FiscalReviewError("FISCAL_ID_INVALID", name + " must be a positive integer", 400);
  return v;
}
function hashes(evidence: unknown) {
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}
async function signoffRowsTx(tx: DbTransaction, companyId: number, start: string, end: string, accountId: number) {
  return resultRows<Signoff>(
    await tx.execute(sql`
 SELECT id,company_id,period_start_date::text,period_end_date::text,
 retained_earnings_account_id,evidence_hash,review_kind,reviewer_id,reviewer_name,
 reviewed_at::text,note,revoked_at::text
 FROM accounting_fiscal_review_signoffs
 WHERE company_id=${companyId} AND period_start_date=${start}::date
   AND period_end_date=${end}::date AND retained_earnings_account_id=${accountId}
 ORDER BY reviewed_at DESC,id DESC LIMIT 100
 `)
  );
}
type RequiredTrigger = { table_name: string; trigger_name: string };
const CLOSED_VOUCHER_GUARD: RequiredTrigger[] = [
  { table_name: "vouchers", trigger_name: "vouchers_closed_period_guard" },
];
const CLOSED_ENTRY_GUARD: RequiredTrigger[] = [
  { table_name: "voucher_entries", trigger_name: "voucher_entries_closed_period_guard" },
];
const AUDIT_CHAIN_TRIGGERS: RequiredTrigger[] = [
  ["vouchers", "vouchers_audit_actor_columns"],
  ["vouchers", "vouchers_audit_row_insert"],
  ["vouchers", "vouchers_audit_row_update"],
  ["vouchers", "vouchers_audit_row_delete"],
  ["voucher_entries", "voucher_entries_audit_row_insert"],
  ["voucher_entries", "voucher_entries_audit_row_update"],
  ["voucher_entries", "voucher_entries_audit_row_delete"],
  ["audit_log", "audit_log_before_insert_chain"],
  ["audit_log", "audit_log_append_only"],
  ["audit_log", "audit_log_no_truncate"],
].map(([table_name, trigger_name]) => ({ table_name, trigger_name }));
const OPENING_BALANCE_TRIGGERS: RequiredTrigger[] = OPENING_BALANCE_LOCK_TABLES.map((table) => ({
  table_name: table,
  trigger_name: openingBalanceLockTriggerName(table),
}));
/**
 * True when every named trigger is enabled on its own table in the current
 * schema; a same-named trigger on another table does not count. The names
 * are bound as one JSON parameter: this reads pg_catalog only, never rows.
 */
function triggersEnabledSql(required: RequiredTrigger[]) {
  return sql`NOT EXISTS(
   SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(required)}::jsonb) AS required(table_name text, trigger_name text)
   WHERE NOT EXISTS(
     SELECT 1 FROM pg_trigger t
     JOIN pg_class target ON target.oid=t.tgrelid
     JOIN pg_namespace ns ON ns.oid=target.relnamespace
     WHERE ns.nspname=current_schema()
       AND target.relname=required.table_name
       AND t.tgname=required.trigger_name
       AND NOT t.tgisinternal AND t.tgenabled IN ('O','A')
   )
 )`;
}
export async function fiscalReadinessTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    periodStartDate: string;
    periodEndDate: string;
    retainedEarningsAccountId: number;
  }
): Promise<FiscalReadiness> {
  const { companyId } = input;
  positive(companyId, "Company");
  positive(input.retainedEarningsAccountId, "Retained earnings account");
  await assertTransactionCompanyScope(tx, companyId);
  const start = day(input.periodStartDate),
    end = day(input.periodEndDate);
  if (start > end) throw new FiscalReviewError("FISCAL_PERIOD_INVALID", "End date must be on or after start date", 400);
  const today = await companyBusinessDate(companyId, tx);
  const blockers: string[] = [],
    warnings: string[] = [];
  const books = resultRows<Row & { base_currency: string | null }>(
    await tx.execute(sql`
  SELECT base_currency FROM companies WHERE id=${companyId}
 `)
  )[0];
  if (
    !books ||
    String(books.base_currency ?? "USD")
      .trim()
      .toUpperCase() !== "USD"
  )
    blockers.push(
      "Reviewed close requires a USD functional company; foreign functional currencies need a certified translation policy"
    );
  if (end >= today)
    blockers.push("Period close requires an ended accounting period before today's company-local business date");
  // Every close candidate is checked against the company-only chart account,
  // and the existing writer retains its own independent equity-side validation.
  const retained = resultRows<Row & { id: number; account_type: string; deleted_at: string | null; active: boolean }>(
    await tx.execute(sql`
 SELECT id,account_type,deleted_at::text,active
 FROM ledger_accounts WHERE company_id=${companyId} AND id=${input.retainedEarningsAccountId}
 LIMIT 1
 `)
  )[0];
  if (
    !retained ||
    String(retained.account_type).trim().toLowerCase() !== "equity" ||
    !!retained.deleted_at ||
    retained.active === false
  )
    blockers.push("Select an active Equity/Retained Earnings ledger account owned by this company");
  const closures = resultRows<ClosureRow>(
    await tx.execute(sql`
 SELECT id,period_start_date::text,period_end_date::text,
   closing_voucher_id,status,net_income::text
 FROM fiscal_period_closures WHERE company_id=${companyId}
   AND status='CLOSED' ORDER BY period_end_date DESC LIMIT 50
 `)
  );
  const last = closures[0]?.period_end_date ?? null;
  const next = last ? new Date(new Date(last + "T00:00:00Z").getTime() + 86400000).toISOString().slice(0, 10) : null;
  if (last && (start !== next || end <= last))
    blockers.push(`Periods must be contiguous after last close ${last}; required next start ${next}`);
  if (closures.some((c) => c.period_end_date === end))
    blockers.push("A closed period with this ending date already exists");
  const trial = await buildTrialBalance(companyId, end, tx);
  if (!trial.balanced) blockers.push(`Trial balance discrepancy at period end: USD ${trial.unexplainedDifference}`);
  if (trial.openingSidesAssumed)
    warnings.push(`${trial.openingSidesAssumed} opening balance side(s) inferred from account type`);
  const erasedProfit = trial.rows.filter(
    (r) =>
      r.kind === "ledger" &&
      r.deleted &&
      ["income", "expense", "cost_of_sales"].includes(
        financialStatementCategory({ code: r.code, accountType: r.accountType })
      ) &&
      new Decimal(r.closingDebit).minus(r.closingCredit).abs().gt("0.005")
  );
  if (erasedProfit.length)
    blockers.push(`${erasedProfit.length} deleted profit/loss account(s) still carry posted balances`);
  // If this is the very FIRST close, protect all previous P&L entries:
  // the existing close writer also refuses a start after the earliest such.
  if (!last) {
    const earliest =
      resultRows<Row & { first_date: string | null }>(
        await tx.execute(sql`
   SELECT MIN(COALESCE(v.effective_date,v.voucher_date))::text AS first_date
   FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id
   JOIN ledger_accounts la ON la.id=e.ledger_account_id AND la.company_id=v.company_id
   WHERE v.company_id=${companyId} AND v.deleted_at IS NULL AND v.optional=false
     AND LOWER(TRIM(la.account_type)) IN
      ('income','revenue','direct income','indirect income','expense',
       'direct expense','indirect expense','government taxes','cogs')
  `)
      )[0]?.first_date ?? null;
    if (earliest && earliest < start)
      blockers.push(`Oldest live P&L entry ${earliest} precedes first close start ${start}`);
  }
  const [totals, protection] = await Promise.all([
    tx.execute(sql`
 WITH active_vouchers AS(
  SELECT v.id,v.voucher_number,v.voucher_type,v.currency,v.optional,v.deleted_at,
   COALESCE(v.effective_date,v.voucher_date) AS booked_on,v.created_by
  FROM vouchers v WHERE v.company_id=${companyId}
    AND COALESCE(v.effective_date,v.voucher_date)<=${end}::date
 ),
 live_lines AS(
  SELECT v.id AS voucher_id,v.voucher_number,v.voucher_type,v.currency,v.booked_on,
   v.created_by,e.id AS entry_id,e.ledger_account_id,
   e.debit_amount,e.credit_amount,e.base_debit_amount,e.base_credit_amount,
   la.company_id AS account_owner,
   (COALESCE(e.base_debit_amount,e.debit_amount,0)-
    COALESCE(e.base_credit_amount,e.credit_amount,0)) AS signed
  FROM active_vouchers v JOIN voucher_entries e ON e.voucher_id=v.id
  LEFT JOIN ledger_accounts la ON la.id=e.ledger_account_id
  WHERE v.optional=false AND v.deleted_at IS NULL
 ),
 vouchers_sums AS(
  SELECT voucher_id,voucher_type,
   SUM(COALESCE(debit_amount,0)-COALESCE(credit_amount,0)) AS difference
  FROM live_lines GROUP BY voucher_id,voucher_type
 )
 SELECT
  (SELECT COUNT(*)::text FROM active_vouchers WHERE optional=false AND deleted_at IS NULL) AS posted_vouchers,
  (SELECT COUNT(*)::text FROM live_lines) AS posted_lines,
  -- JSON keeps NULL positions distinct (CONCAT_WS skips NULLs) and includes
  -- posting type/actor. A materially changed voucher cannot inherit approval.
  (SELECT MD5(COALESCE(STRING_AGG(MD5(
    jsonb_build_array(voucher_id,voucher_number,voucher_type,booked_on,
      created_by,entry_id,ledger_account_id,debit_amount,credit_amount,
      base_debit_amount,base_credit_amount,currency,account_owner)::text),
    '' ORDER BY voucher_id,entry_id),''))
    FROM live_lines) AS lines_digest,
  (SELECT COUNT(*)::text FROM live_lines
    WHERE ledger_account_id IS NOT NULL AND (account_owner IS NULL OR account_owner<>${companyId}))
      AS missing_ledger_targets,
  (SELECT COUNT(*)::text FROM vouchers_sums
    WHERE ABS(difference)>0.01
      AND LOWER(TRIM(voucher_type)) NOT IN
        ('stock transfer','consumption','stock adjustment')) AS unbalanced_balanced_type,
  (SELECT COUNT(*)::text FROM live_lines
    WHERE UPPER(TRIM(COALESCE(currency,'USD')))<>'USD'
      AND (
        (COALESCE(debit_amount,0)<>0 AND base_debit_amount IS NULL)
        OR (COALESCE(credit_amount,0)<>0 AND base_credit_amount IS NULL)
      )) AS non_usd_untranslated,
  (SELECT COUNT(*)::text FROM live_lines l
    JOIN ledger_accounts la ON la.id=l.ledger_account_id AND la.company_id=${companyId}
    WHERE LOWER(TRIM(la.account_type)) IN
     ('income','revenue','direct income','indirect income',
      'expense','direct expense','indirect expense','government taxes','cogs')
      AND (ABS(COALESCE(l.base_debit_amount,l.debit_amount,0)-
          COALESCE(l.debit_amount,0))>0.01
        OR ABS(COALESCE(l.base_credit_amount,l.credit_amount,0)-
          COALESCE(l.credit_amount,0))>0.01)
  ) AS pnl_base_mismatch,
  (SELECT COUNT(*)::text FROM active_vouchers WHERE optional=true) AS optional_vouchers,
  (SELECT MAX(entry_id)::text FROM live_lines) AS latest_entry_id,
  (SELECT COUNT(DISTINCT voucher_id)::text FROM live_lines
    WHERE created_by IS NULL) AS postings_without_actor
  `),
    tx.execute(sql`
 SELECT
 ${triggersEnabledSql(CLOSED_VOUCHER_GUARD)} AS vouchers_guard,
 ${triggersEnabledSql(CLOSED_ENTRY_GUARD)} AS entries_guard,
 ${triggersEnabledSql(AUDIT_CHAIN_TRIGGERS)} AS audit_guard,
 -- The fiscal closing journal depends on ALL seven opening sources, not
 -- merely the ledger-account master. A missing master lock blocks approval.
 ${triggersEnabledSql(OPENING_BALANCE_TRIGGERS)} AS opening_guard,
 -- FORCE RLS and the expected company-scoping policy must be installed
 -- on all three review tables before any new independent signoff is valid.
 (
   SELECT COUNT(*)=3 FROM pg_class cl
   JOIN pg_namespace ns ON ns.oid=cl.relnamespace
   WHERE ns.nspname=current_schema()
     AND cl.relname IN (
       'accounting_fiscal_review_signoffs',
       'accounting_fiscal_reviewed_closures',
       'accounting_fiscal_review_policy'
     )
     AND cl.relrowsecurity AND cl.relforcerowsecurity
 ) AND (
   SELECT COUNT(*)=3 FROM pg_policies p
   WHERE p.schemaname=current_schema()
     AND p.tablename IN (
       'accounting_fiscal_review_signoffs',
       'accounting_fiscal_reviewed_closures',
       'accounting_fiscal_review_policy'
     )
     AND p.policyname='fiscal_review_company_scope'
 ) AS review_rls_guard
 `),
  ]);
  const e = resultRows<EvidenceRow>(totals)[0];
  const g = resultRows<
    Row & {
      vouchers_guard: boolean;
      entries_guard: boolean;
      audit_guard: boolean;
      opening_guard: boolean;
      review_rls_guard: boolean;
    }
  >(protection)[0];
  const source = {
    postedVouchers: num(e?.posted_vouchers),
    postedVoucherLines: num(e?.posted_lines),
    sourceDigest: String(e?.lines_digest ?? ""),
    balancedVoucherErrors: num(e?.unbalanced_balanced_type),
    missingLedgerTargets: num(e?.missing_ledger_targets),
    nonUsdUntranslatedLines: num(e?.non_usd_untranslated),
    pnlBaseAmountMismatchLines: num(e?.pnl_base_mismatch),
    optionalVouchers: num(e?.optional_vouchers),
    postingsWithoutActor: num(e?.postings_without_actor),
  };
  const protections = {
    voucherDateGuardInstalled: g?.vouchers_guard === true,
    entryDateGuardInstalled: g?.entries_guard === true,
    auditChainInstalled: g?.audit_guard === true,
    openingBalanceGuardInstalled: g?.opening_guard === true,
    reviewMetadataCompanyRlsInstalled: g?.review_rls_guard === true,
  };
  if (source.balancedVoucherErrors)
    blockers.push(`${source.balancedVoucherErrors} live voucher(s) of balanced types have unequal debit and credit`);
  if (source.missingLedgerTargets)
    blockers.push(`${source.missingLedgerTargets} posted line(s) target another company's or a missing ledger account`);
  if (source.nonUsdUntranslatedLines)
    blockers.push(
      `${source.nonUsdUntranslatedLines} foreign-currency lines lack a historical USD base on a nonzero debit/credit side`
    );
  if (source.pnlBaseAmountMismatchLines)
    blockers.push(
      `${source.pnlBaseAmountMismatchLines} income/expense lines have historical USD base amounts different from legacy debit/credit; the existing close writer must be reviewed before certification`
    );
  if (
    !protections.voucherDateGuardInstalled ||
    !protections.entryDateGuardInstalled ||
    !protections.auditChainInstalled ||
    !protections.openingBalanceGuardInstalled
  )
    blockers.push(
      "A required closed-period, master-opening or audit-hash trigger is missing, disabled or on the wrong table"
    );
  if (!protections.reviewMetadataCompanyRlsInstalled)
    blockers.push(
      "Fiscal approval tables require ENABLE and FORCE RLS with company-scope policies before independent review"
    );
  if (source.optionalVouchers)
    warnings.push(
      `${source.optionalVouchers} optional vouchers dated through the period end are excluded from posted books`
    );
  if (source.postingsWithoutActor)
    warnings.push(
      `${source.postingsWithoutActor} older vouchers have no creator identity; audit actor provenance incomplete`
    );
  warnings.push(
    "Retrospective live-source and present master opening values are not an immutable historical knowledge-at-date snapshot."
  );
  warnings.push(
    "Factory operational WIP/raw/finished historic cost, intercompany profit eliminations, rental contracts, bank matching and all original FX bases require separate signoff where applicable."
  );
  const fingerprint = hashes({
    companyId,
    start,
    end,
    retainedEarningsAccountId: input.retainedEarningsAccountId,
    latestClosedEnd: last,
    trial: {
      totals: trial.totals,
      components: trial.differenceComponents,
      assumptions: trial.openingSidesAssumed,
      rows: trial.rows.map((r) => [
        r.kind,
        r.id,
        r.code,
        r.accountType,
        r.openingDebit,
        r.openingCredit,
        r.periodDebit,
        r.periodCredit,
        r.closingDebit,
        r.closingCredit,
      ]),
    },
    source,
    protections,
    blockers,
    warnings,
  });
  const signoffs = await signoffRowsTx(tx, companyId, start, end, input.retainedEarningsAccountId);
  const valid = signoffs.filter((x) => !x.revoked_at && x.evidence_hash === fingerprint);
  const accountant = valid.find((s) => s.review_kind === "ACCOUNTING");
  const owner = valid.find((s) => s.review_kind === "OWNER" && s.reviewer_id !== accountant?.reviewer_id);
  const ready = blockers.length === 0 && !!accountant && !!owner;
  return {
    companyId,
    periodStartDate: start,
    periodEndDate: end,
    retainedEarningsAccountId: input.retainedEarningsAccountId,
    businessDate: today,
    evidenceHash: fingerprint,
    reviewedCloseReady: ready,
    eligibleForSignoff: blockers.length === 0,
    trialBalance: {
      balanced: trial.balanced,
      differenceUsd: trial.unexplainedDifference,
      openingDifferenceUsd: trial.differenceComponents.openingBalances,
      singleSidedStockDifferenceUsd: trial.differenceComponents.singleSidedStockVouchers,
      otherDifferenceUsd: trial.differenceComponents.otherUnbalancedVouchers,
      assumedOpeningSides: trial.openingSidesAssumed,
    },
    source,
    history: {
      latestClosedEnd: last,
      expectedNextStart: next,
      closedPeriods: closures.map((c) => ({
        id: num(c.id),
        from: c.period_start_date,
        to: c.period_end_date,
        voucherId: num(c.closing_voucher_id),
        netIncomeUsd: c.net_income,
      })),
      historicalScope: "live_source_as_of",
    },
    protections,
    signoffs: signoffs.map((s) => ({
      id: num(s.id),
      kind: s.review_kind,
      reviewerId: s.reviewer_id,
      reviewerName: s.reviewer_name,
      reviewedAt: s.reviewed_at,
      note: s.note,
      current: !s.revoked_at && s.evidence_hash === fingerprint,
    })),
    blockers,
    warnings,
    certified: false,
  };
}
export async function recordFiscalReviewTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    periodStartDate: string;
    periodEndDate: string;
    retainedEarningsAccountId: number;
    evidenceHash: string;
    reviewKind: ReviewKind;
    note: string;
    reviewer: Reviewer;
  }
) {
  await assertTransactionCompanyScope(tx, input.companyId);
  // The two review capacities must not approve concurrently against an
  // incomplete view of the other's actor. PostgreSQL releases the lock when
  // this metadata transaction commits or rolls back.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`fiscal-signoff:${input.companyId}:${input.periodEndDate}`}))`
  );
  const readiness = await fiscalReadinessTx(tx, input);
  if (!readiness.eligibleForSignoff)
    throw new FiscalReviewError("FISCAL_NOT_READY", "Resolve readiness blockers before signing a fiscal period");
  if (readiness.evidenceHash !== input.evidenceHash)
    throw new FiscalReviewError("FISCAL_STALE_EVIDENCE", "Accounting source changed: refresh preview before signoff");
  const note = input.note.trim();
  if (note.length < 10 || note.length > 2000)
    throw new FiscalReviewError("FISCAL_NOTE_INVALID", "Review note must be 10–2,000 characters", 400);
  const current = readiness.signoffs.find((s) => s.current && s.kind !== input.reviewKind);
  if (current && current.reviewerId === input.reviewer.userId)
    throw new FiscalReviewError(
      "FISCAL_SEPARATE_REVIEWERS_REQUIRED",
      "The accountant and owner approvals must be completed by different people"
    );
  const inserted = resultRows<{ id: number } & Row>(
    await tx.execute(sql`
 INSERT INTO accounting_fiscal_review_signoffs
 (company_id,period_start_date,period_end_date,retained_earnings_account_id,
  evidence_hash,review_kind,reviewer_id,reviewer_name,note)
 VALUES(${input.companyId},${input.periodStartDate}::date,${input.periodEndDate}::date,
  ${input.retainedEarningsAccountId},${readiness.evidenceHash},
  ${input.reviewKind},${input.reviewer.userId},${input.reviewer.username},${note})
 RETURNING id
 `)
  )[0];
  await writeAuditEvent(
    {
      companyId: input.companyId,
      userId: input.reviewer.userId,
      username: input.reviewer.username,
      action: "approve",
      tableName: "accounting_fiscal_review_signoffs",
      recordId: num(inserted.id),
      recordIdentifier: `${input.periodStartDate}..${input.periodEndDate}:${input.reviewKind}`,
      changes: {
        evidenceHash: { new: readiness.evidenceHash },
        reviewKind: { new: input.reviewKind },
        reviewNote: { new: note },
      },
    },
    tx
  );
  return { id: num(inserted.id), reviewKind: input.reviewKind, evidenceHash: readiness.evidenceHash };
}
export async function revokeFiscalReviewTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    signoffId: number;
    reason: string;
    actor: Reviewer;
  }
) {
  await assertTransactionCompanyScope(tx, input.companyId);
  positive(input.signoffId, "Signoff ID");
  const reason = input.reason.trim();
  if (reason.length < 10 || reason.length > 1000)
    throw new FiscalReviewError("FISCAL_REVOKE_REASON_INVALID", "Give a 10–1,000 character reason", 400);
  const row = resultRows<Signoff>(
    await tx.execute(sql`
 SELECT id,company_id,period_start_date::text,period_end_date::text,
  retained_earnings_account_id,evidence_hash,review_kind,reviewer_id,reviewer_name,
  reviewed_at::text,note,revoked_at::text
 FROM accounting_fiscal_review_signoffs
 WHERE company_id=${input.companyId} AND id=${input.signoffId} FOR UPDATE
 `)
  )[0];
  if (!row || row.revoked_at)
    throw new FiscalReviewError("FISCAL_SIGNOFF_MISSING", "Active review signoff not found", 404);
  const attached = resultRows<{ id: number } & Row>(
    await tx.execute(sql`
 SELECT id FROM accounting_fiscal_reviewed_closures
 WHERE company_id=${input.companyId} AND
  (accounting_signoff_id=${input.signoffId} OR owner_signoff_id=${input.signoffId})
 LIMIT 1
 `)
  )[0];
  if (attached)
    throw new FiscalReviewError(
      "FISCAL_SIGNOFF_USED",
      "A signoff used for a completed reviewed close cannot be revoked"
    );
  await tx.execute(sql`
 UPDATE accounting_fiscal_review_signoffs SET revoked_at=NOW(),
  revoked_by=${input.actor.userId},revoke_reason=${reason}
 WHERE company_id=${input.companyId} AND id=${input.signoffId}
 `);
  await writeAuditEvent(
    {
      companyId: input.companyId,
      userId: input.actor.userId,
      username: input.actor.username,
      action: "void",
      tableName: "accounting_fiscal_review_signoffs",
      recordId: input.signoffId,
      changes: { revoked: { new: true }, reason: { new: reason } },
    },
    tx
  );
  return { id: input.signoffId, revoked: true };
}
export async function ensureReviewedFiscalCloseTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    periodStartDate: string;
    periodEndDate: string;
    retainedEarningsAccountId: number;
    evidenceHash: string;
  }
) {
  const readiness = await fiscalReadinessTx(tx, input);
  if (readiness.evidenceHash !== input.evidenceHash)
    throw new FiscalReviewError(
      "FISCAL_STALE_EVIDENCE",
      "Posted ledger or controls changed after approval; refresh and obtain new signoffs"
    );
  if (!readiness.reviewedCloseReady)
    throw new FiscalReviewError(
      "FISCAL_REVIEW_INCOMPLETE",
      readiness.blockers.join("; ") || "Separate current Accounting and Owner signoffs are required"
    );
  // Lock the specific current signoff records until the *same* transaction
  // finishes posting the close and its metadata. A revocation cannot slip in
  // after financial verification but before the closing journal is committed.
  const signed = resultRows<Signoff>(
    await tx.execute(sql`
 SELECT id,company_id,period_start_date::text,period_end_date::text,
  retained_earnings_account_id,evidence_hash,review_kind,reviewer_id,reviewer_name,
  reviewed_at::text,note,revoked_at::text
 FROM accounting_fiscal_review_signoffs
 WHERE company_id=${input.companyId}
   AND period_start_date=${input.periodStartDate}::date
   AND period_end_date=${input.periodEndDate}::date
   AND retained_earnings_account_id=${input.retainedEarningsAccountId}
   AND evidence_hash=${readiness.evidenceHash} AND revoked_at IS NULL
 FOR UPDATE
 `)
  );
  const first = signed.find(
    (x) => x.review_kind === "ACCOUNTING" && !x.revoked_at && x.evidence_hash === readiness.evidenceHash
  );
  const second = signed.find(
    (x) =>
      x.review_kind === "OWNER" &&
      !x.revoked_at &&
      x.evidence_hash === readiness.evidenceHash &&
      x.reviewer_id !== first?.reviewer_id
  );
  if (!first || !second) throw new FiscalReviewError("FISCAL_REVIEW_INCOMPLETE", "Independent signoffs not found");
  return { accountingSignoffId: num(first.id), ownerSignoffId: num(second.id), evidenceHash: readiness.evidenceHash };
}
export async function recordReviewedFiscalCloseTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    closureId: number;
    voucherId: number;
    accountingSignoffId: number;
    ownerSignoffId: number;
    evidenceHash: string;
    actor: Reviewer;
  }
) {
  await tx.execute(sql`
 INSERT INTO accounting_fiscal_reviewed_closures
 (company_id,fiscal_closure_id,closing_voucher_id,accounting_signoff_id,
  owner_signoff_id,evidence_hash,reviewed_by)
 VALUES(${input.companyId},${input.closureId},${input.voucherId},
  ${input.accountingSignoffId},${input.ownerSignoffId},
  ${input.evidenceHash},${input.actor.userId})
 `);
  await writeAuditEvent(
    {
      companyId: input.companyId,
      userId: input.actor.userId,
      username: input.actor.username,
      action: "approve",
      tableName: "accounting_fiscal_reviewed_closures",
      recordId: input.closureId,
      changes: {
        accountingSignoffId: { new: input.accountingSignoffId },
        ownerSignoffId: { new: input.ownerSignoffId },
        closingVoucherId: { new: input.voucherId },
        evidenceHash: { new: input.evidenceHash },
      },
    },
    tx
  );
}
export async function reviewedFiscalCloseHistoryTx(tx: DbTransaction, companyId: number) {
  await assertTransactionCompanyScope(tx, companyId);
  return resultRows<Row>(
    await tx.execute(sql`
 SELECT e.id,e.fiscal_closure_id,e.closing_voucher_id,e.evidence_hash,
  e.certified_at::text,e.reviewed_by,
  a.reviewer_name AS accounting_reviewer,o.reviewer_name AS owner_reviewer,
  (c.id IS NOT NULL AND c.status='CLOSED') AS currently_closed
 FROM accounting_fiscal_reviewed_closures e
 JOIN accounting_fiscal_review_signoffs a ON a.id=e.accounting_signoff_id
 JOIN accounting_fiscal_review_signoffs o ON o.id=e.owner_signoff_id
 LEFT JOIN fiscal_period_closures c ON c.id=e.fiscal_closure_id AND c.company_id=e.company_id
 WHERE e.company_id=${companyId}
 ORDER BY e.certified_at DESC LIMIT 100
 `)
  );
}

/**
 * Per-company adoption of mandatory independent reviews. Default false,
 * so enabling this rule cannot silently change legacy companies.
 * Owner can toggle with an audited reason. The same fiscal advisory lock
 * serializes it against a close already in progress.
 */
export async function fiscalReviewPolicyTx(tx: DbTransaction, companyId: number) {
  await assertTransactionCompanyScope(tx, companyId);
  const row = resultRows<
    { enforce_reviewed_close: boolean; updated_by: string; updated_at: string; reason: string } & Row
  >(
    await tx.execute(sql`
   SELECT enforce_reviewed_close,updated_by,updated_at::text,reason
   FROM accounting_fiscal_review_policy WHERE company_id=${companyId}
   LIMIT 1
  `)
  )[0];
  return {
    companyId,
    enforceReviewedClose: row?.enforce_reviewed_close ?? false,
    updatedBy: row?.updated_by ?? null,
    updatedAt: row?.updated_at ?? null,
    reason: row?.reason ?? null,
    explicitlyConfigured: !!row,
  };
}
export async function setFiscalReviewPolicyTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    enforce: boolean;
    reason: string;
    actor: Reviewer;
  }
) {
  const { companyId, actor } = input;
  await assertTransactionCompanyScope(tx, companyId);
  const reason = input.reason.trim();
  if (reason.length < 10 || reason.length > 1000)
    throw new FiscalReviewError("FISCAL_POLICY_REASON_REQUIRED", "A 10–1,000 character reason is required", 400);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${CLOSED_PERIOD_LOCK_NAMESPACE},${companyId})`);
  const before = await fiscalReviewPolicyTx(tx, companyId);
  await tx.execute(sql`
 INSERT INTO accounting_fiscal_review_policy(company_id,enforce_reviewed_close,
  updated_by,reason) VALUES(${companyId},${input.enforce},${actor.userId},${reason})
 ON CONFLICT(company_id) DO UPDATE SET
  enforce_reviewed_close=EXCLUDED.enforce_reviewed_close,
  updated_by=EXCLUDED.updated_by,reason=EXCLUDED.reason,updated_at=NOW()
 `);
  await writeAuditEvent(
    {
      companyId,
      userId: actor.userId,
      username: actor.username,
      action: "settings_change",
      tableName: "accounting_fiscal_review_policy",
      recordIdentifier: `company:${companyId}:reviewed-close`,
      changes: {
        enforceReviewedClose: { old: before.enforceReviewedClose, new: input.enforce },
        reason: { new: reason },
      },
    },
    tx
  );
  return fiscalReviewPolicyTx(tx, companyId);
}
