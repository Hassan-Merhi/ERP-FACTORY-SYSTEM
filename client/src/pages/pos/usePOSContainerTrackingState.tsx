// Extracted from ./POSContainerTracking.tsx to keep that module under the source-size cap.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useOptionalApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { duoMobileText } from "@/i18n/iphoneDuoMobileTranslations";
import { useToast } from "@/hooks/use-toast";
import { getLocalTodayISO } from "./portDeparture";

export interface PosUserContext {
  currentCompanyId?: number | null;
  assignedLocationId?: number | null;
  currentLocationId?: number | null;
}

interface PosContainerRow {
  id: number;
  containerNumber: string;
  supplierName: string | null;
  supplierCode: string | null;
  status: string;
  eta: string | null;
  portDepartureDate: string | null;
  numberPlate: string | null;
  trackingLocation: string | null;
  agent: string | null;
  transporter: string | null;
  docReceived: boolean | null;
  docsSentDate: string | null;
}

interface PosContainerTrackingResponse {
  assignedLocation: {
    id: number;
    name: string;
    code: string;
  };
  total: number;
  containers: PosContainerRow[];
}

type ColumnKey =
  | "container"
  | "supplier"
  | "status"
  | "eta"
  | "portDeparture"
  | "daysSinceDeparture"
  | "truck"
  | "location"
  | "agent"
  | "transporter"
  | "docs"
  | "docsSent";

const COLUMN_PREF_KEY = "pos-container-tracking-visible-columns-v3";

export const COLUMN_DEFS: Array<{ key: ColumnKey; label: string }> = [
  { key: "container", label: "Container #" },
  { key: "supplier", label: "Supplier" },
  { key: "status", label: "Status" },
  { key: "eta", label: "ETA" },
  { key: "portDeparture", label: "Left Port" },
  { key: "daysSinceDeparture", label: "Days Since" },
  { key: "truck", label: "Truck #" },
  { key: "location", label: "Location" },
  { key: "agent", label: "Agent" },
  { key: "transporter", label: "Transporter" },
  { key: "docs", label: "Docs" },
  { key: "docsSent", label: "Docs Sent" },
];

const DEFAULT_VISIBLE_COLUMNS: ColumnKey[] = COLUMN_DEFS.map((column) => column.key);

