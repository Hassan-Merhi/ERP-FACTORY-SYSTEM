import { useState } from "react";
import { subDays } from "date-fns";
import { CalendarDays, FileDown, Loader2 } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  translateFactoryStaffTrackingText,
  type FactoryStaffTrackingTranslationKey,
} from "@/i18n/factoryStaffTrackingTranslations";
import { localDateStr, parseLocalDate, periodFor } from "../factoryProductionTargetsModel";
import {
  factoryProductionToday,
  getProductionRangeDates,
  ProductionDateRangeError,
} from "./productionWeeklyExcel";

export interface ProductionExportDates {
  start: string;
  end: string;
}

interface ProductionExcelRangeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  exporting: boolean;
  onExport: (dates: ProductionExportDates) => void;
}

function selectPreset(preset: "this" | "last" | "four", today: string): ProductionExportDates {
  const current = periodFor("weekly", today);
  if (preset === "this") return { start: current.start, end: today };
  if (preset === "last") {
    const start = localDateStr(subDays(parseLocalDate(current.start), 7));
    return { start, end: localDateStr(subDays(parseLocalDate(current.start), 1)) };
  }
  return {
    start: localDateStr(subDays(parseLocalDate(today), 27)),
    end: today,
  };
}

function displayDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

export function ProductionExcelRangeDialog({
  open,
  onOpenChange,
  exporting,
  onExport,
}: ProductionExcelRangeDialogProps) {
  const { language } = useApplicationLanguage();
  const tr = (key: FactoryStaffTrackingTranslationKey) => translateFactoryStaffTrackingText(key, language);
  const isMobile = useIsMobile();
  const today = factoryProductionToday();
  const [dates, setDates] = useState<ProductionExportDates>(() => selectPreset("this", factoryProductionToday()));
  const [draftStart, setDraftStart] = useState<string | null>(null);
  const [rangeError, setRangeError] = useState<ProductionDateRangeError["code"] | null>(null);

  const setPreset = (preset: "this" | "last" | "four") => {
    setDates(selectPreset(preset, today));
    setDraftStart(null);
    setRangeError(null);
  };

  const onDayClick = (date: Date) => {
    if (exporting) return;
    const chosen = localDateStr(date);
    if (!draftStart) {
      setDraftStart(chosen);
      setRangeError(null);
      return;
    }

    const next = {
      start: chosen < draftStart ? chosen : draftStart,
      end: chosen < draftStart ? draftStart : chosen,
    };
    try {
      getProductionRangeDates(next.start, next.end, today);
      setDates(next);
      setDraftStart(null);
      setRangeError(null);
    } catch (error) {
      if (error instanceof ProductionDateRangeError) {
        setRangeError(error.code);
        // Keep the first date selected so the user can choose a closer end date.
        return;
      }
      throw error;
    }
  };

  const description = draftStart
    ? tr("exportChooseEndDate")
    : tr("exportSelectDateRange");

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!exporting) {
          onOpenChange(nextOpen);
          if (!nextOpen) {
            setDraftStart(null);
            setRangeError(null);
          }
        }
      }}
    >
      <DialogContent className="w-[calc(100vw-1rem)] max-w-fit p-4 sm:p-5" data-testid="production-weekly-excel-calendar">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarDays className="h-5 w-5 text-primary" />
            {tr("exportDateRangeTitle")}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-2 py-2">
          <Button variant="outline" size="sm" onClick={() => setPreset("this")} disabled={exporting} data-testid="production-excel-this-week">
            {tr("exportThisWeek")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPreset("last")} disabled={exporting} data-testid="production-excel-last-week">
            {tr("exportLastWeek")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPreset("four")} disabled={exporting} data-testid="production-excel-last-four-weeks">
            {tr("exportLastFourWeeks")}
          </Button>
        </div>

        <DialogBody className="max-h-[65vh]">
          <Calendar
            mode="range"
            selected={
              draftStart
                ? { from: parseLocalDate(draftStart), to: undefined }
                : { from: parseLocalDate(dates.start), to: parseLocalDate(dates.end) }
            }
            onDayClick={onDayClick}
            numberOfMonths={isMobile ? 1 : 2}
            defaultMonth={parseLocalDate(dates.start)}
            disabled={{ after: parseLocalDate(today) }}
            endMonth={parseLocalDate(today)}
            className="mx-auto"
          />
        </DialogBody>

        <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm" aria-live="polite">
          <div className="font-medium">{tr("exportSelectedDates")}</div>
          <div className="mt-1 font-semibold tabular-nums">
            {draftStart
              ? `${displayDate(draftStart)} — …`
              : `${displayDate(dates.start)} — ${displayDate(dates.end)}`}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{tr("exportRangeLimit")}</p>
          {rangeError && (
            <p className="mt-1 text-sm font-semibold text-destructive" role="alert">
              {rangeError === "tooLong"
                ? tr("exportRangeTooLong")
                : rangeError === "future"
                  ? tr("exportFutureDate")
                  : tr("exportInvalidRange")}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={exporting} onClick={() => onOpenChange(false)}>
            {tr("cancel")}
          </Button>
          <Button
            disabled={exporting || Boolean(draftStart) || Boolean(rangeError)}
            onClick={() => onExport(dates)}
            data-testid="production-excel-confirm-export"
          >
            {exporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileDown className="mr-2 h-4 w-4" />}
            {exporting ? tr("exportingWeeklyExcel") : tr("exportWeeklyExcel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
