import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CalendarDays, ChevronDown, ChevronUp, Download, LayoutList, List,
  PackageCheck, RefreshCw, ScanLine, ShieldCheck, SlidersHorizontal, Weight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { type PressingReportFilters, type PressingReportColumn } from "@shared/pressingReportContracts";
import {
  exportPressingReport, fetchPressingReport, pressingCell, pressingDisplayDateTime, pressingKpiWorkers,
  type PressingCondensedRow, type PressingDetailRow, type PressingReportOptions,
} from "./pressing-scanner/pressingReportClient";
import PressingCorrectionReview from "./PressingCorrectionReview";
import PressingHourlyTargets from "./PressingHourlyTargets";

const ROOT = "/api/factory/pressing-machines/report";
const DETAIL_COLUMNS: PressingReportColumn[] = [
  "referenceNumber", "articleCode", "productName", "weightKg", "operatorName", "confirmedAt",
];
const SUMMARY_COLUMNS: PressingReportColumn[] = [
  "productionDate", "operatorName", "productName", "bales", "weightKg", "firstScanAt", "lastScanAt",
];
const today = () => {
  const now = new Date();
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")].join("-");
};
const formatError = (error: unknown) =>
  error instanceof Error ? error.message : "Could not load pressing scans";
const countText = (value: number | string | null | undefined) =>
  Number(value || 0).toLocaleString();
const kgText = (value: number | string | null | undefined) =>
  Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 3 });
const approx40KgText = (kg: number) =>
  (kg / 40).toLocaleString(undefined, { maximumFractionDigits: 2 });
const workerName = (name: string | null | undefined) =>
  name?.trim() || "Display name not set";

