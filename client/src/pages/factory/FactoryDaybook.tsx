/**
 * Factory Daybook page shell.
 *
 * The page keeps its original route/import path and default export; everything
 * it used to hold inline now lives under ./daybook — the controller hook
 * (state, queries, mutations, filters, exports), the filter bar, the condensed
 * table and the dialog stack. This file is only composition.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { AuditLog } from "@/pages/settings/AuditLog";
import { PageHeader } from "@/components/PageHeader";
import { BookOpen, ChevronDown, ClipboardList, FileDown, History } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useFactoryDaybookModel } from "./daybook/useFactoryDaybookModel";
import { FactoryDaybookFilters } from "./daybook/FactoryDaybookFilters";
import { FactoryDaybookTable } from "./daybook/FactoryDaybookTable";
import { FactoryDaybookDialogs } from "./daybook/FactoryDaybookDialogs";
import type { FactoryMyAccess } from "@shared/apiTypes";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";

export default function FactoryDaybook() {
  const { selectedCompany } = useCompany();
  const model = useFactoryDaybookModel();
  const { activeDaybookTab, setActiveDaybookTab } = model;
  const { data: myAccess } = useQuery<FactoryMyAccess>({
    queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    staleTime: 5 * 60000,
  });
  const hiddenTabs = myAccess?.companyId === selectedCompany?.id && myAccess?.hasFactoryAccess === true
    ? myAccess.hiddenCostFields
    : ["hide_tab_daybook_transactions","hide_tab_daybook_activity"];
  const showTransactions = !hiddenTabs.includes("hide_tab_daybook_transactions");
  const showActivity = !hiddenTabs.includes("hide_tab_daybook_activity");
  const visibleTabs = [showTransactions ? "transactions" : null, showActivity ? "activity" : null].filter(
    (value): value is "transactions" | "activity" => value !== null
  );
  const effectiveTab = visibleTabs.includes(activeDaybookTab) ? activeDaybookTab : visibleTabs[0];

  useEffect(() => {
    if (effectiveTab && activeDaybookTab !== effectiveTab) {
      setActiveDaybookTab(effectiveTab);
    }
  }, [activeDaybookTab, effectiveTab, setActiveDaybookTab]);

  return (
    <div className="space-y-5 pb-6">
      {/* Visual-only header: accounting, permissions and exports remain owned by the existing model. */}
      <div className="relative isolate overflow-hidden rounded-2xl border border-sky-200/70 bg-gradient-to-br from-white via-slate-50 to-sky-50/80 p-4 shadow-sm dark:border-blue-500/20 dark:from-slate-950 dark:via-slate-900 dark:to-blue-950/50 sm:p-6">
        <div aria-hidden="true" className="pointer-events-none absolute right-0 top-0 h-full w-1/2 bg-[radial-gradient(ellipse_at_top_right,hsl(var(--factory-hue)_83%_53%_/_0.14),transparent_75%)] dark:bg-[radial-gradient(ellipse_at_top_right,hsl(var(--factory-hue)_83%_53%_/_0.22),transparent_75%)]" />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <PageHeader title="Factory Daybook" subtitle="All factory transactions in one view" icon={<BookOpen className="h-5 w-5 text-blue-600 dark:text-sky-400" />} />
          </div>
        {showTransactions && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                disabled={model.filteredEntries.length === 0 || model.isExportingDetailed}
                data-testid="button-export-excel"
                className="h-10 gap-2 rounded-xl border-sky-200 bg-white/75 px-4 shadow-sm hover:bg-sky-50 dark:border-blue-500/30 dark:bg-slate-900/75 dark:hover:bg-slate-800"
              >
                <FileDown className="w-4 h-4" />
                {model.isExportingDetailed ? "Exporting..." : "Export"}
                <ChevronDown className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={model.handleExportToExcel} data-testid="export-simple">
                Summary Export
              </DropdownMenuItem>
              <DropdownMenuItem onClick={model.handleExportDetailedToExcel} data-testid="export-detailed">
                Detailed Export (with entries)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        </div>
      </div>

      {/* Tab selector: Transactions / Edits & Activity */}
      {visibleTabs.length === 0 ? (
        <div className="rounded-xl border border-border/70 bg-card p-6 text-sm text-muted-foreground">
          No Daybook tabs are available for this user.
        </div>
      ) : (
        <Tabs value={effectiveTab} onValueChange={(value) => setActiveDaybookTab(value as "transactions" | "activity")}>
          <div className="erp-mobile-scroll-tabs pb-1">
            <TabsList className="h-auto w-max min-w-full gap-1 rounded-xl border border-border/60 bg-muted/50 p-1 shadow-sm sm:min-w-0 sm:w-fit dark:bg-slate-900/80" aria-label="Factory daybook sections">
              {showTransactions && (
                <TabsTrigger value="transactions" className="gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold data-[state=active]:bg-blue-600 data-[state=active]:text-white data-[state=active]:shadow-md dark:data-[state=active]:bg-blue-600 dark:data-[state=active]:text-white">
                  <ClipboardList className="h-4 w-4" aria-hidden="true" />
                  Transactions
                </TabsTrigger>
              )}
              {showActivity && (
                <TabsTrigger value="activity" className="gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold data-[state=active]:bg-blue-600 data-[state=active]:text-white data-[state=active]:shadow-md dark:data-[state=active]:bg-blue-600 dark:data-[state=active]:text-white">
                  <History className="h-4 w-4" aria-hidden="true" />
                  Edits &amp; Activity
                </TabsTrigger>
              )}
            </TabsList>
          </div>

          {showTransactions && (
            <TabsContent value="transactions" className="mt-3 space-y-4">
              <FactoryDaybookFilters model={model} />
              <FactoryDaybookTable model={model} />
              <FactoryDaybookDialogs model={model} />
            </TabsContent>
          )}

          {showActivity && (
            <TabsContent value="activity" className="mt-3">
              {effectiveTab === "activity" && <AuditLog context="daybook" defaultActions="all" />}
            </TabsContent>
          )}
        </Tabs>
      )}

      {model.AdminDialog}
    </div>
  );
}
