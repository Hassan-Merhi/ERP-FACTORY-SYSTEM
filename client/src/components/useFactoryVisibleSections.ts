// Extracted from ./FactorySidebar.tsx to keep that module under the source-size cap.
import {
  Activity,
  BarChart3,
  Beaker,
  Bell,
  BookMarked,
  BookOpen,
  Building2,
  ClipboardCheck,
  Container,
  CreditCard,
  FileText,
  Gauge,
  GitCompareArrows,
  HardHat,
  History,
  Landmark,
  Layers,
  LayoutGrid,
  ListOrdered,
  MapPin,
  Package,
  ScanLine,
  Settings,
  ShoppingCart,
  Store,
  TableProperties,
  Trash2,
  TrendingUp,
  UserRound,
  Users,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { accessQueryPolicy, stableSettingsQueryPolicy } from "@/lib/queryPolicies";
import { useLocation } from "wouter";
import { useCompany } from "@/contexts/CompanyContext";
import { NAV_COLOR, type NavItem } from "@/components/sidebar/sidebarPrimitives";
import {
  FACTORY_SIDEBAR_PAGES,
  factoryPageAllowsRole,
  hasFactoryPageKey,
  resolveFactoryPage,
} from "@/app/factoryAccessRegistry";
import { FACTORY_OTHERS_NAV_LINKS, factoryHubTabHideKey } from "@/factory/config/navigationPresentation";
import {
  FACTORY_SIDEBAR_GROUP_ORDER,
  visibleFactoryGroup,
  collapseFactorySalesDispatchNav,
  type FactoryNavSection,
  type FactorySidebarUser,
} from "./useFactoryVisibleSectionsHelpers";
export { collapseFactorySalesDispatchNav, type FactorySidebarUser } from "./useFactoryVisibleSectionsHelpers";

export const FACTORY_NAV_ICONS: Record<string, typeof Package> = {
  "factory/production-report": BarChart3,
  "factory/agents": UserRound,
  "factory/accounts": Landmark,
  "factory/cost-centers": Layers,
  "factory/daybook": BookOpen,
  "factory/vouchers": FileText,
  "factory/tickets": ClipboardCheck,
  "factory/stock-entry": ScanLine,
  "factory/raw-materials": Package,
  "factory/waste-dispatch": Trash2,
  "factory/bales-hub": History,
  "factory/pos": ShoppingCart,
  "factory/invoicing": FileText,
  "factory/location-inventory": MapPin,
  "factory/stock-query": Package,
  "factory/monthly-production-matrix": TableProperties,
  "factory/containers-hub": Container,
  "factory/stock-allocation-v5": LayoutGrid,
  "factory/sheets-sacks": Layers,
  "factory/parties": Users,
  "factory/contacts": BookMarked,
  "factory/payroll-hub": HardHat,
  "factory/analytics": TrendingUp,
  "factory/rental/shops": Store,
  "factory/rental/warehouses": Building2,
  "factory/rental/payments": CreditCard,
  "factory/intelligence/dashboard": Activity,
  "factory/intelligence/kpis": Gauge,
  "factory/intelligence/supplier-hub": ClipboardCheck,
  "factory/intelligence/financial-hub": BarChart3,
  "factory/intelligence/production-hub": Beaker,
  "factory/intelligence/alerts": Bell,
  "factory/intelligence/settings": Settings,
  "factory/intelligence/mhd-view": ListOrdered,
};

const FACTORY_SIDEBAR_COLORS: Record<string, string> = {
  Production: NAV_COLOR.operations,
  "Sales & Loading": NAV_COLOR.sales,
  Inventory: NAV_COLOR.inventory,
  Finance: NAV_COLOR.finance,
  Rentals: NAV_COLOR.rentals,
  Intelligence: NAV_COLOR.intelligence,
  Others: NAV_COLOR.pinned,
};

export const FACTORY_NAV_SECTIONS: FactoryNavSection[] = FACTORY_SIDEBAR_GROUP_ORDER.map((label) => {
  // The matrix and consumables now live inside Overview; retain their direct URLs and original permissions.
  const pages = FACTORY_SIDEBAR_PAGES.filter(
    (page) =>
      visibleFactoryGroup(page) === label &&
      !page.pinned &&
      page.key !== "factory/monthly-production-matrix" &&
      page.key !== "factory/sheets-sacks"
  );
  const orderedPages =
    label === "Others"
      ? [...pages].sort(
          (a, b) =>
            ["factory/stock-query", "factory/tickets"].indexOf(a.key) -
            ["factory/stock-query", "factory/tickets"].indexOf(b.key)
        )
      : pages;
  return {
    label,
    color: FACTORY_SIDEBAR_COLORS[label],
    developerOnly: pages.length > 0 && pages.every((page) => page.accessLevel === "developer"),
    items: [
      ...(label === "Others"
        ? FACTORY_OTHERS_NAV_LINKS.map((item) => ({
            title: item.title,
            url: item.url,
            accessKey: item.accessKey,
            hideKey: "hideKey" in item ? item.hideKey : undefined,
            adminOnly: "adminOnly" in item ? item.adminOnly : false,
            icon:
              item.iconKey === "comparison" ? GitCompareArrows : item.iconKey === "saleReturns" ? History : BarChart3,
          }))
        : []),
      ...orderedPages.map((page) => ({
        title:
          page.key === "factory/invoicing"
            ? "Invoices & Loading"
            : page.key === "factory/pos" || page.key === "factory/waste-dispatch"
              ? "POS & Dispatch"
              : page.label,
        url: page.route,
        icon: FACTORY_NAV_ICONS[page.key] ?? FileText,
        accessKey: page.key,
        adminOnly: page.accessLevel === "admin",
        developerOnly: page.accessLevel === "developer",
        featureFlag: page.featureFlag,
        featureFlagDefaultOn: page.featureFlagDefaultOn,
      })),
    ],
  };
}).filter((section) => section.items.length > 0);

export function useFactoryVisibleSections(user?: FactorySidebarUser): {
  sections: FactoryNavSection[];
  isPinnedVisible: (item: Pick<NavItem, "url">) => boolean;
  isHubTabVisible: (url: string) => boolean;
  isAdmin: boolean;
  isDeveloper: boolean;
  isPrivileged: boolean;
  /** The user's stored Factory tab/cost-field visibility list (hide/grant keys). */
  hiddenTabFields: readonly string[];
  /** Admin, Owner, Developer or full access: Factory hubs show every tab. */
  seesAllTabs: boolean;
} {
  const { selectedCompany } = useCompany();
  const [currentLocation] = useLocation();
  const isDeveloper = user?.role === "Developer";
  const isAdmin = user?.role === "Admin" || isDeveloper;

  const { data: settings } = useQuery({
    queryKey: companyQueryKey("/api/factory/settings", selectedCompany?.id),
    queryFn: async () => {
      const r = await fetch("/api/factory/settings");
      return r.ok ? r.json() : {};
    },
    ...stableSettingsQueryPolicy,
    enabled: !!user && !!selectedCompany?.id,
  });

  const { data: myAccess } = useQuery<{
    fullAccess: boolean;
    pageKeys: string[];
    hiddenCostFields: string[];
  }>({
    queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id),
    ...accessQueryPolicy,
    enabled: !!user && !!selectedCompany?.id,
  });

  const isPinnedVisible = (item: Pick<NavItem, "url">): boolean => {
    const page = resolveFactoryPage(item.url);
    if (!page || !myAccess) return false; // Never show destinations before company grants resolve.
    if (item.url.includes("tab=sale-returns") && !isAdmin) return false;
    if (!factoryPageAllowsRole(page, user?.role)) return false;
    if (page.featureFlag) {
      const defaultOn = !!page.featureFlagDefaultOn;
      const enabled = defaultOn ? settings?.[page.featureFlag] !== false : settings?.[page.featureFlag] === true;
      if (!enabled) return false;
    }
    // The ordinary Factory route guard bypasses per-user page lists for these roles.
    const privilegedRole = ["Admin", "Owner", "Developer"].includes(user?.role ?? "");
    if (!privilegedRole && !myAccess.fullAccess && !hasFactoryPageKey(page, myAccess.pageKeys)) {
      return false;
    }
    return true;
  };

  const isHubTabVisible = (url: string): boolean => {
    if (!myAccess) return false;
    const [pathname, query = ""] = url.split("?", 2);
    const params = new URLSearchParams(query);
    const tab = params.get("tab");
    const section = params.get("section");
    const hidden = myAccess.hiddenCostFields ?? [];
    const value = tab ?? section;
    const hideKey = factoryHubTabHideKey(pathname, value);
    if (hideKey && hidden.includes(hideKey)) return false;
    if (
      pathname === "/factory/invoicing" &&
      ["pending", "priority"].includes(tab ?? "") &&
      (hidden.includes("hide_invoicing_loadings_tab") || settings?.loadingsTabPendingEnabled === false)
    )
      return false;
    if (
      pathname === "/factory/sales/loadings" &&
      ["pending", "priority"].includes(tab ?? "") &&
      settings?.loadingsTabPendingEnabled === false
    )
      return false;
    if (pathname === "/factory/bales-hub" && tab === "barcode" && settings?.balesTabBarcodeEnabled === false)
      return false;
    return true;
  };

  const sections = FACTORY_NAV_SECTIONS.filter((s) => !s.developerOnly || isDeveloper)
    .map((s) => ({
      ...s,
      items: s.items.filter((item) => {
        // Use the same role, feature-flag, and per-company allow-list check as
        // pinned and recent navigation. An empty grant list remains default-deny.
        if (item.adminOnly && !isAdmin) return false;
        if (!isPinnedVisible({ url: item.url })) return false;
        if (item.hideKey && myAccess?.hiddenCostFields?.includes(item.hideKey)) return false;

        // Preserve all authorized pages in the sidebar, including those accessible
        // from a parent hub. Visibility remains controlled by the access registry.
        return true;
      }),
    }))
    .map((s) => ({
      ...s,
      items: s.label === "Sales & Loading" ? collapseFactorySalesDispatchNav(s.items, currentLocation) : s.items,
    }))
    .filter((s) => s.items.length > 0);

  const isPrivileged = isAdmin || myAccess?.fullAccess === true;
  const seesAllTabs = ["Admin", "Owner", "Developer"].includes(user?.role ?? "") || myAccess?.fullAccess === true;
  return {
    sections,
    isPinnedVisible,
    isHubTabVisible,
    isAdmin,
    isDeveloper,
    isPrivileged,
    hiddenTabFields: myAccess?.hiddenCostFields ?? [],
    seesAllTabs,
  };
}
