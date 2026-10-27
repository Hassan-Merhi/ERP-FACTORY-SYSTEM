/**
 * A committed ERP company-rate change alters *reported* current USD values,
 * not original voucher amounts. These are read-models that may depend on the
 * applicable dated rate. Keep one list for same-tab and realtime refresh.
 *
 * Prefixes are bounded by '/', '?', or the end of the URL to avoid matching
 * unrelated API endpoints with a similar path.
 */
export const FX_RATE_REFRESH_PATHS = [
  "/api/exchange-rates",
  "/api/accounts",
  "/api/ledger-accounts",
  "/api/bank-accounts",
  "/api/customers",
  "/api/factory/customers",
  "/api/loans",
  "/api/stats/net-profit",
  "/api/stats/net-position",
  "/api/stats/group-net-position",
  "/api/stats/financial-ratios",
  "/api/stats/ratios",
  "/api/stats/import-cycle-balance",
  "/api/reports/net-position",
  "/api/reports/balance-sheet",
  "/api/reports/ratios",
  "/api/balance-sheet",
  "/api/factory/net-position",
  "/api/dashboard",
] as const;

/** Match a URL path or a URL-with-parameters, but not a longer path lookalike. */
export function isFxRateDependentPath(key: string): boolean {
  return FX_RATE_REFRESH_PATHS.some((prefix) =>
    key === prefix || key.startsWith(prefix + "/") || key.startsWith(prefix + "?")
  );
}

const EXPLICIT_RATE_COMPANY_PATHS = [
  "/api/exchange-rates",
  "/api/accounts/multi-currency/monetary-valuation",
] as const;

export function isFxRateDependentQuery(
  queryKey: readonly unknown[],
  savedCompanyId?: number
): boolean {
  const key = queryKey[0];
  if (typeof key !== "string" || !isFxRateDependentPath(key)) return false;
  if (!savedCompanyId) return true;

  // Rate screens use ["/api/exchange-rates/...", companyId, ...]. Other
  // accounts/stats query keys can use a numeric filter as their second item,
  // and must not be mistaken for a company ID.
  if (EXPLICIT_RATE_COMPANY_PATHS.some((prefix) =>
    key === prefix || key.startsWith(prefix + "/") || key.startsWith(prefix + "?")
  )) {
    if (typeof queryKey[1] === "number" && queryKey[1] !== savedCompanyId) return false;
  }
  // A URL with explicit companyId is company-specific, too.
  const match = key.match(/[?&]companyId=(\d+)(?:&|$)/);
  if (match && Number(match[1]) !== savedCompanyId) return false;
  return true;
}
