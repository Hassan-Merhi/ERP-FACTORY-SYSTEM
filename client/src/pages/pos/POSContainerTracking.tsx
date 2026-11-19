import { CheckCircle2, FileClock, MapPin, PackageSearch, Snowflake, Truck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/PageHeader";
import { RowsExportMenu } from "@/components/export/RowsExportMenu";
import "@/styles/pos-container-premium.css";
import { COLUMN_DEFS, supplierLabel, type PosContainerRow, type PosUserContext } from "./usePOSContainerTrackingState";
import { daysSincePortDeparture } from "./portDeparture";
import { usePOSContainerTrackingState2 } from "./usePOSContainerTrackingState2";
import { POSContainerTrackingSection } from "./POSContainerTrackingSection";
import { POSContainerTrackingPosContainerMobileList } from "./POSContainerTrackingPosContainerMobileList";
import { POSContainerTrackingContent } from "./POSContainerTrackingContent";

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
      >
        <RowsExportMenu
          title="Containers OTW"
          rows={visibleContainers}
          columns={COLUMN_DEFS.filter((column) => isColumnVisible(column.key)).map((column) => ({
            header: column.label,
            type: column.key === "daysSinceDeparture" ? ("number" as const) : undefined,
            value: (container: PosContainerRow) => {
              switch (column.key) {
                case "container":
                  return container.containerNumber;
                case "supplier":
                  return supplierLabel(container);
                case "status":
                  return container.status;
                case "eta":
                  return container.eta ? formatDisplayDate(container.eta) : null;
                case "portDeparture":
                  return container.portDepartureDate ? formatDisplayDate(container.portDepartureDate) : null;
                case "daysSinceDeparture":
                  return daysSincePortDeparture(container.portDepartureDate, todayISO);
                case "truck":
                  return container.numberPlate;
                case "location":
                  return container.trackingLocation;
                case "agent":
                  return container.agent;
                case "transporter":
                  return container.transporter;
                case "docs":
                  return container.docReceived ? "Received" : "Pending";
                case "docsSent":
                  return container.docsSentDate
                    ? formatDisplayDate(container.docsSentDate)
                    : container.docReceived
                      ? "Not sent"
                      : null;
              }
            },
          }))}
          resource="retail.pos"
          data-testid="button-export-pos-containers"
        />
      </PageHeader>

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

      <POSContainerTrackingContent
        agentFilter={agentFilter}
        agentOptions={agentOptions}
        clearFilters={clearFilters}
        docsFilter={docsFilter}
        hasActiveFilters={hasActiveFilters}
        isColumnVisible={isColumnVisible}
        search={search}
        setAgentFilter={setAgentFilter}
        setDocsFilter={setDocsFilter}
        setSearch={setSearch}
        setStatusFilter={setStatusFilter}
        setSupplierFilter={setSupplierFilter}
        setTransporterFilter={setTransporterFilter}
        statusFilter={statusFilter}
        statusOptions={statusOptions}
        supplierFilter={supplierFilter}
        supplierOptions={supplierOptions}
        toggleColumn={toggleColumn}
        transporterFilter={transporterFilter}
        transporterOptions={transporterOptions}
      />

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
