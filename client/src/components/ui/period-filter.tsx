import { useState } from "react";
import { CalendarIcon, ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Calendar } from "@/components/ui/calendar";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import {
  format,
  startOfDay,
  endOfDay,
  startOfWeek,
  startOfMonth,
  endOfMonth,
  subMonths,
  startOfYear,
  subDays,
} from "date-fns";
import type { DateRange } from "react-day-picker";

export type PeriodPreset =
  | "all_time"
  | "today"
  | "yesterday"
  | "this_week"
  | "this_month"
  | "last_1_month"
  | "last_6_months"
  | "this_year"
  | "custom";

export interface PeriodFilterValue {
  fromDate: string;
  toDate: string;
  preset: PeriodPreset;
}

interface PeriodFilterProps {
  value: PeriodFilterValue;
  onChange: (value: PeriodFilterValue) => void;
  defaultPreset?: PeriodPreset;
  className?: string;
  hideCustomInputs?: boolean;
  "data-testid"?: string;
}

/**
 * Parse the YYYY-MM-DD strings used by report filters without ever returning
 * an Invalid Date. Persisted browser state can outlive schema/UI changes, so a
 * string being present is not enough to trust it as a calendar value.
 */
export function parsePeriodFilterDate(dateValue: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return undefined;

  const [year, month, day] = dateValue.split("-").map(Number);
  const parsed = new Date(year, month - 1, day, 12, 0, 0, 0);

  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return undefined;
  }

  return parsed;
}

function getPresetDates(preset: PeriodPreset): { fromDate: string; toDate: string } {
  const today = new Date();
  const formatDate = (d: Date) => format(d, "yyyy-MM-dd");

  switch (preset) {
    case "all_time":
      return { fromDate: "", toDate: "" };
    case "today":
      return {
        fromDate: formatDate(startOfDay(today)),
        toDate: formatDate(endOfDay(today)),
      };
    case "yesterday": {
      const yesterday = subDays(today, 1);
      return {
        fromDate: formatDate(startOfDay(yesterday)),
        toDate: formatDate(endOfDay(yesterday)),
      };
    }
    case "this_week":
      return {
        fromDate: formatDate(startOfWeek(today, { weekStartsOn: 1 })),
        toDate: formatDate(today),
      };
    case "this_month":
      return {
        fromDate: formatDate(startOfMonth(today)),
        toDate: formatDate(today),
      };
    case "last_1_month": {
      const lastMonth = subMonths(today, 1);
      return {
        fromDate: formatDate(startOfMonth(lastMonth)),
        toDate: formatDate(endOfMonth(lastMonth)),
      };
    }
    case "last_6_months": {
      return {
        fromDate: formatDate(subMonths(today, 6)),
        toDate: formatDate(today),
      };
    }
    case "this_year":
      return {
        fromDate: formatDate(startOfYear(today)),
        toDate: formatDate(today),
      };
    case "custom":
    default:
      return {
        fromDate: formatDate(startOfMonth(today)),
        toDate: formatDate(today),
      };
  }
}

export function getDefaultPeriodValue(preset: PeriodPreset = "this_month"): PeriodFilterValue {
  const dates = getPresetDates(preset);
  return { ...dates, preset };
}

