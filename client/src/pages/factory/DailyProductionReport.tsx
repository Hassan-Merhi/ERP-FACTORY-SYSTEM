import { Suspense } from "react";
import { lazyRetry as lazy } from "@/lib/lazyRetry";
import FactoryShippingContainers from "@/pages/factory/FactoryShippingContainers";
import FactoryStatusBuilder from "@/pages/factory/FactoryStatusBuilder";
import FactoryOtwTrackingTab from "@/pages/factory/FactoryOtwTrackingTab";
import { PageHeader } from "@/components/PageHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BarChart3, FlaskConical, Layers, Ship, TableProperties, Truck } from "lucide-react";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import { useFactoryNavigationAccess } from "@/hooks/useFactoryNavigationAccess";
import { useDailyProductionReport } from "./dailyproductionreport/useDailyProductionReport";
import { ProductionTabPanel } from "./dailyproductionreport/components/ProductionTabPanel";
import "./factoryshippingcontainers/shipping-redesign.css";

const FactoryMonthlyProductionMatrix = lazy(() => import("./FactoryMonthlyProductionMatrix"));
const FactorySheetsAndSacks = lazy(() => import("./FactorySheetsAndSacks"));

type OverviewTab = "otw-tracking" | "production" | "monthly-production" | "shipping" | "sheets-sacks" | "sheets";
const OVERVIEW_TABS: readonly OverviewTab[] = [
  "otw-tracking",
  "production",
  "monthly-production",
  "shipping",
  "sheets-sacks",
  "sheets",
];
const HIDDEN_KEYS: Record<OverviewTab, string> = {
  "otw-tracking": "hide_tab_overview_otw_tracking",
  production: "hide_tab_overview_production",
  "monthly-production": "hide_tab_overview_monthly_production",
  shipping: "hide_tab_overview_shipping",
  "sheets-sacks": "hide_tab_overview_sheets_sacks",
  sheets: "hide_tab_overview_sheets",
};

// Keep page permissions for Monthly Production and Sheets & Sacks when embedding
// them in Overview. Moving navigation must not grant access to either workflow.
export default function DailyProductionReport() {
  const report = useDailyProductionReport();
  const { ready, canOpen, access, isPrivileged } = useFactoryNavigationAccess();
  const hidden = isPrivileged ? [] : (access?.hiddenCostFields ?? []);
  const visibleTabs = OVERVIEW_TABS.filter((tab) => {
    if (hidden.includes(HIDDEN_KEYS[tab])) return false;
    if (tab === "monthly-production") return canOpen("/factory/monthly-production-matrix");
    if (tab === "sheets-sacks") return canOpen("/factory/sheets-sacks");
    return true;
  });
  // Before access resolves, preserve deep-linked tabs instead of stripping the query.
  const [activeTab, setActiveTab] = useHubQueryState<OverviewTab>({
    key: "tab",
    allowedValues: ready ? visibleTabs : OVERVIEW_TABS,
    knownValues: OVERVIEW_TABS,
    defaultValue: visibleTabs.includes("production") ? "production" : (visibleTabs[0] ?? "production"),
  });
  const show = (tab: OverviewTab) => ready && visibleTabs.includes(tab);

  if (!ready) return <div className="p-5 text-sm text-muted-foreground">Loading access...</div>;

  return (
    <div className={`flex h-full min-w-0 flex-col overflow-hidden ${activeTab === "shipping" ? "shipping-overview-shell" : ""}`}>
      <div className={activeTab === "shipping" ? "shipping-overview-header shrink-0 px-5 pt-5 pb-4" : "shrink-0 border-b px-4 pt-4 pb-3"}>
        <PageHeader
          title="Overview"
          subtitle="Manufacturing overview — output metrics & bale lifecycle"
          icon={activeTab === "shipping" ? <span className="shipping-overview-icon"><Ship className="h-5 w-5" /></span> : undefined}
        />
      </div>

      {visibleTabs.length === 0 ? (
        <div className="p-6 text-sm text-muted-foreground">No Overview tabs are available for this user.</div>
      ) : (
        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as OverviewTab)} className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className={`erp-mobile-scroll-tabs mx-4 mt-3 shrink-0 pb-1 ${activeTab === "shipping" ? "shipping-overview-tabs" : ""}`}>
            <TabsList className="w-max min-w-full sm:min-w-0 sm:w-fit" aria-label="Factory overview" data-testid="tabs-production-analytics">
              {show("otw-tracking") && (
                <TabsTrigger value="otw-tracking" data-testid="tab-otw-tracking">
                  <Truck className="mr-1.5 h-4 w-4" /> OTW Tracking
                </TabsTrigger>
              )}
              {show("production") && (
                <TabsTrigger value="production" data-testid="tab-production">
                  <FlaskConical className="mr-1.5 h-4 w-4" /> Production
                </TabsTrigger>
              )}
              {show("monthly-production") && (
                <TabsTrigger value="monthly-production" data-testid="tab-monthly-production">
                  <BarChart3 className="mr-1.5 h-4 w-4" /> Monthly Production
                </TabsTrigger>
              )}
              {show("shipping") && (
                <TabsTrigger value="shipping" data-testid="tab-shipping">
                  <Ship className="mr-1.5 h-4 w-4" /> Shipping
                </TabsTrigger>
              )}
              {show("sheets-sacks") && (
                <TabsTrigger value="sheets-sacks" data-testid="tab-sheets-sacks">
                  <Layers className="mr-1.5 h-4 w-4" /> Sheets & Sacks
                </TabsTrigger>
              )}
              {show("sheets") && (
                <TabsTrigger value="sheets" data-testid="tab-sheets">
                  <TableProperties className="mr-1.5 h-4 w-4" /> Sheets
                </TabsTrigger>
              )}
            </TabsList>
          </div>

          {show("otw-tracking") && (
            <TabsContent value="otw-tracking" className="mt-0 flex-1 overflow-y-auto p-4 data-[state=inactive]:hidden">
              <FactoryOtwTrackingTab />
            </TabsContent>
          )}
          {show("production") && (
            <TabsContent value="production" className="mt-0 flex flex-1 flex-col gap-4 overflow-y-auto p-4 data-[state=inactive]:hidden">
              <ProductionTabPanel report={report} />
            </TabsContent>
          )}
          {show("monthly-production") && (
            <TabsContent value="monthly-production" className="mt-0 min-h-0 flex-1 overflow-y-auto p-4 data-[state=inactive]:hidden">
              <Suspense fallback={<div className="p-4 text-sm text-muted-foreground">Loading monthly production...</div>}>
                <FactoryMonthlyProductionMatrix />
              </Suspense>
            </TabsContent>
          )}
          {show("shipping") && (
            <TabsContent value="shipping" className="mt-0 flex-1 overflow-y-auto p-4 data-[state=inactive]:hidden">
              <FactoryShippingContainers />
            </TabsContent>
          )}
          {show("sheets-sacks") && (
            <TabsContent value="sheets-sacks" className="mt-0 min-h-0 flex-1 overflow-y-auto p-4 data-[state=inactive]:hidden">
              <Suspense fallback={<div className="p-4 text-sm text-muted-foreground">Loading sheets and sacks...</div>}>
                <FactorySheetsAndSacks />
              </Suspense>
            </TabsContent>
          )}
          {show("sheets") && (
            <TabsContent value="sheets" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden">
              <FactoryStatusBuilder />
            </TabsContent>
          )}
        </Tabs>
      )}
    </div>
  );
}
