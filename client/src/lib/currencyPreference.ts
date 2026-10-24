/**
 * Browser currency preferences are scoped to the authenticated user AND ERP
 * company. A Mali/CFA selection must never leak into Zambia/USD-ZMW.
 *
 * The old "selectedCurrency" key is READ only as a compatibility fallback for
 * legacy CFA companies. Never write global keys for new currency selections.
 */
export type ScopedCurrencyChoice = { scope: string; currency: string };

export function currencyPreferenceScope(companyId: number, userId: string | number): string {
  return "erp-currency:" + encodeURIComponent(String(userId)) + ":" + String(companyId);
}

export function readScopedCurrencyPreference(scope: string | null): string | null {
  if (!scope) return null;
  try {
    return localStorage.getItem(scope);
  } catch {
    return null;
  }
}

export function saveScopedCurrencyPreference(scope: string, currency: string): void {
  try {
    localStorage.setItem(scope, currency);
  } catch {
    /* storage disabled: in-memory choice still works */
  }
}

export function legacyCfaCurrencyPreference(preferredCurrency: string | null | undefined): string | null {
  if (preferredCurrency === "USD" || preferredCurrency === "CFA") return preferredCurrency;
  try {
    const old = localStorage.getItem("selectedCurrency");
    return old === "USD" || old === "CFA" ? old : null;
  } catch {
    return null;
  }
}

/** Legacy CFA companies keep writing the global browser key older screens read. */
export function saveLegacyCfaCurrencyPreference(currency: "USD" | "CFA"): void {
  try {
    localStorage.setItem("selectedCurrency", currency);
  } catch {
    /* storage disabled */
  }
}

/** Only allow currencies belonging to the selected company's pair. */
export function allowedCompanyCurrency(
  candidate: string | null | undefined,
  base: string,
  display: string | null
): boolean {
  return !!candidate && (candidate === base || (display !== null && candidate === display));
}
