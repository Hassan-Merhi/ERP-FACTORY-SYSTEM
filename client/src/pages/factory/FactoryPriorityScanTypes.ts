// Extracted from ./FactoryPriorityScan.tsx to keep that module under the source-size cap.

export const PRIORITY_SCAN_CONFIGS_URL = "/api/factory/customer-orders/loading-list/priority-scan-configs";

export const PENDING_LOADS_URL = "/api/factory/customer-orders?status=LOADING&profile=summary&pageSize=250";

export const PRIORITY_SCAN_ROUTE_URL = "/api/factory/customer-orders/loading-list/priority-scan-route";

export const PRIORITY_SCAN_FLASH_MS = 2_000;

export interface PriorityScanConfig {
  id: number;
  orderId: number;
  color: string;
  priority: number;
  enabled: boolean;
  proformaIdUsed: number | null;
}

export interface PendingLoad {
  id: number;
  customerId: number;
  customerName: string;
  totalQtyBales: number;
  proformaIdUsed: number | null;
  proformaName: string | null;
  status: string;
}

interface PriorityRouteTarget {
  orderId: number;
  priority: number;
  color: string;
  proformaId: number;
  remainingQty: number;
}

export interface PriorityRouteResolution {
  referenceNumber: string;
  baleId: number;
  productName: string | null;
  articleCode: string;
  locationId: number;
  target: PriorityRouteTarget;
  candidates: PriorityRouteTarget[];
}

export interface PriorityScanRequestError extends Error {
  status?: number;
  code?: string;
  overloaded?: unknown;
  notInProforma?: unknown;
}

export interface PriorityScanAdvanceResult {
  completedOrderIds: number[];
  activeOrderId: number | null;
  activePriority: number | null;
}

export interface PriorityScanAllocation extends PriorityRouteResolution {
  advance: PriorityScanAdvanceResult | null;
}

export interface ScanFeedback {
  type: "success" | "error" | "warn" | "duplicate";
  referenceNumber: string;
  message: string;
}
