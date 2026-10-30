import { FEATURE_KEYS } from "@shared/schema";

/**
 * View Only always inherits every ERP business-data page, including pages
 * added after the user's old per-company allow-list was saved. Stale saved
 * lists must never silently hide newer read pages. Dashboard, Settings, and
 * the write-only Create Voucher page stay excluded.
 *
 * The View Only HTTP middleware separately rejects business mutations.
 * Other roles continue to use their explicitly assigned ERP page keys.
 */
export function effectiveErpPageKeys(role: string, savedPageKeys: readonly string[]): string[] {
  if (role === "View Only") {
    return FEATURE_KEYS.filter((key) => key !== "dashboard" && key !== "settings" && key !== "create");
  }
  return [...savedPageKeys];
}
