import { useMemo } from "react";
import { CalendarRange, Search, Users } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { StockEntryWorker } from "./derived";
import type { GroupRow } from "./types";

interface HistoryFiltersProps {
  fromDate: string;
  toDate: string;
  onFromDateChange: (value: string) => void;
  onToDateChange: (value: string) => void;
  selectedWorkerId: string;
  onWorkerChange: (workerId: string) => void;
  workers: StockEntryWorker[];
  groups: GroupRow[];
  search: string;
  onSearchChange: (value: string) => void;
  includeUnassigned: boolean;
  onIncludeUnassignedChange: (value: boolean) => void;
}

export function HistoryFilters({
  fromDate, toDate, onFromDateChange, onToDateChange, selectedWorkerId,
  onWorkerChange, workers, groups, search, onSearchChange,
  includeUnassigned, onIncludeUnassignedChange,
}: HistoryFiltersProps) {
  const workerOptions = useMemo(() => {
    const byId = new Map<number, string>();
    for (const worker of workers) {
      byId.set(worker.id, worker.fullName || worker.full_name || worker.name || `Worker #${worker.id}`);
    }
    // Preserve names for inactive workers who still appear in historical entries.
    for (const group of groups) {
      if (group.workerId != null && !byId.has(group.workerId)) {
        byId.set(group.workerId, group.workerName || `Worker #${group.workerId}`);
      }
    }
    return [...byId].sort((a, b) => a[1].localeCompare(b[1], undefined, { sensitivity: "base" }));
  }, [workers, groups]);

  return (
    <div className="flex items-end gap-2 px-3 py-2 rounded-xl border bg-muted/30 flex-wrap">
      <div className="space-y-1 shrink-0">
        <Label htmlFor="stock-entry-history-from" className="flex items-center gap-1 text-xs text-muted-foreground">
          <CalendarRange className="h-3.5 w-3.5" /> From
        </Label>
        <Input
          id="stock-entry-history-from"
          type="date"
          value={fromDate}
          onChange={(event) => onFromDateChange(event.target.value)}
          data-testid="input-stock-entry-from"
          className="w-40 h-8 text-xs"
        />
      </div>
      <div className="space-y-1 shrink-0">
        <Label htmlFor="stock-entry-history-to" className="text-xs text-muted-foreground">To</Label>
        <Input
          id="stock-entry-history-to"
          type="date"
          value={toDate}
          onChange={(event) => onToDateChange(event.target.value)}
          data-testid="input-stock-entry-to"
          className="w-40 h-8 text-xs"
        />
      </div>
      <div className="space-y-1 shrink-0 min-w-[170px]">
        <Label className="flex items-center gap-1 text-xs text-muted-foreground">
          <Users className="h-3.5 w-3.5" /> Worker
        </Label>
        <Select value={selectedWorkerId} onValueChange={onWorkerChange}>
          <SelectTrigger className="w-48 h-8 text-xs" data-testid="select-stock-entry-worker" aria-label="Filter stock entry by worker">
            <SelectValue placeholder="All workers" />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            <SelectItem value="all">All workers</SelectItem>
            {workerOptions.map(([id, name]) => (
              <SelectItem key={id} value={String(id)}>{name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="relative flex-1 min-w-[180px]">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
        <Input
          className="pl-8 h-8 text-xs"
          placeholder="Search by reference number…"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          data-testid="input-search"
        />
      </div>
      <div className="flex items-center gap-1.5 shrink-0 h-8">
        <Checkbox
          id="include-unassigned"
          checked={includeUnassigned}
          onCheckedChange={(value) => onIncludeUnassignedChange(!!value)}
          data-testid="checkbox-include-unassigned"
        />
        <Label htmlFor="include-unassigned" className="text-xs cursor-pointer whitespace-nowrap">
          Include Unassigned
        </Label>
      </div>
    </div>
  );
}
