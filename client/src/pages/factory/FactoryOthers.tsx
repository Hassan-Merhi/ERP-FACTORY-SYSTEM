import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { getSupplierReturnsCopy } from "@/i18n/supplierReturnsTranslations";
import { getFinalizedSaleReturnCopy } from "@/i18n/factoryFinalizedSaleReturnTranslations";
import { useSearch } from "wouter";
import { BarChart3, GitCompareArrows, PackageMinus, RotateCcw } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import { useFactoryNavigationAccess } from "@/hooks/useFactoryNavigationAccess";
import ProductionComparison from "./ProductionComparison";
import ProductComparisonCharts from "./productcomparison/ProductComparisonCharts";
import FactorySupplierReturns from "./FactorySupplierReturns";
import FactoryFinalizedSaleReturns from "./FactoryFinalizedSaleReturns";

type OthersTab = "comparison" | "product-comparison" | "supplier-returns" | "sale-returns";
const ALL_TABS: readonly OthersTab[] = ["comparison", "product-comparison", "supplier-returns", "sale-returns"];

export default function FactoryOthers() {
  const { ready, access, isPrivileged } = useFactoryNavigationAccess();
  const { language } = useApplicationLanguage();
  const copy = getSupplierReturnsCopy(language);
  const returnCopy = getFinalizedSaleReturnCopy(language);
  const { data: user } = useQuery<{ role?: string }>({ queryKey: ["/api/auth/me"] });
  const mayReturnToSupplier = user?.role === "Admin" || user?.role === "Developer";
  const search = useSearch();
  const hidden = isPrivileged ? [] : (access?.hiddenCostFields ?? []);
  const visibleTabs = ALL_TABS.filter((tab) =>
    tab === "supplier-returns" || tab === "sale-returns"
      ? mayReturnToSupplier
      : !hidden.includes(tab === "comparison" ? "hide_tab_overview_comparison" : "hide_tab_overview_product_comparison")
  );
  const visibleTabsKey = visibleTabs.join(",");
  const [activeTab, setActiveTab] = useHubQueryState<OthersTab>({
    key: "tab",
    allowedValues: ready ? visibleTabs : ALL_TABS,
    knownValues: ALL_TABS,
    defaultValue: visibleTabs[0] ?? "comparison",
  });

  // Sidebar links can change the query while this hub stays mounted.
  // Sync that navigation as well as the tab strip's own clicks.
  useEffect(() => {
    const requested = new URLSearchParams(search).get("tab") as OthersTab | null;
    if (ready && requested && visibleTabsKey.split(",").includes(requested) && requested !== activeTab) {
      setActiveTab(requested);
    }
  }, [search, ready, visibleTabsKey, activeTab, setActiveTab]);

  if (!ready) return <div className="p-5 text-sm text-muted-foreground">Loading access...</div>;
  if (visibleTabs.length === 0) {
    return <div className="p-5 text-sm text-muted-foreground">No comparison tabs are available for this user.</div>;
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <div className="shrink-0 border-b px-4 pt-4 pb-3">
        <PageHeader title="Others" subtitle={copy.hubSubtitle} />
      </div>
      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as OthersTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="erp-mobile-scroll-tabs mx-4 mt-3 shrink-0 pb-1">
          <TabsList className="w-max min-w-full sm:min-w-0 sm:w-fit" aria-label="Other factory reports">
            {visibleTabs.includes("comparison") && (
              <TabsTrigger value="comparison" data-testid="tab-others-comparison">
                <GitCompareArrows className="mr-1.5 h-4 w-4" /> Comparison
              </TabsTrigger>
            )}
            {visibleTabs.includes("product-comparison") && (
              <TabsTrigger value="product-comparison" data-testid="tab-others-product-comparison">
                <BarChart3 className="mr-1.5 h-4 w-4" /> Product Comparison
              </TabsTrigger>
            )}
            {mayReturnToSupplier && (
              <TabsTrigger value="supplier-returns" data-testid="tab-others-supplier-returns">
                <PackageMinus className="mr-1.5 h-4 w-4" /> {copy.tab}
              </TabsTrigger>
            )}
            {mayReturnToSupplier && (
              <TabsTrigger value="sale-returns" data-testid="tab-others-sale-returns">
                <RotateCcw className="mr-1.5 h-4 w-4" /> {returnCopy.tabLabel}
              </TabsTrigger>
            )}
          </TabsList>
        </div>
        {visibleTabs.includes("comparison") && (
          <TabsContent value="comparison" className="mt-0 flex-1 overflow-y-auto p-4 data-[state=inactive]:hidden">
            <ProductionComparison />
          </TabsContent>
        )}
        {visibleTabs.includes("product-comparison") && (
          <TabsContent
            value="product-comparison"
            className="mt-0 flex-1 overflow-y-auto p-4 data-[state=inactive]:hidden"
          >
            <ProductComparisonCharts />
          </TabsContent>
        )}
        {mayReturnToSupplier && (
          <TabsContent
            value="supplier-returns"
            className="mt-0 flex-1 overflow-y-auto p-4 data-[state=inactive]:hidden"
          >
            <FactorySupplierReturns />
          </TabsContent>
        )}
        {mayReturnToSupplier && (
          <TabsContent value="sale-returns" className="mt-0 flex-1 overflow-y-auto p-4 data-[state=inactive]:hidden">
            <FactoryFinalizedSaleReturns />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
