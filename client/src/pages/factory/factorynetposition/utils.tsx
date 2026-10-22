/**
 * Pure helpers and lookup tables for the FactoryNetPosition page.
 *
 * Extracted from FactoryNetPosition.tsx during the Phase 4 god-file split.
 */

export function fmt(n: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

export function fmtDate(d: string): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export /** Extract the prefix before " - " in an account name, or return null if none. */
function getNamePrefix(name: string): string | null {
  const idx = name.indexOf(" - ");
  return idx > 0 ? name.slice(0, idx).trim() : null;
}

/** A collapsible sub-group for accounts that share the same name prefix. */

export /* ── Custom Net Position View ─────────────────────────────────────────────── */
const NP_CUSTOM_VIEW_HIDDEN_KEY = "netpos_custom_view_hidden";
const customHiddenKey = (companyId?: number) => `${NP_CUSTOM_VIEW_HIDDEN_KEY}:${companyId ?? "no-company"}`;

export function loadCustomViewHidden(companyId?: number): Set<string> {
  try {
    // Fall back once to the pre-company key so existing choices survive.
    const raw = localStorage.getItem(customHiddenKey(companyId)) ?? localStorage.getItem(NP_CUSTOM_VIEW_HIDDEN_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

export function saveCustomViewHidden(keys: Set<string>, companyId?: number) {
  try {
    localStorage.setItem(customHiddenKey(companyId), JSON.stringify(Array.from(keys)));
  } catch {
    // View-only preference. Private browsing must never crash the report.
  }
}

export function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export function shiftDate(date: string, days: number): string {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function formatDateLabel(date: string): string {
  const d = new Date(date + "T12:00:00Z");
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}
