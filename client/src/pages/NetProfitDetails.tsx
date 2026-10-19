import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar as CalendarPicker } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Minus,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Calendar,
  X,
  Download,
  MessageSquare,
  ExternalLink,
  MoreHorizontal,
  TrendingUp,
  Wallet,
  ArrowUpRight,
  ArrowDownRight,
  Scale,
} from "lucide-react";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useCompany } from "@/contexts/CompanyContext";
import type { NotInLedgerSectionData } from "@/components/netposition/NotInLedgerCard";
import type { AccountDisplayLayout } from "./accounts/DisplayAccountGroups";
import { useAccountDisplayOrder } from "@/hooks/useAccountDisplayOrder";
import { InlineOrderButtons, inlineDrag, type InlineOrderActions } from "@/components/accounts/InlineOrderButtons";

interface AccountItem {
  id?: number;
  name: string;
  code: string;
  value: number;
  category: string;
  balanceSide?: "Dr" | "Cr";
}

interface BreakdownItem {
  name: string;
  value: number;
}

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

function CategoryGroup({
  category,
  accounts,
  side,
  formatAmount,
  groupKey,
  groupSiblings = [],
  actions,
}: {
  category: string;
  accounts: AccountItem[];
  side: "asset" | "liability" | "equity";
  formatAmount: (n: number) => string;
  groupKey?: string | null;
  groupSiblings?: string[];
  actions?: InlineOrderActions;
}) {
  const [open, setOpen] = useState(true);
  const accountKeys = accounts.filter((a) => a.id != null).map((a) => `ledger:${a.id}`);
  // Use signed sum so credit-balance prepaid entries (negative) reduce the total
  const total = accounts.reduce((s, a) => s + a.value, 0);
  const color =
    side === "asset"
      ? "text-emerald-600 dark:text-emerald-400"
      : side === "equity"
        ? "text-violet-600 dark:text-violet-400"
        : "text-rose-600 dark:text-rose-400";
  const headerBg =
    side === "asset"
      ? "bg-emerald-50/60 dark:bg-emerald-950/30"
      : side === "equity"
        ? "bg-violet-50/60 dark:bg-violet-950/30"
        : "bg-rose-50/60 dark:bg-rose-950/30";

  return (
    <div className="rounded-md overflow-hidden border border-border/60" {...inlineDrag(groupKey || null, actions)}>
      <div className={`flex items-stretch ${headerBg}`}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex-1 flex items-center justify-between px-3 py-2 text-sm font-semibold hover-elevate"
          data-testid={`button-category-${category.toLowerCase().replace(/\s+/g, "-")}`}
        >
          <div className="flex items-center gap-2">
            {open ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            )}
            <span className="text-foreground">{category}</span>
            <span className="text-xs font-normal text-muted-foreground bg-background/60 rounded-sm px-1.5 py-0.5">
              {accounts.length}
            </span>
          </div>
          <span className={`font-mono font-bold tabular-nums ${color}`}>{formatAmount(Math.abs(total))}</span>
        </button>
        <InlineOrderButtons label={category} nodeKey={groupKey || null} siblingKeys={groupSiblings} actions={actions} />
      </div>
      {open && (
        <div className="divide-y divide-border/50">
          {accounts.map((acc, i) => {
            const ledgerBase = window.location.pathname.startsWith("/properties")
              ? "/properties/ledger-monthly"
              : "/ledger-monthly";
            const isCreditOnAsset = side === "asset" && acc.value < 0;
            const rowColor = isCreditOnAsset ? "text-rose-600 dark:text-rose-400" : color;
            return (
              <div
                key={i}
                className="flex items-center justify-between gap-2 px-3 py-2 text-sm hover:bg-muted/30 transition-colors"
                data-testid={`row-account-${i}`}
                {...inlineDrag(acc.id != null ? `ledger:${acc.id}` : null, actions)}
              >
                {acc.id ? (
                  <button
                    type="button"
                    onClick={() => window.open(`${ledgerBase}/${acc.id}`, "_blank")}
                    className="text-foreground hover:text-foreground/80 text-left flex items-center gap-1 group"
                  >
                    <span>{acc.name}</span>
                    {isCreditOnAsset && (
                      <span className="text-xs text-rose-500 dark:text-rose-400 font-normal ml-1">(Cr)</span>
                    )}
                    {side === "equity" && acc.balanceSide && (
                      <span className="text-xs text-muted-foreground font-normal ml-1">({acc.balanceSide})</span>
                    )}
                    <ExternalLink className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 touch:opacity-100 shrink-0 transition-opacity" />
                  </button>
                ) : (
                  <span className="text-foreground flex items-center gap-1">
                    {acc.name}
                    {isCreditOnAsset && (
                      <span className="text-xs text-rose-500 dark:text-rose-400 font-normal">(Cr)</span>
                    )}
                    {side === "equity" && acc.balanceSide && (
                      <span className="text-xs text-muted-foreground font-normal ml-1">({acc.balanceSide})</span>
                    )}
                  </span>
                )}
                <div className="flex items-center gap-1">
                  <InlineOrderButtons
                    label={acc.name}
                    nodeKey={acc.id != null ? `ledger:${acc.id}` : null}
                    siblingKeys={accountKeys}
                    actions={actions}
                  />
                  <span className={`font-mono tabular-nums font-medium ${rowColor}`}>
                    {formatAmount(Math.abs(acc.value))}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SidePanel({
  id,
  title,
  subtitle,
  side,
  total,
  accounts,
  formatAmount,
  displayLayout,
  orderActions,
}: {
  id: string;
  title: string;
  subtitle?: string;
  side: "asset" | "liability" | "equity";
  total: number;
  accounts: AccountItem[];
  formatAmount: (n: number) => string;
  displayLayout?: AccountDisplayLayout;
  orderActions?: InlineOrderActions;
}) {
  const [open, setOpen] = useState(true);

  const layoutGroups = (displayLayout?.nodes || []).filter((n) => n.type === "group");
  const layoutMembership = new Map(
    (displayLayout?.nodes || [])
      .filter((n) => n.type === "ledger" && n.parentKey)
      .map((n) => [Number(n.key.slice(7)), n])
  );
  const layoutGroupNames = new Map(layoutGroups.map((n) => [`display:${n.key}`, n.name || "Group"]));
  const layoutOrder = new Map(layoutGroups.map((n) => [`display:${n.key}`, n.order]));
  // A group can have accounts on both sides. Partition each side separately,
  // so liabilities never cancel assets and dashboard totals never change.
  const grouped = accounts.reduce<Record<string, AccountItem[]>>((acc, item) => {
    const membership = item.id ? layoutMembership.get(item.id) : undefined;
    const category = membership?.parentKey ? `display:${membership.parentKey}` : item.category || "Other";
    if (!acc[category]) acc[category] = [];
    acc[category].push(item);
    return acc;
  }, {});
  const sortedCategories = Object.entries(grouped)
    .map(([key, items]) => {
      if (layoutGroupNames.has(key)) {
        items.sort(
          (a, b) =>
            (layoutMembership.get(a.id || -1)?.order ?? 10000) - (layoutMembership.get(b.id || -1)?.order ?? 10000)
        );
      }
      return [key, items] as const;
    })
    .sort(([keyA, a], [keyB, b]) => {
      const aRank = layoutOrder.get(keyA),
        bRank = layoutOrder.get(keyB);
      if (aRank != null && bRank != null) return aRank - bRank;
      if (aRank != null) return -1;
      if (bRank != null) return 1;
      return b.reduce((s, x) => s + Math.abs(x.value), 0) - a.reduce((s, x) => s + Math.abs(x.value), 0);
    });

  const groupKeys = sortedCategories
    .filter(([key]) => layoutGroupNames.has(key))
    .map(([key]) => key.slice("display:".length));
  const isAsset = side === "asset";
  const isEquity = side === "equity";
  const headerGradient = isAsset
    ? "from-emerald-500/10 to-transparent dark:from-emerald-500/15"
    : isEquity
      ? "from-violet-500/10 to-transparent dark:from-violet-500/15"
      : "from-rose-500/10 to-transparent dark:from-rose-500/15";
  const totalColor = isAsset
    ? "text-emerald-600 dark:text-emerald-400"
    : isEquity
      ? "text-violet-600 dark:text-violet-400"
      : "text-rose-600 dark:text-rose-400";
  const iconBg = isAsset
    ? "bg-emerald-100 dark:bg-emerald-900/50 text-emerald-600 dark:text-emerald-400"
    : isEquity
      ? "bg-violet-100 dark:bg-violet-900/50 text-violet-600 dark:text-violet-400"
      : "bg-rose-100 dark:bg-rose-900/50 text-rose-600 dark:text-rose-400";
  const footerBg = isAsset
    ? "bg-emerald-50/50 dark:bg-emerald-950/30 border-emerald-200/60 dark:border-emerald-800/40"
    : isEquity
      ? "bg-violet-50/50 dark:bg-violet-950/30 border-violet-200/60 dark:border-violet-800/40"
      : "bg-rose-50/50 dark:bg-rose-950/30 border-rose-200/60 dark:border-rose-800/40";
  const displayTotal = isEquity ? Math.abs(total) : total;
  const totalSide = isEquity && total !== 0 ? (total > 0 ? "Dr" : "Cr") : null;

  return (
    <Card data-testid={`card-${id}`} className="flex flex-col overflow-hidden">
      <div
        className={`bg-linear-to-r ${headerGradient} px-5 py-4 cursor-pointer select-none`}
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${iconBg}`}>
              {isAsset ? (
                <ArrowUpRight className="h-4 w-4" />
              ) : isEquity ? (
                <Scale className="h-4 w-4" />
              ) : (
                <ArrowDownRight className="h-4 w-4" />
              )}
            </div>
            <div>
              <div className={`font-semibold text-base ${totalColor}`}>{title}</div>
              {subtitle && <div className="text-xs text-muted-foreground mt-0.5">{subtitle}</div>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-2xl font-bold font-mono tabular-nums ${totalColor}`}>
              {formatAmount(displayTotal)}
              {totalSide && <span className="text-xs font-normal ml-1">{totalSide}</span>}
            </span>
            {open ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
            )}
          </div>
        </div>
      </div>

      {open && (
        <CardContent className="pt-3 pb-4 flex-1 space-y-2">
          {sortedCategories.length > 0 ? (
            <>
              {sortedCategories.map(([cat, catAccounts]) => (
                <CategoryGroup
                  key={cat}
                  category={layoutGroupNames.get(cat) || cat}
                  accounts={catAccounts}
                  side={side}
                  formatAmount={formatAmount}
                  groupKey={layoutGroupNames.has(cat) ? cat.slice("display:".length) : null}
                  groupSiblings={groupKeys}
                  actions={orderActions}
                />
              ))}
              <div
                className={`flex justify-between items-center px-3 py-2.5 rounded-md border font-semibold text-sm mt-2 ${footerBg}`}
              >
                <span className="text-muted-foreground">
                  {isAsset ? "Total Assets" : isEquity ? "Net Equity Balance" : "Total Liabilities"}
                </span>
                <span className={`font-mono tabular-nums ${totalColor}`}>
                  {formatAmount(displayTotal)}
                  {totalSide && <span className="text-xs font-normal ml-1">{totalSide}</span>}
                </span>
              </div>
            </>
          ) : (
            <p className="text-muted-foreground text-center py-6 text-sm">No data recorded</p>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function todayStr() {
  return new Date().toLocaleDateString("en-CA");
}

export default function NetProfitDetails() {
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

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <div className="flex items-center gap-4">
          <Skeleton className="h-10 w-10 rounded-lg" />
          <Skeleton className="h-8 w-64" />
        </div>
        <Skeleton className="h-32 w-full rounded-xl" />
        <div className="grid grid-cols-2 gap-4">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-5 w-5" />
              <span>Failed to load data: {(error as Error).message}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const forUsTotal = data?.forUsTotal || 0;
  const onUsTotal = data?.onUsTotal || 0;
  const netPos = data?.netPosition || 0;
  const isPositive = netPos >= 0;

  // Ratio bar: what fraction of total is assets
  const grandTotal = forUsTotal + onUsTotal;
  const assetPct = grandTotal > 0 ? (forUsTotal / grandTotal) * 100 : 50;
  const nativeCurrencies = Object.keys(data?.currency?.nativeDebitByCurrency ?? {});
  const hasSpPosProfitBaseline = Boolean(data?.spPosProfitBaselineDate);
  const showPartnerEquity = selectedCompany?.companyType === "supplier_partner";

  return (
    <div className="space-y-5 w-full sm:p-4 md:p-6">
      {/* ── Header ── */}
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

      {/* Only provisional totals need the warning; resolved historical rates are not news. */}
      {data?.currency?.totalsProvisional && (
        <Card className="border-amber-500/40 bg-amber-500/5" data-testid="net-position-currency-context">
          <CardContent className="p-4 space-y-2">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <p className="text-sm font-semibold">Currency context</p>
              <Badge variant={data.currency.totalsProvisional ? "outline" : "secondary"}>
                {data.currency.totalsProvisional ? "Provisional" : "Historical rates resolved"}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              Native balances remain separate; historical base values use the {data.currency.rateConvention} convention.
            </p>
            {nativeCurrencies.length > 0 && (
              <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs font-mono">
                {nativeCurrencies.map((currency) => (
                  <span key={currency}>
                    {currency} debit {data.currency?.nativeDebitByCurrency[currency]}
                  </span>
                ))}
              </div>
            )}
            {data.currency.totalsProvisional && (
              <p className="text-xs text-amber-800 dark:text-amber-200" role="status">
                {data.currency.unresolvedLegacyEntryCount} legacy foreign-currency entries remain unresolved and are
                excluded from reliable base totals.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Summary hero ── */}
      <Card data-testid="card-formula" className="overflow-hidden">
        <CardContent className="p-0">
          {/* Three stat blocks */}
          <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-border">
            {/* What We Have */}
            <div className="p-5 flex items-center gap-4">
              <div className="p-2.5 rounded-xl bg-emerald-100 dark:bg-emerald-900/50 shrink-0">
                <Wallet className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-0.5">
                  What We Have
                </p>
                <p className="text-2xl font-bold font-mono tabular-nums text-emerald-600 dark:text-emerald-400 truncate">
                  {formatAmount(forUsTotal)}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {data?.forUs.accounts?.length || 0} asset accounts
                </p>
              </div>
            </div>

            {/* What We Owe */}
            <div className="p-5 flex items-center gap-4">
              <div className="p-2.5 rounded-xl bg-rose-100 dark:bg-rose-900/50 shrink-0">
                <Scale className="h-5 w-5 text-rose-600 dark:text-rose-400" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-0.5">What We Owe</p>
                <p className="text-2xl font-bold font-mono tabular-nums text-rose-600 dark:text-rose-400 truncate">
                  {formatAmount(onUsTotal)}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {data?.onUs.accounts?.length || 0} liability accounts
                </p>
              </div>
            </div>

            {/* Net Position */}
            <div
              className={`p-5 flex items-center gap-4 ${isPositive ? "bg-emerald-50/40 dark:bg-emerald-950/20" : "bg-rose-50/40 dark:bg-rose-950/20"}`}
            >
              <div
                className={`p-2.5 rounded-xl shrink-0 ${isPositive ? "bg-emerald-100 dark:bg-emerald-900/50" : "bg-rose-100 dark:bg-rose-900/50"}`}
              >
                {isPositive ? (
                  <TrendingUp className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <Minus className="h-5 w-5 text-rose-600 dark:text-rose-400" />
                )}
              </div>
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-0.5">
                  Net Position
                </p>
                <p
                  className={`text-2xl font-bold font-mono tabular-nums truncate ${isPositive ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}
                >
                  {formatAmount(netPos)}
                </p>
                <Badge variant={isPositive ? "default" : "destructive"} className="mt-1 text-xs">
                  {data?.netPositionLabel || "Net Position"}
                </Badge>
              </div>
            </div>
          </div>

          {/* Ratio bar */}
          <div className="px-5 pb-4 pt-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground mb-1.5">
              <span>Assets {assetPct.toFixed(0)}%</span>
              <span>Liabilities {(100 - assetPct).toFixed(0)}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-rose-200 dark:bg-rose-900/60 overflow-hidden">
              <div
                className="h-full rounded-full bg-emerald-500 dark:bg-emerald-500 transition-all duration-500"
                style={{ width: `${Math.min(100, Math.max(0, assetPct))}%` }}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Assets + Liabilities side by side ── */}
      {accountOrder.canArrange && (
        <div className="flex flex-wrap items-center justify-end gap-2 mb-2">
          <span className="text-xs text-muted-foreground">
            {accountOrder.arranging ? "Drag grouped accounts or use the arrows. Saved for all users." : ""}
          </span>
          <Button
            size="sm"
            variant={accountOrder.arranging ? "default" : "outline"}
            onClick={() => accountOrder.setArranging(!accountOrder.arranging)}
            disabled={accountOrder.isSaving}
            data-testid="button-arrange-net-position"
          >
            {accountOrder.arranging ? "Finish arranging" : "Arrange groups & accounts"}
          </Button>
        </div>
      )}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
        <SidePanel
          id="assets"
          title="What We Have"
          subtitle={`${data?.forUs.accounts?.length || 0} asset accounts`}
          side="asset"
          total={forUsTotal}
          accounts={data?.forUs.accounts || []}
          formatAmount={formatAmount}
          displayLayout={displayLayout}
          orderActions={orderActions}
        />
        <SidePanel
          id="liabilities"
          title="What We Owe"
          subtitle={`${data?.onUs.accounts?.length || 0} liability accounts`}
          side="liability"
          total={onUsTotal}
          accounts={data?.onUs.accounts || []}
          formatAmount={formatAmount}
          displayLayout={displayLayout}
          orderActions={orderActions}
        />
      </div>

      {/* ── Amounts not yet in the ledger (never in the totals) ── */}

      {/* ── Partner capital / equity (Supplier Partner only) ── */}
      {showPartnerEquity && (
        <SidePanel
          id="equity"
          title="Partner Capital / Equity"
          subtitle={`${data?.equity?.accounts?.length || 0} equity accounts — excluded from Net Position totals`}
          side="equity"
          total={data?.equity?.total ?? 0}
          accounts={data?.equity?.accounts || []}
          formatAmount={formatAmount}
        />
      )}

      {/* SP Partner: Realized POS Profit */}
      {((data?.spPosProfit ?? 0) !== 0 || hasSpPosProfitBaseline) && (
        <Card data-testid="card-sp-pos-profit" className="overflow-hidden">
          <div className="bg-linear-to-r from-blue-500/10 to-transparent dark:from-blue-500/15 px-5 py-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-blue-100 dark:bg-blue-900/50 text-blue-600 dark:text-blue-400">
                  <TrendingUp className="h-4 w-4" />
                </div>
                <div>
                  <div className="font-semibold text-base text-blue-600 dark:text-blue-400">
                    Realized Profit (POS Sales)
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    Supplier partner POS profit —{" "}
                    {hasSpPosProfitBaseline
                      ? `monthly profit from ${data?.spPosProfitPeriodStartDate || data?.spPosProfitBaselineDate}`
                      : `monthly profit from ${data?.spPosProfitPeriodStartDate || "the first of this month"}`}
                  </div>
                </div>
              </div>
              <span
                className={`text-2xl font-bold font-mono tabular-nums ${(data?.spPosProfit ?? 0) >= 0 ? "text-blue-600 dark:text-blue-400" : "text-destructive"}`}
              >
                {formatAmount(data?.spPosProfit ?? 0)}
              </span>
            </div>
          </div>
          <CardContent className="pt-3 pb-4">
            <div className="rounded-md overflow-hidden border border-border/60">
              <div className="flex items-center justify-between px-3 py-2.5 text-sm">
                <span className="text-foreground">Supplier Partner POS Profit</span>
                <span className="font-mono tabular-nums font-medium text-blue-600 dark:text-blue-400">
                  {formatAmount(data?.spPosProfit ?? 0)}
                </span>
              </div>
              <div className="px-3 py-2 bg-muted/40 text-xs text-muted-foreground border-t border-border/50">
                Formula: Sum of (sale price − cost price) for sales in this month
                {data?.spPosProfitPeriodStartDate
                  ? ` (${data.spPosProfitPeriodStartDate} to ${data.spPosProfitAsOfDate || "today"})`
                  : ""}
                . Prior months remain available through the date filter.
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
