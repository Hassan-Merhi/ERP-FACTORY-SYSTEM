import { Package, Search, Truck } from "lucide-react";
import { cn } from "@/lib/utils";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import StockItems from "@/pages/StockItems";
import StockQuery from "@/pages/StockQuery";
import OffloadItemSearch from "@/pages/OffloadItemSearch";
import { canAccessErpFeature, type ErpFeatureAccess } from "@/app/erpAccess";

const TABS = [
  { value: "items", label: "Items", icon: Package, featureKey: "stock_items" as const },
  { value: "query", label: "Query", icon: Search, featureKey: "stock_query" as const },
  { value: "offload", label: "Offload Search", icon: Truck, featureKey: "stock_items" as const },
] as const;

const TAB_VALUES = TABS.map((tab) => tab.value);

export default function StockHub({ access }: { access?: ErpFeatureAccess }) {
  const visibleTabs = TABS.filter((tab) => canAccessErpFeature(access, tab.featureKey));
  const visibleValues = visibleTabs.map((tab) => tab.value);

  const [activeTab, setTab] = useHubQueryState({
    key: "tab",
    allowedValues: visibleValues,
    knownValues: TAB_VALUES,
    defaultValue: visibleValues[0] ?? "items",
  });

  if (visibleTabs.length === 0) {
    return <div className="p-6 text-sm text-muted-foreground">No Stock tabs are available for this user.</div>;
  }

  return (
    <div className="min-w-0">
      <div className="erp-mobile-scroll-tabs mb-5 pb-1">
        <div className="flex gap-1 p-1 rounded-xl border bg-card w-max min-w-full sm:min-w-0 sm:w-fit h-auto">
          {visibleTabs.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              data-testid={`tab-stock-${value}`}
              onClick={() => setTab(value)}
              className={cn(
                "inline-flex shrink-0 items-center gap-2 px-4 h-9 rounded-lg text-sm font-normal transition-colors",
                activeTab === value
                  ? "bg-accent text-accent-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === "items" && visibleValues.includes("items") && <StockItems />}
      {activeTab === "query" && visibleValues.includes("query") && <StockQuery />}
      {activeTab === "offload" && visibleValues.includes("offload") && <OffloadItemSearch />}
    </div>
  );
}
