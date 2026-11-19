// Extracted from ./loadOtwStockByItem.ts

export type Aggressiveness = "conservative" | "normal" | "aggressive";

export interface LocationCandidate {
  id: number;
  name: string;
  code: string;
}

export interface LocationMatchResult {
  matched: { id: number; name: string; code: string } | null;
  candidates: LocationCandidate[];
}

export interface OtwContainerDetail {
  containerNumber: string;
  quantity: number;
  eta: string | null;
  trackingStatus: string | null;
  currentLocation: string | null;
  shopName: string | null;
  supplierName: string | null;
  importDate: string | null;
  /** How this container's shop name relates to the destination location being analyzed. */
  matchType: "direct" | "unknown" | "other";
}

export interface OtwStockResult {
  /** OTW quantity per stockItemId that counts toward this destination's need (direct + unknown-shop). */
  otwQtyByItem: Map<number, number>;
  /** All OTW container details per stockItemId, including other-shop containers (for display/reason text). */
  otwDetailsByItem: Map<number, OtwContainerDetail[]>;
}

export interface StockTransferSuggestionItem {
  stockItemId: number;
  stockItemName: string;
  stockItemCode: string;
  sourceQty: number;
  destinationQty: number;
  sourceSalesQty: number;
  destinationSalesQty: number;
  sourceSalesRate: number; // units/day
  destinationSalesRate: number; // units/day
  otwQty: number | null;
  otwDetails?: OtwContainerDetail[];
  otwSummary?: string;
  suggestedQty: number;
  reason: string;
  confidence: number; // 0-1
  previousTransferQty: number;
  previousTransferCount: number;
  lastTransferDate: string | null;
  oldTransferSummary: string;
}

export interface StockTransferSuggestionContext {
  sourceLocationId: number;
  sourceLocationName: string;
  destinationLocationId: number;
  destinationLocationName: string;
  dateFrom: string;
  dateTo: string;
  days: number;
  aggressiveness: Aggressiveness;
  items: StockTransferSuggestionItem[];
  analysisSummary: string;
  otwAvailable: boolean;
  otwSkippedReason: string | null;
  oldTransferSummary: string;
}

/** Normalize a free-text shop/location name for safe equality comparisons only
 *  (never substring/fuzzy — "Kolwezi" and "Kolwezi 2" must never be conflated). */
export function normalizeShopName(name: string | null | undefined): string {
  return (name || "").trim().toLowerCase().replace(/\s+/g, " ");
}
