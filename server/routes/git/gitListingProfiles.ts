import type { EnrichedContainer } from "../../lib/gitHelpers";

export interface GitListingQuery extends Record<string, string | string[] | undefined> {
  page?: string;
  pageSize?: string;
  profile?: string;
  all?: string;
  company?: string;
  containers?: string;
  suppliers?: string;
  transporters?: string;
  agents?: string;
  trucks?: string;
  locations?: string;
  docs?: string;
  delayedState?: string;
  freight?: string;
  etaDates?: string;
  includeNoEta?: string;
  notes?: string;
  sort?: string;
  search?: string;
  q?: string;
  status?: string;
  transporter?: string;
  agent?: string;
  location?: string;
  docsReady?: string;
  delayed?: string;
  overdue?: string;
}

export interface GitListingSummary {
  total: number;
  atSea: number;
  atPort: number;
  leftDar: number;
  inTransit: number;
  arrived: number;
  delayed: number;
  overdue: number;
  totalCost: number;
  totalTransportDuty: number;
}

export interface GitListingFacets {
  companies: string[];
  containerNumbers: string[];
  suppliers: string[];
  transporters: string[];
  agents: string[];
  trucks: string[];
  locations: string[];
  etaDates: string[];
  hasContainersWithNoEta: boolean;
}

const csv = (value: string | string[] | undefined): string[] => {
  const raw = Array.isArray(value) ? value.join(",") : value ?? "";
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
};

const includesOrSentinel = (
  selected: string[],
  value: string | null | undefined,
  emptySentinel?: string,
  presentSentinel?: string,
): boolean => {
  if (selected.length === 0) return true;
  const normalized = (value ?? "").trim();
  return selected.some((candidate) => {
    if (emptySentinel && candidate === emptySentinel) return !normalized;
    if (presentSentinel && candidate === presentSentinel) return !!normalized;
    return candidate === normalized;
  });
};

