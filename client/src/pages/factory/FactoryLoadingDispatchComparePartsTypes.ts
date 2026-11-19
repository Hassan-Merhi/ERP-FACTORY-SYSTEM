// Extracted from ./FactoryLoadingDispatchCompareParts.tsx

export interface TripSummary {
  id: string;
  dispatchNumber: number;
  status: string;
  truckPlate: string | null;
  scannedBales: number;
  scannedWeightKg: number;
}

export type ArticleStatus = "MATCH" | "MISSING" | "EXTRA" | "BOTH" | "UNPLANNED";

export interface ArticleComparison {
  articleCode: string;
  productName: string;
  expectedQty: number | null;
  scannedQty: number;
  matchedQty: number;
  missingQty: number | null;
  extraQty: number;
  expectedWeightKg: number | null;
  scannedWeightKg: number;
  priorityRank: number | null;
  status: ArticleStatus;
}

export interface BaleFinding {
  orderBaleId?: number;
  baleId: number;
  baleReference: string;
  articleCode: string;
  productName: string;
  weightKg: number;
  reason: string;
  dispatchId?: string;
  dispatchNumber?: number;
  expectedDispatchNumber?: number;
  scannedBy?: string;
  scannedAt?: string;
}

export interface Summary {
  loadedBales: number;
  loadedWeightKg: number;
  expectedBales: number | null;
  expectedWeightKg: number | null;
  weightDifferenceKg: number | null;
  verifiedBales: number;
  verifiedWeightKg: number;
  matchedBales: number;
  missingBales: number | null;
  unexpectedBales: number;
  exactMissingBales: number;
  crossTripMisplacedBales: number;
  duplicateBales: number;
  progressPercent: number | null;
}

export interface Comparison {
  scope: "overall" | "trip";
  orderId: number;
  containerNumber: string | null;
  loadingStatus: string;
  generatedAt: string;
  dispatch: TripSummary | null;
  planSource: "none" | "article" | "bale" | "mixed" | "loading";
  hasTripPlan: boolean;
  summary: Summary;
  articles: ArticleComparison[];
  missingBales: BaleFinding[];
  unexpectedBales: BaleFinding[];
  crossTripBales: BaleFinding[];
  duplicateBales: BaleFinding[];
  trips: TripSummary[];
}

export type Filter = "all" | "missing" | "extra" | "match" | "unplanned";

export type FindingsKind = "missing" | "unexpected" | "cross" | "duplicate";
