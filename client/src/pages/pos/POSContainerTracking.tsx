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
import "@/styles/pos-container-premium.css";
import { COLUMN_DEFS, type PosUserContext } from "./usePOSContainerTrackingState";
import { usePOSContainerTrackingState2 } from "./usePOSContainerTrackingState2";
import { POSContainerTrackingSection } from "./POSContainerTrackingSection";
import { POSContainerTrackingPosContainerMobileList } from "./POSContainerTrackingPosContainerMobileList";

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
  } = usePOSContainerTrackingState2(props);

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

      <POSContainerTrackingPosContainerMobileList
        departureEditorProps={departureEditorProps}
        dt={dt}
        error={error}
        formatDisplayDate={formatDisplayDate}
        isColumnVisible={isColumnVisible}
        isError={isError}
        isLoading={isLoading}
        setLocation={setLocation}
        todayISO={todayISO}
        visibleContainers={visibleContainers}
      />
      <POSContainerTrackingSection
        departureEditorProps={departureEditorProps}
        error={error}
        formatDisplayDate={formatDisplayDate}
        hasActiveFilters={hasActiveFilters}
        isColumnVisible={isColumnVisible}
        isError={isError}
        isLoading={isLoading}
        setLocation={setLocation}
        todayISO={todayISO}
        visibleColumns={visibleColumns}
        visibleContainers={visibleContainers}
      />
    </div>
  );
}
