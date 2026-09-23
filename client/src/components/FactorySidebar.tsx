import {
  Package,
  Container,
  History,
  BarChart3,
  ScanLine,
  Users,
  Factory,
  BookOpen,
  Landmark,
  FileText,
  TrendingUp,
  MapPin,
  Settings,
  HardHat,
  UserRound,
  ClipboardCheck,
  Activity,
  Bell,
  Beaker,
  Trash2,
  Gauge,
  MessageCircle,
  AlertTriangle,
  LayoutGrid,
  Store,
  TableProperties,
  KeyRound,
  Building2,
  CreditCard,
  Layers,
  BookMarked,
} from "lucide-react";
import { Sidebar, SidebarContent } from "@/components/ui/sidebar";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { accessQueryPolicy, liveCountQueryPolicy, stableSettingsQueryPolicy } from "@/lib/queryPolicies";
import { useConnectivity } from "@/contexts/ConnectivityContext";
import { useRef, useEffect, useMemo } from "react";
import { useRecentNav } from "@/hooks/use-recent-nav";
import { useCompany } from "@/contexts/CompanyContext";
import { Clock } from "lucide-react";
import {
  ModuleHeader,
  ModuleFooter,
  PinnedNavList,
  SidebarFlatLink,
  SidebarSectionGroup,
  usePinnedOrder,
  useOpenSections,
  MODULE_ACCENT,
  NAV_COLOR,
  type NavItem,
  type NavSection,
} from "@/components/sidebar/sidebarPrimitives";

interface FactoryNavItem extends NavItem {
  adminOnly?: boolean;
  developerOnly?: boolean;
  featureFlag?: string;
  featureFlagDefaultOn?: boolean;
  hideKey?: string;
  requiresExplicitAccess?: boolean;
  viewableByAll?: boolean;
}

interface FactoryNavSection extends NavSection {
  items: FactoryNavItem[];
  developerOnly?: boolean;
}

export const FACTORY_NAV_SECTIONS: FactoryNavSection[] = [
  {
    label: "Production",
    color: NAV_COLOR.operations,
    items: [
      { title: "Stock Entry", url: "/factory/stock-entry", icon: ScanLine },
      { title: "Raw Materials", url: "/factory/raw-materials", icon: Package },
      { title: "Waste Dispatch", url: "/factory/waste-dispatch", icon: Trash2 },
      { title: "Bale Explorer", url: "/factory/bales-hub", icon: History },
    ],
  },
  {
    label: "Sales",
    color: NAV_COLOR.sales,
    items: [
      { title: "Invoicing", url: "/factory/invoicing", icon: FileText },
    ],
  },
  {
    label: "Inventory",
    color: NAV_COLOR.inventory,
    items: [
      { title: "Location Inventory", url: "/factory/location-inventory", icon: MapPin },
      { title: "Containers", url: "/factory/containers-hub", icon: Container },
      { title: "Stock Allocation", url: "/factory/stock-allocation-v5", icon: LayoutGrid },
      { title: "Sheets & Sacks", url: "/factory/sheets-sacks", icon: Layers, viewableByAll: true },
    ],
  },
  {
    label: "Finance",
    color: NAV_COLOR.finance,
    items: [
      { title: "Daybook", url: "/factory/daybook", icon: BookOpen },
      { title: "Parties", url: "/factory/parties", icon: Users },
      { title: "Contacts", url: "/factory/contacts", icon: BookMarked },
      { title: "Payroll & Benefits", url: "/factory/payroll-hub", icon: HardHat },
      { title: "Analytics", url: "/factory/analytics", icon: TrendingUp, adminOnly: true },
    ],
  },
  {
    label: "Rentals",
    color: NAV_COLOR.rentals,
    items: [
      { title: "Shops", url: "/factory/rental/shops", icon: Store },
      { title: "Warehouses", url: "/factory/rental/warehouses", icon: Building2, developerOnly: true },
      { title: "Payments", url: "/factory/rental/payments", icon: CreditCard, developerOnly: true },
    ],
  },
  {
    label: "Intelligence",
    color: NAV_COLOR.intelligence,
    developerOnly: true,
    items: [
      {
        title: "Factory Dashboard",
        url: "/factory/intelligence/dashboard",
        icon: Activity,
        featureFlag: "dashboardEnabled",
      },
      { title: "KPIs", url: "/factory/intelligence/kpis", icon: Gauge, featureFlag: "kpisEnabled" },
      {
        title: "Supplier Intel",
        url: "/factory/intelligence/supplier-hub",
        icon: ClipboardCheck,
        featureFlag: "supplierReportEnabled",
      },
      {
        title: "Financial Intel",
        url: "/factory/intelligence/financial-hub",
        icon: BarChart3,
        featureFlag: "netProfitEnabled",
      },
      {
        title: "Production Intel",
        url: "/factory/intelligence/production-hub",
        icon: Beaker,
        featureFlag: "productionSummaryEnabled",
      },
      { title: "Alerts", url: "/factory/intelligence/alerts", icon: Bell, featureFlag: "alertsEnabled" },
      { title: "Intel Settings", url: "/factory/intelligence/settings", icon: Settings, adminOnly: true },
    ],
  },
];

