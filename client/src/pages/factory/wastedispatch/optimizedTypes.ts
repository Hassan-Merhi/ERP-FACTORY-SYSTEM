import type { Bale } from "./types";

export type WasteBale = Bale & {
  productId: number;
  articleCode?: string;
};

export type GroupSummary = {
  productId: number;
  productName: string;
  categoryName: string;
  baleCount: number;
  totalWeight: number;
  totalCost: number;
  avgRate: number;
};

export type Pagination = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

export type SummaryResponse = {
  groups: GroupSummary[];
  pagination: Pagination;
  totals: { bales: number; weight: number; cost: number };
};

export type HistoryItem = {
  id: number;
  dispatchNumber: string;
  dispatchDate: string;
  notes?: string | null;
  totalBales: number;
  totalWeightKg: number;
  totalCostWrittenOff: number;
};

export type HistoryBale = {
  id: number;
  referenceNumber: string;
  productName: string;
  weightKg: number;
  totalCost: number;
};

export type HistoryResponse = {
  items: HistoryItem[];
  pagination: Pagination;
  // Aggregated across ALL dispatches matching the date filter, not just this page.
  totals: { bales: number; weightKg: number; amount: number };
};

export type PrintDispatch = Pick<HistoryItem, "dispatchNumber" | "dispatchDate" | "notes">;
