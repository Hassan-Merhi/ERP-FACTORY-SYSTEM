// Extracted from ./FactoryDispatchOrderDashboard.tsx to keep that module under the source-size cap.

export type Section = "TRIPS" | "CHARGES" | "PO_FILES" | "HISTORY";

export type Source = "ALL" | "PHYSICAL" | "FINANCIAL" | "CLOSURE";

interface Trip {
  id: string;
  dispatchNumber: number;
  status: string;
  notes: string | null;
  closedAt: string | null;
  scannedBales: number;
  scannedWeightKg: string;
  financialStatus: string;
  postingRevision: number;
  postingId: string | null;
  goodsSubtotal: string | null;
  billableCharges: string | null;
  discounts: string | null;
  customerTotal: string | null;
  postedAt: string | null;
  exportedAt: string | null;
  poNumber: string | null;
  erpContainerNumber: string | null;
  supplierCode: string | null;
  erpImportStatus: "NOT_TRACKED_MANUAL" | "NOT_EXPORTED";
}

interface Charge {
  id: string;
  dispatchId: string | null;
  dispatchNumber: number | null;
  name: string;
  kind: "BILLABLE" | "DISCOUNT" | "INTERNAL" | "ORDER";
  amount: string;
  accountCode: string | null;
  accountName: string | null;
  offsetAccountCode: string | null;
  postedVoucherId: string | null;
  status: "POSTED" | "DRAFT" | "UNLINKED";
}

export interface Overview {
  generatedAt: string;
  schemaReady: boolean;
  companyId: number;
  order: {
    id: number;
    status: string;
    containerNumber: string | null;
    customerName: string | null;
    invoiceNumber: string | null;
    grandTotal: string;
    deleted: boolean;
  };
  summary: {
    tripCount: number;
    closedTrips: number;
    openTrips: number;
    originalLoadingBales: number;
    scannedBales: number;
    uniqueScannedBales: number;
    unshippedBales: number;
    unexpectedScannedBales: number;
    goodsSubtotal: string | null;
    billableCharges: string | null;
    discounts: string | null;
    tripCustomerTotal: string | null;
    originalOrderCharges: string | null;
    invoiceTotal: string | null;
    internalExpenses: string | null;
    generatedPoFiles: number;
    signed: boolean;
    finalized: boolean;
    invoiceConsistent: boolean;
  };
  invoice: null | {
    status: string;
    invoiceNumber: string | null;
    signedAt: string | null;
    signedBy: string | null;
    finalizedAt: string | null;
    includedPostingIds: string[];
    finalizationVoucherIds: string[];
  };
  trips: Trip[];
  charges: Charge[];
  notices: string[];
}

export interface ReleaseGate {
  reconciliation: { ready: boolean; missing: string[]; checkedAt: string };
  invoice: { ready: boolean; missing: string[]; checkedAt: string };
  integrity: null | {
    finalized: boolean;
    signedReconciliation: boolean;
    passed: boolean;
    verifiedAt: string;
    checks: Array<{
      code: string;
      state: "PASS" | "BLOCK" | "INFO" | "NOT_APPLICABLE";
      message: string;
      expected?: string;
      observed?: string;
    }>;
  };
}

interface HistoryEntry {
  source: "PHYSICAL" | "FINANCIAL" | "CLOSURE";
  id: string;
  dispatchId: string | null;
  eventType: string;
  actorUsername: string;
  createdAt: string;
  reason: string | null;
  details: Record<string, unknown>;
}

export interface HistoryPage {
  entries: HistoryEntry[];
  nextCursor: string | null;
  hasMore: boolean;
  financialSchemaInstalled: boolean;
}

export interface Props {
  orderId: number;
  companyId: number | null | undefined;
  onOpenTrip: (dispatchId: number) => void;
  onCompareAll: () => void;
  onPhysicalReport: () => void;
}

export const fmtAmount = (v: string | null | undefined): string =>
  v === null || v === undefined
    ? "—"
    : Number(v).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

export const fmtCount = (v: number) => v.toLocaleString();

export async function json<T>(url: string): Promise<T> {
  const result = await fetch(url, {
    credentials: "include",
    cache: "no-store",
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
  });
  const type = (result.headers.get("content-type") ?? "").toLowerCase();
  if (!type.includes("application/json")) {
    throw new Error("The dispatch reporting API did not return JSON. Confirm the correct backend is deployed.");
  }
  const data = await result.json();
  if (!result.ok) throw new Error(data.message || "Dispatch reporting failed");
  return data as T;
}

export const headerButton = (active: boolean) =>
  active
    ? "bg-blue-600 text-white shadow-sm hover:bg-blue-700"
    : "border border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground";
