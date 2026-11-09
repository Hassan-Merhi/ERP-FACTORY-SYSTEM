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
import { Clock, LifeBuoy } from "lucide-react";
import type { ShellUser } from "@/app/shellUser";
import { canUsePropertiesCapability, canNavigateProperties, PROPERTIES_NAVIGATION } from "@/properties/config/propertiesNavigation";
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
    items: section.items.filter((item) => canNavigateProperties(item.url, { role: isDeveloper ? "Developer" : "User" }, null)),
  })).filter((section) => section.items.length > 0);
}

// Stable route-keyed icons avoid silently changing icons if the manifest order
// changes. Labels, URLs and visibility still come from the canonical registry.
const pinnedIconsByPath = {
  "/properties/daybook": BookOpen,
  "/properties/agents": UserRound,
  "/properties/rentals": Building2,
  "/properties/accounts": Landmark,
  "/properties/vouchers": FileText,
  "/properties/analytics": BarChart2,
} as const;
export const PROPERTIES_PINNED_DEFAULTS: NavItem[] = PROPERTIES_NAVIGATION
  .filter((entry) => entry.navigation === "pinned")
  .map((entry) => ({
    title: entry.label,
    url: entry.path,
    icon: pinnedIconsByPath[entry.path as keyof typeof pinnedIconsByPath] ?? Building2,
  }));

export function PropertiesSidebar({ user, onLogout }: { user?: ShellUser; onLogout: () => void | Promise<void> }) {
  const { selectedCompany } = useCompany();
  const isAdmin = canUsePropertiesCapability("admin", user, selectedCompany);
  const isDeveloper = canUsePropertiesCapability("developer", user, selectedCompany);
  const canOpenPersonalSettings = canUsePropertiesCapability("personal", user, selectedCompany);
  // These pages are pinned at the top and should not also appear in
  // collapsible sections. Keep the registry entries for command search.
  const visibleSections = useMemo(
    () =>
      getPropertiesVisibleNavSections(isDeveloper).filter(
        (section) => !["Rentals", "Accounting"].includes(section.label)
      ),
    [isDeveloper]
  );

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
  const recentItems = useRecentNav(allNavItems.filter((item) => canNavigateProperties(item.url, user, selectedCompany)), selectedCompany?.id);

  const testIdFor = (i: NavItem) => `link-properties-${i.url.split("/").pop()}`;

  return (
    <Sidebar className="premium-shell-sidebar">
      <ModuleHeader
        icon={Building2}
        label="Business OS"
        tagline="Properties / Rentals"
        accent={MODULE_ACCENT.properties}
      />

      <SidebarContent className="premium-nav-scroll px-3 py-2 overflow-y-auto">
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
          <SidebarFlatLink
            href="/properties/help-training"
            icon={LifeBuoy}
            label="Help & Training"
            testId="link-properties-help-training"
          />
          {canOpenPersonalSettings && (
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
