// Extracted from ./NetProfitDetails.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
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
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useCompany } from "@/contexts/CompanyContext";
import type { NotInLedgerSectionData } from "@/components/netposition/NotInLedgerCard";
import { useAccountDisplayOrder } from "@/hooks/useAccountDisplayOrder";
import type { InlineOrderActions } from "@/components/accounts/InlineOrderButtons";
import type { AccountItem, BreakdownItem } from "./netprofitdetails/NetPositionSidePanel";

interface NetProfitData {
  totalIncome: number;
  totalExpenses: number;
  netProfit: number;
  spPosProfit?: number;
  spPosProfitBaselineDate?: string | null;
  spPosProfitPeriodStartDate?: string | null;
  spPosProfitAsOfDate?: string | null;
  forUs: { total: number; breakdown: BreakdownItem[]; accounts: AccountItem[] };
  onUs: { total: number; breakdown: BreakdownItem[]; accounts: AccountItem[] };
  equity?: { total: number; accounts: AccountItem[] };
  income: { total: number; breakdown: BreakdownItem[]; accounts: AccountItem[] };
  expenses: { total: number; breakdown: BreakdownItem[]; accounts: AccountItem[] };
  netPosition: number;
  netPositionLabel: string;
  forUsTotal: number;
  onUsTotal: number;
  incomeTotal: number;
  expensesTotal: number;
  /** Amounts not yet in the ledger: shown separately, never in the totals. */
  notInLedger?: NotInLedgerSectionData;
  currency?: {
    rateConvention: string;
    nativeDebitByCurrency: Record<string, string>;
    nativeCreditByCurrency: Record<string, string>;
    historicalBaseDebitTotal: string;
    historicalBaseCreditTotal: string;
    unresolvedLegacyEntryCount: number;
    unresolvedLegacyRawNet: string;
    totalsProvisional: boolean;
  };
}

function todayStr() {
  return new Date().toLocaleDateString("en-CA");
}

