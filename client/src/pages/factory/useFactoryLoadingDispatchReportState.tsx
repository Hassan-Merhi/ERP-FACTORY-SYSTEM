// Extracted from ./FactoryLoadingDispatchReport.tsx to keep that module under the source-size cap.
import { useMemo, useState } from "react";
import { useLocation, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useToast } from "@/hooks/use-toast";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { downloadBlob } from "@/lib/downloadBlob";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { exportFileName } from "@/lib/exportFile";
import type { Report } from "./useFactoryLoadingDispatchReportStateTypes";

const excelMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const qty = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });

export const kg = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: 3 });

export const tripNumber = (value: number) => "#" + String(value).padStart(3, "0");

async function getReport(url: string): Promise<Report> {
  const response = await fetch(url, { credentials: "include", cache: "no-store" });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw Error(data?.message || "Unable to load the dispatch report");
  }
  return response.json() as Promise<Report>;
}

export function useFactoryLoadingDispatchReportState() {
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
  return {
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
  };
}

export function FactoryLoadingDispatchReportSection({
  back,
  dispatchId,
  downloadExcel,
  downloading,
  navigate,
  query,
  report,
}: Pick<
  ReturnType<typeof useFactoryLoadingDispatchReportState>,
  "back" | "dispatchId" | "downloadExcel" | "downloading" | "navigate" | "query" | "report"
>) {
  return (
    <div className="dispatch-print-hide flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-background p-3 dark:border-slate-700">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => navigate(back)}>
          <ArrowLeft className="mr-1.5 h-4 w-4" /> Back to {dispatchId === null ? "dispatches" : "trip"}
        </Button>
        <Badge variant="outline">{report?.source === "CLOSURE" ? "Historical / Frozen" : "Live report"}</Badge>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => void query.refetch()} disabled={query.isFetching || !report}>
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
  );
}

export function FactoryLoadingDispatchReportSection2() {
  return (
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
  );
}
