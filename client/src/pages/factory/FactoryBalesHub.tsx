import { useQuery } from "@tanstack/react-query";
import { Barcode, Boxes, Package, Truck } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FactoryArabicTranslationActions } from "@/components/FactoryArabicTranslationActions";
import BalesHistory from "./BalesHistory";
import BarcodeLookup from "../BarcodeLookup";
import BaleProducts from "../BaleProductsBilingual";
import CustomerLoading from "./CustomerLoading";
import type { FactoryMyAccess } from "@shared/apiTypes";
import { useHubQueryState } from "@/hooks/use-hub-query-state";

type BalesTab = "history" | "barcode" | "products" | "customer-loading";

const ALL_BALES_TABS: readonly BalesTab[] = ["history", "barcode", "products", "customer-loading"];

export default function FactoryBalesHub() {
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

  const [activeTab, setActiveTab] = useHubQueryState<BalesTab>({
    key: "tab",
    allowedValues: visibleTabs,
    knownValues: ALL_BALES_TABS,
    defaultValue: visibleTabs[0] ?? "history",
  });

  if (visibleTabs.length === 0) {
    return <div className="p-6 text-sm text-muted-foreground">No Bale Explorer tabs are available for this user.</div>;
  }

  const show = (tab: BalesTab) => visibleTabs.includes(tab);

  return (
    <div className="flex h-full flex-col">
      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as BalesTab)}
        className="flex h-full flex-col"
      >
        {/* Shared page-header grammar (accent bar, icon, subtitle) like the other hubs and the ERP pages. */}
        <div
          className={
            activeTab === "barcode"
              ? "relative isolate mx-3 mt-3 shrink-0 overflow-hidden rounded-2xl border border-blue-200/70 bg-linear-to-r from-blue-50 via-indigo-50/50 to-slate-50 px-4 pt-4 shadow-sm dark:border-blue-500/25 dark:from-[#101c35] dark:via-[#12274c] dark:to-[#10182c] sm:mx-5 sm:px-5 [&>header]:relative [&>header]:mb-0 [&>header]:border-b-0 [&>header]:pb-3"
              : "shrink-0 px-4 pt-3 [&>header]:mb-0 [&>header]:border-b-0 [&>header]:pb-2"
          }
        >
          {activeTab === "barcode" && (
            <div className="pointer-events-none absolute inset-y-0 right-0 hidden w-1/3 items-center justify-end overflow-hidden pr-10 opacity-15 dark:opacity-20 md:flex" aria-hidden="true">
              <div className="absolute right-12 h-40 w-40 rounded-full bg-blue-500/40 blur-3xl" />
              <Boxes className="relative h-28 w-28 rotate-[-10deg] text-blue-700 dark:text-blue-300" />
            </div>
          )}
          <PageHeader
            title="Bales"
            subtitle="Bale history, barcode lookup, products and customer loading"
            icon={<Package className="h-5 w-5" />}
            showBackButton={false}
          />
        </div>
        <div className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border/70 px-3 pb-2 pt-2 sm:px-5">
          <div className="erp-mobile-scroll-tabs min-w-0 flex-1 pb-1">
            <TabsList className="h-auto w-max min-w-full gap-1 rounded-xl border border-border/70 bg-muted/60 p-1 sm:min-w-0 sm:w-fit dark:bg-slate-900/75" aria-label="Bale explorer sections">
              {show("history") && (
                <TabsTrigger value="history" className="gap-2 rounded-lg px-3 py-2 data-[state=active]:bg-blue-600 data-[state=active]:text-white data-[state=active]:shadow-sm" data-testid="tab-bales-history">
                  <Package className="h-4 w-4" aria-hidden="true" /> Bales
                </TabsTrigger>
              )}
              {show("barcode") && (
                <TabsTrigger value="barcode" className="gap-2 rounded-lg px-3 py-2 data-[state=active]:bg-blue-600 data-[state=active]:text-white data-[state=active]:shadow-sm" data-testid="tab-barcode-lookup">
                  <Barcode className="h-4 w-4" aria-hidden="true" /> Barcode Lookup
                </TabsTrigger>
              )}
              {show("products") && (
                <TabsTrigger value="products" className="gap-2 rounded-lg px-3 py-2 data-[state=active]:bg-blue-600 data-[state=active]:text-white data-[state=active]:shadow-sm" data-testid="tab-bale-products">
                  <Boxes className="h-4 w-4" aria-hidden="true" /> Bale Products
                </TabsTrigger>
              )}
              {show("customer-loading") && (
                <TabsTrigger value="customer-loading" className="gap-2 rounded-lg px-3 py-2 data-[state=active]:bg-blue-600 data-[state=active]:text-white data-[state=active]:shadow-sm" data-testid="tab-customer-loading">
                  <Truck className="h-4 w-4" aria-hidden="true" /> Customer Loading
                </TabsTrigger>
              )}
            </TabsList>
          </div>
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
