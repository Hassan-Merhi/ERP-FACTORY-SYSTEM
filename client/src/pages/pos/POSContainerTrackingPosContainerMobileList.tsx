// Extracted from ./POSContainerTracking.tsx to keep that module under the source-size cap.
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { daysSincePortDeparture } from "./portDeparture";
import { PortDepartureDateCell, supplierLabel } from "./usePOSContainerTrackingState";
import { usePOSContainerTrackingState2 } from "./usePOSContainerTrackingState2";

export function POSContainerTrackingPosContainerMobileList({
  departureEditorProps,
  dt,
  error,
  formatDisplayDate,
  isColumnVisible,
  isError,
  isLoading,
  setLocation,
  todayISO,
  visibleContainers,
}: Pick<
  ReturnType<typeof usePOSContainerTrackingState2>,
  | "departureEditorProps"
  | "dt"
  | "error"
  | "formatDisplayDate"
  | "isColumnVisible"
  | "isError"
  | "isLoading"
  | "setLocation"
  | "todayISO"
  | "visibleContainers"
>) {
  return (
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
  );
}
