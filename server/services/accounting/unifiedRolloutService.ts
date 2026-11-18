/**
 * Phase 15 — cross-module release certification and read-only rollout.
 *
 * Certifiers attach external evidence references, not unverifiable "CI passed"
 * booleans. Pilot mode enables only NEW accounting metadata writes. No mode
 * here can enable voucher posting, fiscal closing or perpetual inventory.
 */
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { writeAuditEvent } from "../audit";
import {
  METADATA_ENTRY_REFERENCES_BLOCKER,
  METADATA_ENTRY_REFERENCES_COMPATIBLE,
  ReleaseError,
  deployedUnifiedReleaseSha,
  lock,
  num,
  reason,
  reviewerId,
  reviewsTx,
  unifiedReleasePolicyTx,
  unifiedReleaseReadinessTx,
  type ReleaseActor,
  type ReleaseMode,
  type ReviewKind,
  type ReviewRow,
} from "./unifiedReleaseReadinessTx";
export {
  METADATA_ENTRY_REFERENCES_BLOCKER,
  METADATA_ENTRY_REFERENCES_COMPATIBLE,
  ReleaseError,
  UNIFIED_PHASES,
  deployedUnifiedReleaseSha,
  unifiedReleasePolicyTx,
  unifiedReleaseReadinessTx,
} from "./unifiedReleaseReadinessTx";
export type { ReleaseActor, ReleaseMode, ReviewKind } from "./unifiedReleaseReadinessTx";
export async function currentPilotEligibilityTx(tx: DbTransaction, companyId: number) {
  const policy = await unifiedReleasePolicyTx(tx, companyId);
  const deployedSha = deployedUnifiedReleaseSha();
  // DO NOT mistake a manually stored pilot row for permission to mutate
  // voucher-linked metadata. This explicitly mirrors the hard readiness gate:
  // existing voucher editors replace line IDs; Phase 15 has NOT certified
  // safe coexistence with metadata FK references that RESTRICT those deletes.
  // This protection applies even to pilot rows created by an older revision.
  if (!METADATA_ENTRY_REFERENCES_COMPATIBLE)
    return {
      allowed: false,
      policy,
      deployedSha,
      reason: METADATA_ENTRY_REFERENCES_BLOCKER,
    };
  if (policy.releaseMode !== "METADATA_PILOT" || !deployedSha || policy.releaseSha !== deployedSha)
    return {
      allowed: false,
      policy,
      deployedSha,
      reason:
        "New accounting metadata writers remain read-only until Owner pilot approval for the exact deployed revision",
    };
  // A future certified compatibility change must still honor *all* readiness
  // blockers, not just the existence of three review rows.
  const readiness = await unifiedReleaseReadinessTx(tx, companyId);
  if (readiness.blockers.length)
    return {
      allowed: false,
      policy,
      deployedSha,
      reason: "Accounting metadata pilot readiness is blocked: " + readiness.blockers.join("; "),
    };
  const active = (await reviewsTx(tx, companyId, deployedSha)).filter((x) => !x.revoked_at);
  const kinds = new Set(active.map((x) => x.review_kind));
  const technical = active.find((x) => x.review_kind === "TECHNICAL");
  const approved =
    !!technical && kinds.has("SECURITY") && kinds.has("FINANCE") && technical.reviewer_id !== policy.updatedBy;
  return {
    allowed: approved,
    policy,
    deployedSha,
    reason: approved
      ? "Owner-authorized metadata-only pilot (financial posting remains blocked)"
      : "Required technical/security/finance signoff missing, revoked or not independent of Owner",
  };
}
async function audit(
  tx: DbTransaction,
  companyId: number,
  actor: ReleaseActor,
  tableName: string,
  id: number,
  kind: "approve" | "update" | "void",
  changes: Record<string, { old?: unknown; new?: unknown }>
) {
  await writeAuditEvent(
    { companyId, userId: actor.userId, username: actor.username, action: kind, tableName, recordId: id, changes },
    tx
  );
}
export async function recordUnifiedReleaseReviewTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    kind: ReviewKind;
    evidenceReference: string;
    notes: string;
    releaseSha: string;
    actor: ReleaseActor;
  }
) {
  const { companyId, actor } = input;
  await assertTransactionCompanyScope(tx, companyId);
  reviewerId(actor.userId);
  const ref = input.evidenceReference.trim(),
    notes = input.notes.trim();
  if (ref.length < 12 || ref.length > 500 || notes.length < 10 || notes.length > 2000)
    throw new ReleaseError(
      "RELEASE_EVIDENCE_INVALID",
      "Provide a verifiable evidence reference and a review explanation",
      400
    );
  const sha = deployedUnifiedReleaseSha();
  if (!sha || sha !== input.releaseSha)
    throw new ReleaseError(
      "RELEASE_SHA_INVALID",
      "Only the currently deployed full source revision can be reviewed",
      409
    );
  await lock(tx, companyId);
  const row = resultRows<{ id: number } & Record<string, unknown>>(
    await tx.execute(sql`
  INSERT INTO accounting_unified_release_reviews(
   company_id,release_sha,review_kind,evidence_reference,
   reviewer_id,reviewer_name,notes)
  VALUES(${companyId},${sha},${input.kind},${ref},
   ${actor.userId},${actor.username},${notes})
  RETURNING id
 `)
  )[0];
  await audit(tx, companyId, actor, "accounting_unified_release_reviews", num(row.id), "approve", {
    reviewKind: { new: input.kind },
    releaseSha: { new: sha },
    evidenceReference: { new: ref },
    notes: { new: notes },
  });
  return { id: num(row.id), releaseSha: sha, reviewKind: input.kind };
}
export async function revokeUnifiedReleaseReviewTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    reviewId: number;
    reason: string;
    actor: ReleaseActor;
  }
) {
  await assertTransactionCompanyScope(tx, input.companyId);
  if (!Number.isSafeInteger(input.reviewId) || input.reviewId < 1)
    throw new ReleaseError("RELEASE_REVIEW_INVALID", "Invalid review ID", 400);
  const why = reason(input.reason);
  await lock(tx, input.companyId);
  const rows = resultRows<ReviewRow>(
    await tx.execute(sql`
  SELECT id,company_id,release_sha,review_kind,evidence_reference,reviewer_id,
   reviewer_name,reviewed_at::text,notes,revoked_at::text
  FROM accounting_unified_release_reviews
  WHERE company_id=${input.companyId} AND id=${input.reviewId} FOR UPDATE
 `)
  );
  const row = rows[0];
  if (!row || row.revoked_at) throw new ReleaseError("RELEASE_REVIEW_MISSING", "Active review not found", 404);
  await tx.execute(sql`UPDATE accounting_unified_release_reviews SET
   revoked_at=NOW(),revoked_by=${input.actor.userId},revoke_reason=${why}
   WHERE company_id=${input.companyId} AND id=${input.reviewId}`);
  // A revoked review invalidates future authorizations. The route's pilot
  // check is currently in a separate transaction from its metadata writer,
  // so this is NOT an atomic check-and-write guarantee against a concurrent
  // revocation. Keep METADATA_ENTRY_REFERENCES_COMPATIBLE=false until Claude
  // certifies source lifecycle compatibility AND transactional authorization.
  await audit(tx, input.companyId, input.actor, "accounting_unified_release_reviews", input.reviewId, "void", {
    reason: { new: why },
  });
  return { id: input.reviewId, revoked: true };
}
export async function setUnifiedReleaseModeTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    mode: ReleaseMode;
    reason: string;
    releaseSha: string | null;
    actor: ReleaseActor;
  }
) {
  const { companyId, actor } = input;
  await assertTransactionCompanyScope(tx, companyId);
  reviewerId(actor.userId);
  const why = reason(input.reason);
  await lock(tx, companyId);
  const previous = await unifiedReleasePolicyTx(tx, companyId);
  const sha = deployedUnifiedReleaseSha();
  if (input.mode === "METADATA_PILOT") {
    if (!sha || input.releaseSha !== sha)
      throw new ReleaseError("RELEASE_SHA_INVALID", "Pilot must match the active deployed full source revision");
    const ready = await unifiedReleaseReadinessTx(tx, companyId);
    if (ready.blockers.length) throw new ReleaseError("RELEASE_READINESS_BLOCKED", ready.blockers.join("; "));
    const active = (await reviewsTx(tx, companyId, sha)).filter((v) => !v.revoked_at);
    const tech = active.find((v) => v.review_kind === "TECHNICAL");
    if (
      !tech ||
      !active.some((v) => v.review_kind === "SECURITY") ||
      !active.some((v) => v.review_kind === "FINANCE") ||
      tech.reviewer_id === actor.userId
    )
      throw new ReleaseError(
        "RELEASE_REVIEW_INCOMPLETE",
        "Current technical, security and finance evidence is required; Owner must be distinct from technical reviewer"
      );
  }
  await tx.execute(sql`
 INSERT INTO accounting_unified_rollout_policy
  (company_id,release_mode,release_sha,approved_by,reason)
 VALUES(${companyId},${input.mode},${input.mode === "METADATA_PILOT" ? sha : null},
  ${actor.userId},${why})
 ON CONFLICT(company_id) DO UPDATE SET
  release_mode=EXCLUDED.release_mode,
  release_sha=EXCLUDED.release_sha,approved_by=EXCLUDED.approved_by,
  approved_at=NOW(),reason=EXCLUDED.reason
 `);
  await audit(tx, companyId, actor, "accounting_unified_rollout_policy", companyId, "update", {
    releaseMode: { old: previous.releaseMode, new: input.mode },
    releaseSha: { old: previous.releaseSha, new: input.mode === "METADATA_PILOT" ? sha : null },
    reason: { new: why },
  });
  return unifiedReleasePolicyTx(tx, companyId);
}