async function loadPosContainers(): Promise<PosContainerTrackingResponse> {
  const response = await fetch("/api/pos/containers-otw", {
    credentials: "include",
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || "Failed to load containers");
  return body;
}

export function supplierLabel(row: PosContainerRow): string {
  return row.supplierCode || row.supplierName || "—";
}

function containsSearch(row: PosContainerRow, search: string): boolean {
  if (!search) return true;
  const haystack = [
    row.containerNumber,
    row.supplierCode,
    row.supplierName,
    row.status,
    row.eta,
    row.portDepartureDate,
    row.numberPlate,
    row.trackingLocation,
    row.agent,
    row.transporter,
    row.docsSentDate,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(search);
}

function uniqueValues(rows: PosContainerRow[], selector: (row: PosContainerRow) => string | null): string[] {
  return Array.from(new Set(rows.map(selector).filter((value): value is string => Boolean(value?.trim())))).sort(
    (a, b) => a.localeCompare(b)
  );
}

export function PortDepartureDateCell({
  container,
  todayISO,
  mobile = false,
  draft,
  onDraftChange,
}: {
  container: PosContainerRow;
  todayISO: string;
  mobile?: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/pos/containers-otw/${container.id}/departure-date`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ portDepartureDate: draft || null }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message || "Could not save departure date");
      return body as { id: number; portDepartureDate: string | null };
    },
    onSuccess: (updated) => {
      queryClient.setQueriesData<PosContainerTrackingResponse>({ queryKey: ["/api/pos/containers-otw"] }, (cached) =>
        cached
          ? {
              ...cached,
              containers: cached.containers.map((row) =>
                row.id === updated.id ? { ...row, portDepartureDate: updated.portDepartureDate } : row
              ),
            }
          : cached
      );
      void queryClient.invalidateQueries({ queryKey: ["/api/pos/containers-otw"] });
      toast({ title: "Departure date saved" });
    },
    onError: (error: Error) => {
      toast({ title: "Could not save departure date", description: error.message, variant: "destructive" });
    },
  });

  const dirty = draft !== (container.portDepartureDate ?? "");
  return (
    <div className="flex items-center gap-1">
      <Input
        type="date"
        value={draft}
        max={todayISO}
        onChange={(event) => onDraftChange(event.target.value)}
        disabled={mutation.isPending}
        className="h-8 w-[145px] min-w-[145px] text-xs"
        aria-label={`Date ${container.containerNumber} left the port`}
        data-testid={`${mobile ? "mobile-" : ""}input-port-departure-${container.id}`}
      />
      {dirty ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-1 px-2"
          disabled={mutation.isPending || Boolean(draft && draft > todayISO)}
          onClick={() => mutation.mutate()}
          aria-label={`Save port departure date for ${container.containerNumber}`}
          data-testid={`${mobile ? "mobile-" : ""}button-save-port-departure-${container.id}`}
        >
          {mutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Save
        </Button>
      ) : null}
    </div>
  );
}

export function usePOSContainerTrackingState({ posUser }: { posUser?: PosUserContext }) {
  const language = useOptionalApplicationLanguage()?.language ?? "en";
  const dt = (key: Parameters<typeof duoMobileText>[0]) => duoMobileText(key, language);
  const [, setLocation] = useLocation();
  const { formatDisplayDate } = useDateFormat();
  const [todayISO, setTodayISO] = useState(() => getLocalTodayISO());
  // Shared by phone cards and desktop rows so an unsaved edit survives a fold,
  // rotation, or split-screen resize without cross-company drafts.
  const [portDateDrafts, setPortDateDrafts] = useState<Record<number, string>>({});
  useEffect(() => setPortDateDrafts({}), [posUser?.currentCompanyId]);
  const departureEditorProps = (container: PosContainerRow) => ({
    draft: portDateDrafts[container.id] ?? container.portDepartureDate ?? "",
    onDraftChange: (value: string) => setPortDateDrafts((previous) => ({ ...previous, [container.id]: value })),
  });
  useEffect(() => {
    const refreshToday = () => setTodayISO(getLocalTodayISO());
    const interval = window.setInterval(refreshToday, 60_000);
    return () => window.clearInterval(interval);
  }, []);
  const [search, setSearch] = useState("");
  const [supplierFilter, setSupplierFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [transporterFilter, setTransporterFilter] = useState("all");
  const [agentFilter, setAgentFilter] = useState("all");
  const [docsFilter, setDocsFilter] = useState("all");
  const [visibleColumns, setVisibleColumns] = useState<Set<ColumnKey>>(() => {
    if (typeof window === "undefined") return new Set(DEFAULT_VISIBLE_COLUMNS);
    try {
      const saved = window.localStorage.getItem(COLUMN_PREF_KEY);
      const previous = saved === null ? window.localStorage.getItem("pos-container-tracking-visible-columns-v2") : null;
      const parsed = JSON.parse(saved ?? previous ?? "[]") as ColumnKey[];
      const valid = parsed.filter((key) => COLUMN_DEFS.some((column) => column.key === key));
      const newlyAdded = previous !== null ? (["portDeparture", "daysSinceDeparture"] as ColumnKey[]) : [];
      return new Set<ColumnKey>(
        valid.length > 0
          ? ["container", ...valid.filter((key) => key !== "container"), ...newlyAdded]
          : DEFAULT_VISIBLE_COLUMNS
      );
    } catch {
      return new Set(DEFAULT_VISIBLE_COLUMNS);
    }
  });

  const { data, isLoading, isError, error } = useQuery<PosContainerTrackingResponse>({
    queryKey: [
      "/api/pos/containers-otw",
      posUser?.currentCompanyId ?? null,
      posUser?.assignedLocationId ?? posUser?.currentLocationId ?? null,
    ],
    queryFn: loadPosContainers,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(COLUMN_PREF_KEY, JSON.stringify(Array.from(visibleColumns)));
  }, [visibleColumns]);

  const containers = useMemo(() => data?.containers ?? [], [data?.containers]);
  const normalizedSearch = search.trim().toLowerCase();
  const supplierOptions = useMemo(() => uniqueValues(containers, supplierLabel), [containers]);
  const statusOptions = useMemo(() => uniqueValues(containers, (row) => row.status), [containers]);
  const transporterOptions = useMemo(() => uniqueValues(containers, (row) => row.transporter), [containers]);
  const agentOptions = useMemo(() => uniqueValues(containers, (row) => row.agent), [containers]);

  const visibleContainers = useMemo(
    () =>
      containers.filter((row) => {
        if (!containsSearch(row, normalizedSearch)) return false;
        if (supplierFilter !== "all" && supplierLabel(row) !== supplierFilter) return false;
        if (statusFilter !== "all" && row.status !== statusFilter) return false;
        if (transporterFilter !== "all" && row.transporter !== transporterFilter) return false;
        if (agentFilter !== "all" && row.agent !== agentFilter) return false;
        if (docsFilter === "received" && !row.docReceived) return false;
        if (docsFilter === "missing" && row.docReceived) return false;
        if (docsFilter === "sent" && !row.docsSentDate) return false;
        if (docsFilter === "ready-not-sent" && !(row.docReceived && !row.docsSentDate)) return false;
        return true;
      }),
    [agentFilter, containers, docsFilter, normalizedSearch, statusFilter, supplierFilter, transporterFilter]
  );

  const summary = useMemo(
    () => ({
      total: containers.length,
      withTruck: containers.filter((row) => Boolean(row.numberPlate?.trim())).length,
      docsReceived: containers.filter((row) => row.docReceived).length,
      docsReadyNotSent: containers.filter((row) => row.docReceived && !row.docsSentDate).length,
    }),
    [containers]
  );

  const hasActiveFilters =
    Boolean(search.trim()) ||
    supplierFilter !== "all" ||
    statusFilter !== "all" ||
    transporterFilter !== "all" ||
    agentFilter !== "all" ||
    docsFilter !== "all";

  const clearFilters = () => {
    setSearch("");
    setSupplierFilter("all");
    setStatusFilter("all");
    setTransporterFilter("all");
    setAgentFilter("all");
    setDocsFilter("all");
  };

  const toggleColumn = (key: ColumnKey) => {
    if (key === "container") return;
    setVisibleColumns((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const isColumnVisible = (key: ColumnKey) => visibleColumns.has(key);
  return {
    agentFilter,
    agentOptions,
    clearFilters,
    data,
    departureEditorProps,
    docsFilter,
    dt,
    error,
    formatDisplayDate,
    hasActiveFilters,
    isColumnVisible,
    isError,
    isLoading,
    search,
    setAgentFilter,
    setDocsFilter,
    setLocation,
    setSearch,
    setStatusFilter,
    setSupplierFilter,
    setTransporterFilter,
    statusFilter,
    statusOptions,
    summary,
    supplierFilter,
    supplierOptions,
    todayISO,
    toggleColumn,
    transporterFilter,
    transporterOptions,
    visibleColumns,
    visibleContainers,
  };
}
