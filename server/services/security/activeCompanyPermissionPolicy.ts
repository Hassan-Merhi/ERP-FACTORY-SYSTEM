import { isErpContainerFactoryAlias } from "./companyResourceRoutePolicy";

export interface CompanyRoleIdentity {
  companyId: number;
  role: string;
}

function positiveId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function isPinnedCompanyRoute(path: string): boolean {
  const normalized = (path.split("?", 1)[0] || "/").toLowerCase();
  if (isErpContainerFactoryAlias(normalized)) return false;
  // Private Factory training media must use the pinned Factory company, not an ERP tab.
  return (
    normalized.startsWith("/api/training/media/factory-") ||
    normalized === "/api/factory" ||
    normalized.startsWith("/api/factory/") ||
    normalized === "/api/properties" ||
    normalized.startsWith("/api/properties/")
  );
}

/**
 * Factory and Properties use the server-pinned factoryCompanyId. Ordinary ERP,
 * POS, import, export, repair, and report routes must use currentCompanyId even
 * when another browser tab has a Factory company pinned in the same session.
 * Historical ERP container document/freight aliases under /api/factory remain ERP.
 */
export function resolvePermissionCompanyId(input: {
  path: string;
  currentCompanyId?: unknown;
  factoryCompanyId?: unknown;
}): number | null {
  const currentCompanyId = positiveId(input.currentCompanyId);
  const factoryCompanyId = positiveId(input.factoryCompanyId);
  return isPinnedCompanyRoute(input.path) ? (factoryCompanyId ?? currentCompanyId) : currentCompanyId;
}

export function chooseActiveCompanyRole(
  companyId: number,
  rows: ReadonlyArray<CompanyRoleIdentity>
): { role: string; developerBypass: boolean } | null {
  const activeRole = rows.find((row) => row.companyId === companyId);
  if (activeRole) {
    return {
      role: activeRole.role,
      developerBypass: activeRole.role === "Developer",
    };
  }

  if (rows.some((row) => row.role === "Developer")) {
    return { role: "Developer", developerBypass: true };
  }

  return null;
}
