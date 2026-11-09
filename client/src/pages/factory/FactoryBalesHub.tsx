import { useQuery } from "@tanstack/react-query";
import { Boxes, Package, ScanBarcode, Truck } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FactoryArabicTranslationActions } from "@/components/FactoryArabicTranslationActions";
import BalesHistory from "./BalesHistory";
import BarcodeLookup from "../BarcodeLookup";
import BaleProducts from "../BaleProductsBilingual";
import CustomerLoading from "./CustomerLoading";
import type { FactoryMyAccess } from "@shared/apiTypes";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import "./balesExplorerModern.css";

type BalesTab = "history" | "barcode" | "products" | "customer-loading";

const ALL_BALES_TABS: readonly BalesTab[] = ["history", "barcode", "products", "customer-loading"];

export default function FactoryBalesHub() {
  const { selectedCompany } = useCompany();
  const { data: settings } = useQuery({
    queryKey: companyQueryKey("/api/factory/settings", selectedCompany?.id), enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const r = await fetch("/api/factory/settings");
      return r.ok ? r.json() : {};
    },
    staleTime: 60000,
  });

  const { data: myAccess } = useQuery<FactoryMyAccess>({ queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id), enabled: Boolean(selectedCompany?.id), staleTime: 5 * 60000 });
  const hiddenTabs = myAccess?.companyId === selectedCompany?.id && myAccess?.hasFactoryAccess === true
    ? myAccess.hiddenCostFields
    : ["hide_tab_bales_history", "hide_tab_bales_barcode", "hide_tab_bales_products", "hide_tab_bales_customer_loading"];

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
    <div className="bales-explorer-page flex h-full min-w-0 flex-col">
      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as BalesTab)}
        className="flex h-full min-w-0 flex-col"
      >
        {/* Shared page-header grammar (accent bar, icon, subtitle) like the other hubs and the ERP pages. */}
        <div className="bales-explorer-hero shrink-0 px-4 pt-4 [&>header]:mb-0 [&>header]:border-b-0 [&>header]:pb-2">
          <PageHeader
            title="Bales"
            subtitle="Bale history, barcode lookup, products and customer loading"
            icon={<Package className="h-5 w-5" />}
            showBackButton={false}
          />
        </div>
        <div className="bales-explorer-nav flex min-w-0 shrink-0 items-center gap-2 px-4 pb-3">
          <div className="erp-mobile-scroll-tabs min-w-0 flex-1 pb-1">
            <TabsList className="w-max min-w-full sm:min-w-0 sm:w-fit" aria-label="Bale explorer sections">
              {show("history") && (
                <TabsTrigger value="history" className="bales-explorer-tab" data-testid="tab-bales-history">
                  <Package className="h-4 w-4" aria-hidden="true" />
                  Bales
                </TabsTrigger>
              )}
              {show("barcode") && (
                <TabsTrigger value="barcode" className="bales-explorer-tab" data-testid="tab-barcode-lookup">
                  <ScanBarcode className="h-4 w-4" aria-hidden="true" />
                  Barcode Lookup
                </TabsTrigger>
              )}
              {show("products") && (
                <TabsTrigger value="products" className="bales-explorer-tab" data-testid="tab-bale-products">
                  <Boxes className="h-4 w-4" aria-hidden="true" />
                  Bale Products
                </TabsTrigger>
              )}
              {show("customer-loading") && (
                <TabsTrigger value="customer-loading" className="bales-explorer-tab" data-testid="tab-customer-loading">
                  <Truck className="h-4 w-4" aria-hidden="true" />
                  Customer Loading
                </TabsTrigger>
              )}
            </TabsList>
          </div>
          {activeTab === "products" && <FactoryArabicTranslationActions className="pb-1" />}
        </div>

        {show("history") && (
          <TabsContent value="history" className="bales-explorer-body mt-0 flex-1 overflow-auto">
            <div className="p-3 sm:p-4">
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
