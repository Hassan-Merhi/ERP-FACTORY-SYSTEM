import {
  Factory,
  BookOpen,
  FileText,
  Settings,
  MessageCircle,
  AlertTriangle,
  TableProperties,
  KeyRound,
} from "lucide-react";
import { Sidebar, SidebarContent } from "@/components/ui/sidebar";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { liveCountQueryPolicy } from "@/lib/queryPolicies";
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
} from "@/components/sidebar/sidebarPrimitives";
import { FACTORY_PINNED_PAGES } from "@/app/factoryAccessRegistry";
import {
  FACTORY_NAV_ICONS,
  FACTORY_NAV_SECTIONS,
  useFactoryVisibleSections,
  type FactorySidebarUser,
} from "./useFactoryVisibleSections";
export {
  FACTORY_NAV_SECTIONS,
  collapseFactorySalesDispatchNav,
  useFactoryVisibleSections,
} from "./useFactoryVisibleSections";

const FACTORY_PINNED_DEFAULTS: NavItem[] = FACTORY_PINNED_PAGES.map((page) => ({
  title: page.label,
  url: page.route,
  icon: FACTORY_NAV_ICONS[page.key] ?? FileText,
}));

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

  const { sections: visibleSections, isPinnedVisible, isAdmin, isDeveloper } = useFactoryVisibleSections(user);

  const { openSections, toggleSection } = useOpenSections(visibleSections);

  const allNavItems = useMemo(() => [...FACTORY_PINNED_DEFAULTS, ...FACTORY_NAV_SECTIONS.flatMap((s) => s.items)], []);
  const recentItems = useRecentNav(allNavItems, selectedCompany?.id, isPinnedVisible);
  const visibleRecentItems = recentItems.filter(isPinnedVisible);
  const conflictsVisible = isPinnedVisible({ url: "/factory/conflicts" });

  const testIdFor = (i: NavItem) => `link-factory-${i.url.split("/").pop()}`;

  return (
    <Sidebar className="premium-shell-sidebar">
      <ModuleHeader icon={Factory} label="Business OS" tagline="Factory / Production" accent={MODULE_ACCENT.factory} />

      <SidebarContent className="premium-nav-scroll px-3 py-2 overflow-y-auto">
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
            <p className="mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/50">
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
          <SidebarFlatLink
            href="/factory/help-training"
            icon={BookOpen}
            label="Help & Training"
            testId="link-factory-help-training"
          />
          {isDeveloper && (
            <SidebarFlatLink
              href="/factory/accounting/toolbox"
              icon={FileText}
              label="Accounting Toolbox"
              color={NAV_COLOR.accounting}
              testId="link-factory-accounting-toolbox"
            />
          )}
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
          {!["Admin", "Developer", "ERP Tester"].includes(user?.role ?? "") && (
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
