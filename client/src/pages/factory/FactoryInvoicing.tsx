import { useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import FactoryProformas from "@/pages/factory/FactoryProformas";
import FactoryInvoices from "@/pages/factory/FactoryInvoices";
import FactoryContainerLoadingScan from "@/pages/factory/FactoryContainerLoadingScan";
import FactoryPendingLoadings from "@/pages/factory/FactoryPendingLoadings";
import { FileText } from "lucide-react";
import type { AuthMe, FactoryMyAccess, ApiListRow } from "@shared/apiTypes";

type InvoicingTab = "proformas" | "invoices" | "loadings" | "pending";

export default function FactoryInvoicing() {
  const [, navigate] = useLocation();
  const search = useSearch();

  const { data: myAccess } = useQuery<FactoryMyAccess>({ queryKey: ["/api/factory/my-access"], staleTime: 5 * 60000 });
  const hidden: string[] = myAccess?.hiddenCostFields ?? [];

  // ── Proformas tab access (existing restriction) ──────────────────────────
  const hideProformasTab = hidden.includes("hide_invoicing_proformas_tab");

  // ── Loadings tab access — mirrors the sidebar pageKeys guard ─────────────
  // A user with restricted pageKeys loses the loadings tab if their allowed
  // list doesn't include "factory/sales/loadings" (same key the sidebar uses).
  const hasLoadingsAccess =
    !myAccess ||
    myAccess.fullAccess ||
    !(myAccess.pageKeys?.length > 0) ||
    myAccess.pageKeys.includes("factory/sales/loadings");

  // ── Pending loadings — mirrors FactoryLoadingsHub restrictions ───────────
  const { data: settings } = useQuery({
    queryKey: ["/api/factory/settings"],
    queryFn: async () => {
      const r = await fetch("/api/factory/settings");
      return r.ok ? r.json() : {};
    },
    staleTime: 60000,
    enabled: hasLoadingsAccess,
  });
  const showPending =
    hasLoadingsAccess &&
    settings?.loadingsTabPendingEnabled !== false &&
    !hidden.includes("hide_tab_loadings_pending");

  // ── Active tab from URL ?tab= param ─────────────────────────────────────
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const rawTab = params.get("tab");

  function resolveTab(t: string | null): InvoicingTab {
    if (t === "invoices") return "invoices";
    if (t === "loadings" && hasLoadingsAccess) return "loadings";
    if (t === "pending" && showPending) return "pending";
    if (t === "proformas" && !hideProformasTab) return "proformas";
    // Default: first visible tab
    if (!hideProformasTab) return "proformas";
    return "invoices";
  }

  const activeTab = resolveTab(rawTab);
  const goTo = (tab: InvoicingTab) => navigate(`/factory/invoicing?tab=${tab}`);

  // ── Build visible tab list ────────────────────────────────────────────────
  type TabDef = { key: InvoicingTab; label: string };
  const allTabs: TabDef[] = [
    { key: "proformas",  label: "Proformas" },
    { key: "invoices",   label: "Invoices" },
    { key: "loadings",   label: "Container Loadings" },
    { key: "pending",    label: "Pending Loadings" },
  ];
  const tabs = allTabs.filter((t) => {
    if (t.key === "proformas") return !hideProformasTab;
    if (t.key === "loadings")  return hasLoadingsAccess;
    if (t.key === "pending")   return showPending;
    return true; // invoices always visible
  });

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="border-b bg-background shrink-0">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 pt-4 pb-3">
          <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <FileText className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h1 className="text-base font-semibold leading-tight">Invoicing</h1>
            <p className="text-xs text-muted-foreground">Proformas, invoices and container loadings</p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-0 px-4" role="tablist">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                role="tab"
                aria-selected={isActive}
                data-testid={`tab-${tab.key}`}
                onClick={() => goTo(tab.key)}
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

      {/* Content */}
      <div className="flex-1 overflow-auto min-h-0">
        {activeTab === "proformas" && !hideProformasTab && <FactoryProformas />}
        {activeTab === "invoices"  && <FactoryInvoices />}
        {activeTab === "loadings"  && hasLoadingsAccess && <FactoryContainerLoadingScan />}
        {activeTab === "pending"   && showPending        && <FactoryPendingLoadings />}
      </div>
    </div>
  );
}
