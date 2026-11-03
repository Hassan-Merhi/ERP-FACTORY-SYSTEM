import { MapPin, Ship, Package, ArrowUpRight } from "lucide-react";
import { Link } from "wouter";
import { useCompany } from "@/contexts/CompanyContext";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import LocationInventory from "@/pages/LocationInventory";
import StockOTW from "@/pages/StockOTW";
import Containers from "@/pages/ContainersPage";
import { canAccessErpFeature, type ErpFeatureAccess } from "@/app/erpAccess";
import { RestrictedTabsState } from "@/components/RestrictedTabsState";

const TABS = [
  { value: "by-location", label: "By Location", icon: MapPin, featureKey: "location_inventory" as const },
  { value: "on-the-way", label: "On The Way", icon: Ship, featureKey: "stock_otw" as const },
  { value: "containers", label: "Containers", icon: Package, featureKey: "containers" as const },
] as const;

const TAB_VALUES = TABS.map((tab) => tab.value);

export default function InventoryHub({ access }: { access?: ErpFeatureAccess }) {
  const { selectedCompany } = useCompany();
  const visibleTabs = TABS.filter((tab) => canAccessErpFeature(access, tab.featureKey));
  const showStockShortcut =
    selectedCompany?.companyType !== "retail" &&
    (canAccessErpFeature(access, "stock_items") || canAccessErpFeature(access, "stock_query"));
  const stockHref = canAccessErpFeature(access, "stock_items") ? "/stock?tab=items" : "/stock?tab=query";
  const visibleValues = visibleTabs.map((tab) => tab.value);

  const [activeTab, setTab] = useHubQueryState({
    key: "tab",
    allowedValues: visibleValues,
    knownValues: TAB_VALUES,
    defaultValue: visibleValues[0] ?? "by-location",
  });

  if (visibleTabs.length === 0) {
    return <RestrictedTabsState />;
  }

  return (
    <Tabs value={activeTab} onValueChange={(value) => setTab(value as (typeof TAB_VALUES)[number])} className="min-w-0">
      <div className="erp-mobile-scroll-tabs mb-5 pb-1">
        <TabsList className="w-max min-w-full sm:min-w-0 sm:w-fit" aria-label="Inventory sections">
          {visibleTabs.map(({ value, label, icon: Icon }) => (
            <TabsTrigger key={value} value={value} data-testid={`tab-${value}`}>
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {showStockShortcut && (
        <nav aria-label="Related inventory tools" className="mb-3 flex justify-end">
          <Link
            href={stockHref}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border bg-card px-3 text-sm font-medium hover:bg-muted"
            data-testid="link-inventory-stock-hub"
          >
            Stock items &amp; search <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </nav>
      )}
      <TabsContent value="by-location" className="m-0">
        {visibleValues.includes("by-location") && <LocationInventory />}
      </TabsContent>
      <TabsContent value="on-the-way" className="m-0">
        {visibleValues.includes("on-the-way") && <StockOTW />}
      </TabsContent>
      <TabsContent value="containers" className="m-0">
        {visibleValues.includes("containers") && <Containers />}
      </TabsContent>
    </Tabs>
  );
}
