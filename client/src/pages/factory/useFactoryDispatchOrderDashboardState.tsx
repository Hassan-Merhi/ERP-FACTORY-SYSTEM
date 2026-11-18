// Extracted from ./FactoryDispatchOrderDashboard.tsx to keep that module under the source-size cap.
import { useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Activity, ChevronDown, FileSpreadsheet, History, ReceiptText, Truck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useToast } from "@/hooks/use-toast";
import { downloadFromUrl, exportFileName } from "@/lib/exportFile";
import {
  fmtAmount,
  json,
  type HistoryPage,
  type Overview,
  type Props,
  type ReleaseGate,
  type Section,
  type Source,
} from "./FactoryDispatchOrderDashboardTypes";

export function useFactoryDispatchOrderDashboardState({
  orderId,
  companyId,
  onOpenTrip,
  onCompareAll,
  onPhysicalReport,
}: Props) {
  const { formatDisplayDateTime } = useDateFormat();
  const [section, setSection] = useState<Section>("TRIPS");
  const [source, setSource] = useState<Source>("ALL");
  const [filterTrip, setFilterTrip] = useState("ALL");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const base = "/api/factory/customer-orders/" + orderId + "/loading-dispatches/order-overview";
  const { toast } = useToast();
  const [exportingExcel, setExportingExcel] = useState(false);
  const exportOrderExcel = async () => {
    setExportingExcel(true);
    try {
      await downloadFromUrl(base + "/report.xlsx", { fileName: exportFileName("dispatch order " + orderId, "xlsx") });
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setExportingExcel(false);
    }
  };
  const scopeKey = companyQueryKey(base, companyId);
  const info = useQuery<Overview>({
    queryKey: scopeKey,
    queryFn: () => json<Overview>(base),
    enabled: Boolean(companyId) && Number.isSafeInteger(orderId) && orderId > 0,
    refetchInterval: 20000,
  });
  const gate = useQuery<ReleaseGate>({
    queryKey: companyQueryKey(base.replace("/order-overview", "/release-readiness"), companyId),
    queryFn: () => json<ReleaseGate>(base.replace("/order-overview", "/release-readiness")),
    enabled: Boolean(companyId) && Number.isSafeInteger(orderId) && orderId > 0,
    // Run automatically and refresh after the order-level evidence changes.
    staleTime: 0,
    refetchInterval: 20000,
    refetchOnWindowFocus: true,
  });
  const value = info.data;
  const history = useInfiniteQuery<HistoryPage, Error>({
    queryKey: [...scopeKey, "history", source, filterTrip],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ source, limit: "25" });
      if (pageParam) params.set("cursor", String(pageParam));
      if (filterTrip !== "ALL") params.set("dispatchId", filterTrip);
      return json<HistoryPage>(base + "/history?" + params.toString());
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(companyId) && section === "HISTORY",
  });
  const historyRows = useMemo(() => history.data?.pages.flatMap((page) => page.entries) ?? [], [history.data]);
  const filteredTrips = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (value?.trips ?? []).filter(
      (t) =>
        !q ||
        [String(t.dispatchNumber), t.status, t.financialStatus, t.notes, t.poNumber, t.supplierCode].some((v) =>
          String(v ?? "")
            .toLowerCase()
            .includes(q)
        )
    );
  }, [value?.trips, search]);
  const date = (s: string | null | undefined) => (s ? formatDisplayDateTime(s) : "—");
  const label = (s: string) =>
    s
      .replaceAll("_", " ")
      .toLowerCase()
      .replace(/(^|\s)\S/g, (v) => v.toUpperCase());
  const sectionItems: Array<{ id: Section; title: string; count?: number; icon: typeof Truck }> = [
    { id: "TRIPS", title: "Trucks", count: value?.trips.length, icon: Truck },
    { id: "CHARGES", title: "Charges", count: value?.charges.length, icon: ReceiptText },
    { id: "PO_FILES", title: "ERP PO files", count: value?.summary.generatedPoFiles, icon: FileSpreadsheet },
    { id: "HISTORY", title: "History", icon: History },
  ];
  return {
    date,
    expanded,
    exportOrderExcel,
    exportingExcel,
    filterTrip,
    filteredTrips,
    gate,
    history,
    historyRows,
    info,
    label,
    onCompareAll,
    onOpenTrip,
    onPhysicalReport,
    orderId,
    search,
    section,
    sectionItems,
    setExpanded,
    setFilterTrip,
    setSearch,
    setSection,
    setSource,
    source,
    value,
  };
}

