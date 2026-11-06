/**
 * GIT — Goods In Transit Workbook
 * Spreadsheet-style replacement for the daily GIT Excel sheet.
 *
 * Tabs:
 *   1. GIT Detail        — Workbook View (grouped by company) + Flat Table toggle
 *   2. Truck / Location  — grouped by transporter (with truck) + no-truck section
 *   3. Agent / Duty      — FIFO duty allocation per agent
 */

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/PageHeader";
import { TabDetail } from "./git-mockup/TabDetail";
import { TabTruckLocation } from "./git-mockup/TabTruckLocation";
import { TabAgentDuty } from "./git-mockup/TabAgentDuty";

export default function GITMockup({ embedded = false }: { embedded?: boolean } = {}) {
  return (
    <div className="flex flex-col h-full overflow-hidden">
      {!embedded && <PageHeader title="GIT" subtitle="Daily goods-in-transit workbook — spreadsheet replacement" />}

      <div className="flex-1 space-y-4 overflow-y-auto bg-gradient-to-b from-violet-50/35 to-background p-3 dark:from-violet-950/10 dark:to-background sm:p-5">
        <Tabs defaultValue="detail">
          <div className="erp-mobile-scroll-tabs pb-1">
            <TabsList className="h-auto w-max min-w-full gap-1 rounded-2xl border border-border/70 bg-muted/70 p-1.5 shadow-sm sm:min-w-0 dark:border-violet-500/20 dark:bg-slate-900/80" aria-label="GIT tracking sections">
              <TabsTrigger value="detail" className="rounded-xl px-4 py-2 text-xs font-semibold text-muted-foreground data-[state=active]:bg-violet-600 data-[state=active]:text-white data-[state=active]:shadow-md sm:text-sm" data-testid="tab-git-detail">
                Detail
              </TabsTrigger>
              <TabsTrigger value="trucks" className="rounded-xl px-4 py-2 text-xs font-semibold text-muted-foreground data-[state=active]:bg-violet-600 data-[state=active]:text-white data-[state=active]:shadow-md sm:text-sm" data-testid="tab-git-trucks">
                Truck / Location
              </TabsTrigger>
              <TabsTrigger value="agents" className="rounded-xl px-4 py-2 text-xs font-semibold text-muted-foreground data-[state=active]:bg-violet-600 data-[state=active]:text-white data-[state=active]:shadow-md sm:text-sm" data-testid="tab-git-agents">
                Agent / Duty
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="detail" className="mt-4">
            <TabDetail />
          </TabsContent>

          <TabsContent value="trucks" className="mt-4">
            <TabTruckLocation />
          </TabsContent>

          <TabsContent value="agents" className="mt-4">
            <TabAgentDuty />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
