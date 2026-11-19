// Extracted from ./FactoryLoadingDispatchScannerCardSection.tsx
import { ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { fmtKg, useFactoryLoadingDispatchScannerState } from "./useFactoryLoadingDispatchScannerState";

export function FactoryLoadingDispatchScannerCardSectionContent({
  embedded = false,
  allFilteredSelected,
  bulkBusy,
  canCorrect,
  correcting,
  filtered,
  formatDisplayDateTime,
  selectAllFiltered,
  selectedIds,
  setCorrection,
  setCorrectionReason,
  toggleSelection,
  visibleScans,
}: Pick<
  Pick<
    ReturnType<typeof useFactoryLoadingDispatchScannerState>,
    | "active"
    | "activeSelection"
    | "allFilteredSelected"
    | "bulkBusy"
    | "canCorrect"
    | "corrected"
    | "correcting"
    | "data"
    | "error"
    | "filterText"
    | "filtered"
    | "formatDisplayDateTime"
    | "isError"
    | "isLoading"
    | "pendingCount"
    | "refetch"
    | "removedVisible"
    | "selectAllFiltered"
    | "selectedIds"
    | "setBulkMode"
    | "setBulkReason"
    | "setCorrection"
    | "setCorrectionReason"
    | "setFilterText"
    | "setRemovedVisible"
    | "setSelectedIds"
    | "setVisibleCount"
    | "toggleSelection"
    | "visibleCount"
    | "visibleScans"
  >,
  | "allFilteredSelected"
  | "bulkBusy"
  | "canCorrect"
  | "correcting"
  | "filtered"
  | "formatDisplayDateTime"
  | "selectAllFiltered"
  | "selectedIds"
  | "setCorrection"
  | "setCorrectionReason"
  | "toggleSelection"
  | "visibleScans"
> & { embedded?: boolean }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table
        className={
          embedded
            ? "w-full min-w-[350px] border-collapse text-left text-xs"
            : "w-full min-w-[600px] border-collapse text-left text-xs"
        }
      >
        <thead className="sticky top-0 bg-slate-100 text-muted-foreground dark:bg-[hsl(var(--factory-hue)_58%_10%)]">
          <tr>
            {canCorrect && (
              <th className="w-10 px-3 py-2">
                <Checkbox
                  checked={allFilteredSelected}
                  disabled={filtered.length === 0 || correcting || bulkBusy}
                  onCheckedChange={(checked) => selectAllFiltered(checked === true)}
                  aria-label="Select all filtered verified bales"
                />
              </th>
            )}
            <th className="px-3 py-2 font-medium">Reference / Article</th>
            {!embedded && <th className="px-3 py-2 font-medium">Product</th>}
            <th className="px-3 py-2 text-right font-medium">Kg</th>
            {!embedded && <th className="px-3 py-2 font-medium">Scanned by / Time</th>}
            <th className="px-3 py-2 text-right font-medium">Action</th>
          </tr>
        </thead>
        <tbody>
          {visibleScans.map((scan) => (
            <tr
              key={String(scan.id)}
              className="border-t dark:border-slate-700"
              data-testid={"dispatch-scan-" + scan.id}
            >
              {canCorrect && (
                <td className="px-3 py-2">
                  <Checkbox
                    checked={selectedIds.has(String(scan.id))}
                    disabled={correcting || bulkBusy}
                    onCheckedChange={(checked) => toggleSelection(String(scan.id), checked === true)}
                    aria-label={"Select bale " + scan.baleReference}
                    data-testid={"checkbox-dispatch-scan-" + scan.id}
                  />
                </td>
              )}
              <td className="px-3 py-2">
                <p
                  className="font-mono font-semibold"
                  title={
                    embedded
                      ? [scan.productName, scan.scannedByUsername, formatDisplayDateTime(scan.scannedAt)]
                          .filter(Boolean)
                          .join(" · ")
                      : undefined
                  }
                >
                  {scan.baleReference}
                </p>
                <p className="text-[11px] text-muted-foreground">{scan.articleCode || "—"}</p>
                {embedded && !scan.stillInLoading && (
                  <span className="text-[11px] font-semibold text-amber-600">Removed from loading since scan</span>
                )}
              </td>
              {!embedded && (
                <td className="px-3 py-2">
                  <p className="max-w-[280px] truncate">{scan.productName || "—"}</p>
                  {!scan.stillInLoading && (
                    <span className="text-[11px] font-semibold text-amber-600">
                      Removed from main loading since scan
                    </span>
                  )}
                </td>
              )}
              <td className="px-3 py-2 text-right font-mono">{fmtKg(Number(scan.weightKg))}</td>
              {!embedded && (
                <td className="px-3 py-2">
                  <p className="font-medium">{scan.scannedByUsername}</p>
                  <p className="text-muted-foreground">{formatDisplayDateTime(scan.scannedAt)}</p>
                </td>
              )}
              <td className="px-3 py-2 text-right">
                {canCorrect ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 text-red-600 hover:text-red-700"
                    onClick={() => {
                      setCorrection(scan);
                      setCorrectionReason("");
                    }}
                    title="Remove verification (audit reason required)"
                    aria-label={"Correct scan " + scan.baleReference}
                    data-testid={"button-remove-dispatch-scan-" + scan.id}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                ) : (
                  <ShieldCheck className="ml-auto h-4 w-4 text-emerald-600" />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
