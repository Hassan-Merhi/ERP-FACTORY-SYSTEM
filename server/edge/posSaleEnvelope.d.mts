export const PHASE9_POS_SALE_KIND: "pos.sale.v1";
export const PHASE9_POS_NEGATIVE_CONFLICT: "PHASE9_POS_STOCK_WOULD_GO_NEGATIVE";
export const PHASE9_POS_CASH_ACCOUNT_CONFLICT: "PHASE9_POS_CASH_ACCOUNT_CHANGED";
export class Phase9PosSaleRefusal extends Error {
  constructor(code: string);
}
export interface Phase9PosSaleItem {
  stockItemId: number;
  quantity: string;
  rate: string;
  originalCurrencyRate: string | null;
}
export interface Phase9PosSaleEvidence {
  companyId: number;
  localVoucherId: number;
  lanInvoiceNumber: string;
  locationId: number;
  paymentAccountType: "cash" | "bank" | "credit";
  paymentAccountId: number;
  actorUserId: string;
  actorUsername: string;
  requestId: string;
  currency: string;
  exchangeRate: string | null;
  voucherDate: string;
  notes: string | null;
  items: Phase9PosSaleItem[];
}
export interface Phase9PosSaleEnvelope extends Phase9PosSaleEvidence {
  kind: "pos.sale.v1";
}
export function phase9PosSaleEnvelope(evidence: Phase9PosSaleEvidence): Phase9PosSaleEnvelope;
export function phase9PosInvoiceNumber(siteId: string, sequence: string | number | bigint): string;
export const PHASE9_POS_SALE_EDIT_KIND: "pos.sale-edit.v1";
export interface Phase9PosSaleEditEvidence {
  companyId: number;
  localVoucherId: number;
  actorUserId: string;
  actorUsername: string;
  requestId: string;
  businessDate: string;
  voucherRef: { clientSaleId: string | null; voucherId: number };
  edit: {
    description: string | null;
    isCreditSale: boolean;
    locationId: number | null;
    paymentAccountId: number | null;
    paymentAccountType: "cash" | "bank" | "credit" | null;
    voucherDate: string | null;
    items: Array<{ existing: boolean; stockItemId: number; quantity: string; sellingPrice: string }>;
  };
}
export interface Phase9PosSaleEditEnvelope extends Phase9PosSaleEditEvidence {
  kind: "pos.sale-edit.v1";
}
export function phase9PosSaleEditEnvelope(evidence: Phase9PosSaleEditEvidence): Phase9PosSaleEditEnvelope;
export const PHASE9_POS_SALE_CANCEL_KIND: "pos.sale-cancel.v1";
export interface Phase9PosSaleCancelEvidence {
  companyId: number;
  localVoucherId: number;
  actorUserId: string;
  actorUsername: string;
  requestId: string;
  businessDate: string;
  voucherRef: { clientSaleId: string | null; voucherId: number };
}
export function phase9PosSaleCancelEnvelope(
  evidence: Phase9PosSaleCancelEvidence
): Phase9PosSaleCancelEvidence & { kind: "pos.sale-cancel.v1" };
