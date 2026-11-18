// Extracted from ./NetProfitDetails.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { downloadFromUrl } from "@/lib/exportFile";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useCompany } from "@/contexts/CompanyContext";
import { useAccountDisplayOrder } from "@/hooks/useAccountDisplayOrder";
import type { InlineOrderActions } from "@/components/accounts/InlineOrderButtons";
import type { AccountItem, BreakdownItem } from "./netprofitdetails/NetPositionSidePanel";
import { todayStr, type NetProfitData } from "./NetProfitDetailsTypes";

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
  const downloadExcel = async (url: string, fileName: string) => {
    try {
      await downloadFromUrl(url, { fileName });
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    }
  };
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
    downloadExcel,
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
