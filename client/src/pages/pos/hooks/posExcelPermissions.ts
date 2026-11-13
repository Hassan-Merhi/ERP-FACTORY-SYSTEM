import type { AuthMe } from "@shared/apiTypes";

/**
 * Export-level safeguard. Caller must use the CURRENT role (a user can switch
 * roles without losing their base Admin account) and honor hidden cost fields.
 * The API serving inventory must also enforce its own company/role permissions.
 */
export function canSeePosExcelFinancials(
  user: Pick<AuthMe, "role" | "currentRole" | "posViewOnly" | "hiddenErpCostFields"> | null | undefined,
): boolean {
  if (!user) return false;
  const effectiveRole = user.currentRole ?? user.role ?? "";
  if (user.posViewOnly || (user.hiddenErpCostFields ?? []).includes("stock_rates")) return false;
  return effectiveRole === "Admin" || effectiveRole === "Owner" || effectiveRole === "Developer";
}
