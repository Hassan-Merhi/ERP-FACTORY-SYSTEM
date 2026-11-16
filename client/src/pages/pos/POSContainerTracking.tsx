import {
  CheckCircle2,
  Columns3,
  FileClock,
  FilterX,
  MapPin,
  PackageSearch,
  Search,
  Snowflake,
  Truck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/PageHeader";
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
import { daysSincePortDeparture } from "./portDeparture";
import "@/styles/pos-container-premium.css";
import {
  COLUMN_DEFS,
  PortDepartureDateCell,
  supplierLabel,
  usePOSContainerTrackingState,
  type PosUserContext,
} from "./usePOSContainerTrackingState";

export default function POSContainerTracking(props: { posUser?: PosUserContext }) {
  const {
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
  } = usePOSContainerTrackingState(props);

  return (
    <div
      className="pos-containers-page flex h-full min-h-0 flex-col gap-3 overflow-hidden p-3 sm:p-4"
      data-testid="pos-container-tracking-page"
    >
      <div className="pos-container-seasonal" aria-hidden="true">
        <Snowflake className="h-5 w-5" />
        <Snowflake className="mt-5 h-3 w-3" />
      </div>
      <PageHeader
        title="Containers OTW"
        icon={<PackageSearch className="h-5 w-5" aria-hidden="true" />}
        meta={
          <>
            <span className="flex items-center gap-1.5">
              <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
              <span>
                {data?.assignedLocation?.name
                  ? `Only containers assigned to ${data.assignedLocation.name}`
                  : "Only containers for your assigned location"}
              </span>
            </span>
            <span className="pos-containers-count" data-testid="text-pos-container-count">
              {data ? (
                <>
                  <Badge variant="secondary" data-pos-shown-badge="true">
                    {visibleContainers.length} shown
                  </Badge>
                  <span>{data.total} active</span>
                </>
              ) : null}
            </span>
          </>
        }
      />

      <div className="pos-container-kpis grid shrink-0 grid-cols-2 gap-2.5 lg:grid-cols-4">
        <div className="pos-container-kpi" data-kpi-tone="violet">
          <span className="pos-container-kpi-icon">
            <PackageSearch className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="pos-container-kpi-label">Active</p>
            <p className="pos-container-kpi-value">{isLoading ? "—" : summary.total}</p>
          </div>
        </div>
        <div className="pos-container-kpi" data-kpi-tone="orange">
          <span className="pos-container-kpi-icon">
            <Truck className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="pos-container-kpi-label">Truck Assigned</p>
            <p className="pos-container-kpi-value">{isLoading ? "—" : summary.withTruck}</p>
          </div>
        </div>
        <div className="pos-container-kpi" data-kpi-tone="green">
          <span className="pos-container-kpi-icon">
            <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="pos-container-kpi-label">Docs Received</p>
            <p className="pos-container-kpi-value">{isLoading ? "—" : summary.docsReceived}</p>
          </div>
        </div>
        <div className="pos-container-kpi" data-kpi-tone="blue">
          <span className="pos-container-kpi-icon">
            <FileClock className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="pos-container-kpi-label">Docs To Send</p>
            <p className="pos-container-kpi-value">{isLoading ? "—" : summary.docsReadyNotSent}</p>
          </div>
        </div>
      </div>

      <div className="pos-container-filters shrink-0">
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

      <section
        className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-4 md:hidden phone-land:block"
        aria-label={dt("containersOnWay")}
        data-testid="pos-container-mobile-list"
      >
        {isLoading ? (
          Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-32 w-full rounded-xl" />)
        ) : isError ? (
          <div role="alert" className="rounded-xl border p-5 text-sm text-destructive">
            {dt("cannotLoadContainers")} {error instanceof Error ? error.message : dt("pleaseRetry")}
          </div>
        ) : visibleContainers.length === 0 ? (
          <p className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">
            {dt("noMatchingContainers")}
          </p>
        ) : (
          visibleContainers.map((container) => (
            <article
              key={container.id}
              className="pos-container-mobile-card min-w-0 p-3"
              data-testid={`pos-container-mobile-${container.id}`}
            >
              <div className="flex min-w-0 items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => setLocation(`/pos-containers/${container.id}`)}
                    className="min-h-11 break-all text-left font-mono text-base font-bold text-primary underline-offset-4 hover:underline"
                    data-testid={`pos-container-mobile-open-${container.id}`}
                  >
                    {container.containerNumber}
                  </button>
                  {isColumnVisible("supplier") && (
                    <p className="break-words text-xs text-muted-foreground">{supplierLabel(container)}</p>
                  )}
                </div>
                {isColumnVisible("status") && (
                  <Badge variant="outline" className="pos-container-status max-w-[45%] break-words text-right">
                    {container.status}
                  </Badge>
                )}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 rounded-lg bg-muted/30 p-2 text-xs">
                {isColumnVisible("eta") && (
                  <div>
                    <span className="block text-muted-foreground">ETA</span>
                    <strong>{container.eta ? formatDisplayDate(container.eta) : "—"}</strong>
                  </div>
                )}
                {isColumnVisible("daysSinceDeparture") && (
                  <div>
                    <span className="block text-muted-foreground">{dt("daysSincePort")}</span>
                    <strong className="tabular-nums">
                      {daysSincePortDeparture(container.portDepartureDate, todayISO) ?? "—"}
                    </strong>
                  </div>
                )}
                {isColumnVisible("truck") && (
                  <div>
                    <span className="block text-muted-foreground">{dt("truck")}</span>
                    <strong className="break-all">{container.numberPlate || "—"}</strong>
                  </div>
                )}
                {isColumnVisible("docs") && (
                  <div>
                    <span className="block text-muted-foreground">{dt("documents")}</span>
                    <strong>{dt(container.docReceived ? "received" : "pending")}</strong>
                  </div>
                )}
              </div>
              <details className="mt-3 rounded-lg border">
                <summary className="min-h-11 cursor-pointer px-3 py-3 text-sm font-medium">
                  {dt("moreTrackingDetails")}
                </summary>
                <dl className="space-y-2 border-t p-3 text-xs">
                  {isColumnVisible("location") && (
                    <div>
                      <dt className="text-muted-foreground">{dt("location")}</dt>
                      <dd className="break-words font-medium">{container.trackingLocation || "—"}</dd>
                    </div>
                  )}
                  {isColumnVisible("transporter") && (
                    <div>
                      <dt className="text-muted-foreground">{dt("transporter")}</dt>
                      <dd className="break-words font-medium">{container.transporter || "—"}</dd>
                    </div>
                  )}
                  {isColumnVisible("agent") && (
                    <div>
                      <dt className="text-muted-foreground">{dt("agent")}</dt>
                      <dd className="break-words font-medium">{container.agent || "—"}</dd>
                    </div>
                  )}
                  {isColumnVisible("docsSent") && (
                    <div>
                      <dt className="text-muted-foreground">{dt("docsSent")}</dt>
                      <dd className="font-medium">
                        {container.docsSentDate
                          ? formatDisplayDate(container.docsSentDate)
                          : container.docReceived
                            ? dt("notSent")
                            : "—"}
                      </dd>
                    </div>
                  )}
                </dl>
              </details>
              {isColumnVisible("portDeparture") && (
                <div className="mt-3">
                  <p className="mb-1 text-xs font-medium text-muted-foreground">{dt("leftPort")}</p>
                  <PortDepartureDateCell
                    container={container}
                    todayISO={todayISO}
                    mobile
                    {...departureEditorProps(container)}
                  />
                </div>
              )}
            </article>
          ))
        )}
      </section>
      <div
        className="pos-container-table hidden min-h-[320px] flex-1 overflow-auto md:block phone-land:hidden"
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
            <TableHeader className="sticky top-0 z-10">
              <TableRow>
                {isColumnVisible("container") ? <TableHead className="whitespace-nowrap">Container #</TableHead> : null}
                {isColumnVisible("supplier") ? <TableHead className="whitespace-nowrap">Supplier</TableHead> : null}
                {isColumnVisible("status") ? <TableHead className="whitespace-nowrap">Status</TableHead> : null}
                {isColumnVisible("eta") ? <TableHead className="whitespace-nowrap">ETA</TableHead> : null}
                {isColumnVisible("portDeparture") ? (
                  <TableHead className="whitespace-nowrap">Left Port</TableHead>
                ) : null}
                {isColumnVisible("daysSinceDeparture") ? (
                  <TableHead className="whitespace-nowrap">Days Since</TableHead>
                ) : null}
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
                        <Badge variant="outline" className="pos-container-status">
                          {container.status}
                        </Badge>
                      </TableCell>
                    ) : null}
                    {isColumnVisible("eta") ? (
                      <TableCell className="whitespace-nowrap">
                        {container.eta ? formatDisplayDate(container.eta) : "—"}
                      </TableCell>
                    ) : null}
                    {isColumnVisible("portDeparture") ? (
                      <TableCell className="whitespace-nowrap">
                        <PortDepartureDateCell
                          container={container}
                          todayISO={todayISO}
                          {...departureEditorProps(container)}
                        />
                      </TableCell>
                    ) : null}
                    {isColumnVisible("daysSinceDeparture") ? (
                      <TableCell
                        className="whitespace-nowrap tabular-nums"
                        data-testid={`days-since-port-departure-${container.id}`}
                      >
                        {daysSincePortDeparture(container.portDepartureDate, todayISO) ?? "—"}
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
