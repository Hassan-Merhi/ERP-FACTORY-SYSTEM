import { searchAny } from "@shared/searchNormalization";
/**
 * gitHelpers.ts — Shared helpers for GIT (Global In-Transit) read routes.
 *
 * Read-only. No INSERT / UPDATE / DELETE anywhere in this file.
 * All DB calls are SELECT-only.
 */

import { db } from "../db";
import { containers, companies, suppliers } from "../../shared/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  CompanyAccessError,
  getAccessibleCompanyIds as getMembershipCompanyIds,
  isPrivilegedRole,
  parsePositiveCompanyId,
} from "../security/companyAccessBoundary";

// ── Status constants ──────────────────────────────────────────────────────────

export const ACTIVE_STATUSES = ["OTW", "Sea", "At Port", "Left Dar", "At Border", "In Transit", "Arrived"] as const;

export type ActiveStatus = (typeof ACTIVE_STATUSES)[number];

export const INACTIVE_STATUSES = ["Offloaded", "Closed", "Completed"] as const;
// DB stores "OFFLOADED" (all-caps) via storage.offloadContainer; include both casings.
export const INACTIVE_SET = new Set<string>([...INACTIVE_STATUSES, "OFFLOADED", "CLOSED", "COMPLETED"]);

// ── Transporter SLA windows (days from borderDate to maxOffloadDate) ──────────

const TRANSPORTER_OFFLOAD_DAYS: Record<string, number> = {
  FARHAT: 11,
  CONTINENTAL: 11,
  TRH: 14,
};
const DEFAULT_OFFLOAD_DAYS = 14;

// ── Access control ────────────────────────────────────────────────────────────

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

// ── Calculation helpers ───────────────────────────────────────────────────────

/**
 * Adds the transporter SLA days to borderDate.
 * Returns null if borderDate is absent or invalid.
 */
