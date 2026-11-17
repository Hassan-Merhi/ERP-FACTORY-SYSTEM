// Extracted from ./FactoryLoadingDispatchCompare.tsx to keep that module under the source-size cap.
import { Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PillTabButton, TabsList } from "@/components/ui/tabs";
import { PAGE_SIZE, printNumber, StatusBadge } from "./FactoryLoadingDispatchCompareParts";
import { useFactoryLoadingDispatchCompareState } from "./useFactoryLoadingDispatchCompareState";

export function useFactoryLoadingDispatchCompareState2() {
  const {
    allTripsEnded,
    canReconcile,
    companyId,
    comparison,
    filter,
    financialReconciliation,
    isSupervisor,
    missingFromLoading,
    navigate,
    orderId,
    refreshAllReconciliation,
    removalReason,
    removeConfirmed,
    removeOpen,
    removeSelected,
    removing,
    result,
    rows,
    s,
    search,
    selectAllMissing,
    selectedCurrent,
    selectedId,
    selectedKg,
    setFilter,
    setRemovalReason,
    setRemoveConfirmed,
    setRemoveOpen,
    setSearch,
    setSelectedMissing,
    setVisibleCount,
    valid,
    visibleCount,
  } = useFactoryLoadingDispatchCompareState();
  return {
    allTripsEnded,
    canReconcile,
    companyId,
    comparison,
    filter,
    financialReconciliation,
    isSupervisor,
    missingFromLoading,
    navigate,
    orderId,
    refreshAllReconciliation,
    removalReason,
    removeConfirmed,
    removeOpen,
    removeSelected,
    removing,
    result,
    rows,
    s,
    search,
    selectAllMissing,
    selectedCurrent,
    selectedId,
    selectedKg,
    setFilter,
    setRemovalReason,
    setRemoveConfirmed,
    setRemoveOpen,
    setSearch,
    setSelectedMissing,
    setVisibleCount,
    valid,
    visibleCount,
  };
}

export function FactoryLoadingDispatchCompareCardSection({
  filter,
  rows,
  search,
  setFilter,
  setSearch,
  setVisibleCount,
  visibleCount,
}: Pick<
  ReturnType<typeof useFactoryLoadingDispatchCompareState2>,
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