export default function PressingHistoryReport({ active, companyId, userId, simpleMode = false }: {
  active: boolean; companyId: number; userId: string; simpleMode?: boolean;
}) {
  const { toast } = useToast();
  const [filters, setFilters] = useState<PressingReportFilters>({
    from: simpleMode ? undefined : today(), to: simpleMode ? undefined : today(),
    status: "active", mode: "condensed", page: 1, limit: 50,
  });
  const [search, setSearch] = useState("");
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showCorrections, setShowCorrections] = useState(false);
  const [initialDate, setInitialDate] = useState(false);
  const invalidDates = Boolean(filters.from && filters.to && (
    filters.from > filters.to || (filters.from === filters.to &&
      !!filters.fromTime && !!filters.toTime && filters.fromTime > filters.toTime)
  ));
  const key = [ROOT, "data", companyId, userId];

  const options = useQuery<PressingReportOptions>({
    queryKey: [ROOT, "options", companyId, userId],
    enabled: active,
    queryFn: async () => {
      const response = await fetch(ROOT + "/options", { credentials: "include", cache: "no-store" });
      if (!response.ok) throw new Error("Could not load pressing filter options");
      return response.json();
    },
    staleTime: 0, refetchOnMount: "always", refetchOnWindowFocus: false,
  });
  useEffect(() => {
    const day = options.data?.serverToday;
    if (simpleMode || !day || initialDate) return;
    setInitialDate(true);
    setFilters(current => ({ ...current, from: day, to: day, page: 1 }));
  }, [options.data?.serverToday, initialDate, simpleMode]);

  const report = useQuery({
    queryKey: [...key, filters],
    enabled: active && !invalidDates,
    queryFn: () => fetchPressingReport(filters),
    staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const update = (value: Partial<PressingReportFilters>) =>
    setFilters(current => ({ ...current, ...value, asOf: undefined, page: 1 }));
  const canSeeEveryone = options.data?.canViewAll === true;
  const canCorrect = options.data?.canCorrect === true;
  const summary = report.data?.summary;
  const kpiSummary = report.data?.overview || summary;
  const byOperator = kpiSummary?.byOperator || [];
  const detail = (report.data?.rows || []).filter(
    (row): row is PressingDetailRow => "id" in row,
  );
  const condensed = (report.data?.rows || []).filter(
    (row): row is PressingCondensedRow => !("id" in row),
  );
  const pageCount = Math.max(1, Math.ceil((report.data?.total || 0) / filters.limit));
  const operators = options.data?.operators || [];
  const weightOptions = options.data?.weightsKg || [];

  // The account login identifies the worker; the visible KPI title is the
  // current Factory profile display name, not P1/P2/P3.
  const workers = pressingKpiWorkers(operators, byOperator);

  const allWorkerBales = workers.reduce((sum, worker) => sum + worker.bales, 0);
  const allWorkerKg = workers.reduce((sum, worker) => sum + worker.kg, 0);

  const selectWorker = (selectedId?: string) => update({
    userId: filters.userId === selectedId ? undefined : selectedId,
  });
  async function excel() {
    if (exporting || invalidDates) return;
    setExporting(true);
    try {
      await exportPressingReport(filters,
        filters.mode === "condensed" ? SUMMARY_COLUMNS : DETAIL_COLUMNS);
      toast({ title: "Pressing scans exported", description: "Excel includes every matching page." });
    } catch (error) {
      toast({ title: "Export failed", description: formatError(error), variant: "destructive" });
    } finally { setExporting(false); }
  }

  return (
    <section className="min-w-0 space-y-4" data-testid="pressing-history-report">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <PackageCheck className="h-5 w-5 text-emerald-500" />
            <h3 className="text-lg font-bold tracking-tight">Pressing Overview</h3>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Confirmed bales and KG · totals cover the complete selected period
          </p>
        </div>
        {!simpleMode && (
          <Button type="button" size="sm" variant="outline"
            disabled={report.isFetching}
            onClick={() => {
              void queryClient.invalidateQueries({ queryKey: key });
              void queryClient.invalidateQueries({ queryKey: [ROOT, "options", companyId, userId] });
            }}>
            <RefreshCw className={"mr-1.5 h-4 w-4 " + (report.isFetching ? "animate-spin" : "")} />
            Refresh
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label="Pressing production KPIs">
        {workers.map((worker, index) => {
          const selected = !!worker.userId && filters.userId === worker.userId;
          const accent = [
            "bg-sky-500/10 text-sky-600 dark:text-sky-400",
            "bg-violet-500/10 text-violet-600 dark:text-violet-400",
            "bg-amber-500/10 text-amber-600 dark:text-amber-400",
          ][index];
          return (
            <button type="button" key={worker.slot}
              data-testid={"pressing-kpi-" + worker.slot.toLowerCase()}
              disabled={!canSeeEveryone || !worker.userId}
              aria-pressed={selected}
              onClick={() => selectWorker(worker.userId)}
              className={"min-w-0 rounded-xl border bg-card p-3 text-left shadow-sm transition-colors sm:p-4 " +
                (selected ? "border-primary ring-1 ring-primary/50" :
                  "border-border/80 hover:border-primary/40") +
                (!canSeeEveryone || !worker.userId ? " cursor-default" : " cursor-pointer")}>
              <div className="flex items-center justify-between gap-2">
                <span className={"min-w-0 break-words rounded-lg px-2.5 py-1 text-xs font-bold sm:text-sm " + accent}
                   data-testid={"pressing-kpi-display-name-" + worker.slot.toLowerCase()}>{worker.label}</span>
                <ScanLine className="h-4 w-4 text-muted-foreground/60" />
              </div>
              <div className="mt-3 text-2xl font-bold leading-none tabular-nums sm:text-3xl">{countText(worker.bales)}</div>
              <div className="mt-1 text-xs text-muted-foreground">Total bales</div>
              <div className="mt-3 flex items-center gap-1.5 border-t pt-2.5">
                <Weight className="h-3.5 w-3.5 text-muted-foreground" />
                <strong className="text-sm tabular-nums">{kgText(worker.kg)} KG</strong>
              </div>
              <div className="mt-1.5 text-sm text-muted-foreground" data-testid={"pressing-kpi-approx-" + worker.slot.toLowerCase()}>
                Approx. (KG ÷ 40): <span className="font-semibold tabular-nums text-foreground">{approx40KgText(worker.kg)}</span>
              </div>
            </button>
          );
        })}
        <button type="button" data-testid="pressing-kpi-all" aria-pressed={!filters.userId}
          onClick={() => update({ userId: undefined })}
          className={"min-w-0 rounded-xl border bg-linear-to-br from-emerald-500/10 via-card to-card p-3 text-left shadow-sm transition-colors sm:p-4 " +
            (!filters.userId ? "border-emerald-500/50" : "border-border/80 hover:border-emerald-500/50")}>
          <div className="flex items-center justify-between gap-2">
            <span className="rounded-lg bg-emerald-500/15 px-2.5 py-1 text-xs font-bold text-emerald-600 dark:text-emerald-400">All pressing workers</span>
            <PackageCheck className="h-4 w-4 text-emerald-500" />
          </div>
          <div className="mt-3 text-2xl font-bold leading-none tabular-nums sm:text-3xl">{countText(allWorkerBales)}</div>
          <div className="mt-1 text-xs text-muted-foreground">Total bales</div>
          <div className="mt-3 flex items-center gap-1.5 border-t pt-2.5">
            <Weight className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
            <strong className="text-sm tabular-nums">{kgText(allWorkerKg)} KG</strong>
          </div>
          <div className="mt-1.5 text-sm text-muted-foreground" data-testid="pressing-kpi-approx-all">
            Approx. (KG ÷ 40): <span className="font-semibold tabular-nums text-foreground">{approx40KgText(allWorkerKg)}</span>
          </div>
        </button>
      </div>

      {!simpleMode && canSeeEveryone && (
        <PressingHourlyTargets active={active} companyId={companyId} serverToday={options.data?.serverToday} />
      )}

      {!simpleMode && (
        <div className="rounded-xl border bg-card p-3 shadow-sm sm:p-4" data-testid="pressing-report-filters">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <SlidersHorizontal className="h-4 w-4 text-muted-foreground" /> Filters
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="outline" className="h-8" onClick={() => {
                const day = options.data?.serverToday || today();
                update({ from: day, to: day, fromTime: undefined, toTime: undefined });
              }}><CalendarDays className="mr-1 h-3.5 w-3.5" />Today</Button>
              <Button size="sm" variant="outline" className="h-8" onClick={() => {
                const day = options.data?.serverToday || today();
                update({ from: day.slice(0, 7) + "-01", to: day, fromTime: undefined, toTime: undefined });
              }}>This Month</Button>
              <Button size="sm" variant="outline" className="h-8"
                onClick={() => update({ from: undefined, to: undefined, fromTime: undefined, toTime: undefined })}>All Time</Button>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <div className="min-w-0 space-y-1">
              <div className="text-xs font-medium text-muted-foreground">From <span className="font-normal">(Beirut time)</span></div>
              <div className="flex min-w-0 gap-1.5">
                <Input type="date" aria-label="From date" className="h-10 min-w-0 flex-[3] text-foreground"
                  value={filters.from || ""}
                  onChange={e => update({ from: e.target.value || undefined,
                    ...(e.target.value ? {} : { fromTime: undefined }) })} />
                <Input type="time" step={60} aria-label="From time (Beirut)" title="From hour and minute, Beirut local time"
                  className="h-10 min-w-0 flex-[2] px-1.5 text-foreground"
                  value={filters.fromTime || ""} disabled={!filters.from}
                  onChange={e => update({ fromTime: e.target.value || undefined })} />
              </div>
            </div>
            <div className="min-w-0 space-y-1">
              <div className="text-xs font-medium text-muted-foreground">To <span className="font-normal">(Beirut time)</span></div>
              <div className="flex min-w-0 gap-1.5">
                <Input type="date" aria-label="To date" className="h-10 min-w-0 flex-[3] text-foreground"
                  value={filters.to || ""}
                  onChange={e => update({ to: e.target.value || undefined,
                    ...(e.target.value ? {} : { toTime: undefined }) })} />
                <Input type="time" step={60} aria-label="To time (Beirut)" title="To hour and minute, Beirut local time"
                  className="h-10 min-w-0 flex-[2] px-1.5 text-foreground"
                  value={filters.toTime || ""} disabled={!filters.to}
                  onChange={e => update({ toTime: e.target.value || undefined })} />
              </div>
            </div>
            {canSeeEveryone && (
              <label className="space-y-1 text-xs font-medium text-muted-foreground">Worker
                <select aria-label="Pressing user filter" value={filters.userId || ""}
                  className="h-10 w-full rounded-md border bg-background px-2 text-sm text-foreground"
                  onChange={e => update({ userId: e.target.value || undefined })}>
                  <option value="">All users</option>
                  {operators.map(operator => (
                    <option key={operator.userId} value={operator.userId}>{operator.displayName?.trim() || "Display name not set"}</option>
                  ))}
                </select>
              </label>
            )}
            <label className="space-y-1 text-xs font-medium text-muted-foreground">Bale weight
              <select aria-label="Pressing KG filter"
                value={filters.weightKg === undefined ? "" : String(filters.weightKg)}
                className="h-10 w-full rounded-md border bg-background px-2 text-sm text-foreground"
                onChange={e => update({ weightKg: e.target.value ? Number(e.target.value) : undefined })}>
                <option value="">All KG</option>
                {weightOptions.map(kg => (
                  <option key={kg} value={Number(kg)}>{kgText(kg)} KG</option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-xs font-medium text-muted-foreground">Barcode / article
              <Input aria-label="Pressing barcode or article search" placeholder="Search..."
                className="h-10 text-foreground" value={search}
                onChange={e => {
                  setSearch(e.target.value);
                  update({ search: e.target.value || undefined });
                }} />
            </label>
            {canSeeEveryone && (
              <label className="space-y-1 text-xs font-medium text-muted-foreground">Status
                <select value={filters.status} aria-label="Pressing confirmation status"
                  className="h-10 w-full rounded-md border bg-background px-2 text-sm text-foreground"
                  onChange={e => update({ status: e.target.value as PressingReportFilters["status"] })}>
                  <option value="active">Confirmed</option>
                  <option value="voided">Voided</option>
                  <option value="all">All</option>
                </select>
              </label>
            )}
          </div>
          {invalidDates && <p role="alert" className="mt-2 text-sm text-destructive">From date/time cannot exceed To date/time.</p>}
          {filters.status !== "active" && (
            <p className="mt-2 text-xs text-muted-foreground">
              KPI totals count confirmed bales only. The history below follows your selected status.
            </p>
          )}
          {Number(summary?.voidedBales || 0) > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              {countText(summary?.voidedBales)} voided scans excluded from KPI totals.
            </p>
          )}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border bg-card shadow-sm" data-testid="pressing-history-collapsible">
        <div className="flex flex-wrap items-center justify-between gap-2 p-3 sm:p-4">
          <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left"
            aria-expanded={historyExpanded} aria-controls="pressing-history-content"
            onClick={() => setHistoryExpanded(value => !value)}>
            <span className="rounded-lg bg-muted p-2">
              <LayoutList className="h-4 w-4 text-muted-foreground" />
            </span>
            <span className="min-w-0">
              <span className="block font-semibold">Scanned Bales</span>
              <span className="block text-xs text-muted-foreground">
                {countText(report.data?.total)} {filters.mode === "condensed" ? "groups" : "scans"} · {historyExpanded ? "Collapse history" : "Open history to view scans"}
              </span>
            </span>
            {historyExpanded ? <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" /> :
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />}
          </button>
          {historyExpanded && !simpleMode && (
            <Button size="sm" variant="outline" disabled={exporting || invalidDates}
              onClick={() => void excel()}>
              <Download className="mr-1.5 h-4 w-4" />{exporting ? "Exporting…" : "Export Excel"}
            </Button>
          )}
        </div>

        {historyExpanded && (
          <div id="pressing-history-content" className="space-y-3 border-t p-3 sm:p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="inline-flex rounded-lg border bg-muted/40 p-1" aria-label="Pressing report view">
                <Button type="button" size="sm" variant={filters.mode === "condensed" ? "secondary" : "ghost"}
                  className="h-8" aria-pressed={filters.mode === "condensed"}
                  onClick={() => update({ mode: "condensed" })}>
                  <LayoutList className="mr-1.5 h-4 w-4" />Condensed
                </Button>
                <Button type="button" size="sm" variant={filters.mode === "detailed" ? "secondary" : "ghost"}
                  className="h-8" aria-pressed={filters.mode === "detailed"}
                  onClick={() => update({ mode: "detailed" })}>
                  <List className="mr-1.5 h-4 w-4" />Detailed
                </Button>
              </div>
              <span className="text-xs text-muted-foreground">Server-confirmed history</span>
            </div>
            {report.isLoading && <p className="text-sm text-muted-foreground">Loading scans…</p>}
            {report.isError && <p role="alert" className="text-sm text-destructive">{formatError(report.error)}</p>}
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[680px] text-left text-sm">
                {filters.mode === "detailed" ? (
                  <>
                    <thead className="bg-muted/70">
                      <tr>
                        <th className="p-3">Bale Ref</th><th className="p-3">Article</th>
                        <th className="p-3">Product</th><th className="p-3 text-right">KG</th>
                        <th className="p-3">Scanned by</th><th className="p-3">Date &amp; Time (Beirut)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.map(row => (
                        <tr key={row.id} className="border-t transition-colors hover:bg-muted/25">
                          <td className="p-3 font-mono text-xs font-semibold">{row.referenceNumber}</td>
                          <td className="p-3">{row.articleCode || "—"}</td>
                          <td className="p-3">{row.productName || "—"}</td>
                          <td className="p-3 text-right font-medium tabular-nums">{kgText(row.weightKg)}</td>
                          <td className="p-3">{workerName(row.operatorName)}</td>
                          <td className="p-3 text-xs tabular-nums">{pressingCell(row, "confirmedAt")}</td>
                        </tr>
                      ))}
                      {!detail.length && !report.isFetching && (
                        <tr><td colSpan={6} className="p-5 text-center text-muted-foreground">No scanned bales for these filters.</td></tr>
                      )}
                    </tbody>
                  </>
                ) : (
                  <>
                    <thead className="bg-muted/70">
                      <tr>
                        <th className="p-3">Day</th><th className="p-3">Worker</th>
                        <th className="p-3">Bale name</th><th className="p-3 text-right">Bales</th>
                        <th className="p-3 text-right">KG</th>
                        <th className="p-3">First scan (Beirut)</th><th className="p-3">Last scan (Beirut)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {condensed.map((row, index) => (
                        <tr key={[row.productionDate, row.operatorUserId, row.articleCode, row.productName, row.shiftId, row.voided, index].join(":")}
                          className="border-t transition-colors hover:bg-muted/25">
                          <td className="p-3 text-xs tabular-nums">{pressingCell(row, "productionDate")}</td>
                          <td className="p-3 font-medium">{workerName(row.operatorName)}</td>
                          <td className="p-3">{row.productName || "—"}</td>
                          <td className="p-3 text-right font-semibold tabular-nums">{countText(row.bales)}</td>
                          <td className="p-3 text-right font-medium tabular-nums">{kgText(row.weightKg)}</td>
                          <td className="p-3 text-xs tabular-nums">{pressingDisplayDateTime(row.firstScanAt, row.timezoneName)}</td>
                          <td className="p-3 text-xs tabular-nums">{pressingDisplayDateTime(row.lastScanAt, row.timezoneName)}</td>
                        </tr>
                      ))}
                      {!condensed.length && !report.isFetching && (
                        <tr><td colSpan={7} className="p-5 text-center text-muted-foreground">No scanned bales for these filters.</td></tr>
                      )}
                    </tbody>
                  </>
                )}
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{countText(report.data?.total)} {filters.mode === "condensed" ? "groups" : "scans"} · Page {filters.page} / {pageCount}</span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={filters.page <= 1}
                  onClick={() => setFilters(current => ({ ...current, page: current.page - 1 }))}>Previous</Button>
                <Button size="sm" variant="outline" disabled={filters.page >= pageCount}
                  onClick={() => setFilters(current => ({ ...current, page: current.page + 1 }))}>Next</Button>
              </div>
            </div>
            {canCorrect && !simpleMode && (
              <div className="border-t pt-2">
                <Button size="sm" variant="ghost" onClick={() => setShowCorrections(value => !value)}>
                  <ShieldCheck className="mr-2 h-4 w-4" />
                  {showCorrections ? "Hide scan actions" : "Manage scans"}
                </Button>
                {showCorrections && <PressingCorrectionReview companyId={companyId} userId={userId} rows={detail} />}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
