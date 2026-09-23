import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarRange, History, Search } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDateFormat } from "@/contexts/DateFormatContext";

import type { GroupRow, StockEntryHistoryPage, StockEntryHistoryProps } from "./stockentryhistory/types";
import { DetailedHistoryTable } from "./stockentryhistory/DetailedHistoryTable";
import { useStockEntryHistoryMutations } from "./stockentryhistory/useStockEntryHistoryMutations";

export default function StockEntryHistory({ onActiveDateChange }: StockEntryHistoryProps = {}) {
  const { formatDisplayDate } = useDateFormat();
  const today = new Date().toLocaleDateString("en-CA");

  const [selectedDate, setSelectedDate] = useState(today);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [includeUnassigned, setIncludeUnassigned] = useState(true);
  const [editingDateKey, setEditingDateKey] = useState<string | null>(null);

  useEffect(() => {
    onActiveDateChange?.(selectedDate || null);
  }, [onActiveDateChange, selectedDate]);

  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(timeout);
  }, [search]);

  const page = 1;
  const pageSize = 9999;

  const params = new URLSearchParams();
  if (selectedDate) {
    params.set("startDate", selectedDate);
    params.set("endDate", selectedDate);
  }
  if (debouncedSearch.trim()) params.set("search", debouncedSearch.trim());
  if (!includeUnassigned) params.set("includeUnassigned", "false");
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

  const { updateDateMutation } = useStockEntryHistoryMutations({
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
            {(pagedGroups?.totalWeight ?? totalWeight).toFixed(2)}
          </span>
          <span className="text-xs text-sky-600/70 dark:text-sky-400/70">kg</span>
        </div>
      </div>

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
    </div>
  );
}
