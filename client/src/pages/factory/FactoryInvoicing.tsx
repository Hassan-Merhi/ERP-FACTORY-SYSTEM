import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/PageHeader";
import FactoryProformas from "@/pages/factory/FactoryProformas";
import FactoryInvoices from "@/pages/factory/FactoryInvoices";
import FactoryContainerLoadingScan from "@/pages/factory/FactoryContainerLoadingScan";
import FactoryPendingLoadings from "@/pages/factory/FactoryPendingLoadings";
import FactoryPriorityScan from "@/pages/factory/FactoryPriorityScan";
import { FileText } from "lucide-react";
import type { FactoryMyAccess } from "@shared/apiTypes";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { translatePriorityScanText } from "@/i18n/priorityScanTranslations";

type InvoicingTab = "proformas" | "invoices" | "loadings" | "pending" | "priority";
type TabDef = { key: InvoicingTab; label: string };
const ALL_INVOICING_TABS: readonly InvoicingTab[] = ["proformas", "invoices", "loadings", "pending", "priority"];

export default function FactoryInvoicing() {
  const { language } = useApplicationLanguage();
  const priorityScanLabel = translatePriorityScanText("priorityScan", language);

  const { data: myAccess } = useQuery<FactoryMyAccess>({ queryKey: ["/api/factory/my-access"], staleTime: 5 * 60000 });
  const hidden: string[] = myAccess?.hiddenCostFields ?? [];

  const showProformas = !hidden.includes("hide_invoicing_proformas_tab");
  const showInvoices = !hidden.includes("hide_invoicing_invoices_tab");
  const showLoadings = !hidden.includes("hide_invoicing_loadings_tab");

  const { data: settings } = useQuery({
    queryKey: ["/api/factory/settings"],
    queryFn: async () => {
      const r = await fetch("/api/factory/settings");
      return r.ok ? r.json() : {};
    },
    staleTime: 60000,
    enabled: showLoadings,
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
      <div className="border-b bg-background shrink-0">
        {/* Shared page-header grammar (accent bar, icon, subtitle) like the ERP and Properties pages. */}
        <div className="px-4 pt-3 [&>header]:mb-0 [&>header]:border-b-0 [&>header]:pb-2">
          <PageHeader
            title="Invoicing"
            subtitle="Proformas, invoices and container loadings"
            icon={<FileText className="h-5 w-5" />}
            showBackButton={false}
          />
        </div>

        <div className="flex gap-0 px-4 overflow-x-auto" role="tablist">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                role="tab"
                aria-selected={isActive}
                data-testid={`tab-${tab.key}`}
                onClick={() => setActiveTab(tab.key)}
                className={[
                  "px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap",
                  isActive
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                ].join(" ")}
              >
                {tab.label}
              </button>
            );
          })}
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
