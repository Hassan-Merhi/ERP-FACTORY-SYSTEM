import { useState, useRef, useCallback, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { selectAccountsArray, type AccountsAllPayload } from "@/lib/accountsAllPayload";
import { drCrClass } from "@/lib/formatNumber";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Search,
  Plus,
  Trash2,
  TrendingUp,
  TrendingDown,
  X,
  FileDown,
  Printer,
  Users,
  ArrowRightLeft,
  BookOpen,
} from "lucide-react";
import { PeriodFilter, PeriodFilterValue, getDefaultPeriodValue } from "@/components/ui/period-filter";
import { useDateJump } from "@/hooks/use-date-jump";
import { useReactToPrint } from "react-to-print";
import { format } from "date-fns";
import { utils, writeFile } from "@/lib/excelHelper";
import { useEscapeBack } from "@/hooks/use-escape-back";

interface Account {
  id: string;
  accountId: number;
  type: string;
  code: string;
  name: string;
  balance: number;
  balanceSide: string | null;
  openingBalance?: number;
  openingBalanceSide?: string | null;
  active: boolean;
}

interface Transaction {
  entryId: number;
  voucherId: number;
  debitAmount: string;
  creditAmount: string;
  narration: string;
  voucherNumber: string;
  voucherType: string;
  voucherDate: string;
  voucherDescription: string;
}

interface GroupedVoucher {
  voucherId: number;
  voucherNumber: string;
  voucherType: string;
  voucherDate: string;
  voucherDescription: string;
  narration: string;
  totalDebit: number;
  totalCredit: number;
  runningBalance?: number;
}

interface AgentAccount {
  id: number;
  companyId: number;
  accountId: string;
  accountType: string;
  accountName: string;
}

function parseBalance(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isNaN(parsed) ? 0 : parsed;
}

const VOUCHER_TYPE_COLORS: Record<string, string> = {
  Payment: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  Receipt: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  Journal: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  Invoice: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
  Purchase: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
};

function voucherBadgeClass(type: string) {
  return VOUCHER_TYPE_COLORS[type] ?? "bg-muted text-muted-foreground";
}

