import { AlignJustify, ChevronDown, ChevronRight, History, List } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/page-state";
import { StatusBadge } from "@/components/StatusBadge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import type { StockEntryHistoryProps } from "./stockentryhistory/types";
import { DetailedHistoryTable } from "./stockentryhistory/DetailedHistoryTable";
import { StockEntryHistoryEditableDateCell } from "./stockentryhistory/EditableDateCell";
import { HistoryFilters } from "./stockentryhistory/HistoryFilters";
import { groupKey } from "./stockentryhistory/groupBaleHelpers";
import { formatDailyNum, formatHistoryTime } from "./stockentryhistory/utils";
import { useStockEntryHistoryModel } from "./StockEntryHistoryModel";

export default function StockEntryHistory({ onActiveDateChange }: StockEntryHistoryProps = {}) {
  const seh = useStockEntryHistoryModel({ onActiveDateChange });

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center h-8 w-8 rounded-xl bg-linear-to-br from-sky-500/30 to-sky-600/10 border border-sky-500/25 shrink-0">
            <History className="h-4 w-4 text-sky-500" />
          </div>
          <div>
            <h2 className="text-base font-bold leading-tight">Stock Entry History</h2>
            <p className="text-xs text-muted-foreground leading-tight">Browse recorded bale entries</p>
          </div>
        </div>

        <div className="flex items-center bg-muted rounded-lg p-0.5 gap-0.5">
          <Button
            variant={seh.viewMode === "condensed" ? "default" : "ghost"}
            size="sm"
            className="h-7 px-2.5 text-xs rounded-md"
            onClick={() => seh.setViewMode("condensed")}
            data-testid="button-view-condensed"
            data-remote-control-safe="true"
            data-remote-control-action="toggle-view"
          >
            <AlignJustify className="w-3 h-3 mr-1" /> Condensed
          </Button>
          <Button
            variant={seh.viewMode === "detailed" ? "default" : "ghost"}
            size="sm"
            className="h-7 px-2.5 text-xs rounded-md"
            onClick={() => seh.setViewMode("detailed")}
            data-testid="button-view-detailed"
            data-remote-control-safe="true"
            data-remote-control-action="toggle-view"
          >
            <List className="w-3 h-3 mr-1" /> Detailed
          </Button>
        </div>
      </div>

      <HistoryFilters
        fromDate={seh.fromDate}
        toDate={seh.toDate}
        onFromDateChange={seh.setFromDate}
        onToDateChange={seh.setToDate}
        selectedWorkerId={seh.selectedWorkerId}
        onWorkerChange={(workerId) => {
          seh.setSelectedWorkerId(workerId);
          if (workerId !== "all") seh.setViewMode("detailed");
        }}
        workers={seh.workers}
        groups={seh.groups}
        search={seh.search}
        onSearchChange={seh.setSearch}
        includeUnassigned={seh.includeUnassigned}
        onIncludeUnassignedChange={seh.setIncludeUnassigned}
      />
      {!seh.dateRangeValid && (
        <p className="text-xs text-destructive">Choose a valid From and To date (From must be on or before To).</p>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border bg-slate-500/10 border-slate-500/20">
          <span className="text-xs font-semibold text-slate-500">Groups</span>
          <span className="text-sm font-bold tabular-nums text-slate-600 dark:text-slate-300">
            {(seh.firstPage?.total ?? seh.groups.length).toLocaleString()}
          </span>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border bg-emerald-500/10 border-emerald-500/20">
          <span className="text-xs font-semibold text-emerald-500">Bales</span>
          <span className="text-sm font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
            {(seh.firstPage?.totalBales ?? seh.totalBales).toLocaleString()}
          </span>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border bg-sky-500/10 border-sky-500/20">
          <span className="text-xs font-semibold text-sky-500">Weight</span>
          <span className="text-sm font-bold tabular-nums text-sky-600 dark:text-sky-400">
            {formatDailyNum(seh.firstPage?.totalWeight ?? seh.totalWeight)}
          </span>
          <span className="text-xs text-sky-600/70 dark:text-sky-400/70">kg</span>
        </div>
      </div>

      {seh.viewMode === "condensed" && (
        <div className="rounded-xl border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-30 bg-muted border-b-2 border-border/60">
              <tr className="text-left">
                <th className="px-3 py-2.5 w-6"></th>
                <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground tracking-wide">
                  No. Workers
                </th>
                <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground tracking-wide">Worker</th>
                <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground tracking-wide">
                  Target
                </th>
                <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground tracking-wide">
                  Shortage
                </th>
                <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground tracking-wide">
                  Bales
                </th>
                <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground tracking-wide">
                  Total kg
                </th>
              </tr>
            </thead>
            <tbody>
              {seh.isLoading && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              )}
              {!seh.isLoading && seh.isError && !seh.historyPages && (
                <tr>
                  <td colSpan={7} className="px-3 py-8">
                    <ErrorState onAction={() => void seh.refetch()} actionLabel="Try again" />
                  </td>
                </tr>
              )}
              {!seh.isLoading && !(seh.isError && !seh.historyPages) && seh.workerGroups.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                    No stock entry records found for the selected filters.
                  </td>
                </tr>
              )}
              {seh.workerGroups.map((workerGroup) => {
                const workerExpanded = seh.expandedKeys.has(workerGroup.workerKey);
                const targetInfo = workerGroup.workerId != null ? seh.workerTargets[workerGroup.workerId] : undefined;
                const target = targetInfo?.targetBales ?? 0;
                const workerCount = targetInfo?.workerCount ?? 0;
                const diff = (targetInfo?.producedBales ?? 0) - target;

                return [
                  <tr
                    key={workerGroup.workerKey}
                    className="border-t hover-elevate cursor-pointer bg-muted/30"
                    onClick={() => seh.toggleExpand(workerGroup.workerKey)}
                    data-testid={`row-worker-${workerGroup.workerKey}`}
                  >
                    <td className="px-3 py-2 text-muted-foreground">
                      {workerExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </td>
                    <td className="px-3 py-2 text-right text-muted-foreground">
                      {targetInfo && workerCount > 0 ? (
                        workerCount
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-semibold">
                      {workerGroup.workerName || <span className="italic text-muted-foreground">Unassigned</span>}
                    </td>
                    <td className="px-3 py-2 text-right text-muted-foreground">
                      {targetInfo ? target : <span className="text-xs text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold">
                      {targetInfo ? (
                        <span
                          className={
                            diff >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"
                          }
                        >
                          {diff >= 0 ? `+${diff}` : diff}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold">{workerGroup.totalBales}</td>
                    <td className="px-3 py-2 text-right font-semibold">{formatDailyNum(workerGroup.totalWeight)}</td>
                  </tr>,
                  workerExpanded && (
                    <tr key={workerGroup.workerKey + "-sub"} className="bg-muted/10">
                      <td colSpan={7} className="px-0 py-0">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-muted-foreground border-b bg-muted/20">
                              <th className="px-8 py-1.5 text-left w-6"></th>
                              <th className="px-3 py-1.5 text-left">Date</th>
                              <th className="px-3 py-1.5 text-left">Location</th>
                              <th className="px-3 py-1.5 text-left">Product</th>
                              <th className="px-3 py-1.5 text-right">Bales</th>
                              <th className="px-3 py-1.5 text-right">Total kg</th>
                              <th className="px-3 py-1.5 text-right">Avg kg</th>
                              <th className="px-3 py-1.5">Reassign</th>
                            </tr>
                          </thead>
                          <tbody>
                            {workerGroup.groups.map((group) => {
                              const key = groupKey(group);
                              const groupExpanded = seh.expandedKeys.has(key + "-bales");
                              return [
                                <tr
                                  key={key}
                                  className="border-t border-border/40 hover-elevate cursor-pointer"
                                  onClick={() => seh.toggleExpand(key + "-bales")}
                                  data-testid={`row-group-${key}`}
                                >
                                  <td className="px-8 py-1.5 text-muted-foreground">
                                    {groupExpanded ? (
                                      <ChevronDown className="w-3 h-3" />
                                    ) : (
                                      <ChevronRight className="w-3 h-3" />
                                    )}
                                  </td>
                                  <td className="px-3 py-1.5" onClick={(event) => event.stopPropagation()}>
                                    <StockEntryHistoryEditableDateCell
                                      dateStr={group.stockEntryDate}
                                      editKey={`group-${key}`}
                                      editingDateKey={seh.editingDateKey}
                                      setEditingDateKey={seh.setEditingDateKey}
                                      formatDisplayDate={seh.formatDisplayDate}
                                      onSave={async (newDate) => {
                                        const baleIds = await seh.resolveGroupBaleIds(group);
                                        if (baleIds.length === 0) {
                                          seh.toast({ title: "No bales found", variant: "destructive" });
                                          return;
                                        }
                                        seh.updateDateMutation.mutate({ ids: baleIds, stockEntryDate: newDate });
                                      }}
                                    />
                                  </td>
                                  <td className="px-3 py-1.5">{group.locationName}</td>
                                  <td className="px-3 py-1.5">
                                    {group.productName || "—"}
                                    {group.articleCode && (
                                      <span className="ml-1 text-muted-foreground">({group.articleCode})</span>
                                    )}
                                  </td>
                                  <td className="px-3 py-1.5 text-right font-medium">{group.baleCount}</td>
                                  <td className="px-3 py-1.5 text-right">
                                    {formatDailyNum(parseFloat(group.totalWeight || "0"))}
                                  </td>
                                  <td className="px-3 py-1.5 text-right">
                                    {formatDailyNum(parseFloat(group.avgWeight || "0"))}
                                  </td>
                                  <td className="px-3 py-1.5" onClick={(event) => event.stopPropagation()}>
                                    <Select
                                      value={group.workerId ? String(group.workerId) : ""}
                                      onValueChange={async (value) => {
                                        const workerId = parseInt(value, 10);
                                        const baleIds = await seh.resolveGroupBaleIds(group);
                                        if (baleIds.length === 0) {
                                          seh.toast({
                                            title: "Reassign failed",
                                            description: "Could not find any bales for this group.",
                                            variant: "destructive",
                                          });
                                          return;
                                        }
                                        seh.bulkAssignMutation.mutate({ baleIds, workerId });
                                      }}
                                    >
                                      <SelectTrigger
                                        className="h-6 w-36 text-xs"
                                        data-testid={`select-assign-worker-${key}`}
                                      >
                                        <SelectValue placeholder="Reassign…" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {seh.workers
                                          .filter((worker) => worker.active)
                                          .map((worker) => (
                                            <SelectItem key={worker.id} value={String(worker.id)}>
                                              {worker.fullName || worker.full_name || worker.name}
                                            </SelectItem>
                                          ))}
                                      </SelectContent>
                                    </Select>
                                  </td>
                                </tr>,
                                groupExpanded && (
                                  <tr key={key + "-bales-detail"} className="bg-muted/20">
                                    <td colSpan={8} className="px-12 py-2">
                                      <table className="w-full text-xs">
                                        <thead>
                                          <tr className="text-muted-foreground">
                                            <th className="text-left pb-1 pr-4">Reference</th>
                                            <th className="text-right pb-1 pr-4">Weight (kg)</th>
                                            <th className="text-left pb-1 pr-4">Status</th>
                                            <th className="text-left pb-1">Finalized At</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {seh.isGroupBalesLoading(group) ? (
                                            <tr>
                                              <td colSpan={4} className="py-2 text-xs text-muted-foreground">
                                                Loading bale details…
                                              </td>
                                            </tr>
                                          ) : (
                                            seh.getGroupBales(group).map((bale) => (
                                              <tr
                                                key={bale.id}
                                                className="border-t border-border/30"
                                                data-testid={`row-bale-${bale.id}`}
                                              >
                                                <td className="py-1 pr-4 font-mono">{bale.referenceNumber}</td>
                                                <td className="py-1 pr-4 text-right">
                                                  {formatDailyNum(parseFloat(bale.weightKg || "0"))}
                                                </td>
                                                <td className="py-1 pr-4">
                                                  <StatusBadge
                                                    status={bale.status}
                                                    label={bale.status}
                                                    showIcon={false}
                                                    className="px-1.5 py-0.5 text-[11px]"
                                                  />
                                                </td>
                                                <td className="py-1">{formatHistoryTime(bale.finalizedAt)}</td>
                                              </tr>
                                            ))
                                          )}
                                        </tbody>
                                      </table>
                                    </td>
                                  </tr>
                                ),
                              ];
                            })}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}

      {seh.viewMode === "detailed" && (
        <DetailedHistoryTable
          isLoading={seh.isLoading}
          allBales={seh.allBales}
          workers={seh.workers}
          editingDateKey={seh.editingDateKey}
          setEditingDateKey={seh.setEditingDateKey}
          formatDisplayDate={seh.formatDisplayDate}
          onUpdateDate={(baleId, stockEntryDate) => seh.updateDateMutation.mutate({ ids: [baleId], stockEntryDate })}
          onAssignWorker={(baleId, workerId) => seh.bulkAssignMutation.mutate({ baleIds: [baleId], workerId })}
        />
      )}
      {seh.hasNextPage && (
        <div ref={seh.loadMoreRef} className="flex justify-center pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void seh.fetchNextPage()}
            disabled={seh.isFetchingNextPage}
          >
            {seh.isFetchingNextPage ? "Loading more entries…" : "Load more entries"}
          </Button>
        </div>
      )}
    </div>
  );
}
