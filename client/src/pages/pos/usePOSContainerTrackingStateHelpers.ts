// Extracted from ./usePOSContainerTrackingState.tsx

export interface PosUserContext {
  currentCompanyId?: number | null;
  assignedLocationId?: number | null;
  currentLocationId?: number | null;
}

export interface PosContainerRow {
  id: number;
  containerNumber: string;
  supplierName: string | null;
  supplierCode: string | null;
  status: string;
  eta: string | null;
  portDepartureDate: string | null;
  numberPlate: string | null;
  trackingLocation: string | null;
  agent: string | null;
  transporter: string | null;
  docReceived: boolean | null;
  docsSentDate: string | null;
}

export interface PosContainerTrackingResponse {
  assignedLocation: {
    id: number;
    name: string;
    code: string;
  };
  total: number;
  containers: PosContainerRow[];
}

export type ColumnKey =
  | "container"
  | "supplier"
  | "status"
  | "eta"
  | "portDeparture"
  | "daysSinceDeparture"
  | "truck"
  | "location"
  | "agent"
  | "transporter"
  | "docs"
  | "docsSent";

export const COLUMN_PREF_KEY = "pos-container-tracking-visible-columns-v3";

export const COLUMN_DEFS: Array<{ key: ColumnKey; label: string }> = [
  { key: "container", label: "Container #" },
  { key: "supplier", label: "Supplier" },
  { key: "status", label: "Status" },
  { key: "eta", label: "ETA" },
  { key: "portDeparture", label: "Left Port" },
  { key: "daysSinceDeparture", label: "Days Since" },
  { key: "truck", label: "Truck #" },
  { key: "location", label: "Location" },
  { key: "agent", label: "Agent" },
  { key: "transporter", label: "Transporter" },
  { key: "docs", label: "Docs" },
  { key: "docsSent", label: "Docs Sent" },
];

export function containsSearch(row: PosContainerRow, search: string): boolean {
  if (!search) return true;
  const haystack = [
    row.containerNumber,
    row.supplierCode,
    row.supplierName,
    row.status,
    row.eta,
    row.portDepartureDate,
    row.numberPlate,
    row.trackingLocation,
    row.agent,
    row.transporter,
    row.docsSentDate,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(search);
}
