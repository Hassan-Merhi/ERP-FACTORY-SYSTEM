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
}
export interface Phase9PosSaleEvidence {
  companyId: number;
  localVoucherId: number;
  lanInvoiceNumber: string;
  locationId: number;
  cashAccountId: number;
  actorUserId: string;
  actorUsername: string;
  requestId: string;
  currency: "USD";
  voucherDate: string;
  notes: string | null;
  items: Phase9PosSaleItem[];
}
export interface Phase9PosSaleEnvelope extends Phase9PosSaleEvidence {
  kind: "pos.sale.v1";
}
export function phase9PosSaleEnvelope(evidence: Phase9PosSaleEvidence): Phase9PosSaleEnvelope;
export function phase9PosInvoiceNumber(siteId: string, sequence: string | number | bigint): string;
