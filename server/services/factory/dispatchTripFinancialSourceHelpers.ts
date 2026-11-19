// Extracted from ./dispatchTripFinancialSource.ts

export type DispatchFinancialSourceErrorCode =
  | "FINANCIAL_SOURCE_UNAVAILABLE"
  | "DISPATCH_NOT_CLOSED"
  | "CLOSURE_REOPENED"
  | "MANIFEST_UNAVAILABLE"
  | "MANIFEST_INVALID"
  | "LOADING_CHANGED"
  | "SCANS_CHANGED"
  | "ARTICLE_CODE_MISSING"
  | "PRICE_UNRESOLVED";

export type Row = Record<string, unknown>;

export interface DispatchSourceBale {
  scanId: string;
  baleId: number;
  baleReference: string;
  articleCode: string;
  productName: string;
  weightKg: string;
  priceUsed: string;
  priceSource: "ORDER_BALE_PRICE_USED";
  pricingMode: "per_bale";
  unitPrice: string;
  lineTotal: string;
}

export interface DispatchFinancialSourceSnapshot {
  companyId: number;
  orderId: number;
  dispatchId: number;
  customerId: number;
  closureHistoryId: string;
  closureRevision: number;
  manifestFingerprint: string;
  sourceFingerprint: string;
  goodsSubtotal: string;
  totalWeightKg: string;
  baleCount: number;
  bales: DispatchSourceBale[];
}

export interface DispatchSourceInput {
  companyId: number;
  orderId: number;
  dispatchId: number;
  customerId: number;
  closureHistoryId: string;
  closureRevision: number;
  manifestFingerprint: string;
  manifest: unknown;
  orderBales: ReadonlyArray<{
    baleId: number;
    baleReference: string;
    articleCode: string | null;
    productName: string | null;
    weightKg: string;
    priceUsed: string;
  }>;
  activeScans: ReadonlyArray<{
    scanId: string;
    baleId: number;
    dispatchId: string;
  }>;
}

export const idString = (value: unknown): string => {
  const stringified = String(value ?? "");
  return /^[1-9][0-9]*$/.test(stringified) ? stringified : "";
};
