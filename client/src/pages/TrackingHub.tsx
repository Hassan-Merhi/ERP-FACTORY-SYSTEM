import { Suspense } from "react";
import { lazyRetry as lazy } from "@/lib/lazyRetry";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Truck } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Skeleton } from "@/components/ui/skeleton";
import { useHubQueryState } from "@/hooks/use-hub-query-state";

const TrackingContainersTab = lazy(() => import("@/pages/tracking/TrackingContainersTab"));
const GITMockup = lazy(() => import("@/pages/GITMockup"));
const TransporterStatement = lazy(() => import("@/pages/TransporterStatement"));

const TAB_VALUES = ["containers-otw", "git-tracking", "transporter-statement"] as const;

function TabFallback() {
  return (
    <div className="p-4 space-y-3">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export default function TrackingHub() {
  const [activeTab, setTab] = useHubQueryState({
    key: "tab",
    allowedValues: TAB_VALUES,
    defaultValue: "containers-otw",
  });

  return (
    <div className="flex flex-col h-full overflow-hidden bg-background">
      <div className="shrink-0 px-3 pt-2 sm:px-4">
        <PageHeader
          title="Tracking"
          subtitle="Containers, shipments and offload tracking"
          icon={<Truck className="h-5 w-5" aria-hidden="true" />}
        />
      </div>

      <div className="flex-1 overflow-hidden flex flex-col pb-4 sm:px-4">
        <Tabs
          value={activeTab}
          onValueChange={(value) => setTab(value as (typeof TAB_VALUES)[number])}
          className="flex flex-col flex-1 overflow-hidden"
        >
          <div className="erp-mobile-scroll-tabs mt-3 mb-2 shrink-0 px-3 pb-1 sm:px-0">
            <TabsList
              className="h-auto w-max min-w-full gap-1 rounded-xl border border-border/70 bg-muted/55 p-1 shadow-sm sm:min-w-0 sm:w-fit [&>button]:rounded-lg [&>button]:px-4 [&>button]:py-2 [&>button]:text-xs [&>button]:font-semibold [&>button[data-state=active]]:bg-gradient-to-r [&>button[data-state=active]]:from-violet-600 [&>button[data-state=active]]:to-fuchsia-600 [&>button[data-state=active]]:text-white [&>button[data-state=active]]:shadow-md"
              aria-label="Tracking sections"
            >
              <TabsTrigger value="containers-otw" data-testid="tab-tracking-containers-otw">
                Containers OTW
              </TabsTrigger>
              <TabsTrigger value="git-tracking" data-testid="tab-tracking-git">
                GIT Tracking
              </TabsTrigger>
              <TabsTrigger value="transporter-statement" data-testid="tab-tracking-transporter-statement">
                Transporter Statement
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="containers-otw" className="flex-1 overflow-hidden m-0 p-0">
            <Suspense fallback={<TabFallback />}>
              <TrackingContainersTab />
            </Suspense>
          </TabsContent>

          <TabsContent value="git-tracking" className="flex-1 overflow-hidden m-0 p-0">
            <Suspense fallback={<TabFallback />}>
              <GITMockup embedded />
            </Suspense>
          </TabsContent>

          <TabsContent value="transporter-statement" className="flex-1 overflow-hidden m-0 p-0 pt-3">
            <Suspense fallback={<TabFallback />}>
              <TransporterStatement embedded />
            </Suspense>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
