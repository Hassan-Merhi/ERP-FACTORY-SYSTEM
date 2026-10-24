/**
 * Retail-only manual voucher UI policy.
 *
 * This policy hides entry/edit affordances; it never filters accounting
 * statements, erases posted vouchers, or blocks the server's transaction-owned
 * Retail sales/returns journals and credit-note reversals.
 */
export const RETAIL_HIDDEN_MANUAL_VOUCHER_TABS = ["journal", "transferorder", "adjustment", "creditnote"] as const;

const hiddenTabs: ReadonlySet<string> = new Set(RETAIL_HIDDEN_MANUAL_VOUCHER_TABS);

/** The normal stock-transfer tab remains separate from hidden Transfer Order. */
export function isRetailManualVoucherTabHidden(tab: string): boolean {
  return hiddenTabs.has(tab.trim().toLowerCase());
}

/** Manual voucher types opened from Daybook/Edit should be read-only in Retail. */
const hiddenVoucherTypes = new Set([
  "journal",
  "credit note",
  "debit note",
  "stock adjustment",
  "adjustment",
  "production",
  "consumption",
  "mixed",
  "stocktransferorder",
  "stock transfer order",
  "transfer order",
]);

export function isRetailManualVoucherTypeHidden(voucherType: string | null | undefined): boolean {
  return hiddenVoucherTypes.has((voucherType ?? "").trim().toLowerCase());
}

/** Querystring/hash deep links never grant visibility to hidden creation tabs. */
export function retailVisibleVoucherTabs<T extends string>(tabs: readonly T[]): T[] {
  return tabs.filter((tab) => !isRetailManualVoucherTabHidden(tab));
}
