import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/PageHeader";
import FactoryProformas from "@/pages/factory/FactoryProformas";
import FactoryInvoices from "@/pages/factory/FactoryInvoices";
import FactoryContainerLoadingScan from "@/pages/factory/FactoryContainerLoadingScan";
import FactoryPendingLoadings from "@/pages/factory/FactoryPendingLoadings";
import FactoryPriorityScan from "@/pages/factory/FactoryPriorityScan";
import { FileText, Truck } from "lucide-react";
import type { FactoryMyAccess } from "@shared/apiTypes";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { TabsList, PillTabButton } from "@/components/ui/tabs";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { translatePriorityScanText } from "@/i18n/priorityScanTranslations";

type InvoicingTab = "proformas" | "invoices" | "loadings" | "pending" | "priority";
type TabDef = { key: InvoicingTab; label: string };
const ALL_INVOICING_TABS: readonly InvoicingTab[] = ["proformas", "invoices", "loadings", "pending", "priority"];

export default function FactoryInvoicing() {
  const { selectedCompany } = useCompany();
  const { language } = useApplicationLanguage();
  const priorityScanLabel = translatePriorityScanText("priorityScan", language);

  const { data: myAccess } = useQuery<FactoryMyAccess>({ queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id), staleTime: 5 * 60000 });
  const hidden = myAccess?.companyId === selectedCompany?.id && myAccess?.hasFactoryAccess === true
    ? myAccess.hiddenCostFields
    : ["hide_invoicing_proformas_tab","hide_invoicing_invoices_tab","hide_invoicing_loadings_tab","hide_tab_loadings_pending"];

  const showProformas = !hidden.includes("hide_invoicing_proformas_tab");
  const showInvoices = !hidden.includes("hide_invoicing_invoices_tab");
  const showLoadings = !hidden.includes("hide_invoicing_loadings_tab");

  const { data: settings } = useQuery({
    queryKey: companyQueryKey("/api/factory/settings", selectedCompany?.id),
    queryFn: async () => {
      const r = await fetch("/api/factory/settings");
      return r.ok ? r.json() : {};
    },
    staleTime: 60000,
    enabled: showLoadings && Boolean(selectedCompany?.id),
  });
  const showPending =
    showLoadings && settings?.loadingsTabPendingEnabled !== false && !hidden.includes("hide_tab_loadings_pending");
  const showPriority = showPending;

  const allTabs: TabDef[] = [
    { key: "proformas", label: "Proformas" },
    { key: "invoices", label: "Invoices" },
    { key: "loadings", label: "Container Loadings" },
    { key: "pending", label: "Pending Loadings" },
    { key: "priority", label: priorityScanLabel },
  ];
  const tabs = allTabs.filter((tab) => {
    if (tab.key === "proformas") return showProformas;
    if (tab.key === "invoices") return showInvoices;
    if (tab.key === "loadings") return showLoadings;
    if (tab.key === "pending") return showPending;
    return showPriority;
  });

  const visibleTabKeys = tabs.map((tab) => tab.key);
  const [activeTab, setActiveTab] = useHubQueryState<InvoicingTab>({
    key: "tab",
    allowedValues: visibleTabKeys,
    knownValues: ALL_INVOICING_TABS,
    defaultValue: visibleTabKeys[0] ?? "invoices",
  });

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div
        className={
          activeTab === "pending"
            ? "shrink-0 border-b border-sky-200/60 bg-gradient-to-r from-slate-50 via-blue-50/80 to-violet-50/70 dark:border-sky-800/50 dark:from-[hsl(var(--factory-hue)_63%_12%)] dark:via-[hsl(var(--factory-hue)_67%_15%)] dark:to-[hsl(var(--factory-hue)_44%_20%)]"
            : "shrink-0 border-b border-border/70 bg-background"
        }
      >
        <div
          className={
            activeTab === "invoices"
              ? "mx-3 mt-2 rounded-2xl border border-blue-500/20 bg-gradient-to-r from-emerald-500/[0.08] via-blue-500/[0.07] to-violet-500/[0.08] px-3 pt-3 dark:from-[hsl(var(--factory-hue)_64%_12%)] dark:via-[hsl(var(--factory-hue)_62%_14%)] dark:to-[hsl(var(--factory-hue)_36%_16%)] sm:mx-4 sm:px-4"
              : activeTab === "proformas"
                ? "mx-3 mt-2 rounded-2xl border border-violet-500/20 bg-gradient-to-r from-violet-500/[0.09] via-indigo-500/[0.06] to-fuchsia-500/[0.08] px-3 pt-3 dark:from-[hsl(var(--factory-hue)_43%_15%)] dark:via-[hsl(var(--factory-hue)_54%_14%)] dark:to-[hsl(var(--factory-hue)_51%_16%)] sm:mx-4 sm:px-4"
                : activeTab === "pending"
                  ? "mx-3 mt-2 rounded-2xl border border-blue-500/20 bg-gradient-to-r from-sky-500/[0.08] via-blue-500/[0.08] to-violet-500/[0.08] px-3 pt-3 dark:from-[hsl(var(--factory-hue)_76%_18%)] dark:via-[hsl(var(--factory-hue)_69%_15%)] dark:to-[hsl(var(--factory-hue)_41%_21%)] sm:mx-4 sm:px-4"
                  : "px-4 pt-3"
          }
        >
          <div className="[&>header]:mb-0 [&>header]:border-b-0 [&>header]:pb-3">
            <PageHeader
              title="Invoicing"
              subtitle="Manage proformas, invoices and container shipments"
              icon={
                activeTab === "invoices" ? (
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-lg shadow-emerald-500/15">
                    <FileText className="h-6 w-6" />
                  </span>
                ) : activeTab === "proformas" ? (
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-lg shadow-violet-500/20">
                    <FileText className="h-6 w-6" />
                  </span>
                ) : activeTab === "pending" ? (
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500 to-blue-700 text-white shadow-lg shadow-blue-500/20">
                    <Truck className="h-6 w-6" />
                  </span>
                ) : (
                  <FileText className="h-5 w-5" />
                )
              }
              showBackButton={false}
            />
          </div>
        </div>
        <div className="erp-mobile-scroll-tabs px-4 pb-2">
          <TabsList className="w-max min-w-full sm:min-w-0 sm:w-fit" aria-label="Factory sections">
            {tabs.map((tab) => {
              const isActive = activeTab === tab.key;
              return (
                <PillTabButton
                  key={tab.key}
                  selected={isActive}
                  className={
                    isActive && activeTab === "pending"
                      ? "bg-blue-600 font-semibold text-white shadow-md shadow-blue-500/20 hover:bg-blue-500 hover:text-white dark:bg-blue-600 dark:text-white"
                      : undefined
                  }
                  data-testid={`tab-${tab.key}`}
                  onClick={() => setActiveTab(tab.key)}
                >
                  {tab.label}
                </PillTabButton>
              );
            })}
          </TabsList>
        </div>
      </div>

      <div className="flex-1 overflow-auto min-h-0">
        {tabs.length === 0 && (
          <div className="p-6 text-sm text-muted-foreground">No Invoicing tabs are available for this user.</div>
        )}
        {activeTab === "proformas" && showProformas && <FactoryProformas />}
        {activeTab === "invoices" && showInvoices && <FactoryInvoices />}
        {activeTab === "loadings" && showLoadings && <FactoryContainerLoadingScan />}
        {activeTab === "pending" && showPending && <FactoryPendingLoadings />}
        {activeTab === "priority" && showPriority && <FactoryPriorityScan />}
      </div>
    </div>
  );
}
