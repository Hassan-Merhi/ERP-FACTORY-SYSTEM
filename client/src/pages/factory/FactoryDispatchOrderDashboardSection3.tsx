// Extracted from ./FactoryDispatchOrderDashboard.tsx to keep that module under the source-size cap.
import { CheckCheck, ClipboardList, FileText, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { useFactoryDispatchOrderDashboardState } from "./useFactoryDispatchOrderDashboardState";

export function FactoryDispatchOrderDashboardSection3({
  exportOrderExcel,
  exportingExcel,
  info,
  onCompareAll,
  onPhysicalReport,
  orderId,
}: Pick<
  ReturnType<typeof useFactoryDispatchOrderDashboardState>,
  "exportOrderExcel" | "exportingExcel" | "info" | "onCompareAll" | "onPhysicalReport" | "orderId"
>) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-blue-600/10 p-2.5 text-blue-700 dark:text-blue-300">
          <ClipboardList className="h-5 w-5" />
        </div>
        <div>
          <h2 className="font-bold text-base sm:text-lg">Order-wide dispatch dashboard</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Financial truck postings, original loading charges and one final invoice all stay under Loading #{orderId}.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => void info.refetch()}
          disabled={info.isFetching}
          data-testid="button-refresh-dispatch-overview"
        >
          <RefreshCw className={"mr-1.5 h-4 w-4 " + (info.isFetching ? "animate-spin" : "")} /> Refresh
        </Button>
        <Button size="sm" variant="outline" onClick={onPhysicalReport}>
          <FileText className="mr-1.5 h-4 w-4" /> Physical report
        </Button>
        <Button size="sm" variant="outline" onClick={onCompareAll}>
          <CheckCheck className="mr-1.5 h-4 w-4" /> Verify all trips
        </Button>
        <ExportButton
          size="sm"
          variant="default"
          busy={exportingExcel}
          onClick={() => {
            // GET download with the browser's existing session.
            // It only exports evidence; never posts an ERP import or voucher.
            void exportOrderExcel();
          }}
          data-testid="button-export-dispatch-order-excel"
        />
      </div>
    </div>
  );
}
