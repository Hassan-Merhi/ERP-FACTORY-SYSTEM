export declare const PHASE9_SALES_VOUCHER_KIND: "voucher.sales.v1";

export interface Phase9SalesVoucherEntry {
  ledgerAccountId: number | null;
  bankAccountId: number | null;
  fixedAssetId: number | null;
  supplierId: number | null;
  employeeId: number | null;
  customerId: number | null;
  factorySupplierId: number | null;
  debitAmount: string;
  creditAmount: string;
  narration: string | null;
}

export interface Phase9SalesVoucherHeader {
  voucherType: "Sales";
  voucherDate: string;
  description: string | null;
  locationId: number | null;
  exchangeRate: string | null;
}

export interface Phase9SalesVoucherEvidence {
  requestId: string;
  companyId: number;
  actorUserId: string;
  actorUsername: string;
  localVoucherId: number;
  voucher: Phase9SalesVoucherHeader;
  entries: Phase9SalesVoucherEntry[];
}

export interface Phase9SalesVoucherPayload extends Phase9SalesVoucherEvidence {
  kind: typeof PHASE9_SALES_VOUCHER_KIND;
}

export declare class Phase9SalesVoucherRefusal extends Error {
  constructor(code: string);
}

export declare function phase9SalesVoucherEnvelope(evidence: Phase9SalesVoucherEvidence): Phase9SalesVoucherPayload;
