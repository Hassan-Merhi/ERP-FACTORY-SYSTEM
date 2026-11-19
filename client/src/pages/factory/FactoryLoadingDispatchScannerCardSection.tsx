// Extracted from ./FactoryLoadingDispatchScanner.tsx to keep that module under the source-size cap.
import { History, Loader2, Package, Trash2, Weight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  PAGE_CHUNK,
  fmtCount,
  fmtKg,
  useFactoryLoadingDispatchScannerState,
} from "./useFactoryLoadingDispatchScannerState";
import { SearchField } from "@/components/ui/search-field";
import { FactoryLoadingDispatchScannerCardSectionContent } from "./FactoryLoadingDispatchScannerCardSectionContent";

export function FactoryLoadingDispatchScannerCardSection({
  embedded = false,
  active,
  activeSelection,
  allFilteredSelected,
  bulkBusy,
  canCorrect,
  corrected,
  correcting,
  data,
  error,
  filterText,
  filtered,
  formatDisplayDateTime,
  isError,
  isLoading,
  pendingCount,
  refetch,
  removedVisible,
  selectAllFiltered,
  selectedIds,
  setBulkMode,
  setBulkReason,
  setCorrection,
  setCorrectionReason,
  setFilterText,
  setRemovedVisible,
  setSelectedIds,
  setVisibleCount,
  toggleSelection,
  visibleCount,
  visibleScans,
}: Pick<
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
> & { embedded?: boolean }) {
  return (
    <Card
      className={
        embedded
          ? "border-0 bg-transparent shadow-none"
          : "border-slate-200 bg-white dark:border-blue-500/20 dark:bg-[hsl(var(--factory-hue)_53%_13%)]"
      }
    >
      <CardContent className={embedded ? "space-y-3 p-0" : "space-y-3 p-4 sm:p-5"}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold">Verified truck bales</h3>
            <p className="text-xs text-muted-foreground">Server-confirmed scans · newest first</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" data-testid="badge-dispatch-scanned-count">
              {fmtCount(data?.activeCount ?? active.length)} bales
            </Badge>
            <Badge variant="outline">
              <Weight className="mr-1 h-3 w-3" /> {fmtKg(data?.activeWeightKg ?? 0)} kg
            </Badge>
            <Button size="sm" variant="outline" onClick={() => void refetch()}>
              Refresh
            </Button>
          </div>
        </div>
        {(active.length > 0 || Boolean(filterText)) && (
          <SearchField
            wrapperClassName="max-w-sm"
            className="h-9"
            placeholder="Search reference, article, operator"
            value={filterText}
            onValueChange={(v) => {
              setFilterText(v);
              setVisibleCount(PAGE_CHUNK);
            }}
            data-testid="input-search-dispatch-scans"
          />
        )}
        {canCorrect && active.length > 0 && (
          <div className="flex flex-wrap items-center gap-2" data-testid="dispatch-bulk-scan-controls">
            <Button
              size="sm"
              variant="outline"
              disabled={filtered.length === 0 || correcting || bulkBusy}
              onClick={() => selectAllFiltered(!allFilteredSelected)}
              data-testid="button-select-filtered-dispatch-scans"
            >
              {allFilteredSelected ? "Deselect filtered" : "Select all filtered"} ({filtered.length})
            </Button>
            <span className="text-xs text-muted-foreground">{activeSelection.length} selected</span>
            {activeSelection.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
                Clear selection
              </Button>
            )}
            <Button
              size="sm"
              variant="destructive"
              disabled={activeSelection.length === 0 || correcting || bulkBusy || pendingCount > 0}
              onClick={() => {
                setBulkReason("");
                setBulkMode("selected");
              }}
              data-testid="button-delete-selected-dispatch-scans"
            >
              <Trash2 className="mr-1.5 h-4 w-4" /> Delete selected ({activeSelection.length})
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="border-red-300 text-red-700 hover:bg-red-50 dark:text-red-300"
              disabled={active.length === 0 || correcting || bulkBusy || pendingCount > 0}
              onClick={() => {
                setBulkReason("");
                setBulkMode("all");
              }}
              data-testid="button-delete-all-dispatch-scans"
            >
              <Trash2 className="mr-1.5 h-4 w-4" /> Delete all ({active.length})
            </Button>
          </div>
        )}
        {isLoading && (
          <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading verified bales…
          </div>
        )}
        {isError && (
          <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">
            {error instanceof Error ? error.message : "Unable to fetch scans"}
          </div>
        )}
        {!isLoading && !isError && filtered.length === 0 && (
          <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            <Package className="mx-auto mb-2 h-6 w-6" />
            {filterText
              ? "No scans match your search."
              : "No verified bales yet. Start scanning as each bale enters the truck."}
          </div>
        )}
        {visibleScans.length > 0 && (
          <FactoryLoadingDispatchScannerCardSectionContent
            embedded={embedded}
            allFilteredSelected={allFilteredSelected}
            bulkBusy={bulkBusy}
            canCorrect={canCorrect}
            correcting={correcting}
            filtered={filtered}
            formatDisplayDateTime={formatDisplayDateTime}
            selectAllFiltered={selectAllFiltered}
            selectedIds={selectedIds}
            setCorrection={setCorrection}
            setCorrectionReason={setCorrectionReason}
            toggleSelection={toggleSelection}
            visibleScans={visibleScans}
          />
        )}
        {filtered.length > visibleCount && (
          <Button size="sm" variant="outline" onClick={() => setVisibleCount((count) => count + PAGE_CHUNK)}>
            Show next {Math.min(PAGE_CHUNK, filtered.length - visibleCount)} scans ({filtered.length - visibleCount}{" "}
            remaining)
          </Button>
        )}
        {corrected.length > 0 && (
          <div className="rounded-xl border dark:border-slate-700">
            <button
              type="button"
              className="flex w-full items-center justify-between p-3 text-left text-sm font-medium"
              onClick={() => setRemovedVisible((value) => !value)}
              data-testid="button-dispatch-correction-history"
            >
              <span className="flex items-center gap-2">
                <History className="h-4 w-4" /> Correction history ({corrected.length})
              </span>
              <span className="text-xs text-muted-foreground">{removedVisible ? "Hide" : "Show"}</span>
            </button>
            {removedVisible && (
              <div className="max-h-[420px] space-y-2 overflow-y-auto border-t p-3 dark:border-slate-700">
                {corrected.map((scan) => (
                  <div
                    key={String(scan.id)}
                    className="flex flex-wrap justify-between gap-2 rounded-lg bg-slate-50 p-2.5 text-xs dark:bg-[hsl(var(--factory-hue)_58%_10%)]"
                  >
                    <div>
                      <p className="font-mono font-semibold">{scan.baleReference}</p>
                      <p className="text-muted-foreground">
                        Originally scanned by {scan.scannedByUsername} · {formatDisplayDateTime(scan.scannedAt)}
                      </p>
                    </div>
                    <div>
                      <p className="font-medium text-red-600">
                        Corrected {scan.removedAt && formatDisplayDateTime(scan.removedAt)}
                      </p>
                      <p className="text-muted-foreground">{scan.removalReason || "No reason"}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
