import {
  Landmark,
  FileText,
  BookOpen,
  Settings,
  Building2,
  Store,
  ClipboardList,
  ArrowLeftRight,
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
      { title: "Properties (Warehouses)", url: "/properties/rentals", icon: Building2 },
      { title: "Shops Rented", url: "/properties/rentals?tab=shops", icon: Store },
      { title: "Payments Log", url: "/properties/rentals?tab=payments", icon: ClipboardList },
      { title: "Cash Transfer", url: "/properties/transfer", icon: ArrowLeftRight },
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
    label: "Accounting Reconciliation",
    color: NAV_COLOR.accounting,
    items: [
      { title: "Open Items", url: "/properties/accounting/open-items", icon: ClipboardList },
      { title: "Bank & Cash Reconciliation", url: "/properties/accounting/cash-bank", icon: Landmark },
      { title: "Multi-Currency Accounting", url: "/properties/accounting/monetary-fx", icon: Landmark },
      { title: "Rental Accounting", url: "/properties/accounting/rentals", icon: ClipboardList },
      { title: "Intercompany & Consolidation", url: "/properties/accounting/consolidation", icon: Landmark },
      { title: "Historical Accounting", url: "/properties/accounting/history", icon: Clock },
      { title: "Financial Statements", url: "/properties/accounting/statements", icon: FileText },
      { title: "Fiscal Closing & Audit", url: "/properties/accounting/fiscal-review", icon: Landmark },
      { title: "Unified Accounting Dashboard", url: "/properties/accounting/dashboard", icon: Landmark },
      { title: "Unified Accounting Rollout", url: "/properties/accounting/rollout", icon: Landmark },
    ],
  },
];

const PROPERTIES_PINNED_DEFAULTS: NavItem[] = [
  { title: "Daybook", url: "/properties/daybook", icon: BookOpen },
  { title: "Agent Ledger", url: "/properties/agents", icon: UserRound },
];

export function PropertiesSidebar({ user, onLogout }: { user?: ShellUser; onLogout: () => void | Promise<void> }) {
  const isAdmin = user?.role === "Admin" || user?.role === "Developer";
  const isDeveloper = user?.role === "Developer";
  const visibleSections = useMemo(
    () =>
      PROPERTIES_NAV_SECTIONS.map((section) => ({
        ...section,
        items: section.items.filter(
          (item) =>
            (isDeveloper ||
              (item.url !== "/properties/accounting/open-items" &&
                item.url !== "/properties/accounting/cash-bank" &&
                item.url !== "/properties/accounting/monetary-fx" &&
                item.url !== "/properties/accounting/rentals" &&
                item.url !== "/properties/accounting/consolidation" &&
                item.url !== "/properties/accounting/history" &&
                item.url !== "/properties/accounting/statements" &&
                item.url !== "/properties/accounting/fiscal-review" &&
                item.url !== "/properties/accounting/dashboard" &&
                item.url !== "/properties/accounting/rollout"))
        ),
      })).filter((section) => section.items.length > 0),
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
