export const PHASE9_PAYMENT_KIND: "voucher.payment-receipt.v1";
export class Phase9PaymentRefusal extends Error {
  constructor(code: string);
}
export interface Phase9PaymentVoucherInputs {
  voucherType: "Payment" | "Receipt";
  voucherDate: string;
  paymentAccountType: string;
  paymentAccountId: number;
  entries: Array<{ accountType: string; accountId: number; amount: string }>;
  notes: string | null;
  optional: boolean;
  currency: string;
  exchangeRate: string | null;
  effectiveDate: string | null;
}
export interface Phase9PaymentEvidence {
  companyId: number;
  localVoucherId: number;
  actorUserId: string;
  actorUsername: string;
  requestId: string;
  voucher: Phase9PaymentVoucherInputs;
}
export interface Phase9PaymentEnvelope extends Phase9PaymentEvidence {
  kind: "voucher.payment-receipt.v1";
}
export function phase9PaymentEnvelope(evidence: Phase9PaymentEvidence): Phase9PaymentEnvelope;
export const PHASE9_PAYMENT_EDIT_KIND: "voucher.payment-receipt-edit.v1";
export const PHASE9_PAYMENT_DELETE_KIND: "voucher.payment-receipt-delete.v1";
export const PHASE9_PAYMENT_CHANGED_CONFLICT: "PHASE9_PAYMENT_CHANGED";
export type Phase9PaymentVoucherRef =
  { origin: "lan"; localVoucherId: number } | { origin: "cloud"; voucherId: number };
export interface Phase9PaymentDeleteEvidence {
  companyId: number;
  localVoucherId: number;
  actorUserId: string;
  actorUsername: string;
  requestId: string;
  voucherRef: Phase9PaymentVoucherRef;
  beforeSha256: string;
}
export interface Phase9PaymentEditEvidence extends Phase9PaymentDeleteEvidence {
  voucher: Phase9PaymentVoucherInputs;
}
export function phase9PaymentEditEnvelope(
  evidence: Phase9PaymentEditEvidence
): Phase9PaymentEditEvidence & { kind: "voucher.payment-receipt-edit.v1" };
export function phase9PaymentDeleteEnvelope(
  evidence: Phase9PaymentDeleteEvidence
): Phase9PaymentDeleteEvidence & { kind: "voucher.payment-receipt-delete.v1" };
