/**
 * Retail Wave 2 client types — customers, discounts/approvals, tax and stock counts.
 * Mirrors the response shapes of `/api/pos/retail/*` so the POS never re-derives money math.
 */
import type { SaleItem } from "./retailPosTypes";

export interface RetailSellingSettings {
  discountLimitPercent: number;
  requireManagerApproval: boolean;
  priceOverrideRequiresApproval: boolean;
  taxEnabled: boolean;
  taxLabel: string;
  taxRate: number;
  taxInclusive: boolean;
  taxRatePercent?: number;
  /** Present on GET /settings: false for POS-role sessions that cannot edit. */
  canManageSettings?: boolean;
}

export interface RetailPromotion {
  id: number;
  name: string;
  discountType: "percent" | "fixed";
  value: number;
  active: boolean;
  startsAt: string | null;
  endsAt: string | null;
  brandId: number | null;
  productId: number | null;
  variantId: number | null;
  createdAt?: string;
}

export interface RetailPricedLinePreview {
  variantId: number;
  quantity: number;
  originalUnitPrice: number;
  unitPrice: number;
  grossUnitPrice: number;
  lineDiscountAmount: number;
  lineDiscountType: "none" | "percent" | "fixed" | "override" | "promotion";
  lineDiscountValue: number;
  discountReason: string | null;
  priceOverride: boolean;
  promotionId: number | null;
  promotionAmount: number;
  taxAmount: number;
  lineTotal: number;
}

export interface RetailCartPreview {
  settings: RetailSellingSettings;
  policy: {
    requiresApproval: boolean;
    reasons: Array<"price_override" | "discount_above_limit">;
    discountLimitPercent: number;
    isManager: boolean;
    hasPriceOverride: boolean;
    hasManualDiscount: boolean;
    effectiveDiscountPercent: number;
  };
  pricing: {
    listSubtotal: number;
    discountTotal: number;
    subtotal: number;
    taxAmount: number;
    totalAmount: number;
    orderDiscountAmount: number;
    lines: RetailPricedLinePreview[];
  };
}

export interface RetailCustomerSummary {
  id: number;
  code: string;
  legalName: string;
  phone: string | null;
  active: boolean;
}

export interface RetailCustomerReturnEntry {
  id: number;
  saleId: number | null;
  refundAmount: number;
  refundTaxAmount: number;
  createdAt: string;
  items: Array<{
    id: number;
    variantId: number;
    productName: string | null;
    color: string | null;
    size: string | null;
    quantity: number;
    grossUnitPrice: number;
  }>;
}

export interface RetailCustomerExchangeEntry {
  id: number;
  originalSaleId: number;
  newSaleId: number;
  returnId: number;
  refundValue: number;
  createdAt: string;
}

export interface RetailCustomerHistory {
  customer: RetailCustomerSummary & { createdAt: string };
  sales: Array<{
    id: number;
    totalAmount: number;
    customerName: string | null;
    createdAt: string;
    status: string;
    items: SaleItem[];
  }>;
  returns: RetailCustomerReturnEntry[];
  exchanges: RetailCustomerExchangeEntry[];
  summary: {
    saleCount: number;
    totalSpent: number;
    totalRefunded: number;
    lastPurchaseAt: string | null;
  };
}

export type RetailStockCountStatus = "draft" | "counting" | "review" | "finalized" | "canceled";
export type RetailStockCountLineStatus = "uncounted" | "counted" | "variance" | "unexpected";

export interface RetailStockCountSessionLine {
  id: number;
  variantId: number;
  expectedQuantity: number;
  countedQuantity: number | null;
  status: RetailStockCountLineStatus;
  recountRequired: boolean;
  notes: string | null;
  varianceQuantity: number | null;
  movementDelta: number | null;
  countedAt: string | null;
  name: string;
  code: string;
  brand: string;
  color: string;
  size: string;
  barcode: string;
  sku: string | null;
}

export interface RetailStockCountSession {
  id: number;
  code: string;
  status: RetailStockCountStatus;
  locationId: number;
  locationName?: string | null;
  notes: string | null;
  snapshotAt: string | null;
  countingStartedAt?: string | null;
  reviewStartedAt?: string | null;
  finalizedAt: string | null;
  canceledAt?: string | null;
  lineCount: number;
  countedLineCount: number;
  uncountedLineCount: number;
  varianceLineCount: number;
  unexpectedLineCount: number;
  recountLineCount: number;
  expectedQuantityTotal: number;
  countedQuantityTotal: number;
  varianceQuantityTotal: number;
  varianceValueTotal: number;
  createdAt: string;
  lines?: RetailStockCountSessionLine[];
  movementCount?: number;
}

export interface RetailStockCountReport {
  summary: {
    sessionCount: number;
    finalizedCount: number;
    varianceQuantityTotal: number;
    varianceValueTotal: number;
  };
  sessions: RetailStockCountSession[];
}

export interface RetailStockCountVarianceReport {
  session: RetailStockCountSession;
  lines: Array<
    RetailStockCountSessionLine & {
      movement: { delta: number; count: number };
      movementDuringCount: number | null;
      liveQuantity?: number | null;
    }
  >;
}

export interface RetailDiscountApprovalResponse {
  required?: false;
  approvalId?: number;
  approvalToken?: string;
  maxDiscountPercent?: number;
  allowsPriceOverride?: boolean;
  expiresAt?: string;
  managerName?: string;
}

/** Human labels for the two approval reasons the server can return. */
export function approvalReasonLabel(reason: string): string {
  if (reason === "price_override") return "Manual price override";
  if (reason === "discount_above_limit") return "Discount above the company limit";
  return reason;
}