const FACTORY_ACCESS_EXTRA_PAGES: { key: string; label: string; group: string }[] = [
  { key: "factory/production-report", label: "Overview", group: "Production" },
  { key: "factory/agents", label: "Agent Ledger", group: "Finance" },
  { key: "factory/accounts", label: "Accounts", group: "Finance" },
  { key: "factory/vouchers", label: "Vouchers", group: "Finance" },
  { key: "factory/transporters", label: "Transporters", group: "Finance" },
  { key: "factory/broker-visual-statement", label: "Broker Statement", group: "Finance" },
  { key: "factory/stock-query", label: "Stock Query", group: "Inventory" },
  { key: "factory/stock-bale-list", label: "Stock Bale List", group: "Inventory" },
  { key: "factory/bale-tracking", label: "Bale Tracking", group: "Inventory" },
  { key: "factory/import", label: "Import", group: "Inventory" },
  { key: "factory/merge-bale-products", label: "Merge Bale Products", group: "Inventory" },
  { key: "factory/bale-product-images", label: "Bale Product Images", group: "Inventory" },
  { key: "factory/price-list", label: "Price List", group: "Sales" },
  { key: "factory/dispatch-batches", label: "Dispatch Batches", group: "Sales" },
  { key: "factory/bale-relabeling", label: "Bale Relabeling", group: "Production" },
  { key: "factory/production-comparison", label: "Production Comparison", group: "Production" },
  { key: "factory/chat", label: "Chat", group: "Other" },
  { key: "factory/settings", label: "Settings", group: "Other" },
];

