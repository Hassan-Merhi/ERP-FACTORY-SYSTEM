// Extracted from ./unifiedRolloutService.ts to keep that module under the source-size cap.
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { companyBusinessDate } from "./companyBusinessDate";
import { buildTrialBalance } from "./integrity/trialBalance";
import { getHistoricalCurrencyReadiness } from "./historicalCurrencyReadiness";
import { PERPETUAL_INVENTORY_POSTING_READY } from "./perpetualInventory/cutover";
import {
  UNIFIED_PHASES,
  requiredTables,
  protectedTables,
  HEX40,
  METADATA_ENTRY_REFERENCES_COMPATIBLE,
  METADATA_ENTRY_REFERENCES_BLOCKER,
  type ReviewKind,
  type ReleaseMode,
  type PolicyRow,
  type ReviewRow,
  type DbTable,
} from "./unifiedReleaseReadinessTxModel";
export {
  UNIFIED_PHASES,
  METADATA_ENTRY_REFERENCES_COMPATIBLE,
  METADATA_ENTRY_REFERENCES_BLOCKER,
  type ReviewKind,
  type ReleaseMode,
  type ReleaseActor,
  type ReviewRow,
} from "./unifiedReleaseReadinessTxModel";

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

export function reviewerId(value: string) {
  const out = value.trim();
  if (!out) throw new ReleaseError("RELEASE_ACTOR_MISSING", "Authenticated reviewer required", 401);
  return out;
}

export function reason(value: string) {
  const clean = value.trim();
  if (clean.length < 10 || clean.length > 1000)
    throw new ReleaseError("RELEASE_REASON_INVALID", "A reason of 10–1,000 characters is required", 400);
  return clean;
}

export const num = (x: unknown) => Number(String(x ?? 0));

export const lock = (tx: DbTransaction, companyId: number) =>
  tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`accounting-release:${companyId}`}))`);

export async function reviewsTx(tx: DbTransaction, companyId: number, sha: string | null) {
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
