import { Suspense } from "react";
import { lazyRetry as lazy } from "@/lib/lazyRetry";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Truck, PackageCheck } from "lucide-react";
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
      <div className="relative isolate mx-3 mt-2 shrink-0 overflow-hidden rounded-2xl border border-violet-200/70 bg-gradient-to-r from-violet-50 via-background to-indigo-50 px-4 py-3 shadow-sm dark:border-violet-500/25 dark:from-[#271744] dark:via-[#16192d] dark:to-[#101b30] sm:mx-4 sm:px-5 sm:py-4">
        <div className="pointer-events-none absolute -right-10 -top-24 h-64 w-80 rounded-full bg-violet-400/15 blur-3xl dark:bg-violet-500/25" aria-hidden="true" />
        <div className="relative flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-violet-300/40 bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-lg shadow-violet-500/20">
              <Truck className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-bold tracking-tight sm:text-2xl" data-testid="text-page-title">Tracking</h1>
              <p className="text-xs text-muted-foreground sm:text-sm">Containers, shipments and offload tracking</p>
            </div>
          </div>
          <div className="hidden shrink-0 items-center gap-2 rounded-full border border-violet-200/80 bg-background/70 px-3 py-1.5 text-xs font-semibold text-violet-700 shadow-sm dark:border-violet-400/25 dark:bg-violet-400/10 dark:text-violet-200 lg:flex">
            <PackageCheck className="h-4 w-4" aria-hidden="true" />
            Logistics workspace
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-hidden flex flex-col pb-4 sm:px-4">
        <Tabs
          value={activeTab}
          onValueChange={(value) => setTab(value as (typeof TAB_VALUES)[number])}
          className="flex flex-col flex-1 overflow-hidden"
        >
          <div className="erp-mobile-scroll-tabs mt-3 mb-2 shrink-0 px-3 pb-1 sm:px-0">
            <TabsList className="h-auto w-max min-w-full gap-1 rounded-xl border border-border/70 bg-muted/55 p-1 shadow-sm sm:min-w-0 sm:w-fit [&>button]:rounded-lg [&>button]:px-4 [&>button]:py-2 [&>button]:text-xs [&>button]:font-semibold [&>button[data-state=active]]:bg-gradient-to-r [&>button[data-state=active]]:from-violet-600 [&>button[data-state=active]]:to-fuchsia-600 [&>button[data-state=active]]:text-white [&>button[data-state=active]]:shadow-md" aria-label="Tracking sections">
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
