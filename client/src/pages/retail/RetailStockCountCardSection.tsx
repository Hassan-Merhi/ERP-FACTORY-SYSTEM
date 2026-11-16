// Extracted from ./RetailStockCount.tsx to keep that module under the source-size cap.
import { Play, ScanLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { MobileBarcodeScanner } from "@/components/MobileBarcodeScanner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { STATUS_LABELS, statusClass, useRetailStockCountState } from "./useRetailStockCountState";

export function RetailStockCountSection({
  scanMutation,
  scanRef,
  scanText,
  setScanText,
}: Pick<ReturnType<typeof useRetailStockCountState>, "scanMutation" | "scanRef" | "scanText" | "setScanText">) {
  return (
    <form
      className="flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const barcode = scanText.trim();
        if (barcode) scanMutation.mutate(barcode);
      }}
    >
      <div className="relative flex-1">
        <ScanLine className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={scanRef}
          autoFocus
          value={scanText}
          onChange={(event) => setScanText(event.target.value)}
          placeholder="Scan a barcode to add one unit"
          className="h-11 pl-10"
          data-testid="stock-count-scan"
        />
      </div>
      <MobileBarcodeScanner
        onScan={(code) => scanMutation.mutate(code)}
        disabled={scanMutation.isPending}
        className="h-11 w-11 shrink-0"
      />
      <Button type="submit" disabled={!scanText.trim() || scanMutation.isPending} data-testid="stock-count-scan-submit">
        Count 1
      </Button>
    </form>
  );
}

export function RetailStockCountCardSection({
  exportStockCountCsv,
  exportingCsv,
  report,
  setSelectedId,
}: Pick<
  ReturnType<typeof useRetailStockCountState>,
  "exportStockCountCsv" | "exportingCsv" | "report" | "setSelectedId"
>) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-lg">History &amp; variance</CardTitle>
        <ExportButton
          kind="csv"
          size="sm"
          busy={exportingCsv}
          onClick={exportStockCountCsv}
          data-testid="stock-count-csv"
        />
      </CardHeader>
      <CardContent className="space-y-2">
        {report && (
          <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <div className="rounded-sm border p-2">
              <div className="text-muted-foreground">Sessions</div>
              <strong>{report.summary.sessionCount}</strong>
            </div>
            <div className="rounded-sm border p-2">
              <div className="text-muted-foreground">Finalized</div>
              <strong>{report.summary.finalizedCount}</strong>
            </div>
            <div className="rounded-sm border p-2">
              <div className="text-muted-foreground">Net variance (units)</div>
              <strong>{report.summary.varianceQuantityTotal}</strong>
            </div>
            <div className="rounded-sm border p-2">
              <div className="text-muted-foreground">Variance value</div>
              <strong>{report.summary.varianceValueTotal}</strong>
            </div>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="p-2">Session</th>
                <th className="p-2">Status</th>
                <th className="p-2">Location</th>
                <th className="p-2 text-right">Lines</th>
                <th className="p-2 text-right">Counted</th>
                <th className="p-2 text-right">Variance</th>
                <th className="p-2">Finalized</th>
              </tr>
            </thead>
            <tbody>
              {(report?.sessions ?? []).map((entry) => (
                <tr
                  key={entry.id}
                  className="cursor-pointer border-b last:border-0 hover:bg-muted/40"
                  onClick={() => setSelectedId(entry.id)}
                  data-no-translate
                >
                  <td className="p-2 font-medium">{entry.code}</td>
                  <td className="p-2">
                    <span className={cn("rounded-full px-2 py-0.5 text-xs", statusClass(entry.status))}>
                      {STATUS_LABELS[entry.status] ?? entry.status}
                    </span>
                  </td>
                  <td className="p-2">{entry.locationName ?? `#${entry.locationId}`}</td>
                  <td className="p-2 text-right">{entry.lineCount}</td>
                  <td className="p-2 text-right">{entry.countedLineCount}</td>
                  <td className="p-2 text-right">
                    {entry.varianceQuantityTotal} · {entry.varianceValueTotal}
                  </td>
                  <td className="p-2 text-xs text-muted-foreground">
                    {entry.finalizedAt ? new Date(entry.finalizedAt).toLocaleString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

export function RetailStockCountCardSection2({
  selectedId,
  sessionsQuery,
  setSelectedId,
}: Pick<ReturnType<typeof useRetailStockCountState>, "selectedId" | "sessionsQuery" | "setSelectedId">) {
  return (
    <Card className="h-fit">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">Sessions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {(sessionsQuery.data ?? []).map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setSelectedId(entry.id)}
            className={cn(
              "flex w-full flex-col gap-1 rounded-lg border p-3 text-left text-sm transition hover:bg-muted/40",
              selectedId === entry.id && "border-primary"
            )}
            data-testid="stock-count-session"
          >
            <span className="flex items-center justify-between gap-2">
              <strong data-no-translate>{entry.code}</strong>
              <span className={cn("rounded-full px-2 py-0.5 text-xs", statusClass(entry.status))}>
                {STATUS_LABELS[entry.status] ?? entry.status}
              </span>
            </span>
            <span className="text-xs text-muted-foreground" data-no-translate>
              {entry.locationName ?? `#${entry.locationId}`} · {new Date(entry.createdAt).toLocaleString()}
            </span>
            <span className="text-xs text-muted-foreground">
              {entry.countedLineCount}/{entry.lineCount} counted · variance {entry.varianceQuantityTotal}
            </span>
          </button>
        ))}
        {!sessionsQuery.isLoading && !(sessionsQuery.data ?? []).length && (
          <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
            No stock counts yet at this location.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function RetailStockCountSection3({
  createMutation,
  includeAllVariants,
  locationId,
  locations,
  recordChanges,
  setIncludeAllVariants,
  setLocationId,
}: Pick<
  ReturnType<typeof useRetailStockCountState>,
  | "createMutation"
  | "includeAllVariants"
  | "locationId"
  | "locations"
  | "recordChanges"
  | "setIncludeAllVariants"
  | "setLocationId"
>) {
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-xl border bg-card p-4 shadow-xs">
      <div className="w-56">
        <Label htmlFor="stock-count-location">Location</Label>
        <select
          id="stock-count-location"
          value={locationId}
          onChange={(event) => setLocationId(event.target.value ? Number(event.target.value) : "")}
          className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
          data-testid="stock-count-location"
        >
          <option value="">Select location</option>
          {locations.map((location) => (
            <option key={location.id} value={location.id}>
              {location.name}
            </option>
          ))}
        </select>
      </div>
      <label className="flex h-10 items-center gap-2 rounded-md border px-3 text-sm">
        <input
          type="checkbox"
          checked={includeAllVariants}
          onChange={(event) => setIncludeAllVariants(event.target.checked)}
          data-testid="stock-count-all-variants"
        />
        Include variants with no stock here
      </label>
      {recordChanges.canCreate("POST", "/api/pos/retail/stock-counts") && (
        <Button
          disabled={!locationId || createMutation.isPending}
          onClick={() => createMutation.mutate()}
          data-testid="stock-count-create"
        >
          <Play className="mr-1 h-4 w-4" /> {createMutation.isPending ? "Creating…" : "New count"}
        </Button>
      )}
    </div>
  );
}
