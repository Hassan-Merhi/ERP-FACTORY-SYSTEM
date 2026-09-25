import type { FactoryMyAccess } from "@shared/apiTypes";
import { resolveFactoryPageKey } from "@shared/factoryAccessRegistry";

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

const SHARED_ACCOUNTING_READ_OWNERS = new Set([
  "factory/accounts",
  "factory/vouchers",
  "factory/payroll-hub",
  "factory/import",
  "factory/settings",
  "factory/invoicing",
]);

const ACCOUNTS_ALL_READ_OWNERS = new Set([
  "factory/accounts",
  "factory/vouchers",
  "factory/payroll-hub",
  "factory/import",
  "factory/settings",
]);

function currentFactoryPageKey(path: string): string | null {
  return resolveFactoryPageKey(path);
}

export function factoryPageOwnsSharedAccountingRead(path: string): boolean {
  const pageKey = currentFactoryPageKey(path);
  return pageKey !== null && SHARED_ACCOUNTING_READ_OWNERS.has(pageKey);
}

export function factoryPageOwnsAccountsAllRead(path: string): boolean {
  const pageKey = currentFactoryPageKey(path);
  return pageKey !== null && ACCOUNTS_ALL_READ_OWNERS.has(pageKey);
}
