// Extracted from ./NetProfitDetails.tsx to keep that module under the source-size cap.
import { exportFileName } from "@/lib/exportFile";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Calendar as CalendarPicker } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Calendar, ChevronDown, Download, MessageSquare, MoreHorizontal, RefreshCw, X } from "lucide-react";
import { useNetProfitDetailsState } from "./useNetProfitDetailsState";

export function NetProfitDetailsPageHeaderSection({
  downloadExcel,
  fromDate,
  refetch,
  sendWhatsApp,
  toDate,
}: Pick<
  ReturnType<typeof useNetProfitDetailsState>,
  "downloadExcel" | "fromDate" | "refetch" | "sendWhatsApp" | "toDate"
>) {
  return (
    <PageHeader
      title="Net Position Details"
      backTarget="/settings"
      backButtonTestId="button-back-settings"
      meta={
        <span>
          {fromDate && toDate
            ? `${fromDate} — ${toDate} (change during period)`
            : toDate
              ? `Balances as of ${toDate}`
              : fromDate
                ? `From ${fromDate} — today (change during period)`
                : "Current balances — all time"}
        </span>
      }
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="default" data-testid="button-actions-menu">
            <MoreHorizontal className="h-4 w-4 mr-2" />
            Actions
            <ChevronDown className="h-3 w-3 ml-1 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem
            data-testid="button-export-excel"
            onClick={() => {
              const url = toDate ? `/api/stats/net-position-excel?toDate=${toDate}` : "/api/stats/net-position-excel";
              void downloadExcel(url, exportFileName("net position", "xlsx", toDate ? { date: toDate } : {}));
            }}
          >
            <Download className="h-4 w-4 mr-2 shrink-0" />
            Export Excel (Full)
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="button-export-monthly-excel"
            onClick={() => {
              const today = new Date().toLocaleDateString("en-CA");
              const start =
                fromDate ||
                (() => {
                  const d = new Date();
                  d.setFullYear(d.getFullYear() - 1);
                  return d.toLocaleDateString("en-CA");
                })();
              const end = toDate || today;
              void downloadExcel(
                `/api/reports/net-position-monthly-excel?startDate=${start}&endDate=${end}`,
                exportFileName("net position monthly", "xlsx", { from: start, to: end })
              );
            }}
          >
            <Download className="h-4 w-4 mr-2 shrink-0" />
            Export Excel (Monthly)
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="button-send-whatsapp"
            disabled={sendWhatsApp.isPending}
            onClick={() => sendWhatsApp.mutate()}
          >
            <MessageSquare className="h-4 w-4 mr-2 shrink-0 text-green-600" />
            {sendWhatsApp.isPending ? "Sending…" : "Send to WhatsApp"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem data-testid="button-refresh" onClick={() => refetch()}>
            <RefreshCw className="h-4 w-4 mr-2 shrink-0" />
            Refresh
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </PageHeader>
  );
}

export function NetProfitDetailsSection({
  clearDates,
  fromDate,
  isFiltered,
  parseLocalDate,
  selectFrom,
  selectTo,
  toDate,
}: Pick<
  ReturnType<typeof useNetProfitDetailsState>,
  "clearDates" | "fromDate" | "isFiltered" | "parseLocalDate" | "selectFrom" | "selectTo" | "toDate"
>) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Calendar className="h-4 w-4 text-muted-foreground shrink-0" />
      <Label className="text-sm text-muted-foreground">From:</Label>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" className="w-40 justify-between font-normal" data-testid="input-from-date">
            {fromDate ? parseLocalDate(fromDate)!.toLocaleDateString("en-US") : "Select date"}
            <Calendar className="h-4 w-4 opacity-70" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto p-0">
          <CalendarPicker
            mode="single"
            selected={parseLocalDate(fromDate)}
            onSelect={selectFrom}
            disabled={(date) => date > new Date()}
            initialFocus
          />
        </PopoverContent>
      </Popover>
      <Label className="text-sm text-muted-foreground">To:</Label>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" className="w-40 justify-between font-normal" data-testid="input-to-date">
            {toDate ? parseLocalDate(toDate)!.toLocaleDateString("en-US") : "Select date"}
            <Calendar className="h-4 w-4 opacity-70" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto p-0">
          <CalendarPicker
            mode="single"
            selected={parseLocalDate(toDate)}
            onSelect={selectTo}
            disabled={(date) => date > new Date()}
            initialFocus
          />
        </PopoverContent>
      </Popover>
      {isFiltered && (
        <Button
          variant="ghost"
          size="icon"
          onClick={clearDates}
          data-testid="button-clear-date"
          title="Clear date filter"
        >
          <X className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}
