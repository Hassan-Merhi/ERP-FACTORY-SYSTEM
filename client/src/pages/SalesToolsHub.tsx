import { Suspense } from "react";
import { lazyRetry as lazy } from "@/lib/lazyRetry";
import { useQuery } from "@tanstack/react-query";
import { Book, ArrowLeftRight, Tag } from "lucide-react";
import { cn } from "@/lib/utils";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import type { AuthMe } from "@shared/apiTypes";
import { canAccessErpFeature, type ErpFeatureAccess } from "@/app/erpAccess";

const POSDaybook = lazy(() => import("@/pages/pos/POSDaybook"));
const StockTransfers = lazy(() => import("@/pages/StockTransfers"));
const POSPriceList = lazy(() => import("@/pages/pos/POSPriceList"));

// These arrays are module-level constants so their references are stable across
// renders — safe to pass as allowedValues to useHubQueryState without memoising.
const POS_TABS = [
  { key: "daybook", label: "POS Daybook", icon: Book },
  { key: "transfers", label: "Stock Transfers", icon: ArrowLeftRight },
] as const;

const ERP_TABS = [
  { key: "transfers", label: "Stock Transfers", icon: ArrowLeftRight },
  { key: "pricelist", label: "Price List", icon: Tag },
] as const;

const POS_TAB_KEYS = POS_TABS.map((t) => t.key) as unknown as readonly ("daybook" | "transfers")[];
const ERP_TAB_KEYS = ERP_TABS.map((t) => t.key) as unknown as readonly ("transfers" | "pricelist")[];

export default function SalesToolsHub() {
  const { data: user } = useQuery<AuthMe>({ queryKey: ["/api/auth/me"] });
  const { data: access } = useQuery<ErpFeatureAccess>({ queryKey: ["/api/my-erp-pages"], staleTime: 30000 });

  const isPOS = user?.role === "POS";
  const tabs = isPOS
    ? POS_TABS.filter((tab) => tab.key !== "daybook" || canAccessErpFeature(access, "pos_daybook"))
    : [...ERP_TABS];
  const knownTabKeys = isPOS ? POS_TAB_KEYS : ERP_TAB_KEYS;
  const tabKeys = tabs.map((tab) => tab.key);
  const defaultTab = tabKeys[0] ?? "transfers";

  const [activeTab, setTab] = useHubQueryState({
    key: "tab",
    allowedValues: tabKeys,
    knownValues: knownTabKeys,
    defaultValue,
  });

  // Render content directly (no Radix Tabs wrapper) — same pattern as StockHub
  // and InventoryHub. Using Radix <Tabs> + <TabsContent> without <TabsList> /
  // <TabsTrigger> triggers a null-dispatcher useContext crash (Radix Tabs
  // requires TabsList to be present in the tree when using TabsContent).
  return (
    <div className="flex min-w-0 flex-col h-full">
      <div className="border-b bg-background px-3 sm:px-4 py-2.5 shrink-0">
        <div className="erp-mobile-scroll-tabs pb-1">
          <div className="flex gap-1 p-1 rounded-xl border bg-card w-max min-w-full sm:min-w-0 sm:w-fit">
            {tabs.map((t) => {
              const isActive = activeTab === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  data-testid={`tab-${t.key}`}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-2 px-4 h-9 rounded-lg text-sm transition-colors",
                    isActive
                      ? "bg-accent text-accent-foreground font-medium"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground font-normal"
                  )}
                >
                  <t.icon className="h-4 w-4 shrink-0" />
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex-1 min-w-0 overflow-auto">
        <Suspense fallback={<div className="p-8 text-center text-muted-foreground">Loading…</div>}>
          {activeTab === "daybook" && <POSDaybook />}
          {activeTab === "transfers" && <StockTransfers hideVoucherNotes />}
          {activeTab === "pricelist" && <POSPriceList />}
        </Suspense>
      </div>
    </div>
  );
}
