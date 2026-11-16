// Extracted from ./DailyScan.tsx to keep that module under the source-size cap.
import { CalendarDays, ChevronLeft, ChevronRight, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatNumber } from "@/lib/formatNumber";
import { addDays } from "./getDailyScanPriority";
import { useDailyScanState } from "./useDailyScanState";

export function DailyScanSection({
  handleExport,
  isLoading,
  isToday,
  scanned,
  scannedKg,
  selectedDate,
  setSelectedDate,
  today,
  totalBales,
  totalKg,
}: Pick<
  ReturnType<typeof useDailyScanState>,
  | "handleExport"
  | "isLoading"
  | "isToday"
  | "scanned"
  | "scannedKg"
  | "selectedDate"
  | "setSelectedDate"
  | "today"
  | "totalBales"
  | "totalKg"
>) {
  return (
    <div className="daily-scan-toolbar flex items-center gap-2 flex-wrap">
      <Button
        variant="outline"
        size="icon"
        onClick={() => setSelectedDate(addDays(selectedDate, -1))}
        data-testid="button-daily-scan-prev-day"
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>

      <div className="daily-scan-date flex items-center gap-1.5 border rounded-md px-2 py-1">
        <CalendarDays className="h-4 w-4 text-muted-foreground" />
        <input
          type="date"
          value={selectedDate}
          max={today}
          onChange={(e) => e.target.value && setSelectedDate(e.target.value)}
          className="bg-transparent text-sm font-medium outline-hidden"
          data-testid="input-daily-scan-date"
        />
      </div>

      <Button
        variant="outline"
        size="icon"
        onClick={() => setSelectedDate(addDays(selectedDate, 1))}
        disabled={isToday}
        data-testid="button-daily-scan-next-day"
      >
        <ChevronRight className="h-4 w-4" />
      </Button>

      {!isToday && (
        <Button variant="ghost" size="sm" onClick={() => setSelectedDate(today)} data-testid="button-daily-scan-today">
          Back to Today
        </Button>
      )}

      <div className="ml-auto flex items-center gap-3 flex-wrap">
        {!isLoading && totalBales > 0 && (
          <span className="text-sm text-muted-foreground" data-testid="text-daily-scan-summary">
            {scanned.length}/{totalBales} verified · {formatNumber(scannedKg)}/{formatNumber(totalKg)} kg
          </span>
        )}
        <Button
          className="daily-scan-export"
          variant="outline"
          size="sm"
          onClick={handleExport}
          data-testid="button-daily-scan-export"
        >
          <Download className="h-4 w-4 mr-1" />
          Export
        </Button>
      </div>
    </div>
  );
}
