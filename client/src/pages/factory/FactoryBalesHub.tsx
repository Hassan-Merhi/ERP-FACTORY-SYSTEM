import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FactoryArabicTranslationActions } from "@/components/FactoryArabicTranslationActions";
import BalesHistory from "./BalesHistory";
import BarcodeLookup from "../BarcodeLookup";
import BaleProducts from "../BaleProductsBilingual";
import CustomerLoading from "./CustomerLoading";
import type { FactoryMyAccess } from "@shared/apiTypes";

type BalesTab = "history" | "barcode" | "products" | "customer-loading";

export default function FactoryBalesHub() {
  const hash = typeof window !== "undefined" ? window.location.hash.replace("#", "") : "";

  const { data: settings } = useQuery({
    queryKey: ["/api/factory/settings"],
    queryFn: async () => {
      const r = await fetch("/api/factory/settings");
      return r.ok ? r.json() : {};
    },
    staleTime: 60000,
  });

  const { data: myAccess } = useQuery<FactoryMyAccess>({ queryKey: ["/api/factory/my-access"], staleTime: 5 * 60000 });
  const hiddenTabs = myAccess?.hiddenCostFields ?? [];

  const visibleTabs: BalesTab[] = [
    !hiddenTabs.includes("hide_tab_bales_history") ? "history" : null,
    settings?.balesTabBarcodeEnabled !== false && !hiddenTabs.includes("hide_tab_bales_barcode") ? "barcode" : null,
    !hiddenTabs.includes("hide_tab_bales_products") ? "products" : null,
    !hiddenTabs.includes("hide_tab_bales_customer_loading") ? "customer-loading" : null,
  ].filter((tab): tab is BalesTab => tab !== null);

  const requestedTab = (["history", "barcode", "products", "customer-loading"] as const).includes(hash as BalesTab)
    ? (hash as BalesTab)
    : null;
  const defaultTab = requestedTab && visibleTabs.includes(requestedTab) ? requestedTab : (visibleTabs[0] ?? "history");
  const [activeTab, setActiveTab] = useState<BalesTab>(defaultTab);

  const activeTabVisible = visibleTabs.includes(activeTab);
  const firstVisibleTab = visibleTabs[0];

  useEffect(() => {
    if (!firstVisibleTab || activeTabVisible) return;
    setActiveTab(firstVisibleTab);
    window.history.replaceState(null, "", `#${firstVisibleTab}`);
  }, [activeTabVisible, firstVisibleTab]);

  function handleTabChange(value: string) {
    const next = value as BalesTab;
    if (!visibleTabs.includes(next)) return;
    setActiveTab(next);
    window.history.replaceState(null, "", `#${next}`);
  }

  if (visibleTabs.length === 0) {
    return <div className="p-6 text-sm text-muted-foreground">No Bale Explorer tabs are available for this user.</div>;
  }

  const show = (tab: BalesTab) => visibleTabs.includes(tab);

  return (
    <div className="flex h-full flex-col">
      <Tabs value={activeTab} onValueChange={handleTabChange} className="flex h-full flex-col">
        <div className="flex flex-shrink-0 items-end justify-between gap-4 overflow-x-auto border-b px-4 pt-3">
          <TabsList className="flex-nowrap">
            {show("history") && (
              <TabsTrigger value="history" data-testid="tab-bales-history">
                Bales
              </TabsTrigger>
            )}
            {show("barcode") && (
              <TabsTrigger value="barcode" data-testid="tab-barcode-lookup">
                Barcode Lookup
              </TabsTrigger>
            )}
            {show("products") && (
              <TabsTrigger value="products" data-testid="tab-bale-products">
                Bale Products
              </TabsTrigger>
            )}
            {show("customer-loading") && (
              <TabsTrigger value="customer-loading" data-testid="tab-customer-loading">
                Customer Loading
              </TabsTrigger>
            )}
          </TabsList>
          {activeTab === "products" && <FactoryArabicTranslationActions className="pb-1" />}
        </div>

        {show("history") && (
          <TabsContent value="history" className="mt-0 flex-1 overflow-auto">
            <div className="p-4">
              <BalesHistory />
            </div>
          </TabsContent>
        )}
        {show("barcode") && (
          <TabsContent value="barcode" className="mt-0 flex-1 overflow-auto">
            <BarcodeLookup />
          </TabsContent>
        )}
        {show("products") && (
          <TabsContent value="products" className="mt-0 flex-1 overflow-auto">
            <BaleProducts />
          </TabsContent>
        )}
        {show("customer-loading") && (
          <TabsContent value="customer-loading" className="mt-0 flex-1 overflow-auto">
            <CustomerLoading />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