export default function Agents() {
  const { selectedCompany } = useCompany();
  const { formatAmount, selectedCurrency, exchangeRate, isMultiCurrency } = useCurrencyContext();
  const { formatDisplayDate } = useDateFormat();
  const { toast } = useToast();

  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);
  const [periodFilter, setPeriodFilter] = useState<PeriodFilterValue>(() => getDefaultPeriodValue("today"));
  useDateJump((date) => setPeriodFilter({ fromDate: date, toDate: date, preset: "custom" }));
  const [agentSearch, setAgentSearch] = useState("");
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addSearch, setAddSearch] = useState("");
  const printRef = useRef<HTMLDivElement>(null);

  useEscapeBack(selectedAccount ? () => setSelectedAccount(null) : null);

  // Preserve the server envelope in the shared cache and normalize only for
  // this screen. That keeps navigation safe for pages that share this query key.
  const { data: allAccounts = [], isLoading: accountsLoading } = useQuery<
    AccountsAllPayload<Account>,
    Error,
    Account[]
  >({
    queryKey: ["/api/accounts/all", selectedCompany?.id],
    select: selectAccountsArray,
    enabled: !!selectedCompany,
  });

  const { data: agentAccountRows = [], isLoading: agentsLoading } = useQuery<AgentAccount[]>({
    queryKey: ["/api/agent-accounts"],
    enabled: !!selectedCompany,
  });

  const agentIds = useMemo(() => new Set(agentAccountRows.map((a) => a.accountId)), [agentAccountRows]);

  const agentAccounts = useMemo(() => {
    const searchLower = agentSearch.trim().toLowerCase();
    return allAccounts.filter((a) => {
      if (!agentIds.has(a.id)) return false;
      if (searchLower && !a.name.toLowerCase().includes(searchLower) && !a.code.toLowerCase().includes(searchLower))
        return false;
      return true;
    });
  }, [allAccounts, agentIds, agentSearch]);

  const availableAccounts = useMemo(() => {
    const searchLower = addSearch.trim().toLowerCase();
    return allAccounts.filter((a) => {
      if (agentIds.has(a.id)) return false;
      if (
        searchLower &&
        !a.name.toLowerCase().includes(searchLower) &&
        !a.code.toLowerCase().includes(searchLower) &&
        !a.type.toLowerCase().includes(searchLower)
      )
        return false;
      return true;
    });
  }, [allAccounts, agentIds, addSearch]);

  const accountTypeUrl = selectedAccount ? (selectedAccount.type || "").toLowerCase().replace(" ", "-") : null;
  const { data: transactions = [], isLoading: transactionsLoading } = useQuery<Transaction[]>({
    queryKey: selectedAccount
      ? [
          `/api/accounts/${accountTypeUrl}/${selectedAccount.accountId}/transactions`,
          { startDate: periodFilter.fromDate, endDate: periodFilter.toDate },
        ]
      : [],
    queryFn: async () => {
      if (!selectedAccount) return [];
      const params = new URLSearchParams();
      if (periodFilter.fromDate) params.append("startDate", periodFilter.fromDate);
      if (periodFilter.toDate) params.append("endDate", periodFilter.toDate);
      const url = `/api/accounts/${accountTypeUrl}/${selectedAccount.accountId}/transactions${params.toString() ? `?${params.toString()}` : ""}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch transactions");
      const data = await res.json();
      return Array.isArray(data) ? data : (data.transactions ?? []);
    },
    enabled: !!selectedAccount,
  });

  const { data: prePeriodData } = useQuery<{ balance: number }>({
    queryKey:
      selectedAccount && periodFilter.fromDate
        ? [
            `/api/accounts/${accountTypeUrl}/${selectedAccount.accountId}/pre-period-balance`,
            { endDate: periodFilter.fromDate },
          ]
        : [],
    queryFn: async () => {
      if (!selectedAccount || !periodFilter.fromDate) return { balance: 0 };
      const res = await fetch(
        `/api/accounts/${accountTypeUrl}/${selectedAccount.accountId}/pre-period-balance?endDate=${encodeURIComponent(periodFilter.fromDate)}`,
        { credentials: "include" }
      );
      if (!res.ok) return { balance: 0 };
      return res.json();
    },
    enabled: !!selectedAccount && !!periodFilter.fromDate,
  });

  const addMutation = useMutation({
    mutationFn: async (account: Account) => {
      const res = await fetch("/api/agent-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ accountId: account.id, accountType: account.type, accountName: account.name }),
      });
      if (!res.ok) throw new Error("Failed to add agent");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agent-accounts"] });
      toast({ title: "Account added to Agent Ledger" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const removeMutation = useMutation({
    mutationFn: async (accountId: string) => {
      const res = await fetch(`/api/agent-accounts/${encodeURIComponent(accountId)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to remove agent");
      return res.json();
    },
    onSuccess: (_, accountId) => {
      queryClient.invalidateQueries({ queryKey: ["/api/agent-accounts"] });
      if (selectedAccount?.id === accountId) setSelectedAccount(null);
      toast({ title: "Account removed from Agent Ledger" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const groupTransactions = (): GroupedVoucher[] => {
    const map = new Map<number, GroupedVoucher>();
    transactions.forEach((txn) => {
      const vid = Number(txn.voucherId);
      const debit = parseBalance(txn.debitAmount);
      const credit = parseBalance(txn.creditAmount);
      const existing = map.get(vid);
      if (existing) {
        existing.totalDebit += debit;
        existing.totalCredit += credit;
        if (!existing.narration && txn.narration) existing.narration = txn.narration;
      } else {
        map.set(vid, {
          voucherId: vid,
          voucherNumber: txn.voucherNumber,
          voucherType: txn.voucherType,
          voucherDate: txn.voucherDate,
          voucherDescription: txn.voucherDescription,
          narration: txn.voucherDescription || txn.narration || "",
          totalDebit: debit,
          totalCredit: credit,
        });
      }
    });
    return Array.from(map.values()).sort((a, b) => {
      const dc = new Date(a.voucherDate).getTime() - new Date(b.voucherDate).getTime();
      return dc !== 0 ? dc : a.voucherNumber.localeCompare(b.voucherNumber);
    });
  };

  const groupedVouchers = groupTransactions();

  const openingBalance: number = useMemo(() => {
    if (periodFilter.fromDate && prePeriodData !== undefined) return prePeriodData.balance;
    const raw = parseBalance(selectedAccount?.openingBalance ?? 0);
    if (selectedAccount?.type === "supplier") return raw;
    return selectedAccount?.openingBalanceSide === "Cr" ? -raw : raw;
  }, [periodFilter.fromDate, prePeriodData, selectedAccount]);

  const vouchersWithBalance: GroupedVoucher[] = useMemo(() => {
    let running = openingBalance;
    return groupedVouchers.map((v) => {
      if (selectedAccount?.type === "supplier") {
        running += v.totalCredit - v.totalDebit;
      } else {
        running += v.totalDebit - v.totalCredit;
      }
      return { ...v, runningBalance: running };
    });
  }, [groupedVouchers, openingBalance, selectedAccount]);

  const closingBalance =
    vouchersWithBalance.length > 0
      ? (vouchersWithBalance[vouchersWithBalance.length - 1].runningBalance ?? openingBalance)
      : openingBalance;

  const periodDebit = vouchersWithBalance.reduce((s, v) => s + v.totalDebit, 0);
  const periodCredit = vouchersWithBalance.reduce((s, v) => s + v.totalCredit, 0);

  const periodLabel = useMemo(() => {
    const hasStart = !!periodFilter.fromDate;
    const hasEnd = !!periodFilter.toDate;
    if (hasStart && hasEnd)
      return `${formatDisplayDate(periodFilter.fromDate)} → ${formatDisplayDate(periodFilter.toDate)}`;
    if (hasStart) return `From ${formatDisplayDate(periodFilter.fromDate)}`;
    if (hasEnd) return `Up to ${formatDisplayDate(periodFilter.toDate)}`;
    return "All dates";
  }, [periodFilter, formatDisplayDate]);

  const handlePrint = useReactToPrint({
    contentRef: printRef,
    documentTitle: selectedAccount ? `Agent Statement - ${selectedAccount.name}` : "Agent Statement",
  });

  const handleExportExcel = async () => {
    if (!selectedAccount || vouchersWithBalance.length === 0) {
      toast({ title: "No data to export", variant: "destructive" });
      return;
    }
    // Build header row — include FX rate when exporting in a converted currency.
    const fxNote =
      isMultiCurrency && exchangeRate
        ? `${selectedCurrency} @ rate ${exchangeRate.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })} per USD`
        : null;
    const rows = [
      ["Ledger", "Type", "Debit", "Credit", "Running Balance", "Date", "Notes", ...(fxNote ? ["FX Rate"] : [])],
    ];
    if (fxNote) rows.push(["", "", "", "", "", "", "", fxNote]);
    const firstDate = vouchersWithBalance[0]?.voucherDate.split("T")[0] ?? "";
    const openingDateFmt = firstDate ? format(new Date(firstDate + "T00:00:00"), "dd MMM yyyy") : "";
    rows.push([selectedAccount.name, "Opening Balance", "", "", formatAmount(openingBalance), openingDateFmt, ""]);
    for (const v of vouchersWithBalance) {
      const dateFmt = format(new Date(v.voucherDate.split("T")[0] + "T00:00:00"), "dd MMM yyyy");
      const note = v.voucherDescription?.trim() || v.narration?.trim() || "";
      rows.push([
        selectedAccount.name,
        v.voucherType,
        v.totalDebit > 0 ? formatAmount(v.totalDebit) : "",
        v.totalCredit > 0 ? formatAmount(v.totalCredit) : "",
        formatAmount(v.runningBalance ?? 0),
        dateFmt,
        note,
      ]);
    }
    const wb = utils.book_new();
    utils.book_append_sheet(
      wb,
      {
        ...utils.aoa_to_sheet(rows),
        "!cols": [{ wch: 25 }, { wch: 14 }, { wch: 15 }, { wch: 15 }, { wch: 18 }, { wch: 14 }, { wch: 30 }],
      },
      selectedAccount.name.substring(0, 31).replace(/[\\/*?[\]:]/g, "_")
    );
    await writeFile(wb, `Agent_Statement_${selectedAccount.name.replace(/[\\/*?[\]:]/g, "_").substring(0, 40)}.xlsx`);
    toast({ title: "Exported successfully" });
  };

  const handlePeriodChange = useCallback((v: PeriodFilterValue) => setPeriodFilter(v), []);

  return (
    <div className="flex h-full">
      {/* ── Left panel — agent list ─────────────────────────────────────── */}
      <div className="w-72 shrink-0 border-r flex flex-col h-full overflow-hidden bg-muted/20">
        {/* Panel header */}
        <div className="px-4 pt-4 pb-3 border-b space-y-3 bg-background">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center">
                <Users className="h-4 w-4 text-primary" />
              </div>
              <span className="text-sm font-bold tracking-tight">Agent Ledger</span>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs gap-1"
              onClick={() => {
                setAddSearch("");
                setAddDialogOpen(true);
              }}
              data-testid="button-add-agent"
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </Button>
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search agents..."
              value={agentSearch}
              onChange={(e) => setAgentSearch(e.target.value)}
              className="pl-8 h-8 text-sm bg-muted/50 border-transparent focus:border-border focus:bg-background"
              data-testid="input-agent-search"
            />
          </div>
        </div>

        {/* Agent list */}
        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
          {agentsLoading || accountsLoading ? (
            <div className="p-2 space-y-2">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-14 w-full rounded-xl" />
              ))}
            </div>
          ) : agentAccounts.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 px-4 text-center">
              <div className="w-12 h-12 rounded-2xl bg-muted flex items-center justify-center">
                <Users className="h-6 w-6 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm font-semibold">{agentIds.size === 0 ? "No agents yet" : "No results"}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {agentIds.size === 0 ? "Click Add to pin an account as an agent" : "Try a different search"}
                </p>
              </div>
            </div>
          ) : (
            agentAccounts.map((account) => {
              const isSelected = selectedAccount?.id === account.id;
              const initials = account.name
                .split(/\s+/)
                .slice(0, 2)
                .map((w) => w[0])
                .join("")
                .toUpperCase();
              const isCr = account.balanceSide?.toLowerCase() === "cr";
              return (
                <div
                  key={account.id}
                  className={`flex items-center gap-2.5 rounded-xl p-2 group transition-colors cursor-pointer
                    ${isSelected ? "bg-primary/10 ring-1 ring-primary/20" : "hover:bg-muted/60"}`}
                  data-testid={`agent-row-${account.id}`}
                >
                  {/* Avatar */}
                  <button
                    className="flex-1 flex items-center gap-2.5 text-left min-w-0"
                    onClick={() => setSelectedAccount(account)}
                    data-testid={`button-select-agent-${account.id}`}
                  >
                    <div
                      className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 text-xs font-bold
                      ${isSelected ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
                    >
                      {initials || "—"}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate leading-tight">{account.name}</p>
                      {account.balance !== 0 ? (
                        <p
                          className={`text-xs tabular-nums font-mono mt-0.5 ${isCr ? "text-red-500 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}`}
                        >
                          {formatAmount(Math.abs(account.balance))}{" "}
                          <span className="font-sans font-medium">{account.balanceSide ?? ""}</span>
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground mt-0.5">$0 — settled</p>
                      )}
                    </div>
                  </button>
                  <button
                    className="p-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive hover:bg-destructive/10 shrink-0"
                    onClick={() => removeMutation.mutate(account.id)}
                    data-testid={`button-remove-agent-${account.id}`}
                    title="Remove from Agent Ledger"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ── Right panel — statement ─────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto bg-background">
        {!selectedAccount ? (
          <div className="h-full flex items-center justify-center">
            <div className="flex flex-col items-center gap-4 text-center max-w-xs">
              <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center">
                <BookOpen className="h-8 w-8 text-muted-foreground" />
              </div>
              <div>
                <p className="text-base font-semibold">No agent selected</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Pick an agent from the list to view their ledger statement
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="p-6 space-y-5 max-w-5xl">
            {/* Header */}
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2.5 flex-wrap">
                  <h2 className="text-xl font-bold tracking-tight" data-testid="text-agent-account-name">
                    {selectedAccount.name}
                  </h2>
                  <Badge
                    variant="secondary"
                    className="text-xs no-default-active-elevate bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 capitalize font-semibold"
                  >
                    {selectedAccount.type}
                  </Badge>
                </div>
                <div className="flex items-center gap-1.5 mt-1.5">
                  {selectedAccount.balanceSide?.toLowerCase() === "cr" ? (
                    <TrendingDown className="w-3.5 h-3.5 text-emerald-600" />
                  ) : (
                    <TrendingUp className="w-3.5 h-3.5 text-red-500" />
                  )}
                  <span className="text-base font-bold font-mono tabular-nums" data-testid="text-agent-balance">
                    {formatAmount(Math.abs(selectedAccount.balance))}
                  </span>
                  <span className={`text-xs font-semibold ${drCrClass(selectedAccount.balanceSide)}`}>
                    {selectedAccount.balanceSide ?? ""}
                  </span>
                  <span className="text-xs text-muted-foreground">current balance</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleExportExcel}
                  disabled={transactionsLoading || vouchersWithBalance.length === 0}
                  data-testid="button-export-excel"
                >
                  <FileDown className="h-3.5 w-3.5 mr-1.5" />
                  Excel
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handlePrint()}
                  disabled={transactionsLoading}
                  data-testid="button-print"
                >
                  <Printer className="h-3.5 w-3.5 mr-1.5" />
                  Print
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setSelectedAccount(null)}
                  data-testid="button-clear-account"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Period filter */}
            <PeriodFilter value={periodFilter} onChange={handlePeriodChange} />

            {/* Stats grid */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="rounded-xl border bg-muted/30 p-4 space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Opening</p>
                <p className="text-base font-bold font-mono tabular-nums leading-tight">
                  {formatAmount(Math.abs(openingBalance))}
                </p>
                <p className="text-xs text-muted-foreground">
                  {openingBalance >= 0
                    ? selectedAccount.type === "supplier"
                      ? "Cr"
                      : "Dr"
                    : selectedAccount.type === "supplier"
                      ? "Dr"
                      : "Cr"}
                </p>
              </div>
              <div className="rounded-xl border bg-red-50/50 dark:bg-red-950/20 border-red-200/60 dark:border-red-800/40 p-4 space-y-1.5">
                <p className="text-xs font-medium text-red-600 dark:text-red-400 uppercase tracking-wide">Debit</p>
                <p className="text-base font-bold font-mono tabular-nums text-red-700 dark:text-red-300 leading-tight">
                  {formatAmount(periodDebit)}
                </p>
                <p className="text-xs text-muted-foreground">this period</p>
              </div>
              <div className="rounded-xl border bg-emerald-50/50 dark:bg-emerald-950/20 border-emerald-200/60 dark:border-emerald-800/40 p-4 space-y-1.5">
                <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400 uppercase tracking-wide">
                  Credit
                </p>
                <p className="text-base font-bold font-mono tabular-nums text-emerald-700 dark:text-emerald-300 leading-tight">
                  {formatAmount(periodCredit)}
                </p>
                <p className="text-xs text-muted-foreground">this period</p>
              </div>
              <div
                className={`rounded-xl border p-4 space-y-1.5 ${closingBalance >= 0 ? "bg-blue-50/50 dark:bg-blue-950/20 border-blue-200/60 dark:border-blue-800/40" : "bg-orange-50/50 dark:bg-orange-950/20 border-orange-200/60 dark:border-orange-800/40"}`}
              >
                <p
                  className={`text-xs font-medium uppercase tracking-wide ${closingBalance >= 0 ? "text-blue-600 dark:text-blue-400" : "text-orange-600 dark:text-orange-400"}`}
                >
                  Closing
                </p>
                <p
                  className={`text-base font-bold font-mono tabular-nums leading-tight ${closingBalance >= 0 ? "text-blue-700 dark:text-blue-300" : "text-orange-700 dark:text-orange-300"}`}
                >
                  {formatAmount(Math.abs(closingBalance))}
                </p>
                <p className="text-xs text-muted-foreground">
                  {closingBalance >= 0
                    ? selectedAccount.type === "supplier"
                      ? "Cr"
                      : "Dr"
                    : selectedAccount.type === "supplier"
                      ? "Dr"
                      : "Cr"}
                </p>
              </div>
            </div>

            {/* Ledger table */}
            <div ref={printRef} className="print-container">
              {/* Print-only header */}
              <div className="hidden print:block mb-4">
                <div className="text-center">
                  <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>{selectedCompany?.name}</h1>
                  <h2 style={{ fontSize: 14, fontWeight: 600, margin: "4px 0 0" }}>
                    Agent Ledger: {selectedAccount.name}
                  </h2>
                </div>
                <div
                  style={{
                    borderTop: "1px solid #ccc",
                    borderBottom: "1px solid #ccc",
                    padding: "6px 0",
                    fontSize: 11,
                    marginTop: 8,
                  }}
                >
                  <div>Period: {periodLabel}</div>
                  <div>Generated: {formatDisplayDate(new Date())}</div>
                </div>
              </div>

              <div className="rounded-xl border overflow-hidden shadow-sm">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50 hover:bg-muted/50 border-b-2">
                      <TableHead className="text-xs h-10 font-bold uppercase tracking-wide text-muted-foreground w-[120px]">
                        Date
                      </TableHead>
                      <TableHead className="text-xs h-10 font-bold uppercase tracking-wide text-muted-foreground w-[110px]">
                        Type
                      </TableHead>
                      <TableHead className="text-xs h-10 font-bold uppercase tracking-wide text-muted-foreground">
                        Particulars
                      </TableHead>
                      <TableHead className="text-xs h-10 font-bold uppercase tracking-wide text-muted-foreground text-right w-[130px]">
                        Debit
                      </TableHead>
                      <TableHead className="text-xs h-10 font-bold uppercase tracking-wide text-muted-foreground text-right w-[130px]">
                        Credit
                      </TableHead>
                      <TableHead className="text-xs h-10 font-bold uppercase tracking-wide text-muted-foreground text-right w-[145px]">
                        Balance
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {transactionsLoading ? (
                      [...Array(5)].map((_, i) => (
                        <TableRow key={i}>
                          {[24, 16, 40, 20, 20, 24].map((w, j) => (
                            <TableCell key={j}>
                              <Skeleton className={`h-4 w-${w} ${j >= 3 ? "ml-auto" : ""}`} />
                            </TableCell>
                          ))}
                        </TableRow>
                      ))
                    ) : (
                      <>
                        {/* Opening Balance row */}
                        <TableRow className="bg-muted/30 hover:bg-muted/30" data-testid="row-opening-balance">
                          <TableCell
                            className="py-3 text-xs font-bold text-muted-foreground uppercase tracking-wider"
                            colSpan={3}
                          >
                            Opening Balance
                          </TableCell>
                          <TableCell className="py-3 text-right font-mono text-sm text-foreground">
                            {selectedAccount.type === "supplier"
                              ? openingBalance < 0
                                ? formatAmount(Math.abs(openingBalance))
                                : "—"
                              : openingBalance > 0
                                ? formatAmount(openingBalance)
                                : "—"}
                          </TableCell>
                          <TableCell className="py-3 text-right font-mono text-sm text-foreground">
                            {selectedAccount.type === "supplier"
                              ? openingBalance > 0
                                ? formatAmount(openingBalance)
                                : "—"
                              : openingBalance < 0
                                ? formatAmount(Math.abs(openingBalance))
                                : "—"}
                          </TableCell>
                          <TableCell className="py-3 text-right font-mono text-sm font-semibold">
                            {formatAmount(Math.abs(openingBalance))}{" "}
                            <span className="text-xs font-normal text-muted-foreground">
                              {openingBalance >= 0
                                ? selectedAccount.type === "supplier"
                                  ? "Cr"
                                  : "Dr"
                                : selectedAccount.type === "supplier"
                                  ? "Dr"
                                  : "Cr"}
                            </span>
                          </TableCell>
                        </TableRow>

                        {vouchersWithBalance.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={6}>
                              <div className="flex flex-col items-center gap-3 py-14 text-center">
                                <div className="w-12 h-12 rounded-2xl bg-muted flex items-center justify-center">
                                  <ArrowRightLeft className="h-6 w-6 text-muted-foreground" />
                                </div>
                                <div>
                                  <p className="text-sm font-semibold">No transactions</p>
                                  <p className="text-xs text-muted-foreground mt-0.5">No activity in this period</p>
                                </div>
                              </div>
                            </TableCell>
                          </TableRow>
                        ) : (
                          vouchersWithBalance.map((v, idx) => {
                            const bal = v.runningBalance ?? 0;
                            const dateKey = v.voucherDate.split("T")[0];
                            const dateFmt = format(new Date(dateKey + "T00:00:00"), "dd MMM yyyy");
                            const note = v.narration?.trim() || v.voucherDescription?.trim() || "";
                            return (
                              <TableRow
                                key={v.voucherId}
                                className={`hover:bg-accent/30 transition-colors ${idx % 2 === 1 ? "bg-muted/10" : ""}`}
                                data-testid={`row-voucher-${v.voucherId}`}
                              >
                                <TableCell className="py-3 font-mono text-sm whitespace-nowrap text-muted-foreground">
                                  {dateFmt}
                                </TableCell>
                                <TableCell className="py-3">
                                  <Badge
                                    variant="secondary"
                                    className={`text-xs no-default-active-elevate font-semibold ${voucherBadgeClass(v.voucherType)}`}
                                  >
                                    {v.voucherType}
                                  </Badge>
                                </TableCell>
                                <TableCell className="py-3">
                                  {note && <p className="text-xs text-muted-foreground truncate max-w-xs">{note}</p>}
                                </TableCell>
                                <TableCell className="py-3 text-right font-mono text-sm">
                                  {v.totalDebit > 0 ? (
                                    <span className="text-foreground font-medium">{formatAmount(v.totalDebit)}</span>
                                  ) : (
                                    <span className="text-muted-foreground/40">—</span>
                                  )}
                                </TableCell>
                                <TableCell className="py-3 text-right font-mono text-sm">
                                  {v.totalCredit > 0 ? (
                                    <span className="text-foreground font-medium">{formatAmount(v.totalCredit)}</span>
                                  ) : (
                                    <span className="text-muted-foreground/40">—</span>
                                  )}
                                </TableCell>
                                <TableCell className="py-3 text-right font-mono text-sm font-semibold">
                                  {formatAmount(Math.abs(bal))}{" "}
                                  <span className="text-xs font-normal text-muted-foreground">
                                    {bal >= 0
                                      ? selectedAccount.type === "supplier"
                                        ? "Cr"
                                        : "Dr"
                                      : selectedAccount.type === "supplier"
                                        ? "Dr"
                                        : "Cr"}
                                  </span>
                                </TableCell>
                              </TableRow>
                            );
                          })
                        )}

                        {/* Closing Balance row */}
                        {vouchersWithBalance.length > 0 && (
                          <TableRow
                            className="bg-muted/40 hover:bg-muted/40 border-t-2"
                            data-testid="row-closing-balance"
                          >
                            <TableCell
                              colSpan={3}
                              className="py-3 text-xs font-bold text-muted-foreground uppercase tracking-wider"
                            >
                              Closing Balance
                            </TableCell>
                            <TableCell className="py-3 text-right font-mono text-sm font-semibold text-foreground">
                              {formatAmount(periodDebit)}
                            </TableCell>
                            <TableCell className="py-3 text-right font-mono text-sm font-semibold text-foreground">
                              {formatAmount(periodCredit)}
                            </TableCell>
                            <TableCell className="py-3 text-right font-mono text-sm font-bold">
                              {formatAmount(Math.abs(closingBalance))}{" "}
                              <span className="text-xs font-normal text-muted-foreground">
                                {closingBalance >= 0
                                  ? selectedAccount.type === "supplier"
                                    ? "Cr"
                                    : "Dr"
                                  : selectedAccount.type === "supplier"
                                    ? "Dr"
                                    : "Cr"}
                              </span>
                            </TableCell>
                          </TableRow>
                        )}
                      </>
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Add account dialog ──────────────────────────────────────────── */}
      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Account to Agent Ledger</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by name, code or type..."
                value={addSearch}
                onChange={(e) => setAddSearch(e.target.value)}
                className="pl-9"
                autoFocus
                data-testid="input-add-agent-search"
              />
            </div>
            <div className="max-h-80 overflow-y-auto border rounded-xl divide-y">
              {accountsLoading ? (
                <div className="p-4 space-y-2">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-8 w-full" />
                  ))}
                </div>
              ) : availableAccounts.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">No accounts found</div>
              ) : (
                availableAccounts.slice(0, 100).map((account) => (
                  <button
                    key={account.id}
                    className="w-full px-4 py-3 text-left hover-elevate flex items-center gap-3"
                    onClick={() => {
                      addMutation.mutate(account);
                      setAddDialogOpen(false);
                    }}
                    data-testid={`button-add-account-${account.id}`}
                  >
                    <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center text-xs font-bold text-muted-foreground shrink-0">
                      {account.name
                        .split(/\s+/)
                        .slice(0, 2)
                        .map((w) => w[0])
                        .join("")
                        .toUpperCase() || "—"}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{account.name}</p>
                      <p className="text-xs text-muted-foreground capitalize">{account.type}</p>
                    </div>
                    {account.balance !== 0 && (
                      <span className="text-xs tabular-nums text-muted-foreground shrink-0 font-mono">
                        {formatAmount(Math.abs(account.balance))}{" "}
                        <span className={drCrClass(account.balanceSide)}>{account.balanceSide ?? ""}</span>
                      </span>
                    )}
                  </button>
                ))
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
