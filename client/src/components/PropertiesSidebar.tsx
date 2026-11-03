import {
  Landmark,
  FileText,
  BookOpen,
  Settings,
  Building2,
  ClipboardList,
  KeyRound,
  BarChart2,
  UserRound,
} from "lucide-react";
import { Sidebar, SidebarContent } from "@/components/ui/sidebar";
import { useMemo } from "react";
import { useRecentNav } from "@/hooks/use-recent-nav";
import { useCompany } from "@/contexts/CompanyContext";
import { Clock } from "lucide-react";
import type { ShellUser } from "@/app/shellUser";
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

export const PROPERTIES_NAV_SECTIONS: NavSection[] = [
  {
    label: "Rentals",
    color: NAV_COLOR.finance,
    items: [
      // The Rentals hub already has Warehouses, Shops and Payments tabs.
      // Keep those views reachable inside the hub, without 3 sidebar copies.
      { title: "Rentals", url: "/properties/rentals", icon: Building2 },
    ],
  },
  {
    label: "Accounting",
    color: NAV_COLOR.accounting,
    items: [
      { title: "Accounts", url: "/properties/accounts", icon: Landmark },
      { title: "Vouchers", url: "/properties/vouchers", icon: FileText },
      { title: "Analytics", url: "/properties/analytics", icon: BarChart2 },
    ],
  },
  {
    label: "Accounting Tools",
    color: NAV_COLOR.accounting,
    items: [{ title: "Accounting Toolbox", url: "/properties/accounting/toolbox", icon: ClipboardList }],
  },
];

/** One visibility policy for Properties sidebar and command search.
 * These routes are only registered for Developer in PropertiesRoutes.
 */
export function getPropertiesVisibleNavSections(isDeveloper: boolean): NavSection[] {
  return PROPERTIES_NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter(
      (item) =>
        isDeveloper || !item.url.startsWith("/properties/accounting/")
    ),
  })).filter((section) => section.items.length > 0);
}

const PROPERTIES_PINNED_DEFAULTS: NavItem[] = [
  { title: "Daybook", url: "/properties/daybook", icon: BookOpen },
  { title: "Agent Ledger", url: "/properties/agents", icon: UserRound },
];

export function PropertiesSidebar({ user, onLogout }: { user?: ShellUser; onLogout: () => void | Promise<void> }) {
  const isAdmin = user?.role === "Admin" || user?.role === "Developer";
  const isDeveloper = user?.role === "Developer";
  const visibleSections = useMemo(() => getPropertiesVisibleNavSections(isDeveloper), [isDeveloper]);

  const { items: pinnedItems, reorder: reorderPinned } = usePinnedOrder(
    "properties-pinned-order",
    PROPERTIES_PINNED_DEFAULTS
  );

  const { openSections, toggleSection } = useOpenSections(visibleSections, {
    defaultFirstWhenNoneActive: true,
  });

  const allNavItems = useMemo(
    () => [...PROPERTIES_PINNED_DEFAULTS, ...visibleSections.flatMap((s) => s.items)],
    [visibleSections]
  );
  const { selectedCompany } = useCompany();
  const recentItems = useRecentNav(allNavItems, selectedCompany?.id);

  const testIdFor = (i: NavItem) => `link-properties-${i.url.split("/").pop()}`;

  return (
    <Sidebar>
      <ModuleHeader
        icon={Building2}
        label="Business OS"
        tagline="Properties / Rentals"
        accent={MODULE_ACCENT.properties}
      />

      <SidebarContent className="px-3 py-2 overflow-y-auto">
        <PinnedNavList items={pinnedItems} color={NAV_COLOR.pinned} onReorder={reorderPinned} testIdFor={testIdFor} />

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
                  testId={`link-props-recent-${item.url.replace(/\//g, "-")}`}
                />
              ))}
            </div>
          </div>
        )}

        <div className="mt-4 pt-3 border-t border-sidebar-border/60 space-y-0.5">
          {user?.role !== "ERP Tester" && (
            <SidebarFlatLink
              href="/properties/my-settings"
              icon={KeyRound}
              label="My Settings"
              testId="link-properties-my-settings"
            />
          )}
          {isAdmin && (
            <SidebarFlatLink
              href="/properties/settings"
              icon={Settings}
              label="Settings"
              testId="link-properties-settings"
            />
          )}
        </div>
      </SidebarContent>

      <ModuleFooter user={user} accent={MODULE_ACCENT.properties} onLogout={onLogout} />
    </Sidebar>
  );
}
