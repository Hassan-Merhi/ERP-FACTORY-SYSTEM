import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import FactoryContainerLoadingScan from "./FactoryContainerLoadingScan";
import FactoryPendingLoadings from "./FactoryPendingLoadings";
import { Truck } from "lucide-react";
import type { AuthMe, FactoryMyAccess, ApiListRow } from "@shared/apiTypes";

type LoadingsTab = "loadings" | "pending";

export default function FactoryLoadingsHub() {
  const hash = typeof window !== "undefined" ? window.location.hash.replace("#", "") : "";

  const { data: settings, isSuccess: settingsLoaded } = useQuery({
    queryKey: ["/api/factory/settings"],
    queryFn: async () => {
      const r = await fetch("/api/factory/settings");
      return r.ok ? r.json() : {};
    },
    staleTime: 60000,
  });

  const { data: myAccess, isSuccess: accessLoaded } = useQuery<FactoryMyAccess>({ queryKey: ["/api/factory/my-access"], staleTime: 5 * 60000 });
  const hiddenTabs = myAccess?.hiddenCostFields ?? [];

  const showPending =
    settings?.loadingsTabPendingEnabled !== false && !hiddenTabs.includes("hide_tab_loadings_pending");

  const [activeTab, setActiveTab] = useState<LoadingsTab>("loadings");

  // Once both queries resolve, honour the URL hash (if allowed)
  useEffect(() => {
    if (!settingsLoaded || !accessLoaded) return;
    if (hash === "pending" && showPending) {
      setActiveTab("pending");
    } else {
      setActiveTab("loadings");
    }
  }, [settingsLoaded, accessLoaded, hash, showPending]); 

  // If showPending turns false while the pending tab is active, fall back
  useEffect(() => {
    if (!showPending && activeTab === "pending") {
      setActiveTab("loadings");
    }
  }, [showPending, activeTab]);

  function handleTabChange(value: LoadingsTab) {
    setActiveTab(value);
    window.history.replaceState(null, "", `#${value}`);
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
          <button
            role="tab"
            aria-selected={activeTab === "loadings"}
            data-testid="tab-container-loadings"
            onClick={() => handleTabChange("loadings")}
            className={[
              "px-4 py-2 text-sm font-medium border-b-2 transition-colors",
              activeTab === "loadings"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            ].join(" ")}
          >
            Container Loadings
          </button>
          {showPending && (
            <button
              role="tab"
              aria-selected={activeTab === "pending"}
              data-testid="tab-pending-loadings"
              onClick={() => handleTabChange("pending")}
              className={[
                "px-4 py-2 text-sm font-medium border-b-2 transition-colors",
                activeTab === "pending"
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
        {activeTab === "loadings" && <FactoryContainerLoadingScan />}
        {activeTab === "pending" && showPending && <FactoryPendingLoadings />}
      </div>
    </div>
  );
}
