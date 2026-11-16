// Extracted from ./UnifiedAccountingRollout.tsx to keep that module under the source-size cap.

export type Kind = "TECHNICAL" | "SECURITY" | "FINANCE";

export type Mode = "READ_ONLY" | "METADATA_PILOT";

interface Review {
  id: number;
  kind: Kind;
  reviewerId: string;
  reviewerName: string;
  reviewedAt: string;
  evidenceReference: string;
  notes: string;
  revoked: boolean;
}

export interface Policy {
  companyId: number;
  releaseMode: Mode;
  releaseSha: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  reason: string | null;
  configured: boolean;
}

export interface Readiness {
  companyId: number;
  businessDate: string;
  deployedSha: string | null;
  releaseMode: Mode;
  policy: Policy;
  bookedTrial: { balanced: boolean; differenceUsd: string; assumedOpeningSides: number };
  historicalFx: {
    ready: boolean;
    unresolvedEntryCount: number;
    unresolvedVoucherCount: number;
    sampleVoucherIds: number[];
    certified: false;
    caveat: string;
  };
  schema: {
    missing: string[];
    unprotected: string[];
    tables: Array<{
      name: string;
      exists: boolean;
      rls: boolean;
      forced: boolean;
      hasPolicy: boolean;
    }>;
  };
  posting: {
    perpetualReady: boolean;
    phase15CanActivateInventory: false;
    phase15CanPostFinancialVouchers: false;
    phase15CanRewriteHistoricalVouchers: false;
  };
  phaseCatalog: Array<{ phase: number; title: string; erpPath: string; implementation: string }>;
  releaseReviews: Review[];
  reviewsComplete: boolean;
  blockers: string[];
  warnings: string[];
  eligibleForExternalReview: boolean;
  pilotOperational: boolean;
  metadataEntryReferencesCompatible: boolean;
  certified: false;
  status: "PROVISIONAL_NOT_CERTIFIED";
}

export const root = "/api/accounting/rollout";

export const kinds: Kind[] = ["TECHNICAL", "SECURITY", "FINANCE"];

export async function read<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.message ?? "Rollout report unavailable");
  return result as T;
}
