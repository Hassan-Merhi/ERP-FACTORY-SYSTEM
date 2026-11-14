/** Fiscal review metadata and reviewed close coordination; no bypasses. */
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { writeAuditEvent } from "../audit";
import { CLOSED_PERIOD_LOCK_NAMESPACE } from "./closedPeriodGuard";
import { fiscalReadinessTx } from "./fiscalReviewReadiness";
import {
  FiscalReviewError,
  num,
  positive,
  type ReviewKind,
  type Reviewer,
  type Row,
  type Signoff,
} from "./fiscalReviewShared";

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
