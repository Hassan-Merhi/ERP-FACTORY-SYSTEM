// Extracted from ./FactoryNetPositionDetails.tsx
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { ChevronRight, ChevronLeft, RefreshCw, CalendarDays } from "lucide-react";
import { shiftDate, formatDateLabel } from "./factorynetposition/utils";
import { useFactoryNetPositionDetailsState } from "./useFactoryNetPositionDetailsState";

export function FactoryNetPositionDetailsContent({
  companyToday,
  displayAsOf,
  isFetching,
  isSavingValuationMode,
  isToday,
  queryClient,
  refetch,
  setAsOf,
  updatePref,
  valuationMode,
}: Pick<
  ReturnType<typeof useFactoryNetPositionDetailsState>,
  | "companyToday"
  | "displayAsOf"
  | "isFetching"
  | "isSavingValuationMode"
  | "isToday"
  | "queryClient"
  | "refetch"
  | "setAsOf"
  | "updatePref"
  | "valuationMode"
>) {
  return (
    <div className="flex items-start justify-between gap-4 flex-wrap">
      <div>
        <PageHeader
          title="Factory Net Position"
          subtitle={
            isToday
              ? "Current factory financial standing — what we have vs what we owe"
              : `Historical snapshot — as of ${formatDateLabel(displayAsOf)}`
          }
        />
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1 border rounded-md p-0.5" data-testid="valuation-mode-toggle">
          <Button
            variant={valuationMode === "cost" ? "default" : "ghost"}
            size="sm"
            disabled={isSavingValuationMode}
            onClick={() => updatePref({ factoryNetPositionValuationMode: "cost" })}
            data-testid="button-valuation-cost"
          >
            Cost Price
          </Button>
          <Button
            variant={valuationMode === "selling" ? "default" : "ghost"}
            size="sm"
            disabled={isSavingValuationMode}
            onClick={() => updatePref({ factoryNetPositionValuationMode: "selling" })}
            data-testid="button-valuation-selling"
          >
            Selling Price
          </Button>
        </div>
        {/* Date navigation */}
        <div className="flex items-center gap-1 border rounded-md px-1 py-0.5">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setAsOf(shiftDate(displayAsOf, -1))}
            data-testid="button-date-prev"
            title="Previous day"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-1.5 px-1">
            <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="date"
              value={displayAsOf}
              max={companyToday}
              onChange={(e) => e.target.value && setAsOf(e.target.value >= companyToday ? "" : e.target.value)}
              className="text-sm bg-transparent border-none outline-hidden cursor-pointer w-[120px]"
              data-testid="input-as-of-date"
            />
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              const next = shiftDate(displayAsOf, 1);
              setAsOf(next >= companyToday ? "" : next);
            }}
            disabled={isToday}
            data-testid="button-date-next"
            title="Next day"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        {!isToday && (
          <Button variant="outline" size="sm" onClick={() => setAsOf("")} data-testid="button-date-today">
            Today
          </Button>
        )}
        <Button
          variant="outline"
          size="default"
          onClick={() => {
            // The payroll breakdown must refresh with its parent total.
            void queryClient.invalidateQueries({ queryKey: ["/api/factory/net-position/payroll-breakdown"] });
            void refetch();
          }}
          disabled={isFetching}
          data-testid="button-refresh"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>
    </div>
  );
}