export function parseGitPagination(query: GitListingQuery) {
  const rawPage = Number.parseInt(String(query.page ?? "1"), 10);
  const rawPageSize = Number.parseInt(String(query.pageSize ?? "50"), 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const pageSize = Math.min(100, Number.isFinite(rawPageSize) && rawPageSize > 0 ? rawPageSize : 50);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function applyGitTableFilters(rows: EnrichedContainer[], query: GitListingQuery): EnrichedContainer[] {
  const selectedContainers = csv(query.containers);
  const selectedSuppliers = csv(query.suppliers);
  const selectedTransporters = csv(query.transporters);
  const selectedAgents = csv(query.agents);
  const selectedTrucks = csv(query.trucks);
  const selectedLocations = csv(query.locations);
  const selectedEtaDates = csv(query.etaDates);
  const search = String(query.search ?? query.q ?? "").trim().toLowerCase();

  return rows.filter((row) => {
    if (query.company && query.company !== "ALL" && row.companyName !== query.company) return false;
    if (query.status && row.status !== query.status) return false;
    if (query.transporter && row.transporter !== query.transporter) return false;
    if (query.agent && row.agent !== query.agent) return false;
    if (query.location && row.trackingLocation !== query.location) return false;
    if (query.docsReady === "true" && !row.docsReadyNotSent) return false;
    if (query.delayed === "true" && !(row.daysDelayed && row.daysDelayed > 0)) return false;
    if (query.overdue === "true" && !row.isOverdue) return false;
    if (selectedContainers.length > 0 && !selectedContainers.includes(row.containerNumber)) return false;
    if (selectedSuppliers.length > 0 && !selectedSuppliers.includes(row.supplierCode ?? "")) return false;
    if (!includesOrSentinel(selectedTransporters, row.transporter, "NO_TRANSPORTER")) return false;
    if (!includesOrSentinel(selectedAgents, row.agent, "NO_AGENT")) return false;
    if (!includesOrSentinel(selectedTrucks, row.numberPlate, "NO_TRUCK", "HAS_TRUCK")) return false;
    if (!includesOrSentinel(selectedLocations, row.trackingLocation, "NO_LOCATION", "HAS_LOCATION")) return false;

    if (query.docs === "MISSING" && row.docReceived) return false;
    if (query.docs === "RECEIVED" && !row.docReceived) return false;
    if (query.delayedState === "YES" && !(row.daysDelayed && row.daysDelayed > 0)) return false;
    if (query.delayedState === "OVERDUE" && !row.isOverdue) return false;
    if (query.delayedState === "NO" && !!(row.daysDelayed && row.daysDelayed > 0)) return false;

    const freight = Number.parseFloat(row.poFreight ?? "0") || 0;
    if (query.freight === "HAS_FREIGHT" && freight <= 0) return false;
    if (query.freight === "NO_FREIGHT" && freight > 0) return false;

    if (selectedEtaDates.length > 0 || query.includeNoEta === "true") {
      if (!row.eta) {
        if (query.includeNoEta !== "true") return false;
      } else if (!selectedEtaDates.includes(row.eta)) {
        return false;
      }
    }

    if (query.notes === "WITH" && !(row.trackingDescription ?? "").trim()) return false;
    if (query.notes === "WITHOUT" && !!(row.trackingDescription ?? "").trim()) return false;

    if (search) {
      const values = [row.containerNumber, row.companyName, row.numberPlate, row.transporter, row.agent];
      if (!values.some((value) => (value ?? "").toLowerCase().includes(search))) return false;
    }
    return true;
  });
}

export function sortGitRows(rows: EnrichedContainer[], sort: string | undefined): EnrichedContainer[] {
  return [...rows].sort((a, b) => {
    if (sort === "ETA_ASC" || sort === "ETA_DESC") {
      const aMs = a.eta ? new Date(a.eta).getTime() : sort === "ETA_ASC" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
      const bMs = b.eta ? new Date(b.eta).getTime() : sort === "ETA_ASC" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
      if (aMs !== bMs) return sort === "ETA_ASC" ? aMs - bMs : bMs - aMs;
    }
    const companyOrder = a.companyName.localeCompare(b.companyName, undefined, { sensitivity: "base" });
    if (companyOrder !== 0) return companyOrder;
    const shopOrder = (a.shopName ?? "").localeCompare(b.shopName ?? "", undefined, {
      numeric: true,
      sensitivity: "base",
    });
    if (shopOrder !== 0) return shopOrder;
    return a.containerNumber.localeCompare(b.containerNumber);
  });
}

const unique = (values: Array<string | null | undefined>) =>
  [...new Set(values.map((value) => (value ?? "").trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
  );

export function buildGitFacets(rows: EnrichedContainer[]): GitListingFacets {
  return {
    companies: unique(rows.map((row) => row.companyName)),
    containerNumbers: unique(rows.map((row) => row.containerNumber)),
    suppliers: unique(rows.map((row) => row.supplierCode)),
    transporters: unique(rows.map((row) => row.transporter)),
    agents: unique(rows.map((row) => row.agent)),
    trucks: unique(rows.map((row) => row.numberPlate)),
    locations: unique(rows.map((row) => row.trackingLocation)),
    etaDates: unique(rows.map((row) => row.eta)),
    hasContainersWithNoEta: rows.some((row) => !row.eta),
  };
}

const amount = (value: string | null | undefined) => Number.parseFloat(value ?? "0") || 0;

export function buildGitTableSummary(rows: EnrichedContainer[]): GitListingSummary {
  return {
    total: rows.length,
    atSea: rows.filter((row) => row.status === "OTW" || row.status === "Sea").length,
    atPort: rows.filter((row) => row.status === "At Port").length,
    leftDar: rows.filter((row) => row.status === "Left Dar").length,
    inTransit: rows.filter((row) => row.status === "At Border" || row.status === "In Transit").length,
    arrived: rows.filter((row) => row.status === "Arrived").length,
    delayed: rows.filter((row) => row.daysDelayed !== null && row.daysDelayed > 0).length,
    overdue: rows.filter((row) => row.isOverdue).length,
    totalCost: rows.reduce((sum, row) => sum + amount(row.grandTotal), 0),
    totalTransportDuty: rows.reduce((sum, row) => sum + amount(row.transportFee) + amount(row.dutyFee), 0),
  };
}

export function toGitCompactRow(row: EnrichedContainer) {
  const compact: Record<string, unknown> = { ...row };
  for (const key of [
    "trackingProvider",
    "trackingEnabled",
    "trackingAutoUpdate",
    "trackingCarrierHint",
    "trackingLastCheckedAt",
    "trackingLastStatus",
    "trackingLastLocation",
    "trackingLastEventDate",
    "trackingLastDescription",
    "trackingError",
    "trackingChangedAt",
    "trackingDetectedCarrier",
    "trackingFallbackUsed",
    "trackingFallbackReason",
    "trackingNextCheckAt",
    "trackingLastSkipReason",
    "trackingLink",
    "createdAt",
  ]) {
    delete compact[key];
  }
  return compact;
}
