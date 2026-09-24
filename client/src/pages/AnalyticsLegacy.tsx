import { Fragment } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PeriodFilter } from "@/components/ui/period-filter";
import { PageHeader } from "@/components/PageHeader";

import { useAnalyticsLegacy } from "./analyticslegacy/useAnalyticsLegacy";
import { BalanceSectionsPanel } from "./analyticslegacy/components/BalanceSectionsPanel";
import { ExpenseSectionsPanel } from "./analyticslegacy/components/ExpenseSectionsPanel";
import { SalesSectionPanel } from "./analyticslegacy/components/SalesSectionPanel";
import { ContainersSectionPanel } from "./analyticslegacy/components/ContainersSectionPanel";
import { ReportsSectionPanel } from "./analyticslegacy/components/ReportsSectionPanel";

// Layout shell. State lives in useAnalyticsLegacy; each group of mutually
// exclusive `activeSection` blocks is its own panel component.
export default function Analytics() {
  const analytics = useAnalyticsLegacy();
  const { activeSection, periodFilter, setActiveSection, setPeriodFilter, sidebarGroups } = analytics;

  return (
    <div className="flex flex-col h-full md:flex-row">
      {/* ── Mobile section selector (shown only on small screens) ── */}
      <div className="md:hidden border-b bg-muted/30 py-2 shrink-0">
        <Select value={activeSection} onValueChange={setActiveSection}>
          <SelectTrigger className="w-full" data-testid="select-analytics-section">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sidebarGroups.map((group) => (
              <Fragment key={group.label}>
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {group.label}
                </div>
                {group.items.map((item) => (
                  <SelectItem key={item.key} value={item.key}>
                    {item.label}
                  </SelectItem>
                ))}
              </Fragment>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* ── Desktop left nav (hidden on mobile) ── */}
      <nav
        className="hidden md:block w-56 shrink-0 border-r bg-muted/30 p-3 space-y-4 overflow-y-auto"
        data-testid="tabs-analytics"
      >
        {sidebarGroups.map((group) => (
          <div key={group.label}>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-2 mb-1">
              {group.label}
            </p>
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                const isActive = activeSection === item.key;
                return (
                  <button
                    key={item.key}
                    onClick={() => setActiveSection(item.key)}
                    className={`flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-sm transition-colors ${isActive ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover-elevate"}`}
                    data-testid={`tab-${item.key}`}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="flex-1 overflow-y-auto space-y-4 pt-3 md:space-y-6 md:p-6">
        <PageHeader title="Analytics" subtitle="Comprehensive financial analysis and reporting">
          {activeSection !== "containers" && (
            <PeriodFilter value={periodFilter} onChange={setPeriodFilter} data-testid="analytics-period-filter" />
          )}
        </PageHeader>

        <BalanceSectionsPanel analytics={analytics} />
        <ExpenseSectionsPanel analytics={analytics} />
        <SalesSectionPanel analytics={analytics} />
        <ContainersSectionPanel analytics={analytics} />
        <ReportsSectionPanel analytics={analytics} />
      </div>
    </div>
  );
}
