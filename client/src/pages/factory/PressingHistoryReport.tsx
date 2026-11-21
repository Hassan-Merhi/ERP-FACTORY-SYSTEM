import { ChevronDown, ChevronUp, Download, LayoutList, PackageCheck, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { queryClient } from "@/lib/queryClient";
import { type PressingReportColumn } from "@shared/pressingReportContracts";
import { exportPressingReport } from "./pressing-scanner/pressingReportClient";
import PressingHourlyTargets from "./PressingHourlyTargets";
import {
  DETAIL_COLUMNS,
  ROOT,
  countText,
  formatError,
  usePressingHistoryReportState,
} from "./usePressingHistoryReportState";
import { PressingHistoryReportSection } from "./PressingHistoryReportSection";
import { PressingHistoryReportPressingReportFilters } from "./PressingHistoryReportPressingReportFilters";
import { PressingHistoryReportContent } from "./PressingHistoryReportContent";
const SUMMARY_COLUMNS: PressingReportColumn[] = [
  "productionDate",
  "operatorName",
  "productName",
  "bales",
  "weightKg",
  "firstScanAt",
  "lastScanAt",
];

export default function PressingHistoryReport(props: {
  active: boolean;
  companyId: number;
  userId: string;
  simpleMode?: boolean;
}) {
  const {
    active,
    allWorkerBales,
    allWorkerKg,
    canCorrect,
    canSeeEveryone,
    companyId,
    condensed,
    detail,
    exporting,
    filters,
    historyExpanded,
    hourlyDay,
    invalidDates,
    key,
    onHourlyData,
    operators,
    options,
    pageCount,
    report,
    sameHourlyDay,
    search,
    selectWorker,
    setExporting,
    setFilters,
    setHistoryExpanded,
    setHourlyDay,
    setSearch,
    setShowCorrections,
    showCorrections,
    simpleMode,
    summary,
    t,
    toast,
    update,
    userId,
    weightOptions,
    workers,
  } = usePressingHistoryReportState(props);
  async function excel() {
    if (exporting || invalidDates) return;
    setExporting(true);
    try {
      await exportPressingReport(filters, filters.mode === "condensed" ? SUMMARY_COLUMNS : DETAIL_COLUMNS);
      toast({ title: "Pressing scans exported", description: "Excel includes every matching page." });
    } catch (error) {
      toast({ title: "Export failed", description: formatError(error), variant: "destructive" });
    } finally {
      setExporting(false);
    }
  }

  return (
    <section className="min-w-0 space-y-4" data-testid="pressing-history-report">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-2.5 text-emerald-500">
            <PackageCheck className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-lg font-bold tracking-tight">Pressing Overview</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {simpleMode
                ? "Confirmed items and KG · totals cover the complete selected period"
                : "Confirmed scans · 07:00–17:00 Beirut time · " + (hourlyDay || options.data?.serverToday || "Today")}
              {!simpleMode && !sameHourlyDay && " · Updating totals…"}
            </p>
          </div>
        </div>
        {!simpleMode && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-9 rounded-lg"
            disabled={report.isFetching}
            onClick={() => {
              void queryClient.invalidateQueries({ queryKey: key });
              void queryClient.invalidateQueries({ queryKey: [ROOT, "options", companyId, userId] });
              void queryClient.invalidateQueries({
                queryKey: ["/api/factory/pressing-machines/report/hourly-targets", companyId],
              });
            }}
          >
            <RefreshCw className={"mr-1.5 h-4 w-4 " + (report.isFetching ? "animate-spin" : "")} />
            Refresh
          </Button>
        )}
      </div>

      <PressingHistoryReportContent
        allWorkerBales={allWorkerBales}
        allWorkerKg={allWorkerKg}
        canSeeEveryone={canSeeEveryone}
        filters={filters}
        selectWorker={selectWorker}
        t={t}
        update={update}
        workers={workers}
      />

      {!simpleMode && canSeeEveryone && (
        <PressingHourlyTargets
          active={active}
          companyId={companyId}
          serverToday={options.data?.serverToday}
          selectedDay={hourlyDay}
          onDayChange={setHourlyDay}
          onDataChange={onHourlyData}
        />
      )}

      {!simpleMode && (
        <PressingHistoryReportPressingReportFilters
          canSeeEveryone={canSeeEveryone}
          filters={filters}
          invalidDates={invalidDates}
          operators={operators}
          options={options}
          search={search}
          setSearch={setSearch}
          summary={summary}
          update={update}
          weightOptions={weightOptions}
        />
      )}

      <div className="overflow-hidden rounded-xl border bg-card shadow-sm" data-testid="pressing-history-collapsible">
        <div className="flex flex-wrap items-center justify-between gap-2 p-3 sm:p-4">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-3 text-left"
            aria-expanded={historyExpanded}
            aria-controls="pressing-history-content"
            onClick={() => setHistoryExpanded((value) => !value)}
          >
            <span className="rounded-lg bg-muted p-2">
              <LayoutList className="h-4 w-4 text-muted-foreground" />
            </span>
            <span className="min-w-0">
              <span className="block font-semibold">Scanned Items</span>
              <span className="block text-xs text-muted-foreground">
                {countText(report.data?.total)} {filters.mode === "condensed" ? "groups" : "scans"} ·{" "}
                {historyExpanded ? "Collapse history" : "Open history to view scans"}
              </span>
            </span>
            {historyExpanded ? (
              <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}
          </button>
          {historyExpanded && !simpleMode && (
            <Button size="sm" variant="outline" disabled={exporting || invalidDates} onClick={() => void excel()}>
              <Download className="mr-1.5 h-4 w-4" />
              {exporting ? "Exporting…" : "Export Excel"}
            </Button>
          )}
        </div>

        {historyExpanded && (
          <PressingHistoryReportSection
            canCorrect={canCorrect}
            companyId={companyId}
            condensed={condensed}
            detail={detail}
            filters={filters}
            pageCount={pageCount}
            report={report}
            setFilters={setFilters}
            setShowCorrections={setShowCorrections}
            showCorrections={showCorrections}
            simpleMode={simpleMode}
            update={update}
            userId={userId}
          />
        )}
      </div>
    </section>
  );
}
