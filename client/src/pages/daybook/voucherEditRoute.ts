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
  "Credit Note": "creditnote",
  "Debit Note": "creditnote",
  Production: "adjustment",
  Consumption: "adjustment",
  Mixed: "adjustment",
};

export function voucherEditPath(
  voucher: { id: number; voucherType: string },
  vouchersBase = "/vouchers"
): string | null {
  if (voucher.voucherType === "Sales" || voucher.voucherType === "POS") {
    // The POS editor is an ERP route; Factory and Properties open the read-only voucher instead.
    return vouchersBase === "/vouchers" ? `/pos/edit/${voucher.id}` : voucherDetailPath(voucher.id, vouchersBase);
  }
  if (voucher.voucherType === "Purchase") return `${vouchersBase}?edit=${voucher.id}&tab=purchase&from=daybook`;
  const tab = VOUCHER_EDIT_TABS[voucher.voucherType];
  return tab ? `${vouchersBase}?edit=${voucher.id}&tab=${tab}&from=daybook` : null;
}

/** The read-only voucher view in the same workspace as `vouchersBase`. */
export function voucherDetailPath(id: number, vouchersBase = "/vouchers"): string {
  return `${vouchersBase.replace(/\/vouchers$/, "")}/voucher-detail/${id}`;
}

/**
 * Edit destination for a voucher reached outside Daybook (old `/vouchers/:id/edit` links, Optional
 * Vouchers). Same as Daybook's Edit: a purchase opens its container and every other type goes
 * through voucherEditPath. Where there is no editor to open (a purchase without a container, or a
 * type voucherEditPath does not edit) the read-only voucher opens instead.
 */
export async function resolveVoucherEditDestination(
  voucher: { id: number; voucherType: string },
  vouchersBase = "/vouchers"
): Promise<string> {
  if (voucher.voucherType === "Purchase") {
    // Containers are ERP pages; Factory and Properties purchases open the read-only voucher.
    if (vouchersBase === "/vouchers") {
      try {
        const response = await fetch(`/api/vouchers/${voucher.id}/view-entries`, { credentials: "include" });
        const data = response.ok ? await response.json() : null;
        const containerId = data && !Array.isArray(data) ? data.purchaseOrder?.containerId : null;
        if (containerId) return `/containers/${containerId}`;
      } catch {
        // Fall through to the read-only voucher.
      }
    }
    return voucherDetailPath(voucher.id, vouchersBase);
  }
  return voucherEditPath(voucher, vouchersBase) ?? voucherDetailPath(voucher.id, vouchersBase);
}
