import { Package, Settings, Book, MessageCircle, AlertTriangle, KeyRound, ArrowRight } from "lucide-react";
import { useConnectivity } from "@/contexts/ConnectivityContext";
import { ERP_NAV_SECTIONS, ERP_PINNED_ITEMS, ERP_UTILITY_ITEMS } from "@/app/erpPageRegistry";

import { Sidebar, SidebarContent } from "@/components/ui/sidebar";
import { useQuery } from "@tanstack/react-query";
import { useRef, useEffect, useMemo } from "react";
import { useCompany } from "@/contexts/CompanyContext";
import { useRecentNav } from "@/hooks/use-recent-nav";
import { Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { erpPageAccessQueryOptions } from "@/app/erpAccessQuery";
import { effectiveErpRole, ERP_PERSONAL_SETTINGS_HIDDEN_ROLES, ERP_RETAIL_HIDDEN_ROUTES, isErpNavigationItemVisible, isErpRetailHiddenPath } from "@shared/erpNavigationPolicy";
import { liveCountQueryPolicy, stableSettingsQueryPolicy } from "@/lib/queryPolicies";
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
export { ERP_NAV_SECTIONS, ERP_PINNED_ITEMS, ERP_UTILITY_ITEMS } from "@/app/erpPageRegistry";
const defaultPinnedItems = ERP_PINNED_ITEMS;
const utilityItems = ERP_UTILITY_ITEMS;


export const SETTINGS_HIDDEN_ROLES = ERP_PERSONAL_SETTINGS_HIDDEN_ROLES;

export const RETAIL_HIDDEN_ERP_ROUTES = ERP_RETAIL_HIDDEN_ROUTES;

/** Legacy export retained for mobile/command consumers; uses shared policy. */
export function isRetailHiddenErpPath(path: string): boolean {
  return isErpRetailHiddenPath(path);
}


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
    ...erpPageAccessQueryOptions(selectedCompany?.id, !!user),
  });

  const { data: companySettings } = useQuery<SidebarCompanySettings>({
    queryKey: companyQueryKey("/api/company-settings", selectedCompany?.id),
    ...stableSettingsQueryPolicy,
    enabled: !!selectedCompany?.id && (user?.currentRole ?? user?.role) !== "ERP Tester",
  });

  const role = effectiveErpRole(user);

  const isItemVisible = (item: NavItem): boolean =>
    isErpNavigationItemVisible({
      path: item.url,
      role,
      companyType: selectedCompany?.companyType,
      access: myErpPages,
      posExcelImportEnabled: companySettings?.posExcelImportEnabled,
    });

  const isDeveloper = role === "Developer";

  // Keep authorized standalone pages visible even when they also exist inside a hub.
  // A hub must be an additional navigation path, not a replacement for existing tabs.
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

export function AppSidebar({ user, onLogout }: { user?: SidebarUser; onLogout: () => void | Promise<void> }) {
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
  const recentItems = useRecentNav(allNavItems, selectedCompany?.id, isItemVisible);

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
    <Sidebar className="flex! premium-shell-sidebar">
      <ModuleHeader icon={Package} label="Business OS" tagline="ERP / Warehouse" accent={MODULE_ACCENT.erp} />

      <SidebarContent className="premium-nav-scroll px-3 py-2 overflow-y-auto">
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
            <p className="mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/50">
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
            <p className="mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/50">
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
          <SidebarFlatLink href="/help-training" icon={Book} label="Help & Training" testId="link-help-training" />
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
        onLogout={onLogout}
      />
    </Sidebar>
  );
}
