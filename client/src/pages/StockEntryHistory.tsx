import { useEffect, useMemo, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlignJustify, CalendarRange, ChevronDown, ChevronRight, History, List, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useToast } from "@/hooks/use-toast";

import { fetchProduction, type ProductionResponse } from "./factory/factoryProductionTargetsModel";
import type { StockEntryWorker } from "./stockentryhistory/derived";
import type { BaleDetail, GroupRow, StockEntryHistoryPage, StockEntryHistoryProps } from "./stockentryhistory/types";
import { DetailedHistoryTable } from "./stockentryhistory/DetailedHistoryTable";
import { StockEntryHistoryEditableDateCell } from "./stockentryhistory/EditableDateCell";
import { createStockEntryHistoryGroupBaleHelpers, groupKey } from "./stockentryhistory/groupBaleHelpers";
import { useStockEntryHistoryMutations } from "./stockentryhistory/useStockEntryHistoryMutations";
import { STATUS_COLORS, fetchAllStockEntryHistoryPages, formatDailyNum, formatHistoryTime } from "./stockentryhistory/utils";

export default function StockEntryHistory({ onActiveDateChange }: StockEntryHistoryProps = {}) {
  const { formatDisplayDate } = useDateFormat();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const today = new Date().toLocaleDateString("en-CA");

  const [selectedDate, setSelectedDate] = useState(today);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [includeUnassigned, setIncludeUnassigned] = useState(true);
  const [editingDateKey, setEditingDateKey] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"condensed" | "detailed">("condensed");
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    onActiveDateChange?.(selectedDate || null);
  }, [onActiveDateChange, selectedDate]);

  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(timeout);
  }, [search]);

  const page = 1;
  const pageSize = 9999;
  const useLite = viewMode === "condensed";

  const params = new URLSearchParams();
  if (selectedDate) {
    params.set("startDate", selectedDate);
    params.set("endDate", selectedDate);
  }
  if (debouncedSearch.trim()) params.set("search", debouncedSearch.trim());
  if (!includeUnassigned) params.set("includeUnassigned", "false");
  if (useLite) params.set("lite", "1");
  params.set("page", String(page));
  params.set("limit", String(pageSize));

  const { data: pagedGroups, isLoading } = useQuery<StockEntryHistoryPage>({
    queryKey: ["/api/factory/bales/stock-entry-history", params.toString(), page, pageSize],
    queryFn: async () => {
      const response = await fetch(`/api/factory/bales/stock-entry-history?${params.toString()}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error(`Stock entry history failed: ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data.items)) throw new Error("Invalid response: items is not an array");
      return data as StockEntryHistoryPage;
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    placeholderData: (previous) => previous,
  });

  const groups: GroupRow[] = useMemo(() => pagedGroups?.items ?? [], [pagedGroups]);
  const allBales = useMemo(() => groups.flatMap((group) => group.bales ?? []), [groups]);
  const totalBales = useMemo(() => groups.reduce((sum, group) => sum + group.baleCount, 0), [groups]);
  const totalWeight = useMemo(
    () => groups.reduce((sum, group) => sum + parseFloat(group.totalWeight || "0"), 0),
    [groups]
  );

  const { data: workers = [] } = useQuery<StockEntryWorker[]>({
    queryKey: ["/api/factory/workers?profile=picker"],
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const targetDate = selectedDate || null;
  const { data: productionTargets } = useQuery<ProductionResponse>({
    queryKey: ["/api/factory/staff-tracking", "production", "daily", targetDate, targetDate],
    queryFn: () => fetchProduction("daily", targetDate!, targetDate!),
    enabled: Boolean(targetDate),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const workerTargets = useMemo<
    Record<number, { targetBales: number; producedBales: number; workerCount: number }>
  >(() => {
    const targets: Record<number, { targetBales: number; producedBales: number; workerCount: number }> = {};
    for (const row of productionTargets?.rows ?? []) {
      if (row.targetBales === null || row.targetBales === undefined) continue;
      const targetBales = Number(row.targetBales);
      const producedBales = Number(row.producedBales ?? 0);
      if (!Number.isFinite(targetBales) || !Number.isFinite(producedBales)) continue;
      targets[row.personId] = { targetBales, producedBales, workerCount: 1 };
    }
    return targets;
  }, [productionTargets]);

  const workerGroups = useMemo(() => {
    const workerMap = new Map<
      string,
      {
        workerKey: string;
        workerId: number | null;
        workerName: string | null;
        totalBales: number;
        totalWeight: number;
        groups: GroupRow[];
      }
    >();

    for (const group of groups) {
      const key = group.workerId != null ? String(group.workerId) : "unassigned";
      const existing = workerMap.get(key) ?? {
        workerKey: key,
        workerId: group.workerId,
        workerName: group.workerName,
        totalBales: 0,
        totalWeight: 0,
        groups: [],
      };
      existing.totalBales += group.baleCount;
      existing.totalWeight += parseFloat(group.totalWeight || "0");
      existing.groups.push(group);
      workerMap.set(key, existing);
    }

    const workerNameById = new Map(
      workers.map((worker) => [worker.id, worker.fullName ?? worker.full_name ?? worker.name ?? ""])
    );
    for (const workerIdString of Object.keys(workerTargets)) {
      const workerId = Number(workerIdString);
      const key = String(workerId);
      if (workerMap.has(key)) continue;
      workerMap.set(key, {
        workerKey: key,
        workerId,
        workerName: workerNameById.get(workerId) || null,
        totalBales: 0,
        totalWeight: 0,
        groups: [],
      });
    }

    return Array.from(workerMap.values()).sort((left, right) => right.totalBales - left.totalBales);
  }, [groups, workerTargets, workers]);

  const expandedGroupBaleKeys = useMemo(
    () => Array.from(expandedKeys).filter((key) => key.endsWith("-bales")),
    [expandedKeys]
  );
  const groupBaleQueries = useQueries({
    queries: expandedGroupBaleKeys.map((key) => {
      const baseKey = key.replace(/-bales$/, "");
      const group = groups.find((item) => groupKey(item) === baseKey);
      if (!group) {
        return {
          queryKey: ["stock-entry-history", "missing-group", key],
          queryFn: async () => [] as BaleDetail[],
          enabled: false,
        };
      }

      const groupParams = new URLSearchParams();
      groupParams.set("startDate", group.stockEntryDate);
      groupParams.set("endDate", group.stockEntryDate);
      if (group.workerId) groupParams.set("workerId", String(group.workerId));
      if (group.productId) groupParams.set("productId", String(group.productId));
      if (group.erpLocationId) groupParams.set("locationId", String(group.erpLocationId));
      if (debouncedSearch.trim()) groupParams.set("search", debouncedSearch.trim());

      return {
        queryKey: ["/api/factory/bales/stock-entry-history/group", groupParams.toString()],
        queryFn: (): Promise<BaleDetail[]> =>
          fetchAllStockEntryHistoryPages(groupParams).then((rows) => rows.flatMap((item) => item.bales ?? [])),
        staleTime: 5 * 60 * 1000,
        refetchOnWindowFocus: false,
        enabled: useLite,
      };
    }),
  });

  const { getGroupBales, resolveGroupBaleIds, isGroupBalesLoading } = createStockEntryHistoryGroupBaleHelpers({
    useLite,
    expandedGroupBaleKeys,
    groupBaleQueries,
    queryClient,
    params,
  });

  function toggleExpand(key: string) {
    setExpandedKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const { updateDateMutation, bulkAssignMutation } = useStockEntryHistoryMutations({
    fromActive: Boolean(selectedDate),
    fromDate: selectedDate || today,
    today,
    setEditingDateKey,
  });

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center h-8 w-8 rounded-xl bg-gradient-to-br from-sky-500/30 to-sky-600/10 border border-sky-500/25 shrink-0">
            <History className="h-4 w-4 text-sky-500" />
          </div>
          <div>
            <h2 className="text-base font-bold leading-tight">Stock Entry History</h2>
            <p className="text-xs text-muted-foreground leading-tight">Browse recorded bale entries</p>
          </div>
        </div>

        <div className="flex items-center bg-muted rounded-lg p-0.5 gap-0.5">
          <Button
            variant={viewMode === "condensed" ? "default" : "ghost"}
            size="sm"
            className="h-7 px-2.5 text-xs rounded-md"
            onClick={() => setViewMode("condensed")}
            data-testid="button-view-condensed"
            data-remote-control-safe="true"
            data-remote-control-action="toggle-view"
          >
            <AlignJustify className="w-3 h-3 mr-1" /> Condensed
          </Button>
          <Button
            variant={viewMode === "detailed" ? "default" : "ghost"}
            size="sm"
            className="h-7 px-2.5 text-xs rounded-md"
            onClick={() => setViewMode("detailed")}
            data-testid="button-view-detailed"
            data-remote-control-safe="true"
            data-remote-control-action="toggle-view"
          >
            <List className="w-3 h-3 mr-1" /> Detailed
          </Button>
        </div>
      </div>

      <div className="flex items-end gap-2 px-3 py-2 rounded-xl border bg-muted/30 flex-wrap">
        <div className="space-y-1 shrink-0">
          <Label htmlFor="stock-entry-history-date" className="flex items-center gap-1 text-xs text-muted-foreground">
            <CalendarRange className="h-3.5 w-3.5" />
            Date
          </Label>
          <Input
            id="stock-entry-history-date"
            type="date"
            value={selectedDate}
            onChange={(event) => setSelectedDate(event.target.value)}
            data-testid="input-stock-entry-date"
            className="w-40 h-8 text-xs"
          />
        </div>

        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            className="pl-8 h-8 text-xs"
            placeholder="Search by reference number…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            data-testid="input-search"
          />
        </div>

        <div className="flex items-center gap-1.5 shrink-0 h-8">
          <Checkbox
            id="include-unassigned"
            checked={includeUnassigned}
            onCheckedChange={(value) => setIncludeUnassigned(!!value)}
            data-testid="checkbox-include-unassigned"
          />
          <Label htmlFor="include-unassigned" className="text-xs cursor-pointer whitespace-nowrap">
            Include Unassigned
          </Label>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border bg-slate-500/10 border-slate-500/20">
          <span className="text-xs font-semibold text-slate-500">Groups</span>
          <span className="text-sm font-bold tabular-nums text-slate-600 dark:text-slate-300">
            {(pagedGroups?.total ?? groups.length).toLocaleString()}
          </span>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border bg-emerald-500/10 border-emerald-500/20">
          <span className="text-xs font-semibold text-emerald-500">Bales</span>
          <span className="text-sm font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
            {(pagedGroups?.totalBales ?? totalBales).toLocaleString()}
          </span>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border bg-sky-500/10 border-sky-500/20">
          <span className="text-xs font-semibold text-sky-500">Weight</span>
          <span className="text-sm font-bold tabular-nums text-sky-600 dark:text-sky-400">
            {formatDailyNum(pagedGroups?.totalWeight ?? totalWeight)}
          </span>
          <span className="text-xs text-sky-600/70 dark:text-sky-400/70">kg</span>
        </div>
      </div>

      {viewMode === "condensed" && (
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
              {isLoading && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              )}
              {!isLoading && workerGroups.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                    No stock entry records found for the selected filters.
                  </td>
                </tr>
              )}
              {workerGroups.map((workerGroup) => {
                const workerExpanded = expandedKeys.has(workerGroup.workerKey);
                const targetInfo = workerGroup.workerId != null ? workerTargets[workerGroup.workerId] : undefined;
                const target = targetInfo?.targetBales ?? 0;
                const workerCount = targetInfo?.workerCount ?? 0;
                const diff = (targetInfo?.producedBales ?? 0) - target;

                return [
                  <tr
                    key={workerGroup.workerKey}
                    className="border-t hover-elevate cursor-pointer bg-muted/30"
                    onClick={() => toggleExpand(workerGroup.workerKey)}
                    data-testid={`row-worker-${workerGroup.workerKey}`}
                  >
                    <td className="px-3 py-2 text-muted-foreground">
                      {workerExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </td>
                    <td className="px-3 py-2 text-right text-muted-foreground">
                      {targetInfo && workerCount > 0 ? workerCount : <span className="text-xs text-muted-foreground">—</span>}
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
                              const groupExpanded = expandedKeys.has(key + "-bales");
                              return [
                                <tr
                                  key={key}
                                  className="border-t border-border/40 hover-elevate cursor-pointer"
                                  onClick={() => toggleExpand(key + "-bales")}
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
                                      editingDateKey={editingDateKey}
                                      setEditingDateKey={setEditingDateKey}
                                      formatDisplayDate={formatDisplayDate}
                                      onSave={async (newDate) => {
                                        const baleIds = await resolveGroupBaleIds(group);
                                        if (baleIds.length === 0) {
                                          toast({ title: "No bales found", variant: "destructive" });
                                          return;
                                        }
                                        updateDateMutation.mutate({ ids: baleIds, stockEntryDate: newDate });
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
                                        const baleIds = await resolveGroupBaleIds(group);
                                        if (baleIds.length === 0) {
                                          toast({
                                            title: "Reassign failed",
                                            description: "Could not find any bales for this group.",
                                            variant: "destructive",
                                          });
                                          return;
                                        }
                                        bulkAssignMutation.mutate({ baleIds, workerId });
                                      }}
                                    >
                                      <SelectTrigger className="h-6 w-36 text-xs" data-testid={`select-assign-worker-${key}`}>
                                        <SelectValue placeholder="Reassign…" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {workers
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
                                          {isGroupBalesLoading(group) ? (
                                            <tr>
                                              <td colSpan={4} className="py-2 text-xs text-muted-foreground">
                                                Loading bale details…
                                              </td>
                                            </tr>
                                          ) : (
                                            getGroupBales(group).map((bale) => (
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
                                                  <span
                                                    className={`inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-semibold ${STATUS_COLORS[bale.status] || "bg-muted text-muted-foreground"}`}
                                                  >
                                                    {bale.status}
                                                  </span>
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

      {viewMode === "detailed" && (
        <DetailedHistoryTable
          isLoading={isLoading}
          allBales={allBales}
          editingDateKey={editingDateKey}
          setEditingDateKey={setEditingDateKey}
          formatDisplayDate={formatDisplayDate}
          onUpdateDate={(baleId, stockEntryDate) =>
            updateDateMutation.mutate({ ids: [baleId], stockEntryDate })
          }
        />
      )}
    </div>
  );
}
