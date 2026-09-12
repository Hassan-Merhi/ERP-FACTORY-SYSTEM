import type {
  Container,
  ContainerCharge,
  POLineItem,
  PurchaseOrder,
  SpContainer,
  SpContainerLine,
  SpOffload,
  SpOffloadCharge,
  SpPrepaidCharge,
  SpStockMovement,
} from "@shared/schema";

export interface SoldContainer {
  containerId: number;
  containerNumber: string;
  supplierId: number;
  status: string;
  importDate: string;
  itemsTotal: string;
  chargesTotal: string;
  grandTotal: string;
  saleId: number;
  customerId: number;
  customerName: string;
  saleDate: string;
  containerCost: string;
  commission: string;
  commissionAccountId: number | null;
  totalAmount: string;
  notes: string | null;
}

/** Detail response of GET /api/containers/:id. */
export interface ContainerDetailData {
  container: Container;
  pos: (PurchaseOrder & { items: POLineItem[] })[];
  charges: ContainerCharge[];
  offloadId?: number | null;
}

/** Pending tracking edits keyed by container id: field → next raw value. */
export type TrackingFieldEdits = Partial<Record<keyof Container, unknown>>;

export interface TrackingEdit {
  [key: number]: TrackingFieldEdits;
}

// ─── Supplier Partner container API shapes ────────────────────────────────────
//
// Modelled from server/routes/sp/spContainerRoutes.ts and spLifecycleRoutes.ts.

/** Row returned by GET /api/sp/containers (list). */
export type SpContainerWithLines = SpContainer & { lines: SpContainerLine[]; totalQty: number };

/** Body returned by GET /api/sp/containers/:id when the container exists. */
export interface SpContainerDetail extends SpContainer {
  lines: SpContainerLine[];
  prepaid: SpPrepaidCharge[];
  offload: SpOffload | null;
  offloadCharges: SpOffloadCharge[];
  movements: SpStockMovement[];
}

/**
 * GET /api/sp/containers/:id resolves the JSON body even on error (the client
 * does not check res.ok), so a `{ message }` error body is a valid result.
 */
export type SpContainerDetailResponse = SpContainerDetail | { message: string };

/** Response of POST /api/sp/containers/:id/cancel. */
export interface SpContainerCancelResponse {
  container: SpContainer;
  cancellationVoucherId: number | null;
  detachedPrepaidChargeCount: number;
}

/** Response of POST /api/containers/sync-all-vouchers. */
export interface ContainerSyncAllResponse {
  scannedPOs: number;
  scannedContainers: number;
  updatedLocalVouchers: number;
  updatedParentVouchers: number;
  updatedFreightVouchers: number;
  updatedContainerCharges: number;
  updatedContainers: number;
  skipped: unknown[];
  notFoundParentVouchers: string[];
  missingParentFreightAccount: string[];
  errors: string[];
  message: string;
}
