import { Suspense } from "react";
import { lazyRetry as lazy } from "@/lib/lazyRetry";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Truck, Users, Calculator } from "lucide-react";
import { useCompany } from "@/contexts/CompanyContext";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import { canAccessErpFeature, type ErpFeatureAccess } from "@/app/erpAccess";
import { RestrictedTabsState } from "@/components/RestrictedTabsState";

const Suppliers = lazy(() => import("@/pages/Suppliers"));
const Customers = lazy(() => import("@/pages/Customers"));
const SupplierProfitCheck = lazy(() => import("@/pages/SupplierProfitCheck"));

const TABS = [
  { key: "suppliers", label: "Suppliers", icon: Truck, featureKey: "suppliers" as const },
  { key: "customers", label: "Customers", icon: Users, featureKey: "customers" as const },
  { key: "profit-check", label: "Profit Check", icon: Calculator, featureKey: "suppliers" as const },
] as const;

const TAB_KEYS = TABS.map((tab) => tab.key);

export default function PartiesHub({ access }: { access?: ErpFeatureAccess }) {
  const { selectedCompany } = useCompany();
  const visibleTabs = TABS.filter(
    (tab) => canAccessErpFeature(access, tab.featureKey) &&
      (tab.key !== "profit-check" || selectedCompany?.companyType !== "retail")
  );
  const visibleKeys = visibleTabs.map((tab) => tab.key);

  const [activeTab, setTab] = useHubQueryState({
    key: "tab",
    allowedValues: visibleKeys,
    knownValues: TAB_KEYS,
    defaultValue: visibleKeys[0] ?? "suppliers",
  });

  if (visibleTabs.length === 0) {
    return <RestrictedTabsState />;
  }

  return (
    <div className="flex min-w-0 flex-col h-full">
      <Tabs
        value={activeTab}
        onValueChange={(value) => setTab(value as (typeof TAB_KEYS)[number])}
        className="flex min-w-0 flex-col h-full"
      >
        <div className="border-b bg-background px-3 sm:px-4 pt-3">
          <div className="erp-mobile-scroll-tabs pb-1">
            <TabsList className="w-max min-w-full sm:min-w-0 sm:w-fit" aria-label="Parties sections">
              {visibleTabs.map((t) => (
                <TabsTrigger key={t.key} value={t.key} className="flex shrink-0 items-center gap-1.5 text-sm">
                  <t.icon className="h-3.5 w-3.5" />
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        </div>

        {visibleTabs.map((t) => (
          <TabsContent key={t.key} value={t.key} className="flex-1 min-w-0 overflow-auto m-0 p-0">
            <Suspense fallback={<div className="p-8 text-center text-muted-foreground">Loading…</div>}>
              {t.key === "suppliers" && <Suppliers />}
              {t.key === "customers" && <Customers />}
              {t.key === "profit-check" && <SupplierProfitCheck />}
            </Suspense>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
