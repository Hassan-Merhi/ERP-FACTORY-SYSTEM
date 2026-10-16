/**
 * GC-LSHI imports Fresh Start FZE containers into its own Supplier Partner
 * inventory. Fresh Start is a partner-capital source, not a supplier payable.
 *
 * Require BOTH Golden Coast ownership roles; a company name or a client flag
 * is never sufficient to authorize posting without a linked supplier.
 */
export const FRESH_START_OTW_SOURCE_NAME = "Fresh Start FZE";

export function isGoldenCoastOtwSource(
  accounts: ReadonlyArray<{ subType?: string | null }>,
): boolean {
  const roles = new Set(accounts.map((account) => account.subType));
  return roles.has("gc_partner_capital") && roles.has("gc_owner_capital");
}
