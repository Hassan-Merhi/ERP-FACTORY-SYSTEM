// Extracted from ./RemoveFromStockTab.tsx to keep that module under the source-size cap.

export interface WorkerOption {
  id: number;
  active?: boolean | null;
  fullName?: string | null;
  name?: string | null;
}

export interface InStockBale {
  id: number;
  productId: number;
  articleCode?: string | null;
  productName?: string | null;
  weightKg: string;
  referenceNumber?: string | null;
  locationName?: string | null;
  finalizedAt?: string | null;
  finalizedBy?: number | null;
  finalizedByName?: string | null;
}

export interface LabelPrintResult {
  referenceNumber: string;
  articleCode?: string | null;
  pieces?: number;
  approxWeightKg?: string | number | null;
}
