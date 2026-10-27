import { FEATURE_KEYS } from "@shared/schema";

/**
 * For an ERP View Only role, no per-company ERP page allow-list means every
 * business-data page is browseable (except Dashboard, Settings, and Create Voucher). A nonempty list remains restrictive.
 * The global View Only HTTP middleware separately rejects every business write.
 */
export function effectiveErpPageKeys(role: string, savedPageKeys: readonly string[]): string[] {
  if (role === "View Only") {
    // Even an explicit allow-list must not expose Dashboard or admin/write-only pages.
    const visible = savedPageKeys.length === 0 ? FEATURE_KEYS : savedPageKeys;
    return visible.filter((key) => key !== "dashboard" && key !== "settings" && key !== "create");
  }
  return [...savedPageKeys];
}
