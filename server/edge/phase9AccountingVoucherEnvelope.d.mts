export declare const PHASE9_SALES_VOUCHER_KIND: "voucher.sales.v1";
export declare const PHASE9_PURCHASE_VOUCHER_KIND: "voucher.purchase.v1";
export type Phase9AccountingVoucherType = "Sales" | "Purchase";
export declare const PHASE9_ACCOUNTING_VOUCHER_KINDS: Readonly<{
  Sales: typeof PHASE9_SALES_VOUCHER_KIND;
  Purchase: typeof PHASE9_PURCHASE_VOUCHER_KIND;
}>;

export interface Phase9AccountingVoucherEntry {
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

export interface Phase9AccountingVoucherHeader {
  voucherType: Phase9AccountingVoucherType;
  voucherDate: string;
  description: string | null;
  locationId: number | null;
  exchangeRate: string | null;
}

export interface Phase9AccountingVoucherEvidence {
  requestId: string;
  companyId: number;
  actorUserId: string;
  actorUsername: string;
  localVoucherId: number;
  voucher: Phase9AccountingVoucherHeader;
  entries: Phase9AccountingVoucherEntry[];
}

export interface Phase9AccountingVoucherPayload extends Phase9AccountingVoucherEvidence {
  kind: typeof PHASE9_SALES_VOUCHER_KIND | typeof PHASE9_PURCHASE_VOUCHER_KIND;
}

export declare class Phase9AccountingVoucherRefusal extends Error {
  constructor(code: string);
}

export declare function phase9SalesVoucherEnvelope(
  evidence: Phase9AccountingVoucherEvidence
): Phase9AccountingVoucherPayload;
export declare function phase9PurchaseVoucherEnvelope(
  evidence: Phase9AccountingVoucherEvidence
): Phase9AccountingVoucherPayload;
