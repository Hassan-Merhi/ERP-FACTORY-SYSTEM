import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { DateMode } from "../types";
import { isoMonthEnd, isoMonthStart } from "../utils";

interface AttendanceReportPeriodBarProps {
  mode: DateMode;
  setMode: (mode: DateMode) => void;
  customStart: string;
  setCustomStart: (value: string) => void;
  customEnd: string;
  setCustomEnd: (value: string) => void;
  navigateMonth: (offset: number) => void;
  rangeLabel: string;
}

/** Period selector: quick modes, the month navigator and the custom date range. */
export function AttendanceReportPeriodBar({
  mode,
  setMode,
  customStart,
  setCustomStart,
  customEnd,
  setCustomEnd,
  navigateMonth,
  rangeLabel,
}: AttendanceReportPeriodBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-3 print:hidden">
      <span className="text-sm font-semibold text-muted-foreground">Period:</span>
      <div className="flex flex-wrap items-center gap-1 rounded-xl border border-slate-200 bg-white/80 p-1 shadow-sm dark:border-blue-900/60 dark:bg-[hsl(var(--factory-hue)_51%_14%)]">
        {(["today", "yesterday", "thisMonth", "custom"] as DateMode[]).map((m) => (
          <Button
            key={m}
            variant="ghost"
            size="sm"
            onClick={() => {
              if (m === "thisMonth") {
                setCustomStart(isoMonthStart());
                setCustomEnd(isoMonthEnd());
              }
              setMode(m);
            }}
            data-testid={`mode-${m}`}
            className={cn(
              "h-8 rounded-lg px-4 text-xs font-semibold transition-colors",
              mode === m
                ? "bg-blue-600 text-white shadow-[0_2px_10px_hsl(var(--factory-hue)_83%_53%_/_0.35)] hover:bg-blue-700 hover:text-white dark:bg-blue-600 dark:hover:bg-blue-500"
                : "text-muted-foreground hover:bg-slate-100 dark:hover:bg-blue-950/70"
            )}
          >
            {m === "today" ? "Today" : m === "yesterday" ? "Yesterday" : m === "thisMonth" ? "This Month" : "Custom"}
          </Button>
        ))}
      </div>

      {/* Month navigator for thisMonth */}
      {mode === "thisMonth" && (
        <div className="flex flex-wrap items-center gap-1 rounded-xl border border-slate-200 bg-white/80 p-1 shadow-sm dark:border-blue-900/60 dark:bg-[hsl(var(--factory-hue)_51%_14%)]">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigateMonth(-1)}
            data-testid="button-prev-month"
            className="h-7 w-7"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="text-xs font-semibold px-2 select-none" data-testid="text-current-month">
            {rangeLabel}
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigateMonth(1)}
            data-testid="button-next-month"
            className="h-7 w-7"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      {/* Custom range inputs */}
      {mode === "custom" && (
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={customStart}
            onChange={(e) => setCustomStart(e.target.value)}
            data-testid="input-custom-start"
            className="h-7 rounded-md border bg-background px-2 text-xs focus:outline-hidden focus:ring-1 focus:ring-ring"
          />
          <span className="text-xs text-muted-foreground">–</span>
          <input
            type="date"
            value={customEnd}
            onChange={(e) => setCustomEnd(e.target.value)}
            data-testid="input-custom-end"
            className="h-7 rounded-md border bg-background px-2 text-xs focus:outline-hidden focus:ring-1 focus:ring-ring"
          />
        </div>
      )}
    </div>
  );
}
