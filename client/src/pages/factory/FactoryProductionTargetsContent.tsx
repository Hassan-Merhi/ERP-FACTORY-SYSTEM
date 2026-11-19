// Extracted from ./FactoryProductionTargets.tsx
import {
  CalendarClock,
  CalendarDays,
  Loader2,
  LockKeyhole,
  MessageCircle,
  SlidersHorizontal,
  Target,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { type PeriodType } from "./factoryProductionTargetsModel";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { useFactoryProductionTargetsState } from "./useFactoryProductionTargetsState";

export function FactoryProductionTargetsContent({
  busy,
  customRange,
  endProductionMutation,
  exportWeeklyMutation,
  finalized,
  period,
  periodType,
  referenceDate,
  rows,
  sendWhatsappMutation,
  setCustomRange,
  setDateRangeOpen,
  setDefaultsEditorOpen,
  setEditorOpen,
  setExcelRangeOpen,
  setPeriodType,
  setReferenceDate,
  tr,
}: Pick<
  ReturnType<typeof useFactoryProductionTargetsState>,
  | "busy"
  | "customRange"
  | "endProductionMutation"
  | "exportWeeklyMutation"
  | "finalized"
  | "period"
  | "periodType"
  | "referenceDate"
  | "rows"
  | "sendWhatsappMutation"
  | "setCustomRange"
  | "setDateRangeOpen"
  | "setDefaultsEditorOpen"
  | "setEditorOpen"
  | "setExcelRangeOpen"
  | "setPeriodType"
  | "setReferenceDate"
  | "tr"
>) {
  return (
    <div className="pt-hero">
      <div className="pt-hero-intro">
        <div className="pt-hero-icon" aria-hidden="true">
          <Target className="h-8 w-8" />
        </div>
        <div>
          <h2>{tr("productionTargets")}</h2>
          <p className="pt-hero-description">{tr("productionSubtitle")}</p>
        </div>
      </div>

      <div className="pt-hero-controls">
        <div className="space-y-1">
          <p className="pt-control-label">{tr("period")}</p>
          <Select
            value={periodType}
            onValueChange={(value) => {
              setPeriodType(value as PeriodType);
              setCustomRange(null);
            }}
            disabled={busy}
          >
            <SelectTrigger className="w-[130px]" data-testid="select-production-period-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="daily">{tr("daily")}</SelectItem>
              <SelectItem value="weekly">{tr("weekly")}</SelectItem>
              <SelectItem value="monthly">{tr("monthly")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <p className="pt-control-label">{periodType === "daily" ? tr("referenceDate") : "Date range"}</p>
          {periodType === "daily" ? (
            <Input
              type="date"
              value={referenceDate}
              onChange={(event) => setReferenceDate(event.target.value)}
              className="w-[155px]"
              disabled={busy}
            />
          ) : (
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                variant="outline"
                className="h-9 gap-2 tabular-nums"
                onClick={() => setDateRangeOpen(true)}
                disabled={busy}
                title="Choose start and end dates from the calendar"
                data-testid="button-production-targets-date-range"
              >
                <CalendarDays className="h-4 w-4" />
                {period.start} — {period.end}
              </Button>
              {customRange && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setCustomRange(null)}
                  disabled={busy}
                  data-testid="button-reset-production-targets-date-range"
                  title={periodType === "weekly" ? "Restore full week" : "Restore full month"}
                >
                  Reset
                </Button>
              )}
            </div>
          )}
        </div>

        {periodType === "daily" && (
          <Button
            variant="outline"
            onClick={() => setDefaultsEditorOpen(true)}
            disabled={rows.length === 0 || busy}
            data-testid="button-edit-production-default-targets"
          >
            <CalendarClock className="mr-2 h-4 w-4" />
            {tr("defaultTargets")}
          </Button>
        )}

        <ExportButton
          kind="excel"
          variant="outline"
          label={exportWeeklyMutation.isPending ? tr("exportingWeeklyExcel") : tr("exportProductionExcel")}
          onClick={() => setExcelRangeOpen(true)}
          disabled={busy}
          title={tr("weeklyExcelTooltip")}
          data-testid="button-export-production-weekly-excel"
        />

        <Button
          className="pt-btn-primary"
          onClick={() => {
            if (periodType !== "daily") {
              setPeriodType("daily");
              return;
            }
            setEditorOpen(true);
          }}
          disabled={finalized || rows.length === 0 || busy}
          title={
            periodType === "daily" ? undefined : "Period targets are a sum of daily targets. Switch to Daily to edit."
          }
          data-testid="button-edit-production-targets"
        >
          <SlidersHorizontal className="mr-2 h-4 w-4" />
          {periodType === "daily" ? tr("editTargets") : "Edit Daily Targets"}
        </Button>

        {periodType === "daily" && (
          <Button
            variant="outline"
            className="pt-btn-wa"
            onClick={() => sendWhatsappMutation.mutate()}
            disabled={rows.length === 0 || busy}
            data-testid="button-send-production-whatsapp"
          >
            {sendWhatsappMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <MessageCircle className="mr-2 h-4 w-4" />
            )}
            {sendWhatsappMutation.isPending ? tr("sendingWhatsappImage") : tr("sendWhatsappImage")}
          </Button>
        )}

        {periodType === "daily" && (
          <Button
            variant="outline"
            className="pt-btn-gold"
            onClick={() => endProductionMutation.mutate()}
            disabled={finalized || rows.length === 0 || busy}
            data-testid="button-end-production"
          >
            {endProductionMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <LockKeyhole className="mr-2 h-4 w-4" />
            )}
            {endProductionMutation.isPending ? tr("endingProduction") : tr("endProduction")}
          </Button>
        )}
      </div>
    </div>
  );
}
