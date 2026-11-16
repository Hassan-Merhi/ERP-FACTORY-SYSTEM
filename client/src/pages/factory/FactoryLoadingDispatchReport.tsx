import { AlertTriangle, Loader2, ShieldCheck, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  FactoryLoadingDispatchReportSection,
  FactoryLoadingDispatchReportSection2,
  kg,
  qty,
  tripNumber,
  useFactoryLoadingDispatchReportState,
} from "./useFactoryLoadingDispatchReportState";

export default function FactoryLoadingDispatchReport() {
  const {
    back,
    closureValid,
    dispatchId,
    downloadExcel,
    downloading,
    formatDisplayDateTime,
    lines,
    navigate,
    orderId,
    query,
    recordLabel,
    report,
    valid,
  } = useFactoryLoadingDispatchReportState();

  if (!valid || !closureValid) {
    return <div className="p-6 text-destructive">Invalid loading, truck or historical closure reference.</div>;
  }

  return (
    <div
      className="h-full min-w-0 overflow-y-auto bg-slate-50/90 p-3 pb-12 dark:bg-[hsl(var(--factory-hue)_56%_7%)] sm:p-5 lg:p-7"
      data-testid="factory-dispatch-print-report"
    >
      <FactoryLoadingDispatchReportSection2 />
      <div className="mx-auto max-w-[1450px] space-y-4">
        <FactoryLoadingDispatchReportSection
          back={back}
          dispatchId={dispatchId}
          downloadExcel={downloadExcel}
          downloading={downloading}
          navigate={navigate}
          query={query}
          report={report}
        />
        {query.isLoading && (
          <div className="flex items-center gap-2 rounded-xl border bg-background p-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading report and verified bale manifest…
          </div>
        )}
        {query.isError && (
          <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/30">
            {query.error instanceof Error ? query.error.message : "Unable to load dispatch report"}
            <Button size="sm" variant="outline" className="ml-2" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </div>
        )}
        {report && (
          <article
            id="factory-dispatch-paper"
            className="space-y-5 rounded-2xl border bg-white p-4 text-slate-950 shadow-sm dark:border-slate-700 dark:bg-[hsl(var(--factory-hue)_53%_13%)] dark:text-slate-100 sm:p-6"
          >
            <header className="dispatch-print-block space-y-3 border-b border-slate-200 pb-4 dark:border-slate-700">
              <div className="flex flex-wrap justify-between gap-3">
                <div className="flex items-start gap-3">
                  <div className="rounded-xl bg-blue-600 p-3 text-white dispatch-print-hide">
                    <Truck className="h-6 w-6" />
                  </div>
                  <div>
                    <h1 className="text-xl font-bold sm:text-2xl">
                      Factory Dispatch {report.trip ? "Manifest" : "Reconciliation"}
                    </h1>
                    <p className="mt-1 text-sm font-semibold">
                      {recordLabel} · Container{" "}
                      {report.trip?.containerNumberSnapshot || report.loading.containerNumber || "—"}
                    </p>
                    <p className="text-xs text-muted-foreground">{report.loading.companyName}</p>
                  </div>
                </div>
                <div className="text-right text-xs">
                  <p className="font-semibold">
                    {report.source === "CLOSURE" ? "FROZEN CLOSURE RECORD" : "LIVE VERIFICATION"}
                  </p>
                  <p>Generated {formatDisplayDateTime(report.generatedAt)}</p>
                  {report.closure && <p>Closure revision #{report.closure.revision}</p>}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
                {(
                  [
                    ["Customer", report.loading.customerName || "—"],
                    ["Proforma", report.loading.proformaName || "—"],
                    ["Loading Order", "#" + report.loading.orderId],
                    ["Loading Status", report.loading.status],
                    ["Trip Number", report.trip ? tripNumber(report.trip.dispatchNumber) : "All trips"],
                    ["Trip Status", report.trip?.status || "Multiple trips"],
                    ["Opened By", report.trip?.createdByUsername || "—"],
                    ["Opened At", report.trip?.createdAt ? formatDisplayDateTime(report.trip.createdAt) : "—"],
                    ["Closed By", report.closure?.closedByUsername || report.trip?.closedByUsername || "—"],
                    ["Closed At", report.closure?.closedAt ? formatDisplayDateTime(report.closure.closedAt) : "—"],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label} className="min-w-0">
                    <p className="font-medium text-muted-foreground">{label}</p>
                    <p className="break-words font-semibold">{value}</p>
                  </div>
                ))}
              </div>
              {report.trip?.notes && (
                <p className="whitespace-pre-wrap rounded-lg bg-slate-50 p-2 text-xs dark:bg-[hsl(var(--factory-hue)_52%_11%)]">
                  <strong>Trip notes:</strong> {report.trip.notes}
                </p>
              )}
            </header>
            {report.notices.length > 0 && (
              <div className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/20 dark:text-amber-200">
                {report.notices.map((n, i) => (
                  <p key={i} className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 dispatch-print-hide" /> {n}
                  </p>
                ))}
              </div>
            )}
            <div className="dispatch-print-block grid grid-cols-3 gap-2 md:grid-cols-6">
              {lines.map(([label, value]) => (
                <div key={label} className="rounded-xl border border-slate-200 p-2.5 dark:border-slate-700">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
                  <p className="mt-1 font-mono text-lg font-bold">{value}</p>
                </div>
              ))}
            </div>
            {report.closure?.approvedWithDiscrepancies && (
              <div className="dispatch-print-block rounded-lg border border-amber-300 p-3 text-xs">
                <p className="font-bold">Supervisor-approved discrepancies</p>
                <p className="mt-1 whitespace-pre-wrap">{report.closure.discrepancyReason}</p>
                <p className="mt-1">
                  Approved by {report.closure.closedByUsername} · {formatDisplayDateTime(report.closure.closedAt)}
                </p>
              </div>
            )}

            {!report.trip && report.comparison.trips.length > 0 && (
              <section className="dispatch-print-section space-y-2">
                <h2 className="text-sm font-bold">Truck trip overview</h2>
                <div className="dispatch-print-table overflow-x-auto rounded-lg border dark:border-slate-700">
                  <table className="w-full min-w-[580px] text-left text-xs">
                    <thead className="bg-slate-100 dark:bg-slate-800">
                      <tr>
                        <th className="px-2 py-2">Trip number</th>
                        <th className="px-2 py-2">Status</th>
                        <th className="px-2 py-2 text-right">Verified Bales</th>
                        <th className="px-2 py-2 text-right">Verified KG</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.comparison.trips.map((t) => (
                        <tr key={t.id} className="border-t dark:border-slate-700">
                          <td className="px-2 py-2">{tripNumber(t.dispatchNumber)}</td>
                          <td className="px-2 py-2">{t.status}</td>
                          <td className="px-2 py-2 text-right font-mono">{qty(t.scannedBales)}</td>
                          <td className="px-2 py-2 text-right font-mono">{kg(t.scannedWeightKg)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            <section className="dispatch-print-section space-y-2">
              <h2 className="text-sm font-bold">Article comparison</h2>
              <div className="dispatch-print-table overflow-x-auto rounded-lg border dark:border-slate-700">
                <table className="w-full min-w-[750px] text-left text-xs">
                  <thead className="bg-slate-100 dark:bg-slate-800">
                    <tr>
                      <th className="px-2 py-2">Article / Product</th>
                      <th className="px-2 py-2 text-right">Expected</th>
                      <th className="px-2 py-2 text-right">Verified</th>
                      <th className="px-2 py-2 text-right">Missing</th>
                      <th className="px-2 py-2 text-right">Extra</th>
                      <th className="px-2 py-2 text-right">KG</th>
                      <th className="px-2 py-2">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.comparison.articles.map((a) => (
                      <tr key={a.articleCode} className="border-t dark:border-slate-700">
                        <td className="px-2 py-2">
                          <p className="font-mono font-semibold">{a.articleCode}</p>
                          <p className="text-muted-foreground">{a.productName}</p>
                        </td>
                        <td className="px-2 py-2 text-right font-mono">{qty(a.expectedQty)}</td>
                        <td className="px-2 py-2 text-right font-mono">{qty(a.scannedQty)}</td>
                        <td className="px-2 py-2 text-right font-mono">{qty(a.missingQty)}</td>
                        <td className="px-2 py-2 text-right font-mono">{qty(a.extraQty)}</td>
                        <td className="px-2 py-2 text-right font-mono">{kg(a.scannedWeightKg)}</td>
                        <td className="px-2 py-2">{a.status}</td>
                      </tr>
                    ))}
                    {report.comparison.articles.length === 0 && (
                      <tr>
                        <td colSpan={7} className="p-4 text-center text-muted-foreground">
                          No articles recorded
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="dispatch-print-section space-y-2">
              <h2 className="text-sm font-bold">
                Verified bale manifest ({report.manifestAvailable ? qty(report.scans.length) : "not archived"})
              </h2>
              {report.manifestAvailable ? (
                <div className="dispatch-print-table overflow-x-auto rounded-lg border dark:border-slate-700">
                  <table className="w-full min-w-[690px] text-left text-xs">
                    <thead className="bg-slate-100 dark:bg-slate-800">
                      <tr>
                        {!report.trip && <th className="px-2 py-2">Trip</th>}
                        <th className="px-2 py-2">Bale Reference</th>
                        <th className="px-2 py-2">Article</th>
                        <th className="px-2 py-2">Product</th>
                        <th className="px-2 py-2 text-right">KG</th>
                        <th className="px-2 py-2">Scanned by</th>
                        <th className="px-2 py-2">Scanned at</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.scans.map((s, i) => (
                        <tr key={s.scanId || String(i)} className="border-t dark:border-slate-700">
                          {!report.trip && <td className="px-2 py-1.5">{tripNumber(s.dispatchNumber || 0)}</td>}
                          <td className="px-2 py-1.5 font-mono">{s.baleReference}</td>
                          <td className="px-2 py-1.5">{s.articleCode}</td>
                          <td className="px-2 py-1.5">{s.productName}</td>
                          <td className="px-2 py-1.5 text-right font-mono">{kg(s.weightKg)}</td>
                          <td className="px-2 py-1.5">{s.scannedBy || "—"}</td>
                          <td className="px-2 py-1.5">{s.scannedAt ? formatDisplayDateTime(s.scannedAt) : "—"}</td>
                        </tr>
                      ))}
                      {report.scans.length === 0 && (
                        <tr>
                          <td colSpan={report.trip ? 6 : 7} className="p-4 text-center text-muted-foreground">
                            No active verified bale records
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="rounded-lg border p-3 text-xs">
                  Exact historical scan records were not archived for this earlier closure. The article comparison above
                  is the original signed snapshot.
                </p>
              )}
            </section>

            {(
              [
                ["Missing bale references", report.comparison.missingBales],
                ["Unexpected scanned references", report.comparison.unexpectedBales],
                ["Wrong-truck allocations", report.comparison.crossTripBales],
                ["Duplicate scan anomalies", report.comparison.duplicateBales],
              ] as const
            ).map(([title, items]) =>
              items.length ? (
                <section key={title} className="dispatch-print-section space-y-2">
                  <h2 className="text-sm font-bold">
                    {title} ({qty(items.length)})
                  </h2>
                  <div className="dispatch-print-table overflow-x-auto rounded-lg border dark:border-slate-700">
                    <table className="w-full min-w-[650px] text-left text-xs">
                      <thead className="bg-slate-100 dark:bg-slate-800">
                        <tr>
                          <th className="px-2 py-2">Bale Reference</th>
                          <th className="px-2 py-2">Article</th>
                          <th className="px-2 py-2">Reason</th>
                          <th className="px-2 py-2">Scanned Trip</th>
                          <th className="px-2 py-2">Expected Trip</th>
                          <th className="px-2 py-2 text-right">KG</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((b, i) => (
                          <tr key={b.baleId + "-" + i} className="border-t dark:border-slate-700">
                            <td className="px-2 py-1.5 font-mono">{b.baleReference}</td>
                            <td className="px-2 py-1.5">{b.articleCode}</td>
                            <td className="px-2 py-1.5">{b.reason?.replace(/_/g, " ") || "—"}</td>
                            <td className="px-2 py-1.5">{b.dispatchNumber ? tripNumber(b.dispatchNumber) : "—"}</td>
                            <td className="px-2 py-1.5">
                              {b.expectedDispatchNumber ? tripNumber(b.expectedDispatchNumber) : "—"}
                            </td>
                            <td className="px-2 py-1.5 text-right font-mono">{kg(b.weightKg)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              ) : null
            )}

            <section className="dispatch-print-section space-y-2">
              <h2 className="text-sm font-bold">Recent activity</h2>
              <p className="text-[11px] text-muted-foreground">
                The Excel export includes up to 10,000 events. The printable report shows the latest 40.
              </p>
              {report.audit.length > 0 ? (
                <div className="dispatch-print-table overflow-x-auto rounded-lg border dark:border-slate-700">
                  <table className="w-full min-w-[500px] text-left text-xs">
                    <thead className="bg-slate-100 dark:bg-slate-800">
                      <tr>
                        <th className="px-2 py-2">Event</th>
                        <th className="px-2 py-2">Operator</th>
                        <th className="px-2 py-2">Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.audit.slice(0, 40).map((a) => (
                        <tr key={a.id} className="border-t dark:border-slate-700">
                          <td className="px-2 py-1.5">{a.eventType.replace(/_/g, " ")}</td>
                          <td className="px-2 py-1.5">{a.actorUsername}</td>
                          <td className="px-2 py-1.5">{formatDisplayDateTime(a.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No audit events recorded.</p>
              )}
            </section>

            <footer className="dispatch-print-block flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-[11px] text-muted-foreground dark:border-slate-700">
              <p className="flex items-center gap-2">
                <ShieldCheck className="h-3.5 w-3.5 dispatch-print-hide" /> Dispatch verification only — no inventory or
                accounting movements.
              </p>
              <p>
                Order #{orderId} · {recordLabel} · {report.source === "CLOSURE" ? "Historical closure" : "Live"}
              </p>
            </footer>
          </article>
        )}
      </div>
    </div>
  );
}
