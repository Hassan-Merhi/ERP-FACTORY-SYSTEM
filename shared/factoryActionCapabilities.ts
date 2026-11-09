/**
 * Factory action capabilities shared by the selected-company UI and authorized
 * server request context. This is a policy helper, NOT an authorization boundary.
 * Route handlers must continue to resolve the company and enforce access server-side.
 */
export type FactoryAction = "dispatch.close" | "dispatch.approve-discrepancy" | "dispatch.reopen" | "production.manage-bonuses";
export interface FactoryActionContext {
  role?: string | null;
  hasFactoryAccess?: boolean;
}
export function factoryActionCapabilities(context: FactoryActionContext): Record<FactoryAction, boolean> {
  const role = (context.role ?? "").trim().toLowerCase();
  const hasAccess = context.hasFactoryAccess !== false;
  const supervisor = role === "admin" || role === "owner" || role === "developer";
  const write = role.length > 0 && role !== "view only" && role !== "create only";
  return {
    "dispatch.close": hasAccess && write,
    "dispatch.approve-discrepancy": hasAccess && supervisor,
    "dispatch.reopen": hasAccess && supervisor,
    // Preserve the existing bonus payment rule: Developer cannot manage bonuses.
    "production.manage-bonuses": hasAccess && (role === "admin" || role === "owner"),
  };
}
