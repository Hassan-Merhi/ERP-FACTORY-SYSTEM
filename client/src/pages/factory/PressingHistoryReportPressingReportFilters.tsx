// Extracted from ./PressingHistoryReport.tsx to keep that module under the source-size cap.
import { CalendarDays, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { PressingReportFilters } from "@shared/pressingReportContracts";
import { countText, kgText, today, usePressingHistoryReportState } from "./usePressingHistoryReportState";
import { SelectContent, SelectItem, SelectTrigger, SelectValue, Select } from "@/components/ui/select";

export function PressingHistoryReportPressingReportFilters({
  canSeeEveryone,
  filters,
  invalidDates,
  operators,
  options,
  search,
  setSearch,
  summary,
  update,
  weightOptions,
}: Pick<
  ReturnType<typeof usePressingHistoryReportState>,
  | "canSeeEveryone"
  | "filters"
  | "invalidDates"
  | "operators"
  | "options"
  | "search"
  | "setSearch"
  | "summary"
  | "update"
  | "weightOptions"
>) {
  return (
    <div className="rounded-xl border bg-card p-3 shadow-sm sm:p-4" data-testid="pressing-report-filters">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <SlidersHorizontal className="h-4 w-4 text-muted-foreground" /> History filters
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            onClick={() => {
              const day = options.data?.serverToday || today();
              update({ from: day, to: day, fromTime: undefined, toTime: undefined });
            }}
          >
            <CalendarDays className="mr-1 h-3.5 w-3.5" />
            Today
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            onClick={() => {
              const day = options.data?.serverToday || today();
              update({ from: day.slice(0, 7) + "-01", to: day, fromTime: undefined, toTime: undefined });
            }}
          >
            This Month
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            onClick={() => update({ from: undefined, to: undefined, fromTime: undefined, toTime: undefined })}
          >
            All Time
          </Button>
        </div>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        These filters apply to the scan history and export below. The KPIs above always match the selected hourly
        production date (07:00–17:00).
      </p>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <div className="min-w-0 space-y-1">
          <div className="text-xs font-medium text-muted-foreground">
            From <span className="font-normal">(Beirut time)</span>
          </div>
          <div className="flex min-w-0 gap-1.5">
            <Input
              type="date"
              aria-label="From date"
              className="h-10 min-w-0 flex-[3] text-foreground"
              value={filters.from || ""}
              onChange={(e) =>
                update({ from: e.target.value || undefined, ...(e.target.value ? {} : { fromTime: undefined }) })
              }
            />
            <Input
              type="time"
              step={60}
              aria-label="From time (Beirut)"
              title="From hour and minute, Beirut local time"
              className="h-10 min-w-0 flex-[2] px-1.5 text-foreground"
              value={filters.fromTime || ""}
              disabled={!filters.from}
              onChange={(e) => update({ fromTime: e.target.value || undefined })}
            />
          </div>
        </div>
        <div className="min-w-0 space-y-1">
          <div className="text-xs font-medium text-muted-foreground">
            To <span className="font-normal">(Beirut time)</span>
          </div>
          <div className="flex min-w-0 gap-1.5">
            <Input
              type="date"
              aria-label="To date"
              className="h-10 min-w-0 flex-[3] text-foreground"
              value={filters.to || ""}
              onChange={(e) =>
                update({ to: e.target.value || undefined, ...(e.target.value ? {} : { toTime: undefined }) })
              }
            />
            <Input
              type="time"
              step={60}
              aria-label="To time (Beirut)"
              title="To hour and minute, Beirut local time"
              className="h-10 min-w-0 flex-[2] px-1.5 text-foreground"
              value={filters.toTime || ""}
              disabled={!filters.to}
              onChange={(e) => update({ toTime: e.target.value || undefined })}
            />
          </div>
        </div>
        {canSeeEveryone && (
          <label className="space-y-1 text-xs font-medium text-muted-foreground">
            Worker
            <Select
              value={filters.userId || "__all__"}
              onValueChange={(v) => update({ userId: v === "__all__" ? undefined : v || undefined })}
            >
              <SelectTrigger aria-label="Pressing user filter" className="h-10 w-full text-foreground">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All users</SelectItem>
                {operators.map((operator) => (
                  <SelectItem key={operator.userId} value={String(operator.userId)}>
                    {operator.displayName?.trim() || "Display name not set"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        )}
        <label className="space-y-1 text-xs font-medium text-muted-foreground">
          Item weight
          <Select
            value={filters.weightKg === undefined ? "__all__" : String(filters.weightKg)}
            onValueChange={(v) => update({ weightKg: v !== "__all__" ? Number(v) : undefined })}
          >
            <SelectTrigger aria-label="Pressing KG filter" className="h-10 w-full text-foreground">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All KG</SelectItem>
              {weightOptions.map((kg) => (
                <SelectItem key={kg} value={String(Number(kg))}>
                  {kgText(kg)} KG
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="space-y-1 text-xs font-medium text-muted-foreground">
          Barcode / article
          <Input
            aria-label="Pressing barcode or article search"
            placeholder="Search..."
            className="h-10 text-foreground"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              update({ search: e.target.value || undefined });
            }}
          />
        </label>
        {canSeeEveryone && (
          <label className="space-y-1 text-xs font-medium text-muted-foreground">
            Status
            <Select
              value={filters.status}
              onValueChange={(v) => update({ status: v as PressingReportFilters["status"] })}
            >
              <SelectTrigger aria-label="Pressing confirmation status" className="h-10 w-full text-foreground">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Confirmed</SelectItem>
                <SelectItem value="voided">Voided</SelectItem>
                <SelectItem value="all">All</SelectItem>
              </SelectContent>
            </Select>
          </label>
        )}
      </div>
      {invalidDates && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          From date/time cannot exceed To date/time.
        </p>
      )}
      {filters.status !== "active" && (
        <p className="mt-2 text-xs text-muted-foreground">
          KPI totals count confirmed items only. The history below follows your selected status.
        </p>
      )}
      {Number(summary?.voidedBales || 0) > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {countText(summary?.voidedBales)} voided scans excluded from KPI totals.
        </p>
      )}
    </div>
  );
}
