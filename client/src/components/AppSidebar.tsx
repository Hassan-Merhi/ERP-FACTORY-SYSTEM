import {
  LayoutDashboard,
  ShoppingCart,
  Package,
  FileText,
  Settings,
  Layers,
  BarChart3,
  FolderPlus,
  Wallet,
  Receipt,
  Book,
  UserCheck,
  PieChart,
  Ship,
  Calculator,
  MessageCircle,
  TableProperties,
  ExternalLink,
  AlertTriangle,
  UserRound,
  ScrollText,
  Store,
  KeyRound,
  LayoutGrid,
  Handshake,
  Bot,
  ShieldCheck,
  ArrowRight,
  Replace,
} from "lucide-react";
import { useConnectivity } from "@/contexts/ConnectivityContext";
import { Sidebar, SidebarContent } from "@/components/ui/sidebar";
import { useQuery } from "@tanstack/react-query";
import { ROUTE_TO_FEATURE } from "@shared/schema";
import { useRef, useEffect, useMemo } from "react";
import { useCompany } from "@/contexts/CompanyContext";
import { useRecentNav } from "@/hooks/use-recent-nav";
import { Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { accessQueryPolicy, liveCountQueryPolicy, stableSettingsQueryPolicy } from "@/lib/queryPolicies";
import { SUPPLIER_PARTNER_RECENT_ITEMS, SUPPLIER_PARTNER_SECTIONS } from "@/lib/supplier-partner-navigation";
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

const defaultPinnedItems: NavItem[] = [
  { title: "Tracking", url: "/tracking", icon: Ship },
  { title: "Dashboard", url: "/financial-overview", icon: LayoutDashboard },
  { title: "Agent Ledger", url: "/agents", icon: UserRound },
  { title: "Daybook", url: "/daybook", icon: Book },
  { title: "All Daybook", url: "/transaction-journal", icon: ScrollText },
  { title: "Vouchers", url: "/vouchers", icon: Receipt },
];

const SETTINGS_HIDDEN_ROLES = new Set(["Admin", "Owner", "Developer"]);

export const ERP_NAV_SECTIONS: NavSection[] = [
  {
    label: "Inventory",
    color: NAV_COLOR.inventory,
    items: [
      { title: "Inventory", url: "/inventory", icon: Layers },
      { title: "Stock", url: "/stock", icon: Package },
      { title: "Optional Vouchers", url: "/optional-vouchers", icon: FileText },
      { title: "Profit Check", url: "/supplier-profit-check", icon: Calculator },
    ],
  },
  {
    label: "Sales & POS",
    color: NAV_COLOR.sales,
    items: [
      { title: "POS", url: "/pos", icon: ShoppingCart },
      { title: "POS Item Replacement", url: "/pos-item-replacement", icon: Replace },
      { title: "Sales Tools", url: "/sales-tools", icon: LayoutGrid },
    ],
  },
  {
    label: "Accounting",
    color: NAV_COLOR.accounting,
    items: [
      { title: "Accounts", url: "/accounts", icon: Wallet },
      { title: "Parties", url: "/parties", icon: Handshake },
      { title: "Payroll", url: "/payroll", icon: UserCheck },
    ],
  },
  {
    label: "Analytics",
    color: NAV_COLOR.analytics,
    items: [
      { title: "Sales Report", url: "/sales-report", icon: PieChart },
      { title: "Stock In & Sales", url: "/stock-in-sales-report", icon: BarChart3 },
      { title: "Analytics", url: "/analytics", icon: BarChart3 },
    ],
  },
  {
    label: "Rentals",
    color: NAV_COLOR.rentals,
    items: [{ title: "Shops", url: "/erp/rental/shops", icon: Store }],
  },
  {
    label: "AI Tools",
    color: NAV_COLOR.analytics,
    devOnly: true,
    items: [
      { title: "AI Command Center", url: "/ai-command-center", icon: Bot },
      { title: "AI Validation", url: "/ai-validation", icon: ShieldCheck },
    ],
  },
];

const utilityItems: NavItem[] = [
  { title: "Create", url: "/create", icon: FolderPlus },
  { title: "Spreadsheet", url: "/spreadsheet", icon: TableProperties },
  { title: "Live Sheets", url: "/live-sheets", icon: ExternalLink },
];

export const ERP_PINNED_ITEMS = defaultPinnedItems;
export const ERP_UTILITY_ITEMS = utilityItems;

interface SidebarUser {
  username?: string | null;
  currentRole?: string | null;
  role?: string | null;
}

interface SidebarCompanySettings {
  posExcelImportEnabled?: boolean;
}

export function useErpVisibleSections(user?: SidebarUser): {
  sections: NavSection[];
  isItemVisible: (item: NavItem) => boolean;
  visibleUtilityItems: NavItem[];
  visiblePinnedItems: NavItem[];
} {
  const { selectedCompany } = useCompany();

  const { data: myErpPages } = useQuery<{ pageKeys: string[]; fullAccess: boolean }>({
    queryKey: companyQueryKey("/api/my-erp-pages", selectedCompany?.id),
    ...accessQueryPolicy,
    enabled: !!user && !!selectedCompany?.id,
  });

  const { data: companySettings } = useQuery<SidebarCompanySettings>({
    queryKey: companyQueryKey("/api/company-settings", selectedCompany?.id),
    ...stableSettingsQueryPolicy,
    enabled: !!selectedCompany?.id,
  });

  const allowedPages = new Set<string>(myErpPages?.pageKeys || []);

  const isItemVisible = (item: NavItem): boolean => {
    const effectiveRole = user?.currentRole ?? user?.role ?? "";
    const isPOSUser = effectiveRole === "POS";
    const isAdmin = effectiveRole === "Admin" || effectiveRole === "Developer";
    const isDeveloper = effectiveRole === "Developer";
    const isOwner = effectiveRole === "Owner";
    const featureKey =
      item.url === "/stock-in-sales-report"
        ? "sales_report"
        : item.url === "/pos-item-replacement"
          ? "pos"
          : ROUTE_TO_FEATURE[item.url];

    if (item.url === "/tracking") return ["Admin", "Developer", "Owner"].includes(effectiveRole);
    if (isPOSUser && item.url === "/pos-item-replacement") return false;

    if (
      item.url === "/factory/raw-stock" &&
      selectedCompany?.companyType !== "factory" &&
      selectedCompany?.companyType !== "factory_v2"
    )
      return false;
    if (item.url === "/net-profit-report") return isDeveloper;
    if (item.url === "/company-transfer") return isDeveloper;
    if (item.url === "/spreadsheet") return isDeveloper;
    if (item.url === "/live-sheets") return isDeveloper;
    if (item.url === "/chat") return isDeveloper;
    if (item.url === "/settings" && isOwner) return false;

    if (isDeveloper || isAdmin || myErpPages?.fullAccess) return true;

    if (isPOSUser) {
      const posRoutes = ["/pos", "/pos-dashboard", "/pos-daybook", "/sales-tools", "/location-inventory"];
      if (companySettings?.posExcelImportEnabled) posRoutes.push("/pos-import");
      return posRoutes.includes(item.url);
    }

    if (featureKey && allowedPages.size > 0) return allowedPages.has(featureKey);
    if (allowedPages.size === 0 && myErpPages) return false;
    if (item.url === "/settings") return false;

    return true;
  };

  const isDeveloper = (user?.currentRole ?? user?.role) === "Developer";

  const sections = ERP_NAV_SECTIONS.map((s) => ({
    ...s,
    items: s.items.filter(isItemVisible),
  })).filter((s) => s.items.length > 0 && (!s.devOnly || isDeveloper));

  return {
    sections,
    isItemVisible,
    visibleUtilityItems: utilityItems.filter(isItemVisible),
    visiblePinnedItems: defaultPinnedItems.filter(isItemVisible),
  };
}

export function AppSidebar({ user }: { user?: SidebarUser }) {
  const { toast } = useToast();
  const { conflictCount } = useConnectivity();
  const { selectedCompany } = useCompany();
  const currentRole = user?.currentRole ?? user?.role ?? "";
  const prevUnreadRef = useRef<number>(-1);

  const { items: pinnedItems, reorder: reorderPinned } = usePinnedOrder("erp-pinned-order", defaultPinnedItems);

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

  const { sections: visibleSections, isItemVisible } = useErpVisibleSections(user);
  const supplierPartnerSections = selectedCompany?.companyType === "supplier_partner" ? SUPPLIER_PARTNER_SECTIONS : [];
  const sidebarSections = [...visibleSections, ...supplierPartnerSections];
  const { openSections, toggleSection } = useOpenSections(sidebarSections);

  const allNavItems = useMemo(
    () => [
      ...defaultPinnedItems,
      ...ERP_NAV_SECTIONS.flatMap((s) => s.items),
      ...utilityItems,
      ...(selectedCompany?.companyType === "supplier_partner" ? SUPPLIER_PARTNER_RECENT_ITEMS : []),
    ],
    [selectedCompany?.companyType]
  );
  const recentItems = useRecentNav(allNavItems, selectedCompany?.id);

  const trailingFor = (item: NavItem) => {
    if (item.url !== "/chat") return null;
    const unread = chatUnread?.count || 0;
    if (unread <= 0) return null;
    return (
      <Badge variant="default" className="text-xs min-w-5 justify-center" data-testid="badge-chat-unread">
        {unread}
      </Badge>
    );
  };

  return (
    <Sidebar>
      <ModuleHeader icon={Package} label="Business OS" tagline="ERP / Warehouse" accent={MODULE_ACCENT.erp} />

      <SidebarContent className="px-3 py-2 overflow-y-auto">
        <PinnedNavList
          items={pinnedItems}
          color={NAV_COLOR.pinned}
          onReorder={reorderPinned}
          isVisible={isItemVisible}
          testIdFor={(i) => `link-${i.url}`}
          trailingFor={trailingFor}
        />

        <div className="space-y-1">
          {sidebarSections.map((section) => (
            <SidebarSectionGroup
              key={section.label}
              section={section}
              isOpen={openSections.has(section.label)}
              onToggle={() => toggleSection(section.label)}
              sectionTestId={`button-section-${section.label.toLowerCase().replace(/\s+/g, "-")}`}
              testIdFor={(i) => `link-${i.url}`}
              trailingFor={trailingFor}
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
                  testId={`link-recent-${item.url.replace(/\//g, "-")}`}
                />
              ))}
            </div>
          </div>
        )}

        {utilityItems.filter(isItemVisible).length > 0 && (
          <div className="mt-4">
            <p className="mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
              Tools
            </p>
            <div className="space-y-0.5">
              {utilityItems.filter(isItemVisible).map((item) => (
                <SidebarFlatLink
                  key={item.url}
                  href={item.url}
                  icon={item.icon}
                  label={item.title}
                  testId={`link-${item.url}`}
                />
              ))}
            </div>
          </div>
        )}

        <div className="mt-4 pt-3 border-t border-sidebar-border/60 space-y-0.5">
          {isItemVisible({ title: "Chat", url: "/chat", icon: MessageCircle }) && (
            <SidebarFlatLink
              href="/chat"
              icon={MessageCircle}
              label="Chat"
              color={NAV_COLOR.pinned}
              badge={chatUnread?.count}
              testId="link-chat"
            />
          )}
          {conflictCount > 0 && (
            <a
              href="/conflicts"
              data-testid="link-conflicts"
              className="flex items-center gap-2.5 rounded-md py-1.5 text-sm text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground transition-colors"
              style={{ borderLeft: "2px solid transparent", paddingLeft: "8px", paddingRight: "10px" }}
            >
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-orange-500" />
              <span className="flex-1 leading-tight">Conflicts</span>
              <Badge
                variant="outline"
                className="text-xs min-w-5 justify-center border-orange-500/40 bg-orange-50 dark:bg-orange-950/30 text-orange-700 dark:text-orange-400"
                data-testid="badge-conflict-count"
              >
                {conflictCount}
              </Badge>
            </a>
          )}
          {!SETTINGS_HIDDEN_ROLES.has(currentRole) && (
            <SidebarFlatLink href="/my-settings" icon={KeyRound} label="My Settings" testId="link-my-settings" />
          )}
          <SidebarFlatLink
            href="/intercompany-requests"
            icon={ArrowRight}
            label="IC Requests"
            testId="link-ic-requests"
          />
          {isItemVisible({ title: "Settings", url: "/settings", icon: Settings }) && (
            <SidebarFlatLink href="/settings" icon={Settings} label="Settings" testId="link-settings" />
          )}
          {isItemVisible({ title: "IC Links", url: "/intercompany-links", icon: Settings }) && (
            <SidebarFlatLink href="/intercompany-links" icon={ArrowRight} label="IC Links" testId="link-ic-links" />
          )}
        </div>
      </SidebarContent>

      <ModuleFooter
        user={user ? { username: user.username ?? undefined, role: user.role ?? undefined } : undefined}
        accent={MODULE_ACCENT.erp}
      />
    </Sidebar>
  );
}
