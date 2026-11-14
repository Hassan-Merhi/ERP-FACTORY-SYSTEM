/**
 * Phase 7 printable truck manifest and loading-wide reconciliation.
 * Browser print/save-PDF and genuine server Excel exports use the same
 * company-scoped reporting source; this screen never changes stock or loading.
 */
import { useMemo, useState } from "react";
import { useLocation, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Loader2, RefreshCw, ShieldCheck, Truck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useToast } from "@/hooks/use-toast";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { downloadBlob } from "@/lib/downloadBlob";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { exportFileName } from "@/lib/exportFile";

interface Trip {
  id: string;
  dispatchNumber: number;
  status: string;
  truckPlate: string | null;
  driverName: string | null;
  destination: string | null;
  notes: string | null;
  containerNumberSnapshot: string | null;
  createdByUsername: string | null;
  createdAt: string | null;
  closedAt: string | null;
  closedByUsername: string | null;
}
interface Bale {
  baleReference: string;
  articleCode: string;
  productName: string;
  baleId: number;
  weightKg: number;
  dispatchId?: string;
  dispatchNumber?: number;
  expectedDispatchNumber?: number;
  reason?: string;
  scannedBy?: string;
  scannedAt?: string;
  scanId?: string;
}
interface Article {
  articleCode: string;
  productName: string;
  expectedQty: number | null;
  scannedQty: number;
  matchedQty: number;
  missingQty: number | null;
  extraQty: number;
  expectedWeightKg: number | null;
  scannedWeightKg: number;
  status: string;
}
interface Summary {
  loadedBales: number;
  loadedWeightKg: number;
  expectedBales: number | null;
  verifiedBales: number;
  expectedWeightKg: number | null;
  verifiedWeightKg: number;
  matchedBales: number;
  missingBales: number | null;
  unexpectedBales: number;
  crossTripMisplacedBales: number;
  duplicateBales: number;
  progressPercent: number | null;
  weightDifferenceKg: number | null;
}
interface Report {
  source: "LIVE" | "CLOSURE";
  generatedAt: string;
  loading: {
    orderId: number;
    companyName: string;
    customerName: string | null;
    proformaName: string | null;
    containerNumber: string | null;
    status: string;
  };
  trip: Trip | null;
  closure: null | {
    id: string;
    revision: number;
    closedByUsername: string;
    closedAt: string;
    discrepancyReason: string | null;
    approvedWithDiscrepancies: boolean;
    reopenedAt: string | null;
    reopenReason: string | null;
  };
  comparison: {
    articles: Article[];
    missingBales: Bale[];
    unexpectedBales: Bale[];
    crossTripBales: Bale[];
    duplicateBales: Bale[];
    trips: Array<{
      id: string;
      dispatchNumber: number;
      truckPlate: string | null;
      status: string;
      scannedBales: number;
      scannedWeightKg: number;
    }>;
    summary: Summary;
  };
  scans: Bale[];
  manifestAvailable: boolean;
  notices: string[];
  audit: Array<{ id: string; dispatchId: string; eventType: string; actorUsername: string; createdAt: string }>;
  auditTruncated: boolean;
}

const excelMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const qty = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
const kg = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: 3 });
const tripNumber = (value: number) => "#" + String(value).padStart(3, "0");

async function getReport(url: string): Promise<Report> {
  const response = await fetch(url, { credentials: "include", cache: "no-store" });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw Error(data?.message || "Unable to load the dispatch report");
  }
  return response.json() as Promise<Report>;
}

