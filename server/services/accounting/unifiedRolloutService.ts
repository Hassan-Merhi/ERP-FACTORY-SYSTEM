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
import { companyBusinessDate } from "./companyBusinessDate";
import { buildTrialBalance } from "./integrity/trialBalance";
import { getHistoricalCurrencyReadiness } from "./historicalCurrencyReadiness";
import { PERPETUAL_INVENTORY_POSTING_READY } from "./perpetualInventory/cutover";
import { writeAuditEvent } from "../audit";

export type ReviewKind = "TECHNICAL" | "SECURITY" | "FINANCE";
export type ReleaseMode = "READ_ONLY" | "METADATA_PILOT";
export interface ReleaseActor {
  userId: string;
  username: string;
}
export class ReleaseError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 409
  ) {
    super(message);
    this.name = "ReleaseError";
  }
}
interface PolicyRow extends Record<string, unknown> {
  release_mode: ReleaseMode;
  release_sha: string | null;
  approved_by: string;
  approved_at: string;
  reason: string;
}
interface ReviewRow extends Record<string, unknown> {
  id: number;
  company_id: number;
  release_sha: string;
  review_kind: ReviewKind;
  evidence_reference: string;
  reviewer_id: string;
  reviewer_name: string;
  reviewed_at: string;
  notes: string;
  revoked_at: string | null;
}
export const UNIFIED_PHASES = [
  [1, "Unified accounting foundation", "/accounting/dashboard"],
  [2, "Double-entry posting and voucher lifecycle", "/vouchers"],
  [3, "Party open-item reconciliation", "/accounting/open-items"],
  [4, "Bank and cash reconciliation", "/accounting/cash-bank"],
  [5, "Historical multi-currency", "/accounting/monetary-fx"],
  [6, "ERP inventory and cost of goods sold", "/accounting/erp-inventory"],
  [7, "Factory production and containers", "/accounting/factory-production"],
  [8, "Rental accounting", "/accounting/rentals"],
  [9, "Intercompany and consolidation", "/accounting/consolidation"],
  [10, "Historical accounting", "/accounting/history"],
  [11, "Professional financial statements", "/accounting/statements"],
  [12, "Cost centers (main's Cost Centers module)", "/cost-centers"],
  [13, "Fiscal closing and audit review", "/accounting/fiscal-review"],
  [14, "Unified net position dashboard", "/accounting/dashboard"],
  [15, "Integration, permissions and rollout", "/accounting/rollout"],
] as const;
const requiredTables = [
  "accounting_open_item_matches",
  "accounting_cash_bank_statements",
  "accounting_cash_bank_matches",
  "accounting_fx_realizations",
  "accounting_rental_expense_links",
  "accounting_fiscal_review_signoffs",
  "accounting_fiscal_reviewed_closures",
  "accounting_fiscal_review_policy",
  "accounting_unified_release_reviews",
  "accounting_unified_rollout_policy",
  "cost_centers",
  "cost_center_allocations",
  "cost_center_monthly_budgets",
] as const;
const protectedTables = [
  "accounting_open_item_matches",
  "accounting_cash_bank_statements",
  "accounting_cash_bank_matches",
  "accounting_fx_realizations",
  "accounting_rental_expense_links",
  "accounting_fiscal_review_signoffs",
  "accounting_fiscal_reviewed_closures",
  "accounting_fiscal_review_policy",
  "accounting_unified_release_reviews",
  "accounting_unified_rollout_policy",
  "cost_centers",
  "cost_center_allocations",
  "cost_center_monthly_budgets",
] as const;
const HEX40 = /^[a-f0-9]{40,64}$/;
export function deployedUnifiedReleaseSha(): string | null {
  // The hosting provider source identity outranks any manually maintained
  // fallback. A stale override may never make changed deployed code appear to
  // be the previously certified build.
  const value = String(
    process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || process.env.UNIFIED_ACCOUNTING_RELEASE_SHA || ""
  )
    .trim()
    .toLowerCase();
  return HEX40.test(value) ? value : null;
}
function reviewerId(value: string) {
  const out = value.trim();
  if (!out) throw new ReleaseError("RELEASE_ACTOR_MISSING", "Authenticated reviewer required", 401);
  return out;
}
function reason(value: string) {
  const clean = value.trim();
  if (clean.length < 10 || clean.length > 1000)
    throw new ReleaseError("RELEASE_REASON_INVALID", "A reason of 10–1,000 characters is required", 400);
  return clean;
}
const num = (x: unknown) => Number(String(x ?? 0));
const lock = (tx: DbTransaction, companyId: number) =>
  tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`accounting-release:${companyId}`}))`);
async function reviewsTx(tx: DbTransaction, companyId: number, sha: string | null) {
  if (!sha) return [] as ReviewRow[];
  return resultRows<ReviewRow>(
    await tx.execute(sql`
 SELECT id,company_id,release_sha,review_kind,evidence_reference,
  reviewer_id,reviewer_name,reviewed_at::text,notes,revoked_at::text
 FROM accounting_unified_release_reviews
 WHERE company_id=${companyId} AND release_sha=${sha}
 ORDER BY id DESC LIMIT 50
 `)
  );
}
export async function unifiedReleasePolicyTx(tx: DbTransaction, companyId: number) {
  await assertTransactionCompanyScope(tx, companyId);
  const policy = resultRows<PolicyRow>(
    await tx.execute(sql`
 SELECT release_mode,release_sha,approved_by,approved_at::text,reason
 FROM accounting_unified_rollout_policy
 WHERE company_id=${companyId} LIMIT 1
 `)
  )[0];
  return {
    companyId,
    releaseMode: policy?.release_mode ?? ("READ_ONLY" as ReleaseMode),
    releaseSha: policy?.release_sha ?? null,
    updatedBy: policy?.approved_by ?? null,
    updatedAt: policy?.approved_at ?? null,
    reason: policy?.reason ?? null,
    configured: !!policy,
  };
}
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
interface DbTable extends Record<string, unknown> {
  name: string;
  exists: boolean;
  rls: boolean;
  forced: boolean;
  // Existence of a real RLS policy is necessary but not sufficient proof of
  // company isolation. External penetration tests still own certification.
  hasPolicy: boolean;
}
/**
 * Open-item, cash/bank and cost-allocation rows reference voucher_entries(id)
 * ON DELETE RESTRICT, while existing voucher edit flows (sales update, journal
 * and payment edits, container voucher sync, POS edits) delete and re-insert a
 * voucher's lines. Once a metadata row exists, those established workflows
 * would fail. Keep the pilot blocked until they are made compatible without
 * changing any posted amount.
 */
export const METADATA_ENTRY_REFERENCES_COMPATIBLE = false;
export const METADATA_ENTRY_REFERENCES_BLOCKER =
  "Metadata matches/allocations reference voucher lines ON DELETE RESTRICT, but existing voucher edit flows replace voucher lines; certify compatibility before any metadata pilot";
export async function unifiedReleaseReadinessTx(tx: DbTransaction, companyId: number) {
  await assertTransactionCompanyScope(tx, companyId);
  const date = await companyBusinessDate(companyId, tx);
  const sha = deployedUnifiedReleaseSha();
  const [tableRows, companyRows, trial, policy, reviews, historicalFx] = await Promise.all([
    tx.execute(sql`
   SELECT names.name,
    (c.oid IS NOT NULL) AS exists,
    COALESCE(c.relrowsecurity,false) AS rls,
    COALESCE(c.relforcerowsecurity,false) AS forced,
    EXISTS(
      SELECT 1 FROM pg_policies p
      WHERE p.schemaname=current_schema() AND p.tablename=names.name
    ) AS "hasPolicy"
   FROM UNNEST(ARRAY[
    'accounting_open_item_matches','accounting_cash_bank_statements',
    'accounting_cash_bank_matches','accounting_fx_realizations',
    'accounting_rental_expense_links',
    'accounting_fiscal_review_signoffs','accounting_fiscal_reviewed_closures',
    'accounting_fiscal_review_policy','accounting_unified_release_reviews',
    'accounting_unified_rollout_policy',
    'cost_centers','cost_center_allocations','cost_center_monthly_budgets'
   ]::text[]) AS names(name)
   LEFT JOIN pg_class c ON c.relname=names.name AND
    c.relnamespace=(SELECT oid FROM pg_namespace WHERE nspname=current_schema())
  `),
    tx.execute(sql`SELECT id,base_currency,active FROM companies WHERE id=${companyId}`),
    buildTrialBalance(companyId, date, tx),
    unifiedReleasePolicyTx(tx, companyId),
    reviewsTx(tx, companyId, sha),
    getHistoricalCurrencyReadiness(companyId, date),
  ]);
  const tables = resultRows<DbTable>(tableRows);
  const company = resultRows<{ id: number; base_currency: string | null; active: boolean } & Record<string, unknown>>(
    companyRows
  )[0];
  const byName = new Map(tables.map((x) => [x.name, x]));
  const missing = requiredTables.filter((t) => !byName.get(t)?.exists);
  const unprotected = protectedTables.filter(
    (t) => !!byName.get(t)?.exists && (!byName.get(t)?.rls || !byName.get(t)?.forced || !byName.get(t)?.hasPolicy)
  );
  const blockers: string[] = [];
  if (!sha)
    blockers.push(
      "Deployed full source SHA unavailable: set UNIFIED_ACCOUNTING_RELEASE_SHA or use Render full commit SHA before certification"
    );
  if (!company || !company.active) blockers.push("Selected company is inactive or missing");
  if (
    String(company?.base_currency ?? "USD")
      .trim()
      .toUpperCase() !== "USD"
  )
    blockers.push("Non-USD functional-base financial translation requires certified policy");
  if (!trial.balanced)
    blockers.push(`Unresolved canonical trial balance difference: USD ${trial.unexplainedDifference}`);
  if (!historicalFx.ready)
    blockers.push(
      `Unresolved historical FX base records: ${historicalFx.unresolvedEntryCount} entries and ${historicalFx.unresolvedVoucherCount} vouchers`
    );
  if (missing.length) blockers.push(`Missing additive accounting metadata tables: ${missing.join(", ")}`);
  if (unprotected.length)
    blockers.push(`Required RLS, FORCE RLS or company policy is missing: ${unprotected.join(", ")}`);
  if (!METADATA_ENTRY_REFERENCES_COMPATIBLE) blockers.push(METADATA_ENTRY_REFERENCES_BLOCKER);
  const active = reviews.filter((v) => !v.revoked_at);
  const seen = new Set(active.map((v) => v.review_kind));
  const technical = active.find((x) => x.review_kind === "TECHNICAL");
  const warnings = [
    "Source code, CI and accounting evidence references must be independently reviewed by Claude and the accounting team; entering a link here does not verify its content.",
    "Legacy historical FX compatibility-ready does not establish immutable historical USD rates.",
    "P&L, ERP/Factory inventory and rental sources are provisional until real source reconciliation.",
    "The pilot only enables newly added metadata writes. Realized FX, reviewed fiscal closing and inventory cutover remain separately blocked.",
    "Existing ERP/Factory posting, voucher lifecycle and legacy workflows are not rerouted or migrated by this release gate.",
  ];
  if (!PERPETUAL_INVENTORY_POSTING_READY)
    warnings.push("Perpetual inventory global posting gate remains FALSE and must not be enabled by this rollout.");
  const signoffs = reviews.map((v) => ({
    id: num(v.id),
    kind: v.review_kind,
    reviewerId: v.reviewer_id,
    reviewerName: v.reviewer_name,
    reviewedAt: v.reviewed_at,
    evidenceReference: v.evidence_reference,
    notes: v.notes,
    revoked: !!v.revoked_at,
  }));
  return {
    companyId,
    businessDate: date,
    deployedSha: sha,
    releaseMode: policy.releaseMode,
    policy,
    bookedTrial: {
      balanced: trial.balanced,
      differenceUsd: trial.unexplainedDifference,
      assumedOpeningSides: trial.openingSidesAssumed,
    },
    historicalFx: {
      ...historicalFx,
      certified: false as const,
      caveat: "Pure legacy compatibility-ready is not independently verified historical USD base completeness.",
    },
    schema: { missing, unprotected, tables },
    posting: {
      perpetualReady: PERPETUAL_INVENTORY_POSTING_READY,
      phase15CanActivateInventory: false,
      phase15CanPostFinancialVouchers: false,
      phase15CanRewriteHistoricalVouchers: false,
    },
    phaseCatalog: UNIFIED_PHASES.map(([phase, title, erpPath]) => ({
      phase,
      title,
      erpPath,
      implementation: "COMMITTED_AWAITING_INDEPENDENT_VERIFICATION",
    })),
    releaseReviews: signoffs,
    metadataEntryReferencesCompatible: METADATA_ENTRY_REFERENCES_COMPATIBLE,
    reviewsComplete:
      seen.has("TECHNICAL") &&
      seen.has("SECURITY") &&
      seen.has("FINANCE") &&
      !!technical &&
      technical.reviewer_id !== policy.updatedBy,
    blockers,
    warnings,
    eligibleForExternalReview: !blockers.length,
    pilotOperational:
      METADATA_ENTRY_REFERENCES_COMPATIBLE &&
      blockers.length === 0 &&
      policy.releaseMode === "METADATA_PILOT" &&
      !!sha &&
      policy.releaseSha === sha &&
      !!technical &&
      technical.reviewer_id !== policy.updatedBy &&
      ["TECHNICAL", "SECURITY", "FINANCE"].every((k) => seen.has(k as ReviewKind)),
    certified: false as const,
    status: "PROVISIONAL_NOT_CERTIFIED" as const,
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
