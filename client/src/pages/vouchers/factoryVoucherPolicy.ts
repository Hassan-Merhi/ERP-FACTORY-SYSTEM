/** Factory's four adjustment voucher editors are not part of the Factory voucher UI. 
 * This policy is independent of per-user hiddenCostFields, so admins/owners
 * cannot accidentally regain these tabs after permission defaults change.
 * It only filters voucher navigation/forms; inventory workflows elsewhere are unchanged.
 */
const ALWAYS_HIDDEN_FACTORY_VOUCHER_TABS: ReadonlySet<string> = new Set([
  "transfer",
  "transferorder",
  "adjustment",
  "creditnote",
]);

export function shouldShowFactoryVoucherTab(
  tab: string,
  hiddenCostFields: readonly string[],
  permissionKey: string,
): boolean {
  return !ALWAYS_HIDDEN_FACTORY_VOUCHER_TABS.has(tab) && !hiddenCostFields.includes(permissionKey);
}
