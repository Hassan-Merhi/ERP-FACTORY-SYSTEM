/**
 * Types for the StockEntryHistory page.
 *
 * Extracted from StockEntryHistory.tsx during the Phase 4 god-file split.
 */

export interface GroupRow {
  stockEntryDate: string;
  erpLocationId: number | null;
  locationName: string;
  workerId: number | null;
  workerName: string | null;
  productId: number | null;
  productName: string | null;
  articleCode: string | null;
  baleCount: number;
  totalWeight: string;
  avgWeight: string;
  firstFinalizedAt: string | null;
  lastFinalizedAt: string | null;
  bales: BaleDetail[];
}

export interface BaleDetail {
  id: number;
  referenceNumber: string;
  weightKg: string;
  status: string;
  finalizedAt: string | null;
  stockEntryDate: string;
  locationName: string;
  workerId: number | null;
  workerName: string | null;
  productName: string | null;
  articleCode: string | null;
}

export interface MatrixRow {
  productLabel: string;
  counts: Record<string, number>;
  total: number;
}

export interface WorkerMatrix {
  workers: string[];
  rows: MatrixRow[];
  workerTotals: Record<string, number>;
  grandTotal: number;
}

export interface StockEntryHistoryPage {
  items: GroupRow[];
  total: number;
  totalBales: number;
  totalWeight: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/** Fetches all pages of a stock-entry-history query using limit=250 per page.
 *  Safety cap: 100 pages. Use only for actions requiring every matching row
 *  (exports, bulk ops, print). Never use for the normal paginated screen list. */

export interface StockEntryHistoryProps {
  onActiveDateChange?: (date: string | null) => void;
}
