import { useQuery } from "@tanstack/react-query";
import FactoryProformas from "@/pages/factory/FactoryProformas";
import FactoryInvoices from "@/pages/factory/FactoryInvoices";
import FactoryContainerLoadingScan from "@/pages/factory/FactoryContainerLoadingScan";
import FactoryPendingLoadings from "@/pages/factory/FactoryPendingLoadings";
import { FileText } from "lucide-react";
import type { FactoryMyAccess } from "@shared/apiTypes";
import { useHubQueryState } from "@/hooks/use-hub-query-state";

type InvoicingTab = "proformas" | "invoices" | "loadings" | "pending";
type TabDef = { key: InvoicingTab; label: string };
const ALL_INVOICING_TABS: readonly InvoicingTab[] = ["proformas", "invoices", "loadings", "pending"];

export default function FactoryInvoicing() {

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

  const allTabs: TabDef[] = [
    { key: "proformas", label: "Proformas" },
    { key: "invoices", label: "Invoices" },
    { key: "loadings", label: "Container Loadings" },
    { key: "pending", label: "Pending Loadings" },
  ];
  const tabs = allTabs.filter((tab) => {
    if (tab.key === "proformas") return showProformas;
    if (tab.key === "invoices") return showInvoices;
    if (tab.key === "loadings") return showLoadings;
    return showPending;
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
        <div className="flex items-center gap-3 px-5 pt-4 pb-3">
          <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <FileText className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h1 className="text-base font-semibold leading-tight">Invoicing</h1>
            <p className="text-xs text-muted-foreground">Proformas, invoices and container loadings</p>
          </div>
        </div>

        <div className="flex gap-0 px-4" role="tablist">
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
      </div>
    </div>
  );
}
