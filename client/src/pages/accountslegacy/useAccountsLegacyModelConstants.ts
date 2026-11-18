// Extracted from ./useAccountsLegacyModel.ts to keep that module under the source-size cap.

/** Voucher type → Vouchers page tab, for statement row navigation. */
export const VOUCHER_TAB_MAP: Record<string, string> = {
  payment: "payment",
  receipt: "receipt",
  journal: "journal",
  contra: "journal",
  stocktransfer: "transferorder",
  "stock transfer": "transferorder",
  transfer: "transfer",
  creditnote: "creditnote",
  "credit note": "creditnote",
  debitnote: "creditnote",
  "debit note": "creditnote",
  production: "adjustment",
  consumption: "adjustment",
  mixed: "adjustment",
};

export interface VoucherSearchResult {
  id: number;
  voucherType?: string | null;
  locationName?: string | null;
  description?: string | null;
  totalAmount?: string | null;
  currency?: string | null;
  effectiveDate?: string | null;
  voucherDate: string;
}
