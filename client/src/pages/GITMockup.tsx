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

      <div className="flex-1 overflow-y-auto px-3 pb-5 pt-2 sm:px-4">
        <Tabs defaultValue="detail" className="min-w-0">
          <div className="erp-mobile-scroll-tabs pb-1">
            <TabsList className="h-auto w-max min-w-full gap-1 rounded-xl border border-border/70 bg-muted/60 p-1 shadow-sm sm:min-w-0 sm:w-fit [&>button]:rounded-lg [&>button]:px-4 [&>button]:py-2 [&>button]:text-xs [&>button]:font-semibold [&>button[data-state=active]]:bg-gradient-to-r [&>button[data-state=active]]:from-violet-600 [&>button[data-state=active]]:to-fuchsia-600 [&>button[data-state=active]]:text-white [&>button[data-state=active]]:shadow-md" aria-label="GIT tracking sections">
              <TabsTrigger value="detail" data-testid="tab-git-detail">
                Detail
              </TabsTrigger>
              <TabsTrigger value="trucks" data-testid="tab-git-trucks">
                Truck / Location
              </TabsTrigger>
              <TabsTrigger value="agents" data-testid="tab-git-agents">
                Agent / Duty
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="detail" className="mt-4 min-w-0">
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
