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
import {
  FACTORY_PINNED_PAGES,
  FACTORY_SETTINGS_PAGES,
  FACTORY_SIDEBAR_PAGES,
  factoryPageAllowsRole,
  hasFactoryPageKey,
  resolveFactoryPage,
} from "@/app/factoryAccessRegistry";

interface FactoryNavItem extends NavItem {
  accessKey: string;
  adminOnly?: boolean;
  developerOnly?: boolean;
  featureFlag?: string;
  featureFlagDefaultOn?: boolean;
  hideKey?: string;
}

interface FactoryNavSection extends NavSection {
  items: FactoryNavItem[];
  developerOnly?: boolean;
}

const FACTORY_NAV_ICONS: Record<string, typeof Package> = {
  "factory/production-report": BarChart3,
  "factory/agents": UserRound,
  "factory/accounts": Landmark,
  "factory/daybook": BookOpen,
  "factory/vouchers": FileText,
  "factory/stock-entry": ScanLine,
  "factory/raw-materials": Package,
  "factory/waste-dispatch": Trash2,
  "factory/bales-hub": History,
  "factory/invoicing": FileText,
  "factory/location-inventory": MapPin,
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
};

const FACTORY_SIDEBAR_GROUP_ORDER = ["Production", "Sales", "Inventory", "Finance", "Rentals", "Intelligence"] as const;
const FACTORY_SIDEBAR_COLORS: Record<string, string> = {
  Production: NAV_COLOR.operations,
  Sales: NAV_COLOR.sales,
  Inventory: NAV_COLOR.inventory,
  Finance: NAV_COLOR.finance,
  Rentals: NAV_COLOR.rentals,
  Intelligence: NAV_COLOR.intelligence,
};

export const FACTORY_NAV_SECTIONS: FactoryNavSection[] = FACTORY_SIDEBAR_GROUP_ORDER.map((label) => {
  const pages = FACTORY_SIDEBAR_PAGES.filter((page) => page.group === label);
  return {
    label,
    color: FACTORY_SIDEBAR_COLORS[label],
    developerOnly: pages.length > 0 && pages.every((page) => page.accessLevel === "developer"),
    items: pages.map((page) => ({
      title: page.label,
      url: page.route,
      icon: FACTORY_NAV_ICONS[page.key] ?? FileText,
      accessKey: page.key,
      adminOnly: page.accessLevel === "admin",
      developerOnly: page.accessLevel === "developer",
      featureFlag: page.featureFlag,
      featureFlagDefaultOn: page.featureFlagDefaultOn,
      hideKey: page.hideKey,
    })),
  };
}).filter((section) => section.items.length > 0);

export const FACTORY_NAV_PAGES: { key: string; label: string; group: string }[] = FACTORY_SETTINGS_PAGES.map(
  ({ key, label, group }) => ({ key, label, group })
);

const FACTORY_PINNED_DEFAULTS: NavItem[] = FACTORY_PINNED_PAGES.map((page) => ({
  title: page.label,
  url: page.route,
  icon: FACTORY_NAV_ICONS[page.key] ?? FileText,
}));

interface FactorySidebarUser {
  username?: string | null;
  role?: string | null;
}

export function useFactoryVisibleSections(user?: FactorySidebarUser): {
  sections: FactoryNavSection[];
  isPinnedVisible: (item: Pick<NavItem, "url">) => boolean;
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

  const isPinnedVisible = (item: Pick<NavItem, "url">): boolean => {
    const page = resolveFactoryPage(item.url);
    if (!page) return false;
    if (!factoryPageAllowsRole(page, user?.role)) return false;
    if (page.featureFlag) {
      const defaultOn = !!page.featureFlagDefaultOn;
      const enabled = defaultOn ? settings?.[page.featureFlag] !== false : settings?.[page.featureFlag] === true;
      if (!enabled) return false;
    }
    if (
      myAccess &&
      !myAccess.fullAccess &&
      myAccess.pageKeys.length > 0 &&
      !hasFactoryPageKey(page, myAccess.pageKeys)
    ) {
      return false;
    }
    if (page.hideKey && myAccess?.hiddenCostFields?.includes(page.hideKey)) return false;
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
        const page = resolveFactoryPage(item.url);
        if (!page || !factoryPageAllowsRole(page, user?.role)) return false;
        if (
          myAccess &&
          !myAccess.fullAccess &&
          myAccess.pageKeys.length > 0 &&
          !hasFactoryPageKey(page, myAccess.pageKeys)
        ) {
          return false;
        }
        if (item.hideKey && myAccess?.hiddenCostFields?.includes(item.hideKey)) return false;
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
  const visibleRecentItems = recentItems.filter(isPinnedVisible);
  const conflictsVisible = isPinnedVisible({ url: "/factory/conflicts" });

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

        {visibleRecentItems.length > 0 && (
          <div className="mt-3">
            <p className="mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
              Recent
            </p>
            <div className="space-y-0.5">
              {visibleRecentItems.map((item) => (
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
          {conflictCount > 0 && conflictsVisible && (
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
