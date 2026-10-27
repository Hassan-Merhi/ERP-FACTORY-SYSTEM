import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { CalendarDays, Download, Filter, RefreshCw, Save, Trash2, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  PRESSING_REPORT_COLUMNS, PRESSING_DEFAULT_COLUMNS, PRESSING_COLUMN_LABELS,
  pressingReportFiltersSchema,
  type PressingReportFilters, type PressingReportColumn,
} from "@shared/pressingReportContracts";
import PressingCorrectionReview from "./PressingCorrectionReview";
import {
  fetchPressingReport, exportPressingReport, pressingCell,
  type PressingReportResponse, type PressingSavedView, type PressingReportOptions,
  type PressingDetailRow,
} from "./pressing-scanner/pressingReportClient";

const ROOT = "/api/factory/pressing-machines/report";
const DEFAULT_CONDENSED: PressingReportColumn[] = [
  "productionDate", "machineName", "operatorName", "shiftId", "articleCode",
  "bales", "weightKg", "firstScanAt", "lastScanAt", "status",
];
const today = () => {
  const now = new Date();
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")].join("-");
};
function initialFilters(): PressingReportFilters {
  const day = today();
  return { from: day, to: day, mode: "detailed", status: "active", page: 1, limit: 100 };
}
function errText(error: unknown): string {
  return error instanceof Error ? error.message : "Could not complete report request";
}
/**
 * Free-text filters hit PostgreSQL on every change; with large histories a
 * request per keystroke is wasteful. The input stays responsive locally and
 * the filter is committed 350ms after typing pauses. External filter changes
 * (saved views, presets) flow back into the input.
 */
