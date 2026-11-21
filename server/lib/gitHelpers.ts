import { searchAny } from "@shared/searchNormalization";
/**
 * gitHelpers.ts — Shared helpers for GIT (Global In-Transit) read routes.
 *
 * Read-only. No INSERT / UPDATE / DELETE anywhere in this file.
 * All DB calls are SELECT-only.
 */

import { db } from "../db";
import { fetchSpGitContainers } from "./spGitTracking";
import { hasIntercompanyTradesTable } from "./intercompanyTradeAvailability";
import { containers, companies, suppliers } from "../../shared/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  ACTIVE_STATUSES,
  INACTIVE_STATUSES,
  TRANSPORTER_OFFLOAD_DAYS,
  DEFAULT_OFFLOAD_DAYS,
  type RawContainerRow,
  type EnrichedContainer,
  type GitFilterQuery,
} from "./gitHelpersHelpers";
export {
  ACTIVE_STATUSES,
  INACTIVE_STATUSES,
  resolveGitCompanyScope,
  buildSummary,
  type ActiveStatus,
  type GitCompanyScope,
  type RawContainerRow,
  type EnrichedContainer,
  type GitFilterQuery,
  type GitSummary,
} from "./gitHelpersHelpers";

// ── Status constants ──────────────────────────────────────────────────────────

// DB stores "OFFLOADED" (all-caps) via storage.offloadContainer; include both casings.
export const INACTIVE_SET = new Set<string>([...INACTIVE_STATUSES, "OFFLOADED", "CLOSED", "COMPLETED"]);

// ── Transporter SLA windows (days from borderDate to maxOffloadDate) ──────────

// ── Access control ────────────────────────────────────────────────────────────

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
  // Do not reference optional intercompany tables until Phase 1 has actually
  // been installed in this database. The company-owned container list remains
  // available, with no cross-company visibility added by the fallback.
  const hasTradeTable =
    opts.containerId !== undefined && opts.containerId < 0 ? false : await hasIntercompanyTradesTable();
  const standaloneGrandTotal = sql<string>`COALESCE(
    (SELECT COALESCE(SUM(po.items_total::numeric), 0) FROM purchase_orders po WHERE po.container_id = ${containers.id})
    + (SELECT COALESCE(SUM(cc.amount::numeric), 0) FROM container_charges cc WHERE cc.container_id = ${containers.id}),
    0
  )::text`;

  const conditions = [
    hasTradeTable
      ? sql`(${inArray(containers.companyId, companyIds)} OR EXISTS (SELECT 1 FROM intercompany_trades trade WHERE trade.physical_container_id = ${containers.id} AND trade.source_company_id = ${containers.companyId} AND trade.destination_company_id IN (${sql.join(
          companyIds.map((id) => sql`${id}`),
          sql`, `
        )}) AND trade.state = 'active'))`
      : inArray(containers.companyId, companyIds),
    inArray(containers.status, statusFilter),
  ];
  if (opts.containerId) conditions.push(eq(containers.id, opts.containerId));

  const erpRows =
    opts.containerId !== undefined && opts.containerId < 0
      ? []
      : await db
          .select({
            id: containers.id,
            companyId: containers.companyId,
            linkedDestinationCompanyIds: hasTradeTable
              ? sql<number[]>`(
                  SELECT COALESCE(array_agg(DISTINCT trade.destination_company_id), ARRAY[]::integer[])
                  FROM intercompany_trades trade
                  WHERE trade.physical_container_id = ${containers.id}
                    AND trade.source_company_id = ${containers.companyId}
                    AND trade.state = 'active'
                    AND trade.destination_company_id IN (${sql.join(
                      companyIds.map((id) => sql`${id}`),
                      sql`, `
                    )})
                )`
              : sql<number[]>`ARRAY[]::integer[]`,
            containerNumber: containers.containerNumber,
            supplierId: containers.supplierId,
            supplierName: suppliers.legalName,
            supplierCode: suppliers.code,
            status: containers.status,
            importDate: containers.importDate,
            grandTotal: hasTradeTable
              ? sql<string>`CASE WHEN EXISTS (SELECT 1 FROM intercompany_trades trade WHERE trade.physical_container_id = ${containers.id} AND trade.state = 'active') THEN ${containers.grandTotal}::text ELSE ${standaloneGrandTotal} END`
              : standaloneGrandTotal,
            itemName: containers.itemName,
            shopName: containers.shopName,
            eta: containers.eta,
            portDepartureDate: containers.portDepartureDate,
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

  // Supplier Partner source ids are negative in GIT only; never mirror them
  // into ERP containers or post another Goods OTW voucher.
  const spRows = await fetchSpGitContainers(companyIds, opts);
  return [...erpRows, ...spRows];
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
