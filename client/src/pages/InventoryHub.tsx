import { MapPin, Ship, Package } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import LocationInventory from "@/pages/LocationInventory";
import StockOTW from "@/pages/StockOTW";
import Containers from "@/pages/ContainersPage";
import CombinedInventory from "@/pages/CombinedInventory";
import { canAccessErpFeature, type ErpFeatureAccess } from "@/app/erpAccess";

const TABS = [
  { value: "by-location", label: "By Location", icon: MapPin, featureKey: "location_inventory" as const },
  { value: "on-the-way", label: "On The Way", icon: Ship, featureKey: "stock_otw" as const },
  { value: "combined", label: "Combined", icon: Layers, featureKey: "stock_items" as const },
  { value: "containers", label: "Containers", icon: Package, featureKey: "containers" as const },
] as const;

const TAB_VALUES = TABS.map((tab) => tab.value);

export default function InventoryHub() {
  const { data: access } = useQuery<ErpFeatureAccess>({ queryKey: ["/api/my-erp-pages"], staleTime: 30000 });
  const visibleTabs = TABS.filter((tab) => canAccessErpFeature(access, tab.featureKey));
  const visibleValues = visibleTabs.map((tab) => tab.value);

  const [activeTab, setTab] = useHubQueryState({
    key: "tab",
    allowedValues: visibleValues,
    knownValues: TAB_VALUES,
    defaultValue: visibleValues[0] ?? "by-location",
  });

  if (visibleTabs.length === 0) {
    return <div className="p-6 text-sm text-muted-foreground">No Inventory tabs are available for this user.</div>;
  }

  return (
    <div className="min-w-0">
      <div className="erp-mobile-scroll-tabs mb-5 pb-1">
        <div className="flex gap-1 p-1 rounded-xl border bg-card w-max min-w-full sm:min-w-0 sm:w-fit h-auto">
          {visibleTabs.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              data-testid={`tab-${value}`}
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

      {activeTab === "by-location" && visibleValues.includes("by-location") && <LocationInventory />}
      {activeTab === "on-the-way" && visibleValues.includes("on-the-way") && <StockOTW />}
      {activeTab === "combined" && visibleValues.includes("combined") && <CombinedInventory />}
      {activeTab === "containers" && visibleValues.includes("containers") && <Containers />}
    </div>
  );
}
