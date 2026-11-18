/**
 * Factory Daybook page shell, on the shared Daybook frame (header, export menu,
 * tabs in `?tab=`, filter bar, results table and states).
 *
 * The page keeps its original route/import path and default export; everything
 * it used to hold inline lives under ./daybook — the controller hook (state,
 * queries, mutations, filters, exports), the filter bar, the condensed table
 * and the dialog stack. This file is only composition.
 */
import { useQuery } from "@tanstack/react-query";
import { RestrictedTabsState } from "@/components/RestrictedTabsState";
import { DaybookHeader, DaybookPage, DaybookTabs } from "@/components/daybook/DaybookFrame";
import { useDaybookTab, type DaybookTab } from "@/components/daybook/useDaybookTab";
import { LoadingState } from "@/components/ui/page-state";
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
  const { data: myAccess } = useQuery<FactoryMyAccess>({
    queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    staleTime: 5 * 60000,
  });
  const accessReady = myAccess?.companyId === selectedCompany?.id;
  const hiddenTabs =
    accessReady && myAccess?.hasFactoryAccess === true
      ? myAccess.hiddenCostFields
      : ["hide_tab_daybook_transactions", "hide_tab_daybook_activity"];
  const showTransactions = !hiddenTabs.includes("hide_tab_daybook_transactions");
  const showActivity = !hiddenTabs.includes("hide_tab_daybook_activity");
  const visibleTabs: DaybookTab[] = [
    ...(showTransactions ? (["transactions"] as const) : []),
    ...(showActivity ? (["activity"] as const) : []),
  ];
  // Until access loads, a deep-linked ?tab= is kept instead of being stripped.
  const [activeTab, setActiveTab] = useDaybookTab(visibleTabs, accessReady);
  const effectiveTab = visibleTabs.includes(activeTab) ? activeTab : visibleTabs[0];

  return (
    <DaybookPage className="pb-6">
      <DaybookHeader
        title="Factory Daybook"
        subtitle="All factory transactions in one view"
        exportBusy={model.isExportingDetailed}
        exportDisabled={model.filteredEntries.length === 0}
        exportOptions={
          showTransactions
            ? [
                { id: "daybook-summary", label: "Summary", kind: "excel", onSelect: model.handleExportToExcel },
                {
                  id: "daybook-detail",
                  label: "Detailed",
                  kind: "excel",
                  onSelect: model.handleExportDetailedToExcel,
                },
              ]
            : undefined
        }
      />

      {!accessReady ? (
        <LoadingState data-testid="factory-daybook-access-loading" />
      ) : !effectiveTab ? (
        <RestrictedTabsState />
      ) : (
        <DaybookTabs
          value={effectiveTab}
          onValueChange={setActiveTab}
          tabs={visibleTabs}
          label="Factory daybook sections"
        >
          <FactoryDaybookFilters model={model} />
          <FactoryDaybookTable model={model} />
          <FactoryDaybookDialogs model={model} />
        </DaybookTabs>
      )}

      {model.AdminDialog}
    </DaybookPage>
  );
}
