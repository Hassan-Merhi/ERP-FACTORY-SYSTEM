// Extracted from ./POSContainerTracking.tsx to keep that module under the source-size cap.
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { daysSincePortDeparture } from "./portDeparture";
import { PortDepartureDateCell, supplierLabel } from "./usePOSContainerTrackingState";
import { usePOSContainerTrackingState2 } from "./usePOSContainerTrackingState2";

export function POSContainerTrackingSection({
  departureEditorProps,
  error,
  formatDisplayDate,
  hasActiveFilters,
  isColumnVisible,
  isError,
  isLoading,
  setLocation,
  todayISO,
  visibleColumns,
  visibleContainers,
}: Pick<
  ReturnType<typeof usePOSContainerTrackingState2>,
  | "departureEditorProps"
  | "error"
  | "formatDisplayDate"
  | "hasActiveFilters"
  | "isColumnVisible"
  | "isError"
  | "isLoading"
  | "setLocation"
  | "todayISO"
  | "visibleColumns"
  | "visibleContainers"
>) {
  return (
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
              {isColumnVisible("portDeparture") ? <TableHead className="whitespace-nowrap">Left Port</TableHead> : null}
              {isColumnVisible("daysSinceDeparture") ? (
                <TableHead className="whitespace-nowrap">Days Since</TableHead>
              ) : null}
              {isColumnVisible("truck") ? <TableHead className="whitespace-nowrap">Truck #</TableHead> : null}
              {isColumnVisible("location") ? <TableHead className="whitespace-nowrap">Location</TableHead> : null}
              {isColumnVisible("agent") ? <TableHead className="whitespace-nowrap">Agent</TableHead> : null}
              {isColumnVisible("transporter") ? <TableHead className="whitespace-nowrap">Transporter</TableHead> : null}
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
  );
}
