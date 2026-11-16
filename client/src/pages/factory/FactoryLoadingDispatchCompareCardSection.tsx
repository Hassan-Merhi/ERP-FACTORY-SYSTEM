// Extracted from ./FactoryLoadingDispatchCompare.tsx to keep that module under the source-size cap.
import { AlertTriangle, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PillTabButton, TabsList } from "@/components/ui/tabs";
import { PAGE_SIZE, printNumber, StatusBadge } from "./FactoryLoadingDispatchCompareParts";
import { useFactoryLoadingDispatchCompareState } from "./useFactoryLoadingDispatchCompareState";

export function FactoryLoadingDispatchCompareCardSection({
  filter,
  rows,
  search,
  setFilter,
  setSearch,
  setVisibleCount,
  visibleCount,
}: Pick<
  ReturnType<typeof useFactoryLoadingDispatchCompareState>,
  "filter" | "rows" | "search" | "setFilter" | "setSearch" | "setVisibleCount" | "visibleCount"
>) {
  return (
    <Card className="min-w-0 border-slate-200 bg-white dark:border-blue-500/20 dark:bg-[hsl(var(--factory-hue)_53%_13%)]">
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-bold">Item-by-item comparison</h2>
            <p className="text-xs text-muted-foreground">
              Article quantities and verified KG; expand differences using the filters below.
            </p>
          </div>
          <Badge variant="secondary">{printNumber(rows.length)} articles</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[180px] flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-9 pl-9"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setVisibleCount(PAGE_SIZE);
              }}
              placeholder="Search article or name"
              data-testid="input-compare-article-search"
            />
          </div>
          <div className="max-w-full overflow-x-auto">
            <TabsList className="w-max" aria-label="Filter article comparison status">
              {(
                [
                  ["all", "All"],
                  ["missing", "Missing"],
                  ["extra", "Extra"],
                  ["match", "Match"],
                ] as const
              ).map(([value, label]) => (
                <PillTabButton
                  key={value}
                  selected={filter === value}
                  onClick={() => {
                    setFilter(value);
                    setVisibleCount(PAGE_SIZE);
                  }}
                >
                  {label}
                </PillTabButton>
              ))}
            </TabsList>
          </div>
        </div>
        <div className="overflow-x-auto rounded-xl border dark:border-slate-700">
          <table className="w-full min-w-[900px] text-left text-xs">
            <thead className="sticky top-0 bg-slate-100 text-muted-foreground dark:bg-[hsl(var(--factory-hue)_59%_11%)]">
              <tr>
                <th className="px-3 py-3 font-semibold">Article</th>
                <th className="px-3 py-3 text-right font-semibold">Pending Loading</th>
                <th className="px-3 py-3 text-right font-semibold">Scanned</th>
                <th className="px-3 py-3 text-right font-semibold">Missing</th>
                <th className="px-3 py-3 text-right font-semibold">Extra</th>
                <th className="px-3 py-3 text-right font-semibold">Loading KG</th>
                <th className="px-3 py-3 text-right font-semibold">Scanned KG</th>
                <th className="px-3 py-3 text-right font-semibold">KG difference</th>
                <th className="px-3 py-3 font-semibold">Result</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, visibleCount).map((article) => (
                <tr
                  key={article.articleCode}
                  className="border-t dark:border-slate-700"
                  data-testid={"compare-article-" + article.articleCode}
                >
                  <td className="px-3 py-3">
                    <p className="font-mono font-semibold">{article.articleCode}</p>
                    <p className="mt-0.5 max-w-[240px] truncate text-muted-foreground">{article.productName || "—"}</p>
                    {article.priorityRank !== null && (
                      <p className="text-[11px] text-blue-600">Priority {article.priorityRank}</p>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right font-mono">{printNumber(article.expectedQty)}</td>
                  <td className="px-3 py-3 text-right font-mono">{printNumber(article.scannedQty)}</td>
                  <td
                    className={
                      "px-3 py-3 text-right font-mono " +
                      ((article.missingQty ?? 0) > 0 ? "font-bold text-amber-600" : "")
                    }
                  >
                    {printNumber(article.missingQty)}
                  </td>
                  <td
                    className={
                      "px-3 py-3 text-right font-mono " + (article.extraQty > 0 ? "font-bold text-red-600" : "")
                    }
                  >
                    {article.expectedQty === null ? "—" : printNumber(article.extraQty)}
                  </td>
                  <td className="px-3 py-3 text-right font-mono">{printNumber(article.expectedWeightKg, 3)}</td>
                  <td className="px-3 py-3 text-right font-mono">{printNumber(article.scannedWeightKg, 3)}</td>
                  <td className="px-3 py-3 text-right font-mono">
                    {printNumber(
                      article.expectedWeightKg === null ? null : article.expectedWeightKg - article.scannedWeightKg,
                      3
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <StatusBadge value={article.status} />
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="p-8 text-center text-muted-foreground">
                    No articles match this filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {rows.length > visibleCount && (
          <Button size="sm" variant="outline" onClick={() => setVisibleCount((v) => v + PAGE_SIZE)}>
            Show more ({printNumber(rows.length - visibleCount)} remaining)
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export function FactoryLoadingDispatchComparePendingLoadingFinalReconciliation({
  allTripsEnded,
  canReconcile,
  missingFromLoading,
  removing,
  selectAllMissing,
  selectedCurrent,
  setRemoveOpen,
  setSelectedMissing,
}: Pick<
  ReturnType<typeof useFactoryLoadingDispatchCompareState>,
  | "allTripsEnded"
  | "canReconcile"
  | "missingFromLoading"
  | "removing"
  | "selectAllMissing"
  | "selectedCurrent"
  | "setRemoveOpen"
  | "setSelectedMissing"
>) {
  return (
    <Card
      className="border-blue-200 bg-white dark:border-blue-500/25 dark:bg-[hsl(var(--factory-hue)_53%_13%)]"
      data-testid="pending-loading-final-reconciliation"
    >
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-base font-bold">Final Pending Loading reconciliation</h2>
            <p className="text-xs text-muted-foreground">
              These are the exact bales still in Pending Loading but not scanned on any dispatch trip. Selecting a bale
              does not change anything until you confirm removal.
            </p>
          </div>
          <Badge variant="outline">{printNumber(missingFromLoading.length)} not scanned</Badge>
        </div>
        {!allTripsEnded && (
          <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-600/30 dark:bg-amber-950/20 dark:text-amber-200">
            You can review missing bales now. To remove them from Pending Loading, finish all open dispatch trips first.
          </p>
        )}
        {missingFromLoading.length === 0 ? (
          <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-200">
            No missing bale references. Every bale in the current loading is verified on a trip.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={selectAllMissing}
                disabled={!canReconcile || removing}
                data-testid="button-select-all-missing-bales"
              >
                {selectedCurrent.length === missingFromLoading.length ? "Clear selection" : "Select all missing"}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!canReconcile || removing || selectedCurrent.length === 0}
                onClick={() => setRemoveOpen(true)}
                data-testid="button-remove-selected-missing-bales"
              >
                Remove {selectedCurrent.length} selected from loading
              </Button>
            </div>
            <div className="max-h-[360px] overflow-auto rounded-lg border dark:border-slate-700">
              <table className="w-full min-w-[480px] text-left text-xs">
                <thead className="sticky top-0 bg-slate-100 dark:bg-[hsl(var(--factory-hue)_58%_10%)]">
                  <tr>
                    <th className="px-3 py-2">Select</th>
                    <th className="px-3 py-2">Bale reference</th>
                    <th className="px-3 py-2">Article</th>
                    <th className="px-3 py-2 text-right">KG</th>
                  </tr>
                </thead>
                <tbody>
                  {missingFromLoading.map((bale) => (
                    <tr key={bale.orderBaleId} className="border-t dark:border-slate-700">
                      <td className="px-3 py-2">
                        <Checkbox
                          checked={selectedCurrent.includes(bale.orderBaleId!)}
                          disabled={!canReconcile || removing}
                          onCheckedChange={(value) =>
                            setSelectedMissing((ids) =>
                              value === true
                                ? [...ids.filter((id) => id !== bale.orderBaleId), bale.orderBaleId!]
                                : ids.filter((id) => id !== bale.orderBaleId)
                            )
                          }
                          aria-label={"Select missing bale " + bale.baleReference}
                        />
                      </td>
                      <td className="px-3 py-2 font-mono font-semibold">{bale.baleReference}</td>
                      <td className="px-3 py-2">
                        {bale.articleCode} <span className="text-muted-foreground">{bale.productName}</span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{printNumber(bale.weightKg, 3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <p className="text-[11px] text-muted-foreground">
          Removal is restricted to Admin, Owner and Developer, requires an approval reason, and returns only unshipped
          bales to stock in one atomic transaction. No scanned/posted bale can be removed. After signing the final order
          reconciliation, all further removals are locked.
        </p>
      </CardContent>
    </Card>
  );
}

export function FactoryLoadingDispatchCompareCardSection2({
  s,
  selectedId,
}: Pick<ReturnType<typeof useFactoryLoadingDispatchCompareState>, "s" | "selectedId">) {
  return (
    <Card className="border-blue-100 bg-white dark:border-blue-500/20 dark:bg-[hsl(var(--factory-hue)_53%_13%)]">
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-bold">Verification progress</p>
          <p className="font-mono text-sm font-bold">
            {printNumber(s?.progressPercent ?? null)}
            {s?.progressPercent !== null && s?.progressPercent !== undefined ? "%" : ""}
          </p>
        </div>
        <div className="h-2.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
          <div
            className="h-full rounded-full bg-blue-600 transition-[width]"
            style={{ width: (s?.progressPercent ?? 0) + "%" }}
          />
        </div>
        <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {selectedId
              ? "Trip scans are recorded without a per-truck target"
              : "Pending Loading weight: " + printNumber(s?.expectedWeightKg ?? null, 3) + " kg"}
          </span>
          <span>Scanned weight: {printNumber(s?.verifiedWeightKg ?? null, 3)} kg</span>
          <span>Weight difference: {printNumber(s?.weightDifferenceKg ?? null, 3)} kg</span>
          <span>
            Loading: {printNumber(s?.loadedBales ?? null)} bales · {printNumber(s?.loadedWeightKg ?? null, 3)} kg
          </span>
        </div>
        {s && s.duplicateBales > 0 && (
          <p className="flex items-center gap-2 text-xs font-semibold text-red-600">
            <AlertTriangle className="h-4 w-4" />
            {s.duplicateBales} active duplicate anomalies
          </p>
        )}
      </CardContent>
    </Card>
  );
}
