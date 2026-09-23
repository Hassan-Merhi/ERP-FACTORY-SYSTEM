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
import { ChevronDown, FileDown } from "lucide-react";
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

export default function FactoryDaybook() {
  const model = useFactoryDaybookModel();
  const { data: myAccess } = useQuery<FactoryMyAccess>({
    queryKey: ["/api/factory/my-access"],
    staleTime: 5 * 60000,
  });
  const hiddenTabs = myAccess?.hiddenCostFields ?? [];
  const showTransactions = !hiddenTabs.includes("hide_tab_daybook_transactions");
  const showActivity = !hiddenTabs.includes("hide_tab_daybook_activity");
  const visibleTabs = [
    showTransactions ? "transactions" : null,
    showActivity ? "activity" : null,
  ].filter((value): value is "transactions" | "activity" => value !== null);
  const effectiveTab = visibleTabs.includes(model.activeDaybookTab) ? model.activeDaybookTab : visibleTabs[0];

  useEffect(() => {
    if (effectiveTab && model.activeDaybookTab !== effectiveTab) {
      model.setActiveDaybookTab(effectiveTab);
    }
  }, [effectiveTab, model.activeDaybookTab, model.setActiveDaybookTab]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <PageHeader title="Factory Daybook" subtitle="All factory transactions in one view" />
        </div>
        {showTransactions && <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              disabled={model.filteredEntries.length === 0 || model.isExportingDetailed}
              data-testid="button-export-excel"
              className="gap-2"
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
        </DropdownMenu>}
      </div>

      {/* Tab selector: Transactions / Edits & Activity */}
      {visibleTabs.length === 0 ? (
        <div className="rounded-md border p-6 text-sm text-muted-foreground">
          No Daybook tabs are available for this user.
        </div>
      ) : (
        <Tabs
          value={effectiveTab}
          onValueChange={(value) => model.setActiveDaybookTab(value as "transactions" | "activity")}
        >
          <TabsList className="w-fit">
            {showTransactions && <TabsTrigger value="transactions">Transactions</TabsTrigger>}
            {showActivity && <TabsTrigger value="activity">Edits &amp; Activity</TabsTrigger>}
          </TabsList>

          {showTransactions && (
            <TabsContent value="transactions" className="space-y-4 mt-2">
              <FactoryDaybookFilters model={model} />
              <FactoryDaybookTable model={model} />
              <FactoryDaybookDialogs model={model} />
            </TabsContent>
          )}

          {showActivity && (
            <TabsContent value="activity" className="mt-2">
              {effectiveTab === "activity" && <AuditLog context="daybook" defaultActions="all" />}
            </TabsContent>
          )}
        </Tabs>
      )}

      {model.AdminDialog}
    </div>
  );
}
