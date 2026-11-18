/**
 * Shared canonical Factory page-access registry.
 *
 * This file is UI-framework agnostic. Settings, navigation, route guards and
 * backend authorization consume this same registry so Factory access cannot drift.
 */
import { FACTORY_PRIMARY_PAGES } from "./factoryAccessPagesPrimary";
import { FACTORY_FINANCE_OTHER_PAGES } from "./factoryAccessPagesFinanceOther";

export type FactoryAccessLevel = "user" | "admin" | "developer";

export interface FactoryPageDefinition {
  key: string;
  label: string;
  group: string;
  route: string;
  aliases?: readonly string[];
  sidebar?: boolean;
  pinned?: boolean;
  settingsVisible?: boolean;
  landing?: boolean;
  accessLevel?: FactoryAccessLevel;
  featureFlag?: string;
  featureFlagDefaultOn?: boolean;
  hideKey?: string;
}

export const FACTORY_ACCESS_REGISTRY: readonly FactoryPageDefinition[] = [
  ...FACTORY_PRIMARY_PAGES,
  ...FACTORY_FINANCE_OTHER_PAGES,
] as const;

export const FACTORY_SETTINGS_PAGES = FACTORY_ACCESS_REGISTRY.filter(
  (page) => page.settingsVisible !== false && (page.accessLevel ?? "user") === "user"
);

export const FACTORY_SIDEBAR_PAGES = FACTORY_ACCESS_REGISTRY.filter((page) => page.sidebar === true);
export const FACTORY_PINNED_PAGES = FACTORY_ACCESS_REGISTRY.filter((page) => page.pinned === true);
export const FACTORY_LANDING_PAGES = FACTORY_ACCESS_REGISTRY.filter(
  (page) => page.landing === true && page.settingsVisible !== false
);

export function normalizeFactoryAccessPath(path: string): string {
  const queryIndex = path.indexOf("?");
  const hashIndex = path.indexOf("#");
  const cutAt = [queryIndex, hashIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0];
  const normalized = cutAt === undefined ? path : path.slice(0, cutAt);
  return normalized || "/";
}

function pathMatchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

export function resolveFactoryPage(path: string): FactoryPageDefinition | null {
  const normalizedPath = normalizeFactoryAccessPath(path);

  // Most-specific route wins so a protected child page cannot be swallowed by
  // a broader canonical page prefix.
  const direct = [...FACTORY_ACCESS_REGISTRY]
    .sort((a, b) => b.route.length - a.route.length)
    .find((page) => pathMatchesPrefix(normalizedPath, page.route));
  if (direct) return direct;

  const aliasMatch = FACTORY_ACCESS_REGISTRY.flatMap((page) => (page.aliases ?? []).map((alias) => ({ page, alias })))
    .sort((a, b) => b.alias.length - a.alias.length)
    .find(({ alias }) => pathMatchesPrefix(normalizedPath, alias));

  return aliasMatch?.page ?? null;
}

export function resolveFactoryPageKey(path: string): string | null {
  return resolveFactoryPage(path)?.key ?? null;
}

export function factoryPageAllowsRole(page: FactoryPageDefinition, role?: string | null): boolean {
  // The bonus checkout route is Admin/Owner-only (not Developer); do not widen it
  // through the general "admin" registry classification.
  if (page.key === "factory/production-bonuses") return role === "Admin" || role === "Owner";
  if (page.key === "factory/intelligence/mhd-view") return ["Admin", "Owner", "Developer"].includes(role ?? "");
  const level = page.accessLevel ?? "user";
  if (level === "developer") return role === "Developer";
  // Account Groups and Daybook are also accessible to Owners in FactoryRoutes;
  // keep the exceptions local instead of widening other admin-only pages.
  if (level === "admin") {
    return (
      role === "Admin" ||
      role === "Developer" ||
      ((page.key === "factory/account-groups" || page.key === "factory/daybook") && role === "Owner")
    );
  }
  return true;
}

export function hasFactoryPageKey(page: FactoryPageDefinition, pageKeys: readonly string[]): boolean {
  if (pageKeys.includes(page.key)) return true;
  return (page.aliases ?? []).some((alias) => pageKeys.includes(alias.replace(/^\//, "")));
}