export function PeriodFilter({
  value,
  onChange,
  className,
  hideCustomInputs = false,
  "data-testid": testId,
}: PeriodFilterProps) {
  const { formatDisplayDate } = useDateFormat();
  const isMobile = useIsMobile();
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [draftFromDate, setDraftFromDate] = useState<Date | undefined>(undefined);

  // Never pass an Invalid Date into react-day-picker/date-fns. Old session
  // storage or manually edited state may contain malformed/impossible dates,
  // and date-fns throws RangeError("Invalid time value") when formatting them.
  const fromDateObj = parsePeriodFilterDate(value.fromDate);
  const toDateObj = parsePeriodFilterDate(value.toDate);

  const calendarRange: DateRange | undefined =
    fromDateObj || toDateObj ? { from: fromDateObj, to: toDateObj } : undefined;

  const handlePresetChange = (preset: PeriodPreset) => {
    if (preset === "custom") {
      // Always start a fresh two-click selection, even when an old range exists.
      setDraftFromDate(undefined);
      // Open after the DropdownMenu has closed to avoid DismissableLayer races.
      setTimeout(() => setCalendarOpen(true), 0);
    } else {
      const dates = getPresetDates(preset);
      onChange({ ...dates, preset });
    }
  };

  const handleDayClick = (day: Date) => {
    if (!draftFromDate) {
      // First click selects From only; never close the dialog here.
      setDraftFromDate(day);
      return;
    }

    // Second click completes the new range, regardless of the previous filter.
    const [from, to] = day < draftFromDate ? [day, draftFromDate] : [draftFromDate, day];
    onChange({
      fromDate: format(from, "yyyy-MM-dd"),
      toDate: format(to, "yyyy-MM-dd"),
      preset: "custom",
    });
    setDraftFromDate(undefined);
    setCalendarOpen(false);
  };

  function buildLabel(): string {
    if (value.preset === "all_time") return "All Time";
    if (value.preset === "today") return "Today";
    if (value.preset === "yesterday") return "Yesterday";
    if (value.preset === "this_week") return "This Week";
    if (value.preset === "this_month") return "This Month";
    if (value.preset === "this_year") return "This Year";
    if (fromDateObj && toDateObj) {
      const from = formatDisplayDate(fromDateObj);
      const to = formatDisplayDate(toDateObj);
      if (from === to) return from;
      return `${from} – ${to}`;
    }
    if (fromDateObj) return formatDisplayDate(fromDateObj);
    if (value.preset === "custom") return "Custom Range";
    return "Select period";
  }

  const displayLabel = buildLabel();

  return (
    <div className={cn("flex min-w-0 w-full flex-wrap items-center gap-2 sm:w-auto", className)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="w-full min-w-0 justify-between gap-1 sm:w-auto"
            data-testid={testId || "period-filter-dropdown"}
          >
            <CalendarIcon className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left sm:max-w-[200px]">{displayLabel}</span>
            <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={isMobile ? "start" : "end"} className="w-56 max-w-[calc(100vw-1rem)]">
          <DropdownMenuItem onClick={() => handlePresetChange("all_time")} data-testid="period-preset-all-time">
            All Time
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => handlePresetChange("today")} data-testid="period-preset-today">
            Today
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handlePresetChange("yesterday")} data-testid="period-preset-yesterday">
            Yesterday
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handlePresetChange("this_week")} data-testid="period-preset-this-week">
            This Week
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handlePresetChange("this_month")} data-testid="period-preset-this-month">
            This Month
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handlePresetChange("last_1_month")} data-testid="period-preset-last-1-month">
            Last 1 Month
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => handlePresetChange("last_6_months")}
            data-testid="period-preset-last-6-months"
          >
            Last 6 Months
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handlePresetChange("this_year")} data-testid="period-preset-this-year">
            This Year
          </DropdownMenuItem>
          {!hideCustomInputs && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => handlePresetChange("custom")} data-testid="period-preset-custom">
                Custom Range...
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Calendar in a modal Dialog — immune to DismissableLayer race conditions */}
      {!hideCustomInputs && (
        <Dialog open={calendarOpen} onOpenChange={setCalendarOpen}>
          <DialogContent className="w-[calc(100vw-1rem)] max-w-fit p-0" data-testid="period-custom-range-dialog">
            <DialogHeader className="px-4 pb-0 pt-4">
              <DialogTitle className="flex items-center justify-between text-sm font-medium">
                Select date range
              </DialogTitle>
              <p className="mt-0.5 text-xs text-muted-foreground">Click a start date, then an end date</p>
            </DialogHeader>
            <DialogBody className="px-2 sm:px-3">
              <Calendar
                mode="range"
                selected={draftFromDate ? { from: draftFromDate, to: undefined } : calendarRange}
                onDayClick={handleDayClick}
                numberOfMonths={isMobile ? 1 : 2}
                defaultMonth={fromDateObj ?? toDateObj ?? new Date()}
              />
            </DialogBody>
            {draftFromDate && (
              <div className="px-4 text-center text-xs text-muted-foreground">Now click an end date</div>
            )}
            <div className="flex justify-end px-4 pb-4">
              <Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={() => setCalendarOpen(false)}>
                <X className="mr-1 h-3.5 w-3.5" /> Close
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