function useDebouncedFilterText(committed: string, commit: (value: string | undefined) => void) {
  const [text, setText] = useState(committed);
  const lastCommitted = useRef(committed);
  useEffect(() => {
    if (committed !== lastCommitted.current) {
      lastCommitted.current = committed;
      setText(committed);
    }
  }, [committed]);
  useEffect(() => {
    if (text === lastCommitted.current) return;
    const timer = window.setTimeout(() => {
      lastCommitted.current = text;
      commit(text.trim() || undefined);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [text, commit]);
  return [text, setText] as const;
}
type HistoryReportProps = {
  active: boolean;
  companyId: number;
  userId: string;
};
export default function PressingHistoryReport({ active, companyId, userId }: HistoryReportProps) {
  const { toast } = useToast();
  const [filters, setFilters] = useState<PressingReportFilters>(initialFilters);
  const dateInvalid = Boolean(filters.from && filters.to && filters.from > filters.to);
  const [columns, setColumns] = useState<PressingReportColumn[]>([...PRESSING_DEFAULT_COLUMNS]);
  const [showColumns, setShowColumns] = useState(false);
  const [viewName, setViewName] = useState("");
  const [makeDefault, setMakeDefault] = useState(false);
  const [exportStatus, setExportStatus] = useState("");
  const [selectedViewId, setSelectedViewId] = useState("");
  const asOfRef = useRef<string | null>(null);
  const defaultLoaded = useRef<string | null>(null);
  const datePresetInitialized = useRef(false);
  const keyPrefix = [ROOT, "data", companyId, userId];

  function change(values: Partial<PressingReportFilters>) {
    asOfRef.current = null;
    setFilters(old => ({ ...old, ...values, page: 1, asOf: undefined }));
  }
  const commitArticle = useCallback((articleCode: string | undefined) => change({ articleCode }), []);
  const commitSearch = useCallback((search: string | undefined) => change({ search }), []);
  const [articleText, setArticleText] = useDebouncedFilterText(filters.articleCode ?? "", commitArticle);
  const [searchText, setSearchText] = useDebouncedFilterText(filters.search ?? "", commitSearch);
  const viewsQuery = useQuery<PressingSavedView[]>({
    queryKey: [ROOT, "views", companyId, userId],
    queryFn: async () => {
      const response = await fetch(ROOT + "/views", { credentials: "include", cache: "no-store" });
      if (!response.ok) throw new Error("Could not retrieve saved report views");
      return response.json();
    },
    enabled: active, staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const optionsQuery = useQuery<PressingReportOptions>({
    queryKey: [ROOT, "options", companyId, userId],
    queryFn: async () => {
      const response = await fetch(ROOT + "/options", { credentials: "include", cache: "no-store" });
      if (!response.ok) throw new Error("Could not load machine and operator filter choices");
      return response.json();
    },
    enabled: active, staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const query = useQuery<PressingReportResponse>({
    queryKey: [...keyPrefix, filters],
    queryFn: () => fetchPressingReport({
      ...filters, asOf: filters.page === 1 ? undefined : asOfRef.current ?? undefined,
    }),
    enabled: active && !dateInvalid, staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  // Keep page-to-page results pinned to the server's first report snapshot.
  useEffect(() => {
    if (query.data?.asOf && query.data.page === 1) asOfRef.current = query.data.asOf;
  }, [query.data?.asOf, query.data?.page]);

  function applyView(view: PressingSavedView) {
    const parsed = pressingReportFiltersSchema.safeParse({
      ...view.filters, mode: view.reportMode, page: 1, limit: 100,
    });
    if (!parsed.success) {
      toast({ title: "Saved view invalid", description: "Review the saved filters and try again.", variant: "destructive" });
      return;
    }
    setFilters(parsed.data);
    setColumns(view.visibleColumns.filter(col => PRESSING_REPORT_COLUMNS.includes(col)));
    setSelectedViewId(String(view.id));
    setViewName(view.name);
    setMakeDefault(view.isDefault);
    asOfRef.current = null;
  }
  useEffect(() => {
    const actorKey = companyId + ":" + userId;
    if (!viewsQuery.data || defaultLoaded.current === actorKey) return;
    defaultLoaded.current = actorKey;
    const preferred = viewsQuery.data.find(x => x.isDefault);
    if (preferred) applyView(preferred);
    // Defaults apply once per operator/company; do not override user edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewsQuery.data, companyId, userId]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", ROOT + "/views", {
        name: viewName.trim(), mode: filters.mode,
        filters: {
          ...(filters.from ? { from: filters.from } : {}),
          ...(filters.to ? { to: filters.to } : {}),
          ...(filters.machineId ? { machineId: filters.machineId } : {}),
          ...(filters.userId ? { userId: filters.userId } : {}),
          ...(filters.articleCode ? { articleCode: filters.articleCode } : {}),
          ...(filters.shiftId ? { shiftId: filters.shiftId } : {}),
          ...(filters.search ? { search: filters.search } : {}),
          status: filters.status,
        },
        visibleColumns: columns, isDefault: makeDefault,
      });
      return response.json() as Promise<PressingSavedView>;
    },
    onSuccess: saved => {
      setSelectedViewId(String(saved.id));
      void queryClient.invalidateQueries({ queryKey: [ROOT, "views", companyId, userId] });
      toast({ title: "Report view saved" });
    },
    onError: error => toast({ title: "Could not save report view", description: errText(error), variant: "destructive" }),
  });
  const removeMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("POST", ROOT + "/views/" + id + "/remove", {});
    },
    onSuccess: () => {
      setSelectedViewId("");
      setViewName("");
      void queryClient.invalidateQueries({ queryKey: [ROOT, "views", companyId, userId] });
      toast({ title: "Saved view deleted" });
    },
    onError: error => toast({ title: "Could not remove saved view", description: errText(error), variant: "destructive" }),
  });
  // The factory's saved production date can differ from the phone's local date.
  useEffect(() => {
    if (datePresetInitialized.current || !optionsQuery.data?.serverToday || !viewsQuery.data) return;
    datePresetInitialized.current = true;
    if (!viewsQuery.data.some(view => view.isDefault)) {
      const serverToday = optionsQuery.data.serverToday;
      setFilters(old => ({
        ...old, from: serverToday, to: serverToday, page: 1, asOf: undefined,
      }));
    }
  }, [optionsQuery.data?.serverToday, viewsQuery.data]);
  const isCondensed = filters.mode === "condensed";
  const visibleColumns = isCondensed
    ? columns.filter(col => DEFAULT_CONDENSED.includes(col))
    : columns.filter(col => !["bales", "firstScanAt", "lastScanAt"].includes(col));
  const effectiveColumns = visibleColumns.length
    ? visibleColumns : isCondensed ? DEFAULT_CONDENSED : PRESSING_DEFAULT_COLUMNS;
  const report = query.data;
  const totalPages = Math.max(1, Math.ceil((report?.total || 0) / filters.limit));
  const canFilterAll = optionsQuery.data?.canViewAll === true;

  const download = async () => {
    if (exportStatus) return;
    setExportStatus("Downloading all filtered records...");
    try {
      await exportPressingReport(filters, effectiveColumns, setExportStatus);
      toast({ title: "Excel export completed", description: "Downloaded full filtered pressing history." });
    } catch (error) {
      toast({ title: "Excel export failed", description: errText(error), variant: "destructive" });
    } finally {
      setExportStatus("");
    }
  };
  return (
    <Card data-testid="pressing-history-report" className="min-w-0">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-lg">
            <CalendarDays className="h-5 w-5" /> Permanent Pressing History
          </CardTitle>
          <Badge variant="outline">Server records only</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Date-filtered accepted pressing records. Offline pending scans are shown separately above and are not counted.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => {
            const day = optionsQuery.data?.serverToday || today();
            change({ from: day, to: day });
          }}>Today</Button>
          <Button size="sm" variant="outline" onClick={() => {
            const day = optionsQuery.data?.serverToday || today();
            const month = day.slice(0, 7);
            change({ from: month + "-01", to: day });
          }}>This Month</Button>
          <Button size="sm" variant="outline" onClick={() => change({ from: undefined, to: undefined })}>All Time</Button>
          <Button size="sm" variant={isCondensed ? "outline" : "default"} onClick={() => { change({ mode: "detailed" }); setColumns([...PRESSING_DEFAULT_COLUMNS]); }}>Detailed</Button>
          <Button size="sm" variant={isCondensed ? "default" : "outline"} onClick={() => { change({ mode: "condensed" }); setColumns([...DEFAULT_CONDENSED]); }}>Condensed</Button>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <label className="space-y-1 text-xs">From date
            <Input type="date" value={filters.from || ""} onChange={e => change({ from: e.target.value || undefined })} />
          </label>
          <label className="space-y-1 text-xs">To date
            <Input type="date" value={filters.to || ""} onChange={e => change({ to: e.target.value || undefined })} />
          </label>
          <label className="space-y-1 text-xs">Confirmation status
            <select className="h-10 w-full rounded-md border bg-background px-2 text-sm"
              value={filters.status} onChange={e => change({ status: e.target.value as PressingReportFilters["status"] })}>
              <option value="active">Confirmed (active)</option>
              <option value="voided">Voided only</option>
              <option value="all">All, including voided</option>
            </select>
          </label>
          <label className="space-y-1 text-xs">Article code
            <Input placeholder="Article" value={articleText} maxLength={50}
              onChange={e => setArticleText(e.target.value)} />
          </label>
          <label className="space-y-1 text-xs">Reference / bale search
            <Input placeholder="Search reference or name" value={searchText} maxLength={100}
              onChange={e => setSearchText(e.target.value)} />
          </label>
          {canFilterAll && (
            <>
              <label className="space-y-1 text-xs">Machine
                <select className="h-10 w-full rounded-md border bg-background px-2 text-sm"
                  value={filters.machineId || ""} onChange={e => change({ machineId: e.target.value ? Number(e.target.value) : undefined })}>
                  <option value="">All machines</option>
                  {(optionsQuery.data?.machines || []).map(m => <option key={m.id} value={m.id}>{m.code} — {m.name}</option>)}
                </select>
              </label>
              <label className="space-y-1 text-xs">Operator
                <select className="h-10 w-full rounded-md border bg-background px-2 text-sm"
                  value={filters.userId || ""} onChange={e => change({ userId: e.target.value || undefined })}>
                  <option value="">All operators</option>
                  {(optionsQuery.data?.operators || []).map(u => <option key={u.userId} value={u.userId}>{u.name}</option>)}
                </select>
              </label>
            </>
          )}
          <label className="space-y-1 text-xs">Shift ID
            <Input type="number" min={1} value={filters.shiftId || ""}
              onChange={e => change({ shiftId: e.target.value ? Number(e.target.value) : undefined })}
              placeholder="All shifts" />
          </label>
        </div>
        {dateInvalid && <p role="alert" className="text-sm text-destructive">From date cannot be after To date.</p>}
        <div className="flex flex-wrap gap-2 items-center">
          <Button variant="outline" size="sm" onClick={() => setShowColumns(x => !x)}>
            <Filter className="mr-2 h-4 w-4" />Columns ({effectiveColumns.length})
          </Button>
          <Button variant="outline" size="sm" onClick={() => {
            asOfRef.current = null;
            void queryClient.invalidateQueries({ queryKey: keyPrefix });
            void queryClient.invalidateQueries({ queryKey: [ROOT, "options", companyId, userId] });
          }}>
            <RefreshCw className="mr-2 h-4 w-4" />Refresh
          </Button>
          <Button size="sm" disabled={Boolean(exportStatus) || dateInvalid || query.isLoading}
            onClick={() => void download()}>
            <Download className="mr-2 h-4 w-4" />{exportStatus || "Export Excel"}
          </Button>
        </div>
        {showColumns && (
          <div className="rounded-lg border p-3 space-y-2">
            <p className="text-sm font-medium">Visible columns (saved with each view)</p>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {(isCondensed ? DEFAULT_CONDENSED : PRESSING_REPORT_COLUMNS.filter(c =>
                !["bales", "firstScanAt", "lastScanAt"].includes(c))).map(key => (
                <label key={key} className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={columns.includes(key)}
                    onChange={e => setColumns(old => e.target.checked
                      ? [...old, key] : old.filter(c => c !== key))} />
                  {PRESSING_COLUMN_LABELS[key]}
                </label>
              ))}
            </div>
            <Button size="sm" variant="outline" onClick={() => setColumns(isCondensed ? [...DEFAULT_CONDENSED] : [...PRESSING_DEFAULT_COLUMNS])}>
              Reset Columns
            </Button>
          </div>
        )}
        <div className="flex flex-wrap gap-2 items-end rounded-lg border p-3">
          <label className="min-w-[160px] flex-1 space-y-1 text-xs">Saved view
            <select className="h-10 w-full rounded-md border bg-background px-2 text-sm"
              value={selectedViewId} onChange={e => {
                const view = viewsQuery.data?.find(v => String(v.id) === e.target.value);
                if (view) applyView(view); else setSelectedViewId("");
              }}>
              <option value="">Custom filters</option>
              {(viewsQuery.data || []).map(v => <option key={v.id} value={v.id}>
                {v.name}{v.isDefault ? " (default)" : ""}
              </option>)}
            </select>
          </label>
          <label className="min-w-[160px] flex-1 space-y-1 text-xs">View name
            <Input placeholder="My Daily Report" value={viewName} maxLength={120}
              onChange={e => setViewName(e.target.value)} />
          </label>
          <label className="flex items-center gap-2 pb-2 text-xs">
            <input type="checkbox" checked={makeDefault} onChange={e => setMakeDefault(e.target.checked)} />
            Default view
          </label>
          <Button size="sm" disabled={!viewName.trim() || saveMutation.isPending || dateInvalid}
            onClick={() => saveMutation.mutate()}>
            <Save className="mr-2 h-4 w-4" />Save View
          </Button>
          <Button size="sm" variant="outline" disabled={!selectedViewId || removeMutation.isPending}
            onClick={() => removeMutation.mutate(selectedViewId)}>
            <Trash2 className="mr-2 h-4 w-4" />Delete View
          </Button>
        </div>
        {query.isError && <p className="text-sm text-destructive" role="alert">{errText(query.error)}</p>}
        {viewsQuery.isError && <p className="text-sm text-destructive" role="alert">{errText(viewsQuery.error)}</p>}
        {report && (
          <>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
              <div className="rounded-lg border bg-muted/30 p-3"><p className="text-xs text-muted-foreground">Confirmed bales</p>
                <strong className="text-xl">{report.summary.totalBales.toLocaleString()}</strong></div>
              <div className="rounded-lg border bg-muted/30 p-3"><p className="text-xs text-muted-foreground">Confirmed KG</p>
                <strong className="text-xl">{Number(report.summary.totalKg).toLocaleString(undefined, { maximumFractionDigits: 3 })}</strong></div>
              <div className="rounded-lg border bg-muted/30 p-3"><p className="text-xs text-muted-foreground">Voided (not counted)</p>
                <strong className="text-xl">{report.summary.voidedBales.toLocaleString()}</strong></div>
            </div>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[650px] whitespace-nowrap text-left text-sm">
                <thead className="bg-muted">
                  <tr>{effectiveColumns.map(key => <th key={key} className="border-b p-2 font-semibold">
                    {PRESSING_COLUMN_LABELS[key]}
                  </th>)}</tr>
                </thead>
                <tbody>
                  {report.rows.map((row, index) => (
                    <tr key={"id" in row ? row.id : [row.productionDate,row.machineId,row.operatorUserId,row.articleCode,row.shiftId,row.voided,index].join(":")}
                      className="border-b last:border-0">
                      {effectiveColumns.map(key => (
                        <td key={key} className="p-2 tabular-nums">{pressingCell(row, key)}</td>
                      ))}
                    </tr>
                  ))}
                  {report.rows.length === 0 && (
                    <tr><td className="p-5 text-center text-muted-foreground" colSpan={effectiveColumns.length}>
                      No pressing confirmations match these filters.
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {canFilterAll && !isCondensed && (
              <PressingCorrectionReview
                companyId={companyId} userId={userId}
                rows={report.rows.filter((row): row is PressingDetailRow => "id" in row)}
              />
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{report.total.toLocaleString()} {isCondensed ? "groups" : "records"} · Page {report.page} of {totalPages}</span>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" disabled={filters.page <= 1}
                  onClick={() => setFilters(old => ({ ...old, page: Math.max(1, old.page - 1) }))}>
                  <ChevronLeft className="mr-1 h-4 w-4" />Previous
                </Button>
                <Button size="sm" variant="outline" disabled={filters.page >= totalPages}
                  onClick={() => setFilters(old => ({ ...old, page: old.page + 1 }))}>
                  Next<ChevronRight className="ml-1 h-4 w-4" />
                </Button>
              </div>
            </div>
          </>
        )}
        {query.isLoading && <p className="text-sm text-muted-foreground">Loading pressing history...</p>}
      </CardContent>
    </Card>
  );
}
