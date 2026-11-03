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
