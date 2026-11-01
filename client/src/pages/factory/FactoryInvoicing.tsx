import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/PageHeader";
import FactoryProformas from "@/pages/factory/FactoryProformas";
import FactoryInvoices from "@/pages/factory/FactoryInvoices";
import FactoryContainerLoadingScan from "@/pages/factory/FactoryContainerLoadingScan";
import FactoryPendingLoadings from "@/pages/factory/FactoryPendingLoadings";
import FactoryPriorityScan from "@/pages/factory/FactoryPriorityScan";
import { FileText, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocation } from "wouter";
import type { AuthMe } from "@shared/apiTypes";
import type { FactoryMyAccess } from "@shared/apiTypes";
import { TabsList, PillTabButton } from "@/components/ui/tabs";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { translatePriorityScanText } from "@/i18n/priorityScanTranslations";

type InvoicingTab = "proformas" | "invoices" | "loadings" | "pending" | "priority";
type TabDef = { key: InvoicingTab; label: string };
const ALL_INVOICING_TABS: readonly InvoicingTab[] = ["proformas", "invoices", "loadings", "pending", "priority"];

export default function FactoryInvoicing() {
  const [, navigate] = useLocation();
  const { data: authUser } = useQuery<AuthMe>({ queryKey: ["/api/auth/me"], staleTime: 5 * 60000 });
  const role = String(authUser?.currentRole || authUser?.role || "").toLowerCase();
  const canOpenNewInvoice = !!role && role !== "view only";
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
      <div className="shrink-0 border-b border-border/70 bg-background">
        <div className={activeTab === "invoices"
          ? "mx-3 mt-2 rounded-2xl border border-blue-500/20 bg-gradient-to-r from-emerald-500/[0.08] via-blue-500/[0.07] to-violet-500/[0.08] px-3 pt-3 dark:from-[#0b2b32] dark:via-[#0d2038] dark:to-[#1b1c39] sm:mx-4 sm:px-4"
          : "px-4 pt-3"}>
          <div className="[&>header]:mb-0 [&>header]:border-b-0 [&>header]:pb-3">
            <PageHeader
              title="Invoicing"
              subtitle="Manage proformas, invoices and container shipments"
              icon={activeTab === "invoices"
                ? <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-lg shadow-emerald-500/15"><FileText className="h-6 w-6" /></span>
                : <FileText className="h-5 w-5" />}
              showBackButton={false}
            >
              {activeTab === "invoices" && canOpenNewInvoice && (
                <Button
                  size="sm"
                  className="h-9 rounded-xl bg-blue-600 px-4 font-semibold text-white hover:bg-blue-500"
                  onClick={() => navigate("/factory/sales/new")}
                  data-testid="button-invoicing-new-invoice"
                >
                  <Plus className="mr-1.5 h-4 w-4" /> New Invoice
                </Button>
              )}
            </PageHeader>
          </div>
        </div>
        <div className="erp-mobile-scroll-tabs px-4 pb-1">
          <TabsList className="w-max min-w-full sm:min-w-0 sm:w-fit" aria-label="Factory sections">
            {tabs.map((tab) => {
              const isActive = activeTab === tab.key;
              return (
                <PillTabButton
                  key={tab.key}
                  selected={isActive}
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
