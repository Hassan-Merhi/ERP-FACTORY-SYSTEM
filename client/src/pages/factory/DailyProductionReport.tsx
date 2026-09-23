import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import FactoryFinancialSnapshot from "@/pages/factory/FactoryFinancialSnapshot";
import FactoryShippingContainers from "@/pages/factory/FactoryShippingContainers";
import FactoryStatusBuilder from "@/pages/factory/FactoryStatusBuilder";
import FactoryContainerTracking from "@/pages/factory/FactoryContainerTracking";
import FactoryOtwTrackingTab from "@/pages/factory/FactoryOtwTrackingTab";
import ProductionComparison from "@/pages/factory/ProductionComparison";
import { PageHeader } from "@/components/PageHeader";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { getFactoryProductComparisonCopy } from "@/i18n/factoryProductComparisonTranslations";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BarChart3, FlaskConical, Ship, Tag, Truck } from "lucide-react";
import type { FactoryMyAccess } from "@shared/apiTypes";

import { useDailyProductionReport } from "./dailyproductionreport/useDailyProductionReport";
import { ProductionTabPanel } from "./dailyproductionreport/components/ProductionTabPanel";
import ProductComparisonCharts from "./productcomparison/ProductComparisonCharts";

type OverviewTab = "otw-tracking" | "production" | "comparison" | "product-comparison" | "shipping" | "sheets";

const OVERVIEW_TABS: OverviewTab[] = [
  "otw-tracking",
  "production",
  "comparison",
  "product-comparison",
  "shipping",
  "sheets",
];

const HIDDEN_KEYS: Record<OverviewTab, string> = {
  "otw-tracking": "hide_tab_overview_otw_tracking",
  production: "hide_tab_overview_production",
  comparison: "hide_tab_overview_comparison",
  "product-comparison": "hide_tab_overview_product_comparison",
  shipping: "hide_tab_overview_shipping",
  sheets: "hide_tab_overview_sheets",
};

// The page is a layout shell: tab chrome plus the panels. All state, queries and
// derived values live in useDailyProductionReport, with heavy panels kept in
// their own components.
export default function DailyProductionReport() {
  const report = useDailyProductionReport();
  const { language } = useApplicationLanguage();
  const productComparisonCopy = getFactoryProductComparisonCopy(language);
  const { data: myAccess } = useQuery<FactoryMyAccess>({ queryKey: ["/api/factory/my-access"], staleTime: 5 * 60000 });
  const hidden = myAccess?.hiddenCostFields ?? [];
  const visibleTabs = OVERVIEW_TABS.filter((tab) => !hidden.includes(HIDDEN_KEYS[tab]));
  const visibleTabsKey = visibleTabs.join("|");
  const firstVisibleTab = visibleTabs[0];

  useEffect(() => {
    if (!firstVisibleTab) return;
    if (OVERVIEW_TABS.includes(report.activeTab as OverviewTab) && !visibleTabs.includes(report.activeTab as OverviewTab)) {
      report.setActiveTab(firstVisibleTab);
    }
  }, [firstVisibleTab, report.activeTab, report.setActiveTab, visibleTabsKey]);

  const show = (tab: OverviewTab) => visibleTabs.includes(tab);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-4 pt-4 pb-3 border-b flex-shrink-0">
        <PageHeader title="Overview" subtitle="Manufacturing overview — output metrics &amp; bale lifecycle" />
      </div>

      {visibleTabs.length === 0 ? (
        <div className="p-6 text-sm text-muted-foreground">No Overview tabs are available for this user.</div>
      ) : (
        <Tabs
          value={report.activeTab}
          onValueChange={report.setActiveTab}
          className="flex flex-col flex-1 overflow-hidden"
        >
          <TabsList className="mx-4 mt-3 mb-0 flex-shrink-0 w-fit" data-testid="tabs-production-analytics">
            {show("otw-tracking") && (
              <TabsTrigger value="otw-tracking" data-testid="tab-otw-tracking">
                <Truck className="h-4 w-4 mr-1.5" /> OTW Tracking
              </TabsTrigger>
            )}
            {show("production") && (
              <TabsTrigger value="production" data-testid="tab-production">
                <FlaskConical className="h-4 w-4 mr-1.5" /> Production
              </TabsTrigger>
            )}
            {show("comparison") && (
              <TabsTrigger value="comparison" data-testid="tab-comparison">
                <Tag className="h-4 w-4 mr-1.5" /> Comparison
              </TabsTrigger>
            )}
            <TabsTrigger value="snapshot" data-testid="tab-snapshot" className="hidden">
              Snapshot
            </TabsTrigger>
            {show("product-comparison") && (
              <TabsTrigger value="product-comparison" data-testid="tab-product-comparison">
                <BarChart3 className="h-4 w-4 mr-1.5" /> {productComparisonCopy.tabLabel}
              </TabsTrigger>
            )}
            {show("shipping") && (
              <TabsTrigger value="shipping" data-testid="tab-shipping">
                <Ship className="h-4 w-4 mr-1.5" /> Shipping
              </TabsTrigger>
            )}
            {show("sheets") && (
              <TabsTrigger value="sheets" data-testid="tab-sheets">
                Sheets
              </TabsTrigger>
            )}
            <TabsTrigger value="container-tracking" data-testid="tab-container-tracking" className="hidden">
              Container Tracking
            </TabsTrigger>
          </TabsList>

          {show("otw-tracking") && (
            <TabsContent value="otw-tracking" className="flex-1 overflow-y-auto p-4 mt-0 data-[state=inactive]:hidden">
              <FactoryOtwTrackingTab />
            </TabsContent>
          )}

          {show("production") && (
            <TabsContent
              value="production"
              className="flex-1 overflow-y-auto p-4 gap-4 flex flex-col mt-0 data-[state=inactive]:hidden"
            >
              <ProductionTabPanel report={report} />
            </TabsContent>
          )}

          <TabsContent value="snapshot" className="hidden">
            <FactoryFinancialSnapshot />
          </TabsContent>

          {show("product-comparison") && (
            <TabsContent
              value="product-comparison"
              className="flex-1 overflow-y-auto p-4 mt-0 data-[state=inactive]:hidden"
            >
              <ProductComparisonCharts />
            </TabsContent>
          )}

          {show("comparison") && (
            <TabsContent value="comparison" className="flex-1 overflow-y-auto p-4 mt-0 data-[state=inactive]:hidden">
              <ProductionComparison />
            </TabsContent>
          )}

          {show("shipping") && (
            <TabsContent value="shipping" className="flex-1 overflow-hidden p-4 mt-0 data-[state=inactive]:hidden">
              <FactoryShippingContainers />
            </TabsContent>
          )}

          {show("sheets") && (
            <TabsContent value="sheets" className="flex-1 overflow-hidden flex flex-col mt-0 data-[state=inactive]:hidden">
              <FactoryStatusBuilder />
            </TabsContent>
          )}

          <TabsContent
            value="container-tracking"
            className="flex-1 overflow-y-auto p-4 mt-0 data-[state=inactive]:hidden"
          >
            <FactoryContainerTracking />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
