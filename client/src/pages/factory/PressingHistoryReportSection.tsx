// Extracted from ./PressingHistoryReport.tsx to keep that module under the source-size cap.
import { LayoutList, List, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pressingCell, pressingDisplayDateTime } from "./pressing-scanner/pressingReportClient";
import PressingCorrectionReview from "./PressingCorrectionReview";
import {
  countText,
  formatError,
  kgText,
  usePressingHistoryReportState,
  workerName,
} from "./usePressingHistoryReportState";

export function PressingHistoryReportSection({
  canCorrect,
  companyId,
  condensed,
  detail,
  filters,
  pageCount,
  report,
  setFilters,
  setShowCorrections,
  showCorrections,
  simpleMode,
  update,
  userId,
}: Pick<
  ReturnType<typeof usePressingHistoryReportState>,
  | "canCorrect"
  | "companyId"
  | "condensed"
  | "detail"
  | "filters"
  | "pageCount"
  | "report"
  | "setFilters"
  | "setShowCorrections"
  | "showCorrections"
  | "simpleMode"
  | "update"
  | "userId"
>) {
  return (
    <div id="pressing-history-content" className="space-y-3 border-t p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-lg border bg-muted/40 p-1" aria-label="Pressing report view">
          <Button
            type="button"
            size="sm"
            variant={filters.mode === "condensed" ? "secondary" : "ghost"}
            className="h-8"
            aria-pressed={filters.mode === "condensed"}
            onClick={() => update({ mode: "condensed" })}
          >
            <LayoutList className="mr-1.5 h-4 w-4" />
            Condensed
          </Button>
          <Button
            type="button"
            size="sm"
            variant={filters.mode === "detailed" ? "secondary" : "ghost"}
            className="h-8"
            aria-pressed={filters.mode === "detailed"}
            onClick={() => update({ mode: "detailed" })}
          >
            <List className="mr-1.5 h-4 w-4" />
            Detailed
          </Button>
        </div>
        <span className="text-xs text-muted-foreground">Server-confirmed history</span>
      </div>
      {report.isLoading && <p className="text-sm text-muted-foreground">Loading scans…</p>}
      {report.isError && (
        <p role="alert" className="text-sm text-destructive">
          {formatError(report.error)}
        </p>
      )}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[680px] text-left text-sm">
          {filters.mode === "detailed" ? (
            <>
              <thead className="bg-muted/70">
                <tr>
                  <th className="p-3">Reference</th>
                  <th className="p-3">Article</th>
                  <th className="p-3">Product</th>
                  <th className="p-3 text-right">KG</th>
                  <th className="p-3">Scanned by</th>
                  <th className="p-3">Date &amp; Time (Beirut)</th>
                </tr>
              </thead>
              <tbody>
                {detail.map((row) => (
                  <tr key={row.id} className="border-t transition-colors hover:bg-muted/25">
                    <td className="p-3 font-mono text-xs font-semibold">{row.referenceNumber}</td>
                    <td className="p-3">{row.articleCode || "—"}</td>
                    <td className="p-3">{row.productName || "—"}</td>
                    <td className="p-3 text-right font-medium tabular-nums">{kgText(row.weightKg)}</td>
                    <td className="p-3">{workerName(row.operatorName)}</td>
                    <td className="p-3 text-xs tabular-nums">{pressingCell(row, "confirmedAt")}</td>
                  </tr>
                ))}
                {!detail.length && !report.isFetching && (
                  <tr>
                    <td colSpan={6} className="p-5 text-center text-muted-foreground">
                      No scanned items for these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </>
          ) : (
            <>
              <thead className="bg-muted/70">
                <tr>
                  <th className="p-3">Day</th>
                  <th className="p-3">Worker</th>
                  <th className="p-3">Product name</th>
                  <th className="p-3 text-right">Items</th>
                  <th className="p-3 text-right">KG</th>
                  <th className="p-3">First scan (Beirut)</th>
                  <th className="p-3">Last scan (Beirut)</th>
                </tr>
              </thead>
              <tbody>
                {condensed.map((row, index) => (
                  <tr
                    key={[
                      row.productionDate,
                      row.operatorUserId,
                      row.articleCode,
                      row.productName,
                      row.shiftId,
                      row.voided,
                      index,
                    ].join(":")}
                    className="border-t transition-colors hover:bg-muted/25"
                  >
                    <td className="p-3 text-xs tabular-nums">{pressingCell(row, "productionDate")}</td>
                    <td className="p-3 font-medium">{workerName(row.operatorName)}</td>
                    <td className="p-3">{row.productName || "—"}</td>
                    <td className="p-3 text-right font-semibold tabular-nums">{countText(row.bales)}</td>
                    <td className="p-3 text-right font-medium tabular-nums">{kgText(row.weightKg)}</td>
                    <td className="p-3 text-xs tabular-nums">
                      {pressingDisplayDateTime(row.firstScanAt, row.timezoneName)}
                    </td>
                    <td className="p-3 text-xs tabular-nums">
                      {pressingDisplayDateTime(row.lastScanAt, row.timezoneName)}
                    </td>
                  </tr>
                ))}
                {!condensed.length && !report.isFetching && (
                  <tr>
                    <td colSpan={7} className="p-5 text-center text-muted-foreground">
                      No scanned items for these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </>
          )}
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {countText(report.data?.total)} {filters.mode === "condensed" ? "groups" : "scans"} · Page {filters.page} /{" "}
          {pageCount}
        </span>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={filters.page <= 1}
            onClick={() => setFilters((current) => ({ ...current, page: current.page - 1 }))}
          >
            Previous
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={filters.page >= pageCount}
            onClick={() => setFilters((current) => ({ ...current, page: current.page + 1 }))}
          >
            Next
          </Button>
        </div>
      </div>
      {canCorrect && !simpleMode && (
        <div className="border-t pt-2">
          <Button size="sm" variant="ghost" onClick={() => setShowCorrections((value) => !value)}>
            <ShieldCheck className="mr-2 h-4 w-4" />
            {showCorrections ? "Hide scan actions" : "Manage scans"}
          </Button>
          {showCorrections && <PressingCorrectionReview companyId={companyId} userId={userId} rows={detail} />}
        </div>
      )}
    </div>
  );
}