export function calcMaxOffloadDate(borderDate: string | null, transporter: string | null): string | null {
  if (!borderDate) return null;
  const d = new Date(borderDate);
  if (isNaN(d.getTime())) return null;
  const norm = (transporter ?? "").trim().toUpperCase();
  const days = TRANSPORTER_OFFLOAD_DAYS[norm] ?? DEFAULT_OFFLOAD_DAYS;
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Days the container has been sitting at port since its ETA, with no truck
 * assigned yet. Returns null when:
 *   - truck is already assigned (numberPlate is set)  → resets to "—"
 *   - ETA is unknown
 *   - container arrived today or hasn't arrived yet
 */
export function calcDaysDelayed(eta: string | null, numberPlate: string | null): number | null {
  if (numberPlate && numberPlate.trim()) return null;
  if (!eta) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const arrival = new Date(eta);
  if (isNaN(arrival.getTime())) return null;
  const diffMs = today.getTime() - arrival.getTime();
  if (diffMs <= 0) return null;
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * True when documents are received from the agent but not yet sent onward.
 */
export function calcDocsReadyNotSent(docReceived: boolean | null, docsSentDate: string | null): boolean {
  return docReceived === true && !docsSentDate;
}

/**
 * True when maxOffloadDate has passed and the container is still active.
 */
export function calcIsOverdue(maxOffloadDate: string | null, status: string): boolean {
  if (!maxOffloadDate || INACTIVE_SET.has(status)) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const max = new Date(maxOffloadDate);
  if (isNaN(max.getTime())) return false;
  return max < today;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type RawContainerRow = {
  id: number;
  companyId: number;
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

// ── DB helpers ────────────────────────────────────────────────────────────────

/**
 * Fetches all active containers for the given company IDs.
 * SELECT-only. No mutations.
 */
export async function fetchActiveContainers(
  companyIds: number[],
  opts: { includeOffloaded?: boolean; containerId?: number } = {}
): Promise<RawContainerRow[]> {
  if (companyIds.length === 0) return [];

  const statusFilter = opts.includeOffloaded ? [...ACTIVE_STATUSES, ...INACTIVE_STATUSES] : [...ACTIVE_STATUSES];

  const conditions = [
    inArray(containers.companyId, companyIds),
    inArray(containers.status, statusFilter),
  ];
  if (opts.containerId) conditions.push(eq(containers.id, opts.containerId));

  return db
    .select({
      id: containers.id,
      companyId: containers.companyId,
      containerNumber: containers.containerNumber,
      supplierId: containers.supplierId,
      supplierName: suppliers.legalName,
      supplierCode: suppliers.code,
      status: containers.status,
      importDate: containers.importDate,
      grandTotal: sql<string>`COALESCE(
        (SELECT COALESCE(SUM(po.items_total::numeric), 0) FROM purchase_orders po WHERE po.container_id = ${containers.id})
        + (SELECT COALESCE(SUM(cc.amount::numeric), 0) FROM container_charges cc WHERE cc.container_id = ${containers.id}),
        0
      )::text`,
      itemName: containers.itemName,
      shopName: containers.shopName,
      eta: containers.eta,
      etaSource: containers.etaSource,
      transporter: containers.transporter,
      transportFee: containers.transportFee,
      numberPlate: containers.numberPlate,
      trackingLocation: containers.trackingLocation,
      borderDate: containers.borderDate,
      offloadDate: containers.offloadDate,
      agent: containers.agent,
      dutyFee: containers.dutyFee,
      docReceived: containers.docReceived,
      trackingDescription: containers.trackingDescription,
      blDocs: containers.blDocs,
      docsSentDate: containers.docsSentDate,
      freightStatus: containers.freightStatus,
      trackingLink: containers.trackingLink,
      poFreight: sql<string>`(SELECT COALESCE(SUM(po.freight::numeric), 0) FROM purchase_orders po WHERE po.container_id = ${containers.id})::text`,
      // ParcelsApp tracking fields
      trackingProvider: containers.trackingProvider,
      trackingEnabled: containers.trackingEnabled,
      trackingAutoUpdate: containers.trackingAutoUpdate,
      trackingCarrierHint: containers.trackingCarrierHint,
      trackingLastCheckedAt: containers.trackingLastCheckedAt,
      trackingLastStatus: containers.trackingLastStatus,
      trackingLastLocation: containers.trackingLastLocation,
      trackingLastEventDate: containers.trackingLastEventDate,
      trackingLastDescription: containers.trackingLastDescription,
      trackingError: containers.trackingError,
      trackingChangedAt: containers.trackingChangedAt,
      trackingDetectedCarrier: containers.trackingDetectedCarrier,
      trackingFallbackUsed: containers.trackingFallbackUsed,
      trackingFallbackReason: containers.trackingFallbackReason,
      trackingNextCheckAt: containers.trackingNextCheckAt,
      trackingLastSkipReason: containers.trackingLastSkipReason,
      createdAt: containers.createdAt,
    })
    .from(containers)
    .leftJoin(suppliers, eq(containers.supplierId, suppliers.id))
    .where(and(...conditions))
    .orderBy(containers.containerNumber);
}

/**
 * Returns a map of companyId → name for the given IDs.
 * SELECT-only.
 */
export async function loadCompanyNames(ids: number[]): Promise<Record<number, string>> {
  if (ids.length === 0) return {};
  const rows = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(inArray(companies.id, ids));
  return Object.fromEntries(rows.map((r) => [r.id, r.name]));
}

/**
 * Attaches computed fields and company name to each raw container row.
 */
export function enrichContainers(rows: RawContainerRow[], nameMap: Record<number, string>): EnrichedContainer[] {
  return rows.map((r) => {
    const maxOffloadDate = calcMaxOffloadDate(r.borderDate, r.transporter);
    return {
      ...r,
      companyName: nameMap[r.companyId] ?? `Company ${r.companyId}`,
      maxOffloadDate,
      daysDelayed: calcDaysDelayed(r.eta, r.numberPlate),
      docsReadyNotSent: calcDocsReadyNotSent(r.docReceived, r.docsSentDate),
      isOverdue: calcIsOverdue(maxOffloadDate, r.status),
    };
  });
}

// ── Filter ────────────────────────────────────────────────────────────────────

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

export function applyGitFilters(rows: EnrichedContainer[], f: GitFilterQuery): EnrichedContainer[] {
  let out = rows;

  if (f.status) {
    const s = f.status.toLowerCase();
    out = out.filter((r) => r.status.toLowerCase() === s);
  }
  if (f.transporter) {
    const t = f.transporter.toLowerCase();
    out = out.filter((r) => (r.transporter ?? "").toLowerCase().includes(t));
  }
  if (f.agent) {
    const a = f.agent.toLowerCase();
    out = out.filter((r) => (r.agent ?? "").toLowerCase().includes(a));
  }
  if (f.location) {
    const l = f.location.toLowerCase();
    out = out.filter((r) => (r.trackingLocation ?? "").toLowerCase().includes(l));
  }

  const term = f.search || f.q;
  if (term) {
    out = out.filter((r) => searchAny(term, r.containerNumber, r.shopName, r.agent, r.transporter));
  }

  if (f.docsReady === "true") {
    out = out.filter((r) => r.docsReadyNotSent);
  }
  if (f.delayed === "true") {
    out = out.filter((r) => r.daysDelayed !== null && r.daysDelayed > 0);
  }
  if (f.overdue === "true") {
    out = out.filter((r) => r.isOverdue);
  }

  return out;
}

// ── Summary builder ───────────────────────────────────────────────────────────

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
