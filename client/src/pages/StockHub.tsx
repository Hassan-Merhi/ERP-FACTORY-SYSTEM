import { Suspense } from "react";
import { lazyRetry as lazy } from "@/lib/lazyRetry";
import { Package, Search, Ship, Truck } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
// Load only the selected Stock tab. These screens have sizable independent
// import, Excel, container and inventory dependencies; downloading all four
// before the first tab renders delays Properties and ERP navigation.
const StockItems = lazy(() => import("@/pages/StockItems"));
const StockQuery = lazy(() => import("@/pages/StockQuery"));
const OffloadItemSearch = lazy(() => import("@/pages/OffloadItemSearch"));
const StockOTW = lazy(() => import("@/pages/StockOTW"));
import { canAccessErpFeature, type ErpFeatureAccess } from "@/app/erpAccess";
import { RestrictedTabsState } from "@/components/RestrictedTabsState";

const TABS = [
  { value: "items", label: "Stock Items", icon: Package, featureKey: "stock_items" as const },
  { value: "query", label: "Stock Query", icon: Search, featureKey: "stock_query" as const },
  { value: "offload", label: "Offload Search", icon: Truck, featureKey: "stock_items" as const },
  { value: "otw", label: "On The Way", icon: Ship, featureKey: "stock_otw" as const },
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
    return <RestrictedTabsState />;
  }

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => setTab(value as (typeof TAB_VALUES)[number])}
      className="stock-hub-shell min-w-0"
    >
      <div className="stock-hub-tabs erp-mobile-scroll-tabs mb-5 pb-1">
        <TabsList className="stock-hub-tab-list w-max min-w-full sm:min-w-0 sm:w-fit" aria-label="Stock sections">
          {visibleTabs.map(({ value, label, icon: Icon }) => (
            <TabsTrigger key={value} value={value} className="stock-hub-tab" data-testid={`tab-stock-${value}`}>
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      <TabsContent value="items" className="m-0">
        <Suspense
          fallback={
            <div role="status" className="p-6 text-sm text-muted-foreground">
              Loading Stock Items…
            </div>
          }
        >
          {visibleValues.includes("items") && <StockItems />}
        </Suspense>
      </TabsContent>
      <TabsContent value="query" className="m-0">
        <Suspense
          fallback={
            <div role="status" className="p-6 text-sm text-muted-foreground">
              Loading Stock Query…
            </div>
          }
        >
          {visibleValues.includes("query") && <StockQuery />}
        </Suspense>
      </TabsContent>
      <TabsContent value="offload" className="m-0">
        <Suspense
          fallback={
            <div role="status" className="p-6 text-sm text-muted-foreground">
              Loading Offload Search…
            </div>
          }
        >
          {visibleValues.includes("offload") && <OffloadItemSearch />}
        </Suspense>
      </TabsContent>
      <TabsContent value="otw" className="m-0">
        <Suspense
          fallback={
            <div role="status" className="p-6 text-sm text-muted-foreground">
              Loading On The Way…
            </div>
          }
        >
          {visibleValues.includes("otw") && <StockOTW />}
        </Suspense>
      </TabsContent>
    </Tabs>
  );
}
