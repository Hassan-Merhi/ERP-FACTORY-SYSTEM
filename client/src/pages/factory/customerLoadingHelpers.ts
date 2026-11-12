import { COLUMN_OPTIONS, type ColumnKey } from "./customerLoadingTypes";

export const PAGE_SIZE = 75;
export const COLUMN_PREFERENCE_KEY = "factory.customer-loading.visible-columns.v1";

/** Only column presentation is persisted; selection, quantities, and proforma data are not stored. */
export function initialVisibleColumns(): Set<ColumnKey> {
  const defaults = new Set(COLUMN_OPTIONS.map((column) => column.key));
  if (typeof window === "undefined") return defaults;
  try {
    const stored = window.localStorage.getItem(COLUMN_PREFERENCE_KEY);
    if (stored === null) return defaults;
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return defaults;
    return new Set(COLUMN_OPTIONS.filter((column) => parsed.includes(column.key)).map((column) => column.key));
  } catch {
    return defaults;
  }
}

export async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.message || "Request failed");
  return payload as T;
}
