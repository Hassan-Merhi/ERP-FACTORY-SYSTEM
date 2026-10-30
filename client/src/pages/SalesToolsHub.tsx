import { Suspense } from "react";
import { lazyRetry as lazy } from "@/lib/lazyRetry";
import { useQuery } from "@tanstack/react-query";
import { Book, ArrowLeftRight, Tag, Replace } from "lucide-react";
import { useCompany } from "@/contexts/CompanyContext";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import type { AuthMe } from "@shared/apiTypes";
import { canAccessErpFeature, type ErpFeatureAccess } from "@/app/erpAccess";

const POSDaybook = lazy(() => import("@/pages/pos/POSDaybook"));
const StockTransfers = lazy(() => import("@/pages/StockTransfers"));
const POSPriceList = lazy(() => import("@/pages/pos/POSPriceList"));
const POSItemReplacement = lazy(() => import("@/pages/POSItemReplacement"));

// These arrays are module-level constants so their references are stable across
// renders — safe to pass as allowedValues to useHubQueryState without memoising.
const POS_TABS = [
  { key: "daybook", label: "POS Daybook", icon: Book },
  { key: "transfers", label: "Stock Transfers", icon: ArrowLeftRight },
] as const;

const ERP_TABS = [
  { key: "transfers", label: "Stock Transfers", icon: ArrowLeftRight },
  { key: "pricelist", label: "Price List", icon: Tag },
  { key: "replacement", label: "Item Replacement", icon: Replace },
] as const;

const POS_TAB_KEYS = POS_TABS.map((t) => t.key) as unknown as readonly ("daybook" | "transfers")[];
const ERP_TAB_KEYS = ERP_TABS.map((t) => t.key) as unknown as readonly ("transfers" | "pricelist" | "replacement")[];

export default function SalesToolsHub({ access }: { access?: ErpFeatureAccess }) {
  const { data: user } = useQuery<AuthMe>({ queryKey: ["/api/auth/me"] });
  const { selectedCompany } = useCompany();

  const isPOS = (user?.currentRole ?? user?.role) === "POS";
  const tabs = isPOS
    ? POS_TABS.filter((tab) => tab.key !== "daybook" || canAccessErpFeature(access, "pos_daybook"))
    : ERP_TABS.filter(
        (tab) => tab.key !== "replacement" ||
          (canAccessErpFeature(access, "pos") && selectedCompany?.companyType !== "retail")
      );
  const knownTabKeys = isPOS ? POS_TAB_KEYS : ERP_TAB_KEYS;
  const tabKeys = tabs.map((tab) => tab.key);
  const defaultTab = tabKeys[0] ?? "transfers";

  const [activeTab, setTab] = useHubQueryState({
    key: "tab",
    allowedValues: tabKeys,
    knownValues: knownTabKeys,
    defaultValue: defaultTab,
  });

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => setTab(value as "daybook" | "transfers" | "pricelist" | "replacement")}
      className="flex min-w-0 flex-col h-full"
    >
      <div className="border-b bg-background px-3 sm:px-4 py-2.5 shrink-0">
        <div className="erp-mobile-scroll-tabs pb-1">
          <TabsList className="w-max min-w-full sm:min-w-0 sm:w-fit" aria-label="Sales tools">
            {tabs.map((t) => (
              <TabsTrigger key={t.key} value={t.key} data-testid={`tab-${t.key}`}>
                <t.icon className="h-4 w-4 shrink-0" />
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      </div>

      <div className="flex-1 min-w-0 overflow-auto">
        <Suspense fallback={<div className="p-8 text-center text-muted-foreground">Loading…</div>}>
          <TabsContent value="daybook" className="m-0">
            <POSDaybook />
          </TabsContent>
          <TabsContent value="transfers" className="m-0">
            <StockTransfers hideVoucherNotes />
          </TabsContent>
          <TabsContent value="pricelist" className="m-0">
            <POSPriceList />
          </TabsContent>
          {tabs.some((tab) => tab.key === "replacement") && (
            <TabsContent value="replacement" className="m-0">
              <POSItemReplacement />
            </TabsContent>
          )}
        </Suspense>
      </div>
    </Tabs>
  );
}
