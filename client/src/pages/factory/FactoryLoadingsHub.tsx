import { useQuery } from "@tanstack/react-query";
import FactoryContainerLoadingScan from "./FactoryContainerLoadingScan";
import FactoryPendingLoadings from "./FactoryPendingLoadings";
import { Truck } from "lucide-react";
import type { FactoryMyAccess } from "@shared/apiTypes";
import { useHubQueryState } from "@/hooks/use-hub-query-state";

type LoadingsTab = "loadings" | "pending";
const ALL_LOADING_TABS: readonly LoadingsTab[] = ["loadings", "pending"];

export default function FactoryLoadingsHub() {

  const { data: settings } = useQuery({
    queryKey: ["/api/factory/settings"],
    queryFn: async () => {
      const r = await fetch("/api/factory/settings");
      return r.ok ? r.json() : {};
    },
    staleTime: 60000,
  });

  const { data: myAccess } = useQuery<FactoryMyAccess>({
    queryKey: ["/api/factory/my-access"],
    staleTime: 5 * 60000,
  });
  const hiddenTabs = myAccess?.hiddenCostFields ?? [];

  const showLoadings = !hiddenTabs.includes("hide_invoicing_loadings_tab");
  const showPending =
    settings?.loadingsTabPendingEnabled !== false && !hiddenTabs.includes("hide_tab_loadings_pending");

  const visibleTabs: LoadingsTab[] = [
    ...(showLoadings ? (["loadings"] as const) : []),
    ...(showPending ? (["pending"] as const) : []),
  ];
  const [effectiveActiveTab, setActiveTab] = useHubQueryState<LoadingsTab>({
    key: "tab",
    allowedValues: visibleTabs,
    knownValues: ALL_LOADING_TABS,
    defaultValue: visibleTabs[0] ?? "loadings",
  });

  function handleTabChange(value: LoadingsTab) {
    setActiveTab(value);
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="border-b bg-background shrink-0">
        {/* Header row */}
        <div className="flex items-center gap-3 px-5 pt-4 pb-3">
          <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Truck className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h1 className="text-base font-semibold leading-tight">Loadings</h1>
            <p className="text-xs text-muted-foreground">Container loading and pending sessions</p>
          </div>
        </div>
        {/* Tab row */}
        <div className="flex gap-0 px-4" role="tablist">
          {showLoadings && <button
            role="tab"
            aria-selected={effectiveActiveTab === "loadings"}
            data-testid="tab-container-loadings"
            onClick={() => handleTabChange("loadings")}
            className={[
              "px-4 py-2 text-sm font-medium border-b-2 transition-colors",
              effectiveActiveTab === "loadings"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            ].join(" ")}
          >
            Container Loadings
          </button>}
          {showPending && (
            <button
              role="tab"
              aria-selected={effectiveActiveTab === "pending"}
              data-testid="tab-pending-loadings"
              onClick={() => handleTabChange("pending")}
              className={[
                "px-4 py-2 text-sm font-medium border-b-2 transition-colors",
                effectiveActiveTab === "pending"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              ].join(" ")}
            >
              Pending Loadings
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto min-h-0">
        {!effectiveActiveTab && (
          <div className="p-6 text-sm text-muted-foreground">No Loadings tabs are available for this user.</div>
        )}
        {effectiveActiveTab === "loadings" && showLoadings && <FactoryContainerLoadingScan />}
        {effectiveActiveTab === "pending" && showPending && <FactoryPendingLoadings />}
      </div>
    </div>
  );
}
