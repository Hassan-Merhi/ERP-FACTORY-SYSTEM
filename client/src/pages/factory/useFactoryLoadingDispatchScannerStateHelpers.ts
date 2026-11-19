// Extracted from ./useFactoryLoadingDispatchScannerState.ts
import type { CameraScanFeedback } from "@/components/MobileBarcodeScanner";

type DispatchStatus = "OPEN" | "CLOSED" | "CANCELLED";

export interface DispatchScan {
  id: number | string;
  dispatchId: number | string;
  orderId: number;
  baleId: number;
  baleReference: string;
  articleCode?: string | null;
  productName?: string | null;
  weightKg: string | number;
  scannedByUsername: string;
  scannedAt: string;
  removedAt?: string | null;
  removedByUserId?: string | null;
  removalReason?: string | null;
  stillInLoading: boolean;
}

export interface ScanHistoryResponse {
  orderId: number;
  dispatchId: number;
  status: DispatchStatus;
  activeCount: number;
  activeWeightKg: number;
  scans: DispatchScan[];
}

export interface DispatchScanError extends Error {
  code?: string;
  previous?: {
    baleReference?: string;
    scannedByUsername?: string;
    dispatchNumber?: number;
    scannedAt?: string;
  } | null;
}

export interface Props {
  orderId: number;
  dispatchId: number;
  companyId: number | null | undefined;
  status: DispatchStatus;
  role: string;
  onChanged: () => void;
}

export const PAGE_CHUNK = 100;

export const MAX_PENDING = 50;

export function scanError(error: unknown): { type: CameraScanFeedback["type"]; message: string } {
  const problem = error as DispatchScanError | null;
  const type: CameraScanFeedback["type"] =
    problem?.code === "DISPATCH_DUPLICATE"
      ? "duplicate"
      : problem?.code === "DISPATCH_NOT_IN_LOADING" || problem?.code === "DISPATCH_AMBIGUOUS_BARCODE"
        ? "warn"
        : "error";
  const prior = problem?.previous;
  const detail =
    type === "duplicate" && prior
      ? "Trip #" + prior.dispatchNumber + " · " + (prior.scannedByUsername || "Previous scanner")
      : null;
  return { type, message: detail || problem?.message || "Could not verify this bale" };
}

export function fmtCount(n: number): string {
  return n.toLocaleString();
}

export function fmtKg(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
