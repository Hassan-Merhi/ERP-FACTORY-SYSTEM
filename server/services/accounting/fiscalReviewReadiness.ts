/** Read-only fiscal readiness: guard checks, trial balance and fingerprint. */
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { companyBusinessDate } from "./companyBusinessDate";
import { buildTrialBalance } from "./integrity/trialBalance";
import { financialStatementCategory } from "./unifiedAccountingFoundation";
import {
  FiscalReviewError,
  day,
  num,
  positive,
  hashes,
  signoffRowsTx,
  CLOSED_VOUCHER_GUARD,
  CLOSED_ENTRY_GUARD,
  AUDIT_CHAIN_TRIGGERS,
  OPENING_BALANCE_TRIGGERS,
  triggersEnabledSql,
  type Row,
  type EvidenceRow,
  type ClosureRow,
  type FiscalReadiness,
} from "./fiscalReviewShared";

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
