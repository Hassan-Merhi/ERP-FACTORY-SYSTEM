import { Suspense } from "react";
import { lazyRetry as lazy } from "@/lib/lazyRetry";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Truck, Users } from "lucide-react";
import { useHubQueryState } from "@/hooks/use-hub-query-state";

const Suppliers = lazy(() => import("@/pages/Suppliers"));
const Customers = lazy(() => import("@/pages/Customers"));

const TABS = [
  { key: "suppliers", label: "Suppliers", icon: Truck },
  { key: "customers", label: "Customers", icon: Users },
] as const;

const TAB_KEYS = TABS.map((tab) => tab.key);

export default function PartiesHub() {
  const [activeTab, setTab] = useHubQueryState({
    key: "tab",
    allowedValues: TAB_KEYS,
    defaultValue: "suppliers",
  });

  return (
    <div className="flex min-w-0 flex-col h-full">
      <Tabs value={activeTab} onValueChange={(value) => setTab(value as (typeof TAB_KEYS)[number])} className="flex min-w-0 flex-col h-full">
        <div className="border-b bg-background px-3 sm:px-4 pt-3">
          <div className="erp-mobile-scroll-tabs pb-1">
            <TabsList className="h-9 w-max min-w-full sm:min-w-0 sm:w-fit">
              {TABS.map((t) => (
                <TabsTrigger key={t.key} value={t.key} className="flex shrink-0 items-center gap-1.5 text-sm">
                  <t.icon className="h-3.5 w-3.5" />
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        </div>

        {TABS.map((t) => (
          <TabsContent key={t.key} value={t.key} className="flex-1 min-w-0 overflow-auto m-0 p-0">
            <Suspense fallback={<div className="p-8 text-center text-muted-foreground">Loading…</div>}>
              {t.key === "suppliers" && <Suppliers />}
              {t.key === "customers" && <Customers />}
            </Suspense>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