export default function FactoryLoadingDispatchReport() {
  const { orderId: idText, dispatchId: dispatchText } = useParams<{ orderId: string; dispatchId?: string }>();
  const orderId = Number(idText);
  const dispatchId = dispatchText ? Number(dispatchText) : null;
  const valid =
    Number.isSafeInteger(orderId) &&
    orderId > 0 &&
    (dispatchId === null || (Number.isSafeInteger(dispatchId) && dispatchId > 0));
  const closureParam = new URLSearchParams(window.location.search).get("closureId");
  const closureValid =
    closureParam === null ||
    (/^[1-9]\d*$/.test(closureParam) && Number.isSafeInteger(Number(closureParam)) && dispatchId !== null);
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { formatDisplayDateTime } = useDateFormat();
  const [downloading, setDownloading] = useState(false);
  const { data: user } = useQuery<{ currentCompanyId?: number | null }>({ queryKey: ["/api/auth/me"] });
  const companyId = user?.currentCompanyId;
  const prefix = "/api/factory/customer-orders/" + orderId + "/loading-dispatches";
  const reportPath =
    dispatchId === null ? prefix + "/reports/overall" : prefix + "/" + dispatchId + "/reports/manifest";
  const suffix = closureParam ? "?closureId=" + encodeURIComponent(closureParam) : "";
  const url = reportPath + suffix;
  const query = useQuery<Report>({
    queryKey: companyQueryKey(url, companyId),
    queryFn: () => getReport(url),
    enabled: valid && closureValid && Boolean(companyId),
    refetchInterval: closureParam
      ? false
      : (queryResultIsHistorical) => (queryResultIsHistorical.state.data?.source === "CLOSURE" ? false : 15000),
  });
  const report = query.data;
  const summary = report?.comparison.summary;
  const recordLabel = report?.trip ? "Dispatch " + tripNumber(report.trip.dispatchNumber) : "All Truck Trips";
  const back = "/factory/sales/loading/dispatch/" + orderId + (dispatchId !== null ? "/" + dispatchId : "");
  const lines = useMemo(
    () => [
      ["Expected", qty(summary?.expectedBales)],
      ["Verified", qty(summary?.verifiedBales)],
      ["Matched", qty(summary?.matchedBales)],
      ["Missing", qty(summary?.missingBales)],
      ["Unexpected", qty(summary?.unexpectedBales)],
      ["Wrong Truck", qty(summary?.crossTripMisplacedBales)],
      ["Duplicates", qty(summary?.duplicateBales)],
      ["Verified KG", kg(summary?.verifiedWeightKg)],
    ],
    [summary]
  );

  const downloadExcel = async () => {
    if (!report || downloading) return;
    setDownloading(true);
    try {
      const resource = reportPath + ".xlsx" + suffix;
      const response = await fetch(resource, { credentials: "include", cache: "no-store" });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw Error(data?.message || "Unable to export dispatch Excel workbook");
      }
      const blob = await response.blob();
      if (blob.size === 0) throw Error("Excel export returned an empty file");
      const filename = exportFileName(
        [
          "factory dispatch",
          report.loading.containerNumber || "loading " + orderId,
          report.trip ? "trip " + report.trip.dispatchNumber : "all trips",
          report.closure ? "closure " + report.closure.revision : "live",
        ].join(" "),
        "xlsx"
      );
      downloadBlob(new Blob([blob], { type: excelMime }), filename);
      toast({
        title: "Dispatch report exported",
        description: "Excel workbook includes manifests, article comparisons and discrepancies.",
      });
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Export unavailable",
        variant: "destructive",
      });
    } finally {
      setDownloading(false);
    }
  };

  if (!valid || !closureValid) {
    return <div className="p-6 text-destructive">Invalid loading, truck or historical closure reference.</div>;
  }

  return (
    <div
      className="h-full min-w-0 overflow-y-auto bg-slate-50/90 p-3 pb-12 dark:bg-[hsl(var(--factory-hue)_56%_7%)] sm:p-5 lg:p-7"
      data-testid="factory-dispatch-print-report"
    >
      <style>{`
        @page { size: A4 landscape; margin: 10mm; }
        @media print {
          body, html { background: white !important; color: #111827 !important; }
          body * { visibility: hidden !important; }
          #factory-dispatch-paper, #factory-dispatch-paper * { visibility: visible !important; }
          #factory-dispatch-paper {
            position: absolute !important; top: 0 !important; left: 0 !important;
            width: 100% !important; max-width: none !important; margin: 0 !important;
            padding: 0 !important; background: white !important; color: #111827 !important;
            box-shadow: none !important; border: none !important;
          }
          #factory-dispatch-paper * { color: #111827 !important; background-color: white !important; box-shadow: none !important; }
          .dispatch-print-hide { display: none !important; }
          .dispatch-print-table { max-height: none !important; overflow: visible !important; }
          .dispatch-print-table table { width: 100% !important; border-collapse: collapse !important; }
          .dispatch-print-table th, .dispatch-print-table td {
            border: 1px solid #cbd5e1 !important; padding: 3px 6px !important;
            font-size: 9px !important; overflow-wrap: anywhere !important;
          }
          .dispatch-print-table tr { break-inside: avoid !important; }
          .dispatch-print-table thead { display: table-header-group !important; }
          .dispatch-print-block { break-inside: avoid-page !important; }
          .dispatch-print-section { break-before: auto; }
        }
      `}</style>
      <div className="mx-auto max-w-[1450px] space-y-4">
        <div className="dispatch-print-hide flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-background p-3 dark:border-slate-700">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => navigate(back)}>
              <ArrowLeft className="mr-1.5 h-4 w-4" /> Back to {dispatchId === null ? "dispatches" : "trip"}
            </Button>
            <Badge variant="outline">{report?.source === "CLOSURE" ? "Historical / Frozen" : "Live report"}</Badge>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void query.refetch()}
              disabled={query.isFetching || !report}
            >
              <RefreshCw className="mr-1.5 h-4 w-4" /> Refresh
            </Button>
            <ExportButton
              size="sm"
              disabled={!report}
              busy={downloading}
              onClick={() => void downloadExcel()}
              data-testid="button-export-dispatch-xlsx"
            />
            <ExportButton
              kind="print"
              size="sm"
              variant="default"
              disabled={!report || query.isFetching}
              onClick={() => window.print()}
              data-testid="button-print-dispatch-report"
            />
          </div>
        </div>
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
