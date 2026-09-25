import type { FactoryMyAccess } from "@shared/apiTypes";

export function canUseFactorySurface(
  access: FactoryMyAccess | undefined,
  pageKey: string,
  requiredVisibleTabs: readonly string[] = []
): boolean {
  if (!access) return false;
  if (access.fullAccess) return true;
  if (!access.hasFactoryAccess) return false;
  if (!access.pageKeys.includes(pageKey)) return false;

  const hidden = new Set(access.hiddenCostFields ?? []);
  return requiredVisibleTabs.every((key) => !hidden.has(key));
}
