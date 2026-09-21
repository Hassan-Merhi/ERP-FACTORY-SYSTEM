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

import { useDailyProductionReport } from "./dailyproductionreport/useDailyProductionReport";
import { ProductionTabPanel } from "./dailyproductionreport/components/ProductionTabPanel";
import ProductComparisonCharts from "./productcomparison/ProductComparisonCharts";

// The page is a layout shell: tab chrome plus the panels. All state, queries and
// derived values live in useDailyProductionReport, with heavy panels kept in
// their own components.
export default function DailyProductionReport() {
  const report = useDailyProductionReport();
  const { language } = useApplicationLanguage();
  const productComparisonCopy = getFactoryProductComparisonCopy(language);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b flex-shrink-0">
        <PageHeader title="Overview" subtitle="Manufacturing overview — output metrics &amp; bale lifecycle" />
      </div>

      <Tabs
        value={report.activeTab}
        onValueChange={report.setActiveTab}
        className="flex flex-col flex-1 overflow-hidden"
      >
        <TabsList className="mx-4 mt-3 mb-0 flex-shrink-0 w-fit" data-testid="tabs-production-analytics">
          <TabsTrigger value="otw-tracking" data-testid="tab-otw-tracking">
            <Truck className="h-4 w-4 mr-1.5" /> OTW Tracking
          </TabsTrigger>
          <TabsTrigger value="production" data-testid="tab-production">
            <FlaskConical className="h-4 w-4 mr-1.5" /> Production
          </TabsTrigger>
          <TabsTrigger value="comparison" data-testid="tab-comparison">
            <Tag className="h-4 w-4 mr-1.5" /> Comparison
          </TabsTrigger>
          <TabsTrigger value="snapshot" data-testid="tab-snapshot" className="hidden">
            Snapshot
          </TabsTrigger>
          <TabsTrigger value="product-comparison" data-testid="tab-product-comparison">
            <BarChart3 className="h-4 w-4 mr-1.5" /> {productComparisonCopy.tabLabel}
          </TabsTrigger>
          <TabsTrigger value="shipping" data-testid="tab-shipping">
            <Ship className="h-4 w-4 mr-1.5" /> Shipping
          </TabsTrigger>
          <TabsTrigger value="sheets" data-testid="tab-sheets">
            Sheets
          </TabsTrigger>
          <TabsTrigger value="container-tracking" data-testid="tab-container-tracking" className="hidden">
            Container Tracking
          </TabsTrigger>
        </TabsList>

        <TabsContent value="otw-tracking" className="flex-1 overflow-y-auto p-4 mt-0 data-[state=inactive]:hidden">
          <FactoryOtwTrackingTab />
        </TabsContent>

        {/* ── Production tab ── */}
        <TabsContent
          value="production"
          className="flex-1 overflow-y-auto p-4 gap-4 flex flex-col mt-0 data-[state=inactive]:hidden"
        >
          <ProductionTabPanel report={report} />
        </TabsContent>

        {/* ── Financial Snapshot tab ── (hidden) */}
        <TabsContent value="snapshot" className="hidden">
          <FactoryFinancialSnapshot />
        </TabsContent>

        <TabsContent
          value="product-comparison"
          className="flex-1 overflow-y-auto p-4 mt-0 data-[state=inactive]:hidden"
        >
          <ProductComparisonCharts />
        </TabsContent>

        <TabsContent value="comparison" className="flex-1 overflow-y-auto p-4 mt-0 data-[state=inactive]:hidden">
          <ProductionComparison />
        </TabsContent>

        <TabsContent value="shipping" className="flex-1 overflow-hidden p-4 mt-0 data-[state=inactive]:hidden">
          <FactoryShippingContainers />
        </TabsContent>

        <TabsContent value="sheets" className="flex-1 overflow-hidden flex flex-col mt-0 data-[state=inactive]:hidden">
          <FactoryStatusBuilder />
        </TabsContent>

        <TabsContent
          value="container-tracking"
          className="flex-1 overflow-y-auto p-4 mt-0 data-[state=inactive]:hidden"
        >
          <FactoryContainerTracking />
        </TabsContent>
      </Tabs>
    </div>
  );
}
