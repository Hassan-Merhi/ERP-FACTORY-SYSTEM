// Extracted from ./useFactoryVisibleSections.ts
import { type NavItem, type NavSection } from "@/components/sidebar/sidebarPrimitives";
import { FACTORY_SIDEBAR_PAGES } from "@/app/factoryAccessRegistry";
import { FACTORY_SALES_DISPATCH_ROUTES } from "@/factory/config/navigationPresentation";

interface FactoryNavItem extends NavItem {
  accessKey: string;
  adminOnly?: boolean;
  developerOnly?: boolean;
  featureFlag?: string;
  featureFlagDefaultOn?: boolean;
  hideKey?: string;
}

export interface FactoryNavSection extends NavSection {
  items: FactoryNavItem[];
  developerOnly?: boolean;
}

// UI grouping only: do not change the canonical registry's permission keys or Settings grouping.
export const FACTORY_SIDEBAR_GROUP_ORDER = [
  "Production",
  "Inventory",
  "Sales & Loading",
  "Finance",
  "Rentals",
  "Intelligence",
  "Others",
] as const;

export function visibleFactoryGroup(page: (typeof FACTORY_SIDEBAR_PAGES)[number]): string {
  if (page.key === "factory/waste-dispatch") return "Sales & Loading";
  if (page.key === "factory/tickets" || page.key === "factory/stock-query") return "Others";
  return page.group === "Sales" ? "Sales & Loading" : page.group;
}

/**
 * A single sidebar entry represents POS and Waste Dispatch, but keeps whichever
 * direct route is active highlighted. Each route still enforces its own grants.
 */
export function collapseFactorySalesDispatchNav<T extends { accessKey: string }>(items: T[], location: string): T[] {
  if (
    !items.some((item) => item.accessKey === "factory/pos") ||
    !items.some((item) => item.accessKey === "factory/waste-dispatch")
  )
    return items;
  const hide = location.startsWith(FACTORY_SALES_DISPATCH_ROUTES.wasteDispatch)
    ? "factory/pos"
    : "factory/waste-dispatch";
  return items.filter((item) => item.accessKey !== hide);
}

export interface FactorySidebarUser {
  username?: string | null;
  role?: string | null;
}
