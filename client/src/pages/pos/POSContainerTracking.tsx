import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { CheckCircle2, Columns3, FileClock, FilterX, MapPin, PackageSearch, Search, Truck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useDateFormat } from "@/contexts/DateFormatContext";

interface PosUserContext {
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
  "container" | "supplier" | "status" | "eta" | "truck" | "location" | "agent" | "transporter" | "docs" | "docsSent";

const COLUMN_PREF_KEY = "pos-container-tracking-visible-columns-v2";

const COLUMN_DEFS: Array<{ key: ColumnKey; label: string }> = [
  { key: "container", label: "Container #" },
  { key: "supplier", label: "Supplier" },
  { key: "status", label: "Status" },
  { key: "eta", label: "ETA" },
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
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || "Failed to load containers");
  return body;
}

function supplierLabel(row: PosContainerRow): string {
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

export default function POSContainerTracking({ posUser }: { posUser?: PosUserContext }) {
  const [, setLocation] = useLocation();
  const { formatDisplayDate } = useDateFormat();
  const [search, setSearch] = useState("");
  const [supplierFilter, setSupplierFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [transporterFilter, setTransporterFilter] = useState("all");
  const [agentFilter, setAgentFilter] = useState("all");
  const [docsFilter, setDocsFilter] = useState("all");
  const [visibleColumns, setVisibleColumns] = useState<Set<ColumnKey>>(() => {
    if (typeof window === "undefined") return new Set(DEFAULT_VISIBLE_COLUMNS);
    try {
      const parsed = JSON.parse(window.localStorage.getItem(COLUMN_PREF_KEY) || "[]") as ColumnKey[];
      const valid = parsed.filter((key) => COLUMN_DEFS.some((column) => column.key === key));
      return new Set<ColumnKey>(
        valid.length > 0 ? ["container", ...valid.filter((key) => key !== "container")] : DEFAULT_VISIBLE_COLUMNS
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

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-3 overflow-hidden p-3 sm:p-4"
      data-testid="pos-container-tracking-page"
    >
      <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <PackageSearch className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Containers OTW</h1>
              <div className="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
                <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                <span>
                  {data?.assignedLocation?.name
                    ? `Only containers assigned to ${data.assignedLocation.name}`
                    : "Only containers for your assigned location"}
                </span>
              </div>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="text-pos-container-count">
          {data ? (
            <>
              <Badge variant="secondary">{visibleContainers.length} shown</Badge>
              <span>{data.total} active</span>
            </>
          ) : null}
        </div>
      </div>

      <div className="grid shrink-0 grid-cols-2 gap-2 lg:grid-cols-4">
        <div className="rounded-xl border bg-card/60 px-3 py-2.5 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Active</p>
            <PackageSearch className="h-4 w-4 text-primary" aria-hidden="true" />
          </div>
          <p className="mt-0.5 text-xl font-semibold tabular-nums sm:text-2xl">{isLoading ? "—" : summary.total}</p>
        </div>
        <div className="rounded-xl border bg-card/60 px-3 py-2.5 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Truck Assigned</p>
            <Truck className="h-4 w-4 text-primary" aria-hidden="true" />
          </div>
          <p className="mt-0.5 text-xl font-semibold tabular-nums sm:text-2xl">{isLoading ? "—" : summary.withTruck}</p>
        </div>
        <div className="rounded-xl border bg-card/60 px-3 py-2.5 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Docs Received</p>
            <CheckCircle2 className="h-4 w-4 text-primary" aria-hidden="true" />
          </div>
          <p className="mt-0.5 text-xl font-semibold tabular-nums sm:text-2xl">
            {isLoading ? "—" : summary.docsReceived}
          </p>
        </div>
        <div className="rounded-xl border bg-card/60 px-3 py-2.5 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Docs To Send</p>
            <FileClock className="h-4 w-4 text-primary" aria-hidden="true" />
          </div>
          <p className="mt-0.5 text-xl font-semibold tabular-nums sm:text-2xl">
            {isLoading ? "—" : summary.docsReadyNotSent}
          </p>
        </div>
      </div>

      <div className="shrink-0 rounded-xl border bg-card/40 p-2.5 shadow-sm">
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search
              className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search container, supplier, truck, location, agent, transporter..."
              className="h-9 pl-9"
              data-testid="input-pos-container-search"
            />
          </div>

          {hasActiveFilters ? (
            <Button variant="ghost" size="sm" className="h-9 shrink-0 gap-2" onClick={clearFilters}>
              <FilterX className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">Clear</span>
            </Button>
          ) : null}
        </div>

        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Select value={supplierFilter} onValueChange={setSupplierFilter}>
            <SelectTrigger className="h-9 w-full min-w-0" data-testid="select-pos-container-supplier">
              <SelectValue placeholder="Supplier" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All suppliers</SelectItem>
              {supplierOptions.map((supplier) => (
                <SelectItem key={supplier} value={supplier}>
                  {supplier}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-9 w-full min-w-0" data-testid="select-pos-container-status">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {statusOptions.map((status) => (
                <SelectItem key={status} value={status}>
                  {status}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={docsFilter} onValueChange={setDocsFilter}>
            <SelectTrigger className="h-9 w-full min-w-0" data-testid="select-pos-container-docs">
              <SelectValue placeholder="Docs" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All docs</SelectItem>
              <SelectItem value="received">Docs received</SelectItem>
              <SelectItem value="missing">Docs not received</SelectItem>
              <SelectItem value="sent">Docs sent</SelectItem>
              <SelectItem value="ready-not-sent">Received, not sent</SelectItem>
            </SelectContent>
          </Select>

          <Select value={transporterFilter} onValueChange={setTransporterFilter}>
            <SelectTrigger className="h-9 w-full min-w-0" data-testid="select-pos-container-transporter">
              <SelectValue placeholder="Transporter" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All transporters</SelectItem>
              {transporterOptions.map((transporter) => (
                <SelectItem key={transporter} value={transporter}>
                  {transporter}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={agentFilter} onValueChange={setAgentFilter}>
            <SelectTrigger className="h-9 w-full min-w-0" data-testid="select-pos-container-agent">
              <SelectValue placeholder="Agent" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All agents</SelectItem>
              {agentOptions.map((agent) => (
                <SelectItem key={agent} value={agent}>
                  {agent}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="h-9 w-full gap-2" data-testid="button-pos-container-columns">
                <Columns3 className="h-4 w-4" aria-hidden="true" />
                Columns
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {COLUMN_DEFS.map((column) => (
                <DropdownMenuCheckboxItem
                  key={column.key}
                  checked={isColumnVisible(column.key)}
                  disabled={column.key === "container"}
                  onCheckedChange={() => toggleColumn(column.key)}
                  onSelect={(event) => event.preventDefault()}
                >
                  {column.label}
                  {column.key === "container" ? " (fixed)" : ""}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div
        className="min-h-[320px] flex-1 overflow-auto rounded-xl border bg-card/30 shadow-sm"
        data-table-scroll-region
      >
        {isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 7 }).map((_, index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : isError ? (
          <div className="flex min-h-52 items-center justify-center p-6 text-center">
            <div>
              <p className="font-medium">Could not load containers</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {error instanceof Error ? error.message : "Unknown error"}
              </p>
            </div>
          </div>
        ) : (
          <Table className="min-w-[1120px]">
            <TableHeader className="sticky top-0 z-10 bg-background/95 backdrop-blur">
              <TableRow>
                {isColumnVisible("container") ? <TableHead className="whitespace-nowrap">Container #</TableHead> : null}
                {isColumnVisible("supplier") ? <TableHead className="whitespace-nowrap">Supplier</TableHead> : null}
                {isColumnVisible("status") ? <TableHead className="whitespace-nowrap">Status</TableHead> : null}
                {isColumnVisible("eta") ? <TableHead className="whitespace-nowrap">ETA</TableHead> : null}
                {isColumnVisible("truck") ? <TableHead className="whitespace-nowrap">Truck #</TableHead> : null}
                {isColumnVisible("location") ? <TableHead className="whitespace-nowrap">Location</TableHead> : null}
                {isColumnVisible("agent") ? <TableHead className="whitespace-nowrap">Agent</TableHead> : null}
                {isColumnVisible("transporter") ? (
                  <TableHead className="whitespace-nowrap">Transporter</TableHead>
                ) : null}
                {isColumnVisible("docs") ? <TableHead className="whitespace-nowrap">Docs</TableHead> : null}
                {isColumnVisible("docsSent") ? <TableHead className="whitespace-nowrap">Docs Sent</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleContainers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={visibleColumns.size} className="h-32 text-center text-muted-foreground">
                    {hasActiveFilters
                      ? "No containers match the current filters"
                      : "No active containers for your assigned location"}
                  </TableCell>
                </TableRow>
              ) : (
                visibleContainers.map((container) => (
                  <TableRow
                    key={container.id}
                    className="h-11 transition-colors hover:bg-muted/40"
                    data-testid={`row-pos-container-${container.id}`}
                  >
                    {isColumnVisible("container") ? (
                      <TableCell className="whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => setLocation(`/pos-containers/${container.id}`)}
                          className="font-mono font-semibold text-primary underline-offset-4 hover:underline"
                          data-testid={`link-pos-container-${container.id}`}
                        >
                          {container.containerNumber}
                        </button>
                      </TableCell>
                    ) : null}
                    {isColumnVisible("supplier") ? (
                      <TableCell className="whitespace-nowrap font-medium">{supplierLabel(container)}</TableCell>
                    ) : null}
                    {isColumnVisible("status") ? (
                      <TableCell className="whitespace-nowrap">
                        <Badge variant="outline">{container.status}</Badge>
                      </TableCell>
                    ) : null}
                    {isColumnVisible("eta") ? (
                      <TableCell className="whitespace-nowrap">
                        {container.eta ? formatDisplayDate(container.eta) : "—"}
                      </TableCell>
                    ) : null}
                    {isColumnVisible("truck") ? (
                      <TableCell className="whitespace-nowrap font-mono">{container.numberPlate || "—"}</TableCell>
                    ) : null}
                    {isColumnVisible("location") ? (
                      <TableCell className="whitespace-nowrap">{container.trackingLocation || "—"}</TableCell>
                    ) : null}
                    {isColumnVisible("agent") ? (
                      <TableCell className="whitespace-nowrap">{container.agent || "—"}</TableCell>
                    ) : null}
                    {isColumnVisible("transporter") ? (
                      <TableCell className="whitespace-nowrap">{container.transporter || "—"}</TableCell>
                    ) : null}
                    {isColumnVisible("docs") ? (
                      <TableCell className="whitespace-nowrap">
                        {container.docReceived ? (
                          <Badge className="border-emerald-500/20 bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400">
                            Received
                          </Badge>
                        ) : (
                          <Badge variant="secondary">Pending</Badge>
                        )}
                      </TableCell>
                    ) : null}
                    {isColumnVisible("docsSent") ? (
                      <TableCell className="whitespace-nowrap">
                        {container.docsSentDate ? (
                          formatDisplayDate(container.docsSentDate)
                        ) : container.docReceived ? (
                          <Badge className="border-amber-500/20 bg-amber-500/10 text-amber-600 hover:bg-amber-500/10 dark:text-amber-400">
                            Not sent
                          </Badge>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
