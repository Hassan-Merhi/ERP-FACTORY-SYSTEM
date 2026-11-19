// Extracted from ./MonetaryFxAccounting.tsx

// Phase 15 source-only rollout: an independent financial release is still required.
export const UNIFIED_FINANCIAL_POSTING_CERTIFIED = false;

export async function load<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? "Cannot load FX accounting report");
  return body as T;
}

export function currency(v: string | null) {
  return v === null ? "Unavailable" : v;
}
