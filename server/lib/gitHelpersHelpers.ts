// Extracted from ./gitHelpers.ts
import {
  CompanyAccessError,
  getAccessibleCompanyIds as getMembershipCompanyIds,
  isPrivilegedRole,
  parsePositiveCompanyId,
} from "../security/companyAccessBoundary";

export const ACTIVE_STATUSES = ["OTW", "Sea", "At Port", "Left Dar", "At Border", "In Transit", "Arrived"] as const;

export type ActiveStatus = (typeof ACTIVE_STATUSES)[number];

export const INACTIVE_STATUSES = ["Offloaded", "Closed", "Completed"] as const;

export const TRANSPORTER_OFFLOAD_DAYS: Record<string, number> = {
  FARHAT: 11,
  CONTINENTAL: 11,
  TRH: 14,
};

export const DEFAULT_OFFLOAD_DAYS = 14;

/**
 * Resolves company scope from request query params.
 *
 * Returns one of:
 *   { mode: "all",    companyIds: number[] }
 *   { mode: "single", companyId: number }
 *   { error: string,  status: number }       ← caller should return this as HTTP error
 */
export type GitCompanyScope =
  | { mode: "all"; companyIds: number[] }
  | { mode: "single"; companyId: number }
  | { error: string; status: number; code: string };

function gitScopeError(error: unknown): Extract<GitCompanyScope, { error: string }> {
  if (error instanceof CompanyAccessError) {
    return { error: error.message, status: error.status, code: error.code };
  }
  return { error: "Unable to resolve company access", status: 500, code: "COMPANY_CONTEXT_FAILED" };
}

export async function resolveGitCompanyScope(
  userId: string,
  role: string,
  query: Record<string, string | string[] | undefined>,
  sessionCompanyId: number | undefined
): Promise<GitCompanyScope> {
  try {
    const wantsAll = query.allCompanies === "true";
    const rawId = typeof query.companyId === "string" ? query.companyId.trim() : "";
    const activeCompanyId = parsePositiveCompanyId(sessionCompanyId, "activeCompanyId");
    const accessible = await getMembershipCompanyIds(userId);

    if (wantsAll) {
      if (!isPrivilegedRole(role)) {
        return {
          error: "Cross-company access requires a privileged role",
          status: 403,
          code: "CROSS_COMPANY_FORBIDDEN",
        };
      }
      return { mode: "all", companyIds: [...accessible].sort((left, right) => left - right) };
    }

    if (rawId) {
      const requestedId = parsePositiveCompanyId(rawId, "requestedCompanyId");
      if (requestedId !== activeCompanyId && !isPrivilegedRole(role)) {
        return {
          error: "Cross-company access requires a privileged role",
          status: 403,
          code: "CROSS_COMPANY_FORBIDDEN",
        };
      }
      if (!accessible.has(requestedId)) {
        return { error: "No access to this company", status: 403, code: "COMPANY_ACCESS_DENIED" };
      }
      return { mode: "single", companyId: requestedId };
    }

    if (!accessible.has(activeCompanyId)) {
      return { error: "No access to this company", status: 403, code: "COMPANY_ACCESS_DENIED" };
    }
    return { mode: "single", companyId: activeCompanyId };
  } catch (error) {
    return gitScopeError(error);
  }
}

export type RawContainerRow = {
  id: number;
  companyId: number;
  // Active destination links to this one physical tracking record, scoped to the requested companies.
  linkedDestinationCompanyIds?: number[];
  containerNumber: string;
  supplierId: number;
  supplierName: string | null;
  supplierCode: string | null;
  status: string;
  importDate: string;
  grandTotal: string | null;
  itemName: string | null;
  shopName: string | null;
  eta: string | null;
  portDepartureDate?: string | null;
  etaSource: string | null;
  transporter: string | null;
  transportFee: string | null;
  numberPlate: string | null;
  trackingLocation: string | null;
  borderDate: string | null;
  offloadDate: string | null;
  agent: string | null;
  dutyFee: string | null;
  docReceived: boolean | null;
  trackingDescription: string | null;
  blDocs: string | null;
  docsSentDate: string | null;
  freightStatus: string | null;
  trackingLink: string | null;
  poFreight: string | null;
  // ParcelsApp tracking fields
  trackingProvider: string | null;
  trackingEnabled: boolean;
  trackingAutoUpdate: boolean;
  trackingCarrierHint: string | null;
  trackingLastCheckedAt: Date | null;
  trackingLastStatus: string | null;
  trackingLastLocation: string | null;
  trackingLastEventDate: Date | null;
  trackingLastDescription: string | null;
  trackingError: string | null;
  trackingChangedAt: Date | null;
  trackingDetectedCarrier: string | null;
  trackingFallbackUsed: boolean | null;
  trackingFallbackReason: string | null;
  trackingNextCheckAt: Date | null;
  trackingLastSkipReason: string | null;
  createdAt: Date;
};

export type EnrichedContainer = RawContainerRow & {
  companyName: string;
  supplierName: string | null;
  maxOffloadDate: string | null;
  daysDelayed: number | null;
  docsReadyNotSent: boolean;
  isOverdue: boolean;
};

export interface GitFilterQuery {
  status?: string;
  transporter?: string;
  agent?: string;
  location?: string;
  search?: string;
  q?: string;
  docsReady?: string;
  delayed?: string;
  overdue?: string;
}

export interface GitSummary {
  total: number;
  byStatus: Record<string, number>;
  delayed: number;
  overdue: number;
  docsReadyNotSent: number;
  withTruck: number;
  withoutTruck: number;
}

export function buildSummary(rows: EnrichedContainer[]): GitSummary {
  const byStatus: Record<string, number> = {};
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  }
  return {
    total: rows.length,
    byStatus,
    delayed: rows.filter((r) => r.daysDelayed !== null && r.daysDelayed > 0).length,
    overdue: rows.filter((r) => r.isOverdue).length,
    docsReadyNotSent: rows.filter((r) => r.docsReadyNotSent).length,
    withTruck: rows.filter((r) => !!(r.numberPlate ?? "").trim()).length,
    withoutTruck: rows.filter((r) => !(r.numberPlate ?? "").trim()).length,
  };
}
