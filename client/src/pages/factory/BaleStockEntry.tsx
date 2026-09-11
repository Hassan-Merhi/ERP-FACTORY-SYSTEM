import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ScanLine, List, CalendarDays, Factory } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FactoryMobileHeader, FactoryMobileHeaderActions, FactoryMobilePage } from "@/components/ui/factory-mobile";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { LabelPrintSettings } from "@/components/LabelPrintSettings";

import StockEntryHistory from "../StockEntryHistory";
import GroundScan from "./GroundScan";
import DailyScan from "./DailyScan";

import { StockEntryTab } from "./bale-stock-entry/StockEntryTab";
import { DailyStockSummary } from "./bale-stock-entry/DailyStockSummary";
import type { AuthMe, FactoryMyAccess, ApiListRow } from "@shared/apiTypes";

export default function BaleStockEntry() {
  const todayStr = new Date().toLocaleDateString("en-CA");
  const [summaryDate, _setSummaryDate] = useState<string>(todayStr);
  const { toast } = useToast();
  // Track which tabs have ever been activated so we only mount heavy components on demand.
  const [mountedTabs, setMountedTabs] = useState<Set<string>>(() => new Set(["entry"]));

  const handleTabChange = (tab: string) => setMountedTabs((prev) => (prev.has(tab) ? prev : new Set([...prev, tab])));

  const { data: settings } = useQuery({
    queryKey: ["/api/factory/settings"],
    queryFn: async () => {
      const r = await fetch("/api/factory/settings");
      return r.ok ? r.json() : {};
    },
    staleTime: 60000,
  });

  const { data: myAccess } = useQuery<FactoryMyAccess>({ queryKey: ["/api/factory/my-access"], staleTime: 5 * 60000 });
  const hiddenTabs = myAccess?.hiddenCostFields ?? [];

  const showEntry = settings?.stockEntryTabEntryEnabled !== false && !hiddenTabs.includes("hide_tab_stockentry_entry");
  const showHistory =
    settings?.stockEntryTabHistoryEnabled !== false && !hiddenTabs.includes("hide_tab_stockentry_history");
  const showGroundScan = !hiddenTabs.includes("hide_tab_stockentry_ground_scan");
  const showDailyScan = !hiddenTabs.includes("hide_tab_stockentry_daily_scan");

  const { data: _productionSession, refetch: refetchSession } = useQuery({
    queryKey: ["/api/factory/stock-entry/production-session", todayStr],
    queryFn: async () => {
      const r = await fetch(`/api/factory/stock-entry/production-session?date=${todayStr}`);
      return r.ok ? r.json() : null;
    },
    staleTime: 30000,
  });

  const _endProductionMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/factory/stock-entry/end-production", { date: todayStr });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message || "Failed to end production");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Production ended", description: "Worker Matrix PDF sent to WhatsApp group." });
      refetchSession();
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "End Production failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <FactoryMobilePage>
      <FactoryMobileHeader>
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-emerald-500/25 bg-gradient-to-br from-emerald-500/30 to-emerald-600/10">
            <ScanLine className="h-5 w-5 text-emerald-500" />
          </div>
          <div className="min-w-0">
            <h1 className="break-words text-lg font-bold leading-tight sm:text-xl">Bale Stock Entry</h1>
            <p className="mt-0.5 break-words text-sm leading-snug text-muted-foreground">
              Scan and record bale production
            </p>
          </div>
        </div>
        <FactoryMobileHeaderActions>
          <LabelPrintSettings />
          <span
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-emerald-500/25 bg-emerald-500/15 px-3 py-2 text-xs font-bold tracking-widest text-emerald-600 dark:text-emerald-400"
            data-testid="badge-stock-entry"
          >
            <Factory className="h-3.5 w-3.5" />
            STOCK ENTRY
          </span>
        </FactoryMobileHeaderActions>
      </FactoryMobileHeader>

      <DailyStockSummary date={summaryDate} />

      <Tabs defaultValue={showEntry ? "entry" : "history"} onValueChange={handleTabChange} className="min-w-0">
        <TabsList aria-label="Bale stock entry sections" className="w-full max-w-full">
          {showEntry && (
            <TabsTrigger value="entry" data-testid="tab-stock-entry">
              <ScanLine className="mr-1 h-4 w-4" />
              Stock Entry
            </TabsTrigger>
          )}
          {showHistory && (
            <TabsTrigger value="history" data-testid="tab-stock-entry-history">
              <List className="mr-1 h-4 w-4" />
              Stock Entry History
            </TabsTrigger>
          )}
          {showGroundScan && (
            <TabsTrigger value="ground-scan" data-testid="tab-ground-scan">
              <ScanLine className="mr-1 h-4 w-4" />
              Ground Scan
            </TabsTrigger>
          )}
          {showDailyScan && (
            <TabsTrigger value="daily-scan" data-testid="tab-daily-scan">
              <CalendarDays className="mr-1 h-4 w-4" />
              Daily Scan
            </TabsTrigger>
          )}
        </TabsList>
        {showEntry && (
          <TabsContent value="entry" className="mt-4 min-w-0">
            <StockEntryTab />
          </TabsContent>
        )}
        {showHistory && (
          <TabsContent value="history" className="mt-0 min-w-0 p-0">
            {mountedTabs.has("history") && <StockEntryHistory />}
          </TabsContent>
        )}
        {showGroundScan && (
          <TabsContent value="ground-scan" className="mt-0 min-w-0 p-0">
            {mountedTabs.has("ground-scan") && <GroundScan />}
          </TabsContent>
        )}
        {showDailyScan && (
          <TabsContent value="daily-scan" className="mt-0 min-w-0 p-0">
            {mountedTabs.has("daily-scan") && <DailyScan />}
          </TabsContent>
        )}
      </Tabs>
    </FactoryMobilePage>
  );
}
