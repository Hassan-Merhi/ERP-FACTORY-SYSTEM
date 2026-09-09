import { Package, Search, Truck } from "lucide-react";
import { cn } from "@/lib/utils";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import StockItems from "@/pages/StockItems";
import StockQuery from "@/pages/StockQuery";
import OffloadItemSearch from "@/pages/OffloadItemSearch";

const TABS = [
  { value: "items", label: "Items", icon: Package },
  { value: "query", label: "Query", icon: Search },
  { value: "offload", label: "Offload Search", icon: Truck },
] as const;

const TAB_VALUES = TABS.map((tab) => tab.value);

export default function StockHub() {
  const [activeTab, setTab] = useHubQueryState({
    key: "tab",
    allowedValues: TAB_VALUES,
    defaultValue: "items",
  });

  return (
    <div className="min-w-0">
      <div className="erp-mobile-scroll-tabs mb-5 pb-1">
        <div className="flex gap-1 p-1 rounded-xl border bg-card w-max min-w-full sm:min-w-0 sm:w-fit h-auto">
          {TABS.map(({ value, label, icon: Icon }) => (
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

      {activeTab === "items" && <StockItems />}
      {activeTab === "query" && <StockQuery />}
      {activeTab === "offload" && <OffloadItemSearch />}
    </div>
  );
}
