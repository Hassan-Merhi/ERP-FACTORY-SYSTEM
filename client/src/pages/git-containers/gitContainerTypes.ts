export interface EnrichedContainerRow {
  id: number;
  containerNumber: string;
  companyId: number;
  companyName: string;
  shopName: string | null;
  supplierName: string | null;
  supplierCode: string | null;
  status: string;
  eta: string | null;
  grandTotal: string | null;
  numberPlate: string | null;
  trackingLocation: string | null;
  borderDate: string | null;
  transporter: string | null;
  transportFee: string | null;
  agent: string | null;
  dutyFee: string | null;
  docReceived: boolean | null;
  trackingDescription: string | null;
  blDocs: string | null;
  docsSentDate: string | null;
  freightStatus: string | null;
  trackingLink?: string | null;
  poFreight: string | null;
  // ParcelsApp auto-tracking
  trackingProvider?: string | null;
  trackingEnabled?: boolean;
  trackingAutoUpdate?: boolean;
  trackingCarrierHint?: string | null;
  trackingLastCheckedAt?: string | null;
  trackingLastStatus?: string | null;
  trackingLastLocation?: string | null;
  trackingLastEventDate?: string | null;
  trackingLastDescription?: string | null;
  trackingError?: string | null;
  trackingChangedAt?: string | null;
  trackingDetectedCarrier?: string | null;
  trackingFallbackUsed?: boolean | null;
  trackingFallbackReason?: string | null;
  trackingNextCheckAt?: string | null;
  trackingLastSkipReason?: string | null;
  maxOffloadDate: string | null;
  daysDelayed: number | null;
  docsReadyNotSent: boolean;
  isOverdue: boolean;
}

export interface GitContainersResponse {
  containers: EnrichedContainerRow[];
  mode: "single" | "all";
  companyId?: number;
  companyName?: string;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasMore: boolean;
  summary?: {
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
  };
  facets?: {
    companies: string[];
    containerNumbers: string[];
    suppliers: string[];
    transporters: string[];
    agents: string[];
    trucks: string[];
    locations: string[];
    etaDates: string[];
    hasContainersWithNoEta: boolean;
  };
}

export const OTW_COLS = [
  { id: "supplier", label: "Supplier" },
  { id: "company", label: "Company" },
  { id: "shopName", label: "Shop Name" },
  { id: "eta", label: "ETA" },
  { id: "cost", label: "Cost" },
  { id: "freight", label: "Freight" },
  { id: "truckNo", label: "Truck #" },
  { id: "location", label: "Location" },
  { id: "borderDate", label: "Border Date" },
  { id: "maxOffload", label: "Max Offload" },
  { id: "delayed", label: "Delayed" },
  { id: "docs", label: "Docs" },
  { id: "docsSent", label: "Docs Sent" },
  { id: "transporter", label: "Transporter" },
  { id: "transportFee", label: "Transport Fee" },
  { id: "agent", label: "Agent" },
  { id: "dutyFee", label: "Duty Fee" },
  { id: "notes", label: "Notes" },
  { id: "blDocs", label: "BL Docs" },
] as const;

export type OtwColId = (typeof OTW_COLS)[number]["id"];

/**
 * ETA filter value for the hierarchical date picker.
 * "ALL" = no filter applied; object = custom selection of specific YYYY-MM-DD dates
 * plus an optional "include containers with no ETA" flag.
 */
export type EtaFilterValue = "ALL" | { selectedDates: string[]; includeNoEta: boolean };

export const DEFAULT_OTW_COL_VIS: Record<OtwColId, boolean> = Object.fromEntries(
  OTW_COLS.map((c) => [c.id, true])
) as Record<OtwColId, boolean>;

export const ACTIVE_STATUSES = ["OTW", "Sea", "At Port", "Left Dar", "At Border", "In Transit", "Arrived"] as const;

export function parseNum(v: string | null | undefined): number {
  if (!v) return 0;
  const n = parseFloat(String(v).replace(/,/g, ""));
  return isNaN(n) ? 0 : n;
}

export function fmt(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

export function fmtDate(d: string | null | undefined) {
  if (!d) return "—";
  const parts = d.split("-");
  if (parts.length !== 3) return d;
  const [y, m, day] = parts;
  return `${day}/${m}/${y.slice(2)}`;
}

export interface DrawerForm {
  eta: string;
  status: string;
  transporter: string;
  transportFee: string;
  numberPlate: string;
  trackingLocation: string;
  borderDate: string;
  agent: string;
  dutyFee: string;
  docReceived: boolean;
  docsSentDate: string;
  trackingLink?: string;
  trackingDescription: string;
  blDocs: string;
  shopName: string;
}

export function seedForm(c: EnrichedContainerRow): DrawerForm {
  return {
    eta: c.eta ?? "",
    status: c.status,
    transporter: c.transporter ?? "",
    transportFee: c.transportFee ?? "",
    numberPlate: c.numberPlate ?? "",
    trackingLocation: c.trackingLocation ?? "",
    borderDate: c.borderDate ?? "",
    agent: c.agent ?? "",
    dutyFee: c.dutyFee ?? "",
    docReceived: c.docReceived === true,
    docsSentDate: c.docsSentDate ?? "",
    trackingLink: c.trackingLink ?? "",
    trackingDescription: c.trackingDescription ?? "",
    blDocs: c.blDocs ?? "",
    shopName: c.shopName ?? "",
  };
}

export const TRANSPORTER_OPTIONS = ["FARHAT", "CONTINENTAL", "KDOUH", "TRH"];
