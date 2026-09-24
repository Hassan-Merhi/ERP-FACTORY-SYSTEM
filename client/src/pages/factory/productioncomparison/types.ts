/**
 * Types for the ProductionComparison page.
 *
 * Extracted from ProductionComparison.tsx during the Phase 4 god-file split.
 */

export interface ProductWorkerRef {
  id: number | null;
  name: string;
  qty: number;
}

export interface ProductRow {
  articleCode: string;
  productName: string;
  categoryName: string;
  qty: number;
  totalWeightKg: number;
  /** Mix batches that produced bales for this product in the period. */
  mixBatchIds?: number[];
  /** Workers who finalized bales of this product in the period (most bales first). */
  workers?: ProductWorkerRef[];
}

export interface SupplierDayRow {
  date: string;
  supplierName: string;
  totalKg: number;
  totalCost?: number;
}

export interface ReportData {
  costsHidden?: boolean;
  production: {
    totalBales: number;
    totalWeightKg: number;
    byProduct: ProductRow[];
    linkedBatches?: Array<{
      id: number;
      totalWeightKg: number;
    }>;
  };
  summary?: {
    batchCost: number;
    productionValue: number;
    statusValue: number;
  };
  supplierMixBreakdown?: SupplierDayRow[];
}

export type Preset = "today-yesterday" | "month" | "year" | "custom";

export interface MergedRow {
  articleCode: string;
  productName: string;
  categoryName: string;
  grade: string;
  aQty: number;
  bQty: number;
  aKg: number;
  bKg: number;
  aMixBatchIds: number[];
  bMixBatchIds: number[];
  /** Distinct worker names across both periods, most bales first. */
  workers: string[];
}

// ── Formatting ────────────────────────────────────────────────────────────────