export function FactoryDispatchOrderDashboardSection({
  date,
  expanded,
  historyRows,
  label,
  setExpanded,
}: Pick<
  ReturnType<typeof useFactoryDispatchOrderDashboardState>,
  "date" | "expanded" | "historyRows" | "label" | "setExpanded"
>) {
  return (
    <div className="space-y-2">
      {historyRows.map((evt) => {
        const key = evt.source + ":" + evt.id;
        return (
          <div key={key} className="rounded-lg border border-border p-3 text-xs">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-blue-600" />
                <span className="font-semibold">{label(evt.eventType)}</span>
                <Badge variant="outline">{label(evt.source)}</Badge>
              </div>
              <span className="text-muted-foreground">{date(evt.createdAt)}</span>
            </div>
            <div className="mt-1 text-muted-foreground">
              {evt.dispatchId ? "Trip ID #" + evt.dispatchId + " · " : "Order-wide · "}
              {evt.actorUsername}
              {evt.reason ? " · Reason: " + evt.reason : ""}
            </div>
            <button
              type="button"
              onClick={() => setExpanded(expanded === key ? null : key)}
              className="mt-2 inline-flex items-center gap-1 text-blue-700 hover:underline dark:text-blue-300"
              aria-expanded={expanded === key}
            >
              <ChevronDown className="h-3.5 w-3.5" /> Original event details
            </button>
            {expanded === key && (
              <pre className="mt-2 max-h-60 overflow-auto rounded-lg bg-muted/60 p-2 text-[11px] leading-relaxed">
                {JSON.stringify(evt.details, null, 2)}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function FactoryDispatchOrderDashboardSection2({
  date,
  filteredTrips,
  label,
  onOpenTrip,
  search,
  setSearch,
}: Pick<
  ReturnType<typeof useFactoryDispatchOrderDashboardState>,
  "date" | "filteredTrips" | "label" | "onOpenTrip" | "search" | "setSearch"
>) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          One row per physical trip, with separate live POST accounting evidence.
        </p>
        <Input
          className="h-9 w-full sm:w-60"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search trip, PO or status…"
          aria-label="Search financial trip reports"
        />
      </div>
      {!filteredTrips.length && (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          No matching trips.
        </p>
      )}
      <div className="space-y-2">
        {filteredTrips.map((t) => (
          <div
            key={t.id}
            className="rounded-xl border border-border bg-card p-3"
            data-testid={"dispatch-overview-trip-" + t.id}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Truck className="h-4 w-4 text-blue-600" />
                <span className="font-semibold text-sm">Trip #{String(t.dispatchNumber).padStart(3, "0")}</span>
                <Badge variant="outline">{label(t.status)}</Badge>
                <Badge variant="secondary">{label(t.financialStatus)}</Badge>
              </div>
              <Button size="sm" variant="outline" onClick={() => onOpenTrip(Number(t.id))}>
                Open trip
              </Button>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs md:grid-cols-4">
              <div>
                <span className="text-muted-foreground">Scanned</span>
                <p className="font-mono font-medium">
                  {t.scannedBales} bales · {fmtAmount(t.scannedWeightKg)} kg
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">Posted goods</span>
                <p className="font-mono font-medium">$ {fmtAmount(t.goodsSubtotal)}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Customer charges / discounts</span>
                <p className="font-mono font-medium">
                  + {fmtAmount(t.billableCharges)} / − {fmtAmount(t.discounts)}
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">Previously posted receivable</span>
                <p className="font-mono font-semibold">$ {fmtAmount(t.customerTotal)}</p>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap justify-between gap-2 border-t border-border pt-2 text-[11px] text-muted-foreground">
              <span>
                Closed: {date(t.closedAt)} · POST ID: {t.postingId ?? "Not posted"}
              </span>
              <span>PO Excel: {t.exportedAt ? "Generated — import not confirmed" : "Not generated"}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
