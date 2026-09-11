import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FactoryArabicTranslationActions } from "@/components/FactoryArabicTranslationActions";
import BalesHistory from "./BalesHistory";
import BarcodeLookup from "../BarcodeLookup";
import BaleProducts from "../BaleProductsBilingual";
import CustomerLoading from "./CustomerLoading";
import type { FactoryMyAccess } from "@shared/apiTypes";

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

  const showBarcode = settings?.balesTabBarcodeEnabled !== false && !hiddenTabs.includes("hide_tab_bales_barcode");

  const defaultTab =
    hash === "products"
      ? "products"
      : hash === "customer-loading"
        ? "customer-loading"
        : hash === "barcode" && showBarcode
          ? "barcode"
          : "history";
  const [activeTab, setActiveTab] = useState(defaultTab);

  useEffect(() => {
    if (activeTab === "barcode" && !showBarcode) {
      setActiveTab("history");
      window.history.replaceState(null, "", "#history");
    }
  }, [activeTab, showBarcode]);

  function handleTabChange(value: string) {
    setActiveTab(value);
    window.history.replaceState(null, "", `#${value}`);
  }

  return (
    <div className="flex h-full flex-col">
      <Tabs value={activeTab} onValueChange={handleTabChange} className="flex h-full flex-col">
        <div className="flex flex-shrink-0 items-end justify-between gap-4 overflow-x-auto border-b px-4 pt-3">
          <TabsList className="flex-nowrap">
            <TabsTrigger value="history" data-testid="tab-bales-history">
              Bales
            </TabsTrigger>
            {showBarcode && (
              <TabsTrigger value="barcode" data-testid="tab-barcode-lookup">
                Barcode Lookup
              </TabsTrigger>
            )}
            <TabsTrigger value="products" data-testid="tab-bale-products">
              Bale Products
            </TabsTrigger>
            <TabsTrigger value="customer-loading" data-testid="tab-customer-loading">
              Customer Loading
            </TabsTrigger>
          </TabsList>
          {activeTab === "products" && <FactoryArabicTranslationActions className="pb-1" />}
        </div>

        <TabsContent value="history" className="mt-0 flex-1 overflow-auto">
          <div className="p-4">
            <BalesHistory />
          </div>
        </TabsContent>
        {showBarcode && (
          <TabsContent value="barcode" className="mt-0 flex-1 overflow-auto">
            <BarcodeLookup />
          </TabsContent>
        )}
        <TabsContent value="products" className="mt-0 flex-1 overflow-auto">
          <BaleProducts />
        </TabsContent>
        <TabsContent value="customer-loading" className="mt-0 flex-1 overflow-auto">
          <CustomerLoading />
        </TabsContent>
      </Tabs>
    </div>
  );
}
