/**
 * Where a voucher is edited, shared by Daybook and All Daybook so "Edit" opens the same screen
 * from either list. Sales/POS open the POS editor; Purchase is resolved by the caller (it may
 * belong to a container); every other editable type opens its Vouchers tab in edit mode.
 */
const VOUCHER_EDIT_TABS: Record<string, string> = {
  PurchaseOrder: "purchase-order",
  Payment: "payment",
  Receipt: "receipt",
  Journal: "journal",
  Contra: "contra",
  StockTransfer: "transferorder",
  "Stock Transfer": "transferorder",
  Transfer: "transfer",
  "Credit Note": "credit-note",
  "Debit Note": "credit-note",
  Production: "adjustment",
  Consumption: "adjustment",
  Mixed: "adjustment",
};

export function voucherEditPath(
  voucher: { id: number; voucherType: string },
  vouchersBase = "/vouchers"
): string | null {
  if (voucher.voucherType === "Sales" || voucher.voucherType === "POS") return `/pos/edit/${voucher.id}`;
  if (voucher.voucherType === "Purchase") return `${vouchersBase}?edit=${voucher.id}&tab=purchase&from=daybook`;
  const tab = VOUCHER_EDIT_TABS[voucher.voucherType];
  return tab ? `${vouchersBase}?edit=${voucher.id}&tab=${tab}&from=daybook` : null;
}