export const FACTORY_NAV_PAGES: { key: string; label: string; group: string }[] = Array.from(
  new Map(
    [
      ...FACTORY_NAV_SECTIONS.flatMap((s) =>
        s.items.map((item) => ({ key: item.url.replace(/^\//, ""), label: item.title, group: s.label }))
      ),
      ...FACTORY_ACCESS_EXTRA_PAGES,
    ].map((page) => [page.key, page])
  ).values()
);

const FACTORY_PINNED_DEFAULTS: NavItem[] = [
  { title: "Overview", url: "/factory/production-report", icon: BarChart3 },
  { title: "Agent Ledger", url: "/factory/agents", icon: UserRound },
  { title: "Accounts", url: "/factory/accounts", icon: Landmark },
  { title: "Daybook", url: "/factory/daybook", icon: BookOpen },
  { title: "Vouchers", url: "/factory/vouchers", icon: FileText },
];

interface FactorySidebarUser {
  username?: string | null;
  role?: string | null;
}

export function useFactoryVisibleSections(user?: FactorySidebarUser): {
  sections: FactoryNavSection[];
  isPinnedVisible: (item: NavItem) => boolean;
  isAdmin: boolean;
  isDeveloper: boolean;
  isPrivileged: boolean;
} {
  const { selectedCompany } = useCompany();
  const isDeveloper = user?.role === "Developer";
  const isAdmin = user?.role === "Admin" || user?.role === "Owner" || isDeveloper;

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

  const isPinnedVisible = (item: NavItem): boolean => {
    if (item.url === "/factory/production-report") {
      return !myAccess?.hiddenCostFields?.includes("hide_tab_production_analytics");
    }
    if (item.url === "/factory/daybook") {
      if (myAccess?.hiddenCostFields?.includes("hide_tab_daybook")) return false;
      if (myAccess && !myAccess.fullAccess && myAccess.pageKeys.length > 0) {
        return myAccess.pageKeys.includes("factory/daybook");
      }
      return true;
    }
    if (item.url === "/factory/agents") {
      return !myAccess?.hiddenCostFields?.includes("hide_tab_agents");
    }
    // Accounts and Vouchers: only show when the user has explicit page access.
    // Mirrors the Finance section's pageKeys check so restricted users can't see
    // them in the pinned area either.
    if (item.url === "/factory/accounts" || item.url === "/factory/vouchers") {
      if (myAccess && !myAccess.fullAccess && myAccess.pageKeys.length > 0) {
        return myAccess.pageKeys.includes(item.url.replace(/^\//, ""));
      }
      return true; // full access or no per-page restrictions configured
    }
    return true;
  };

  const sections = FACTORY_NAV_SECTIONS.filter((s) => !s.developerOnly || isDeveloper)
    .map((s) => ({
      ...s,
      items: s.items.filter((item) => {
        if (item.developerOnly && !isDeveloper) return false;
        if (item.adminOnly && !isAdmin) return false;
        if (item.featureFlag) {
          if (item.featureFlagDefaultOn) {
            if (settings && settings[item.featureFlag] === false) return false;
          } else {
            if (!settings || settings[item.featureFlag] !== true) return false;
          }
        }
        if (item.viewableByAll) {
          // always show in sidebar — access guard handled at the page level
        } else if (myAccess && !myAccess.fullAccess && myAccess.pageKeys.length > 0)
          if (!myAccess.pageKeys.includes(item.url.replace(/^\//, ""))) return false;
        if (item.hideKey && myAccess?.hiddenCostFields?.includes(item.hideKey)) return false;
        if (item.requiresExplicitAccess && !isAdmin && myAccess) {
          if (myAccess.fullAccess) return false;
          if (!myAccess.pageKeys.includes(item.url.replace(/^\//, ""))) return false;
        }
        return true;
      }),
    }))
    .filter((s) => s.items.length > 0);

  const isPrivileged = isAdmin || myAccess?.fullAccess === true;
  return { sections, isPinnedVisible, isAdmin, isDeveloper, isPrivileged };
}

export function FactorySidebar({
  user,
  onLogout,
}: {
  user?: FactorySidebarUser;
  onLogout: () => void | Promise<void>;
}) {
  const { toast } = useToast();
  const { conflictCount } = useConnectivity();
  const { selectedCompany } = useCompany();
  const prevUnreadRef = useRef<number>(-1);

  const { items: pinnedItems, reorder: reorderPinned } = usePinnedOrder(
    "factory-pinned-order",
    FACTORY_PINNED_DEFAULTS
  );

  const { data: chatUnread } = useQuery<{ count: number }>({
    queryKey: companyQueryKey("/api/chat/unread-count", selectedCompany?.id),
    ...liveCountQueryPolicy(60_000),
    enabled: !!user && !!selectedCompany?.id,
  });

  useEffect(() => {
    const count = chatUnread?.count || 0;
    if (prevUnreadRef.current === -1) {
      prevUnreadRef.current = count;
      return;
    }
    if (count > prevUnreadRef.current)
      toast({ title: "New message", description: `You have ${count} unread message${count > 1 ? "s" : ""}.` });
    prevUnreadRef.current = count;
  }, [chatUnread?.count, toast]);

  const {
    sections: visibleSections,
    isPinnedVisible,
    isAdmin,
    isDeveloper,
    isPrivileged: _isPrivileged,
  } = useFactoryVisibleSections(user);

  const { openSections, toggleSection } = useOpenSections(visibleSections);

  const allNavItems = useMemo(() => [...FACTORY_PINNED_DEFAULTS, ...FACTORY_NAV_SECTIONS.flatMap((s) => s.items)], []);
  const recentItems = useRecentNav(allNavItems, selectedCompany?.id);

  const testIdFor = (i: NavItem) => `link-factory-${i.url.split("/").pop()}`;

  return (
    <Sidebar>
      <ModuleHeader icon={Factory} label="Business OS" tagline="Factory / Production" accent={MODULE_ACCENT.factory} />

      <SidebarContent className="px-3 py-2 overflow-y-auto">
        <PinnedNavList
          items={pinnedItems}
          color={NAV_COLOR.pinned}
          onReorder={reorderPinned}
          isVisible={isPinnedVisible}
          testIdFor={testIdFor}
        />

        <div className="space-y-1">
          {visibleSections.map((section) => (
            <SidebarSectionGroup
              key={section.label}
              section={section}
              isOpen={openSections.has(section.label)}
              onToggle={() => toggleSection(section.label)}
              sectionTestId={`button-section-${section.label.toLowerCase()}`}
              testIdFor={testIdFor}
            />
          ))}
        </div>

        {recentItems.length > 0 && (
          <div className="mt-3">
            <p className="mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
              Recent
            </p>
            <div className="space-y-0.5">
              {recentItems.map((item) => (
                <SidebarFlatLink
                  key={item.url}
                  href={item.url}
                  icon={Clock}
                  label={item.title}
                  testId={`link-factory-recent-${item.url.replace(/\//g, "-")}`}
                />
              ))}
            </div>
          </div>
        )}

        <div className="mt-4 pt-3 border-t border-sidebar-border/60 space-y-0.5">
          {isDeveloper && (
            <SidebarFlatLink
              href="/factory/spreadsheet"
              icon={TableProperties}
              label="Spreadsheet"
              testId="link-factory-spreadsheet"
            />
          )}
          {isDeveloper && (
            <SidebarFlatLink
              href="/factory/chat"
              icon={MessageCircle}
              label="Chat"
              color={NAV_COLOR.pinned}
              badge={chatUnread?.count}
              testId="link-factory-chat"
            />
          )}
          {conflictCount > 0 && (
            <a
              href="/factory/conflicts"
              data-testid="link-factory-conflicts"
              className="flex items-center gap-2.5 rounded-md py-1.5 text-sm text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground transition-colors"
              style={{ borderLeft: "2px solid transparent", paddingLeft: "8px", paddingRight: "10px" }}
            >
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-orange-500" />
              <span className="flex-1 leading-tight">Conflicts</span>
              <Badge
                variant="outline"
                className="text-xs min-w-5 justify-center border-orange-500/40 bg-orange-50 dark:bg-orange-950/30 text-orange-700 dark:text-orange-400"
                data-testid="badge-factory-conflict-count"
              >
                {conflictCount}
              </Badge>
            </a>
          )}
          {!["Admin", "Owner", "Developer"].includes(user?.role ?? "") && (
            <SidebarFlatLink
              href="/my-settings"
              icon={KeyRound}
              label="My Settings"
              testId="link-factory-my-settings"
            />
          )}
          {(isAdmin || isDeveloper) && (
            <SidebarFlatLink href="/factory/settings" icon={Settings} label="Settings" testId="link-factory-settings" />
          )}
          {isDeveloper && (
            <SidebarFlatLink
              href="/factory/intelligence/settings"
              icon={Settings}
              label="Intel Settings"
              color={NAV_COLOR.intelligence}
              testId="link-factory-intel-settings"
            />
          )}
        </div>
      </SidebarContent>

      <ModuleFooter
        user={user ? { username: user.username ?? undefined, role: user.role ?? undefined } : undefined}
        accent={MODULE_ACCENT.factory}
        onLogout={onLogout}
      />
    </Sidebar>
  );
}