export function useNetProfitDetailsState() {
  const { formatHistoricalBaseAmount: formatAmount } = useCurrencyContext();
  const { selectedCompany } = useCompany();
  const accountOrder = useAccountDisplayOrder();
  const displayLayout = accountOrder.layout;
  const orderActions: InlineOrderActions = {
    canArrange: accountOrder.canArrange,
    arranging: accountOrder.arranging,
    isSaving: accountOrder.isSaving,
    swap: accountOrder.swap,
    move: accountOrder.move,
  };
  const { toast } = useToast();
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const [fxHistorySide, setFxHistorySide] = useState<"gain" | "loss" | null>(null);

  const toIsoDate = (date: Date) =>
    [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join(
      "-"
    );
  const parseLocalDate = (value: string) => {
    if (!value) return undefined;
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day);
  };
  const selectFrom = (date: Date | undefined) => {
    if (!date) return;
    const value = toIsoDate(date);
    setFromDate(value);
    if (toDate && value > toDate) setToDate(value);
  };
  const selectTo = (date: Date | undefined) => {
    if (!date) return;
    const value = toIsoDate(date);
    setToDate(value);
    if (fromDate && value < fromDate) setFromDate(value);
  };
  const clearDates = () => {
    setFromDate("");
    setToDate("");
  };
  // A date range shows the CHANGE in balances over the selected period:
  // closing snapshot at To minus opening snapshot immediately before From.
  // A single To date remains an as-of balance sheet.
  const previousDay = (iso: string) => {
    const date = new Date(`${iso}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
  };
  const differenceRows = (closing: AccountItem[], opening: AccountItem[]): AccountItem[] => {
    const key = (a: AccountItem) => `${a.id ?? ""}|${a.code}|${a.name}|${a.category}`;
    const old = new Map(opening.map((a) => [key(a), a.value]));
    const seen = new Set<string>();
    const rows = closing.map((a) => {
      const k = key(a);
      seen.add(k);
      return { ...a, value: Math.round((a.value - (old.get(k) ?? 0)) * 100) / 100 };
    });
    for (const a of opening)
      if (!seen.has(key(a))) {
        rows.push({ ...a, value: -a.value });
      }
    return rows.filter((a) => Math.abs(a.value) >= 0.005);
  };
  // Equity has no breakdown, so diff it only where the section carries one.
  const differenceSection = <T extends { total: number; breakdown?: BreakdownItem[]; accounts: AccountItem[] }>(
    closing: T,
    opening: T
  ): T => ({
    ...closing,
    total: Math.round((closing.total - opening.total) * 100) / 100,
    ...(closing.breakdown
      ? {
          breakdown: closing.breakdown.map((b) => ({
            ...b,
            value:
              Math.round((b.value - (opening.breakdown?.find((old) => old.name === b.name)?.value ?? 0)) * 100) / 100,
          })),
        }
      : {}),
    accounts: differenceRows(closing.accounts, opening.accounts),
  });
  const periodEnd = toDate || (fromDate ? todayStr() : "");
  const { data, isLoading, error, refetch } = useQuery<NetProfitData>({
    queryKey: ["/api/stats/net-profit", selectedCompany?.id, fromDate, periodEnd],
    queryFn: async () => {
      const fetchSnapshot = async (date: string) => {
        const query = date ? `?toDate=${encodeURIComponent(date)}` : "";
        const response = await apiRequest("GET", `/api/stats/net-profit${query}`);
        if (!response.ok) throw new Error(await response.text());
        return response.json() as Promise<NetProfitData>;
      };
      const closing = await fetchSnapshot(periodEnd);
      if (!fromDate) return closing;
      const opening = await fetchSnapshot(previousDay(fromDate));
      const diff = (a: number, b: number) => Math.round((a - b) * 100) / 100;
      return {
        ...closing,
        forUs: differenceSection(closing.forUs, opening.forUs),
        onUs: differenceSection(closing.onUs, opening.onUs),
        equity: closing.equity && opening.equity ? differenceSection(closing.equity, opening.equity) : closing.equity,
        income: differenceSection(closing.income, opening.income),
        expenses: differenceSection(closing.expenses, opening.expenses),
        forUsTotal: diff(closing.forUsTotal, opening.forUsTotal),
        onUsTotal: diff(closing.onUsTotal, opening.onUsTotal),
        netPosition: diff(closing.netPosition, opening.netPosition),
        totalIncome: diff(closing.totalIncome, opening.totalIncome),
        totalExpenses: diff(closing.totalExpenses, opening.totalExpenses),
        incomeTotal: diff(closing.incomeTotal, opening.incomeTotal),
        expensesTotal: diff(closing.expensesTotal, opening.expensesTotal),
        netProfit: diff(closing.netProfit, opening.netProfit),
        // The realized-profit tile always presents the month containing periodEnd,
        // independently of the balance-sheet custom From date.
        spPosProfit: closing.spPosProfit ?? 0,
        netPositionLabel: "Net Position Change (selected period)",
      };
    },
  });

  const isFiltered = !!(fromDate || toDate);

  const sendWhatsApp = useMutation({
    mutationFn: () => {
      const today = new Date().toLocaleDateString("en-CA");
      const start =
        fromDate ||
        (() => {
          const d = new Date();
          d.setFullYear(d.getFullYear() - 1);
          return d.toLocaleDateString("en-CA");
        })();
      const end = toDate || today;
      return apiRequest("POST", "/api/whatsapp/send-net-position", { startDate: start, endDate: end });
    },
    onSuccess: async (res) => {
      const body = await res.json();
      toast({ title: "Sent via WhatsApp", description: body.message });
    },
    onError: async (err: ClientErrorLike) => {
      const msg = err?.message || "WhatsApp send failed";
      toast({ title: "WhatsApp Error", description: msg, variant: "destructive" });
    },
  });
  return {
    accountOrder,
    clearDates,
    data,
    displayLayout,
    error,
    formatAmount,
    fromDate,
    fxHistorySide,
    isFiltered,
    isLoading,
    orderActions,
    parseLocalDate,
    refetch,
    selectFrom,
    selectTo,
    selectedCompany,
    sendWhatsApp,
    setFxHistorySide,
    toDate,
  };
}

export function NetProfitDetailsPageHeaderSection({
  fromDate,
  refetch,
  sendWhatsApp,
  toDate,
}: Pick<ReturnType<typeof useNetProfitDetailsState>, "fromDate" | "refetch" | "sendWhatsApp" | "toDate">) {
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
              window.open(url, "_blank");
            }}
          >
            <Download className="h-4 w-4 mr-2 shrink-0" />
            Export (full)
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
              window.open(`/api/reports/net-position-monthly-excel?startDate=${start}&endDate=${end}`, "_blank");
            }}
          >
            <Download className="h-4 w-4 mr-2 shrink-0" />
            Monthly Excel
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
