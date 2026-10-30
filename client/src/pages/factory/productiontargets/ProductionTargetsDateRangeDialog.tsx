import { useEffect, useState } from "react";
import { CalendarDays } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogBody, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useIsMobile } from "@/hooks/use-mobile";
import { localDateStr, parseLocalDate } from "../factoryProductionTargetsModel";

export type ProductionTargetsDateRange = { start: string; end: string };

interface ProductionTargetsDateRangeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  range: ProductionTargetsDateRange;
  onApply: (range: ProductionTargetsDateRange) => void;
}

const MAX_RANGE_DAYS = 31;

function inclusiveDays(start: string, end: string): number {
  const startDate = parseLocalDate(start);
  const endDate = parseLocalDate(end);
  return Math.round(
    (Date.UTC(endDate.getFullYear(), endDate.getMonth(), endDate.getDate()) -
      Date.UTC(startDate.getFullYear(), startDate.getMonth(), startDate.getDate())) / 86400000
  ) + 1;
}

export function ProductionTargetsDateRangeDialog({
  open, onOpenChange, range, onApply,
}: ProductionTargetsDateRangeDialogProps) {
  const isMobile = useIsMobile();
  const [selected, setSelected] = useState<ProductionTargetsDateRange>(range);
  const [firstDay, setFirstDay] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setSelected(range);
    setFirstDay(null);
    setError("");
  }, [open, range.start, range.end]);

  const pickDate = (date: Date) => {
    const day = localDateStr(date);
    if (!firstDay) {
      setFirstDay(day);
      setError("");
      return;
    }
    const next = {
      start: day < firstDay ? day : firstDay,
      end: day < firstDay ? firstDay : day,
    };
    if (inclusiveDays(next.start, next.end) > MAX_RANGE_DAYS) {
      setError("Select up to 31 days. Choose a closer end date.");
      return;
    }
    setSelected(next);
    setFirstDay(null);
    setError("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-1rem)] max-w-fit p-4 sm:p-5" data-testid="production-targets-range-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarDays className="h-5 w-5 text-primary" />
            Choose Production Targets dates
          </DialogTitle>
          <DialogDescription>
            Click the starting day, then the ending day. Each day's targets, absences, and production will be included.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="max-h-[65vh]">
          <Calendar
            key={range.start}
            mode="range"
            selected={firstDay
              ? { from: parseLocalDate(firstDay), to: undefined }
              : { from: parseLocalDate(selected.start), to: parseLocalDate(selected.end) }}
            onDayClick={pickDate}
            numberOfMonths={isMobile ? 1 : 2}
            defaultMonth={parseLocalDate(range.start)}
            className="mx-auto"
          />
        </DialogBody>
        <div className="rounded-lg border bg-muted/30 px-3 py-2 text-sm" aria-live="polite">
          <p className="text-xs text-muted-foreground">Selected date range (maximum 31 days)</p>
          <p className="mt-1 font-semibold tabular-nums">
            {firstDay ? `${firstDay} — select end date` : `${selected.start} — ${selected.end}`}
          </p>
          {error && <p role="alert" className="mt-1 text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={() => onApply(selected)}
            disabled={Boolean(firstDay) || Boolean(error)}
            data-testid="button-apply-production-targets-date-range"
          >
            Apply range
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
