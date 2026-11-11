/**
 * Agent statement panel (right side of the Agent Ledger page): header with
 * balance, period filter, stats grid, ledger table, and print output.
 *
 * Extracted from pages/Agents.tsx. The presentation is theme-aware;
 * calculations, printed statement values, actions, and test ids are preserved.
 */
import { useMemo, useRef } from "react";
import { TrendingUp, TrendingDown, X, FileDown, Printer, ArrowRightLeft, ArrowLeft, Store, Layers3, ArrowDownRight, ArrowUpRight, Flag } from "lucide-react";
import { ErpMobileActionsMenu } from "@/components/ui/erp-mobile-records";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PeriodFilter, type PeriodFilterValue } from "@/components/ui/period-filter";
import { drCrClass } from "@/lib/formatNumber";
import { useReactToPrint } from "react-to-print";
import { format } from "date-fns";
import type { Account, GroupedVoucher } from "./agentStatementMath";
import { balanceSideLabel } from "./agentStatementMath";

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

interface AgentStatementPanelProps {
  companyName: string | undefined;
  selectedAccount: Account;
  fxWallet?: {
    state: { usd: string; eur: string; eurBookUsd: string };
    currentUsd: string | null;
    synchronized: boolean;
  };
  periodFilter: PeriodFilterValue;
  onPeriodChange: (value: PeriodFilterValue) => void;
  transactionsLoading: boolean;
  vouchersWithBalance: GroupedVoucher[];
  openingBalance: number;
  periodDebit: number;
  periodCredit: number;
  closingBalance: number;
  onExportExcel: () => void;
  onClearAccount: () => void;
  formatAmount: (value: number) => string;
  formatDisplayDate: (date: Date | string) => string;
  /** Phone layout: the statement is its own screen with Back to the agent list. */
  phone?: boolean;
}

export function AgentStatementPanel({
  companyName,
  selectedAccount,
  fxWallet,
  periodFilter,
  onPeriodChange,
  transactionsLoading,
  vouchersWithBalance,
  openingBalance,
  periodDebit,
  periodCredit,
  closingBalance,
  onExportExcel,
  onClearAccount,
  formatAmount,
  formatDisplayDate,
  phone = false,
}: AgentStatementPanelProps) {
  const printRef = useRef<HTMLDivElement>(null);

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

  const openingSide = balanceSideLabel(openingBalance, selectedAccount.type);
  const closingSide = balanceSideLabel(closingBalance, selectedAccount.type);

  return (
    <div className={phone ? "min-w-0 space-y-4" : "relative isolate min-h-full min-w-0 space-y-6 rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm dark:border-blue-400/20 dark:bg-[#07152b] lg:p-6 max-md:rounded-none max-md:border-0 max-md:p-3"} data-testid="agent-statement-panel">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        {phone && (
          <Button
            variant="outline"
            size="sm"
            onClick={onClearAccount}
            className="w-full justify-start gap-2"
            data-testid="button-back-to-agents"
          >
            <ArrowLeft className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
            Back to agents
          </Button>
        )}
        <div className={phone ? "min-w-0 flex-1" : "flex min-w-0 flex-1 items-center gap-4"}>
          {!phone && (
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border border-sky-200 bg-gradient-to-br from-sky-50 to-blue-100 text-sky-600 shadow-sm dark:border-sky-400/25 dark:from-[#153f67] dark:to-[#09213c] dark:text-sky-300">
              <Store className="h-8 w-8" aria-hidden="true" />
            </div>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h2
                className={`${phone ? "wrap-break-word text-lg" : "text-2xl"} font-extrabold tracking-tight text-slate-900 dark:text-slate-50`}
                data-testid="text-agent-account-name"
              >
                {selectedAccount.name}
              </h2>
              <Badge
                variant="secondary"
                className="no-default-active-elevate rounded-lg border border-blue-200 bg-blue-100 px-2.5 py-1 text-xs font-bold capitalize text-blue-700 dark:border-blue-400/20 dark:bg-blue-600/25 dark:text-blue-200"
              >
                {selectedAccount.type}
              </Badge>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {selectedAccount.balanceSide?.toLowerCase() === "cr" ? (
                <TrendingDown className="h-4 w-4 text-red-500 dark:text-red-400" />
              ) : (
                <TrendingUp className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              )}
              <span className={`font-mono text-lg font-extrabold tabular-nums ${drCrClass(fxWallet ? (Number(fxWallet.state.eur) >= 0 ? "Dr" : "Cr") : selectedAccount.balanceSide)}`} data-testid="text-agent-balance">
                {fxWallet
                  ? `EUR ${Number(fxWallet.state.eur).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                  : formatAmount(Math.abs(selectedAccount.balance))}
              </span>
              <span className={`text-xs font-semibold ${drCrClass(fxWallet ? (Number(fxWallet.state.eur) >= 0 ? "Dr" : "Cr") : selectedAccount.balanceSide)}`}>
                {fxWallet ? (Number(fxWallet.state.eur) >= 0 ? "Dr" : "Cr") : (selectedAccount.balanceSide ?? "")}
              </span>
              <span className="text-xs font-medium text-slate-500 dark:text-slate-400">{fxWallet ? "native EUR balance" : "current balance"}</span>
            </div>
          </div>
        </div>
        {phone ? (
          <ErpMobileActionsMenu
            iconOnly
            data-testid="button-agent-statement-actions"
            actions={[
              {
                label: "Export Excel",
                icon: FileDown,
                onSelect: onExportExcel,
                disabled: transactionsLoading || vouchersWithBalance.length === 0,
                testId: "button-export-excel",
              },
              {
                label: "Print",
                icon: Printer,
                onSelect: () => handlePrint(),
                disabled: transactionsLoading,
                testId: "button-print",
              },
            ]}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onExportExcel}
              disabled={transactionsLoading || vouchersWithBalance.length === 0}
              data-testid="button-export-excel"
            >
              <FileDown className="mr-1.5 h-4 w-4 text-emerald-500" />
              Excel
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handlePrint()}
              disabled={transactionsLoading}
              data-testid="button-print"
            >
              <Printer className="mr-1.5 h-4 w-4" />
              Print
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={onClearAccount}
              data-testid="button-clear-account"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>

      {fxWallet && (
        <div className="space-y-1 rounded-xl border border-sky-200 bg-sky-50/70 p-4 dark:border-sky-500/30 dark:bg-sky-950/30" data-testid="agent-native-fx-wallet">
          <p className="text-sm font-semibold">FX Agent Native Balance</p>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm font-mono tabular-nums">
            <span>
              EUR{" "}
              {Number(fxWallet.state.eur).toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </span>
            <span>
              USD{" "}
              {Number(fxWallet.state.usd).toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </span>
            <span>
              USD equivalent:{" "}
              {fxWallet.currentUsd == null
                ? "FX rate missing"
                : Number(fxWallet.currentUsd).toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Native currency balance is separate from historical USD journal totals shown below.
          </p>
          {!fxWallet.synchronized && (
            <p role="alert" className="text-xs text-destructive">
              Account and FX wallet mismatch; settlements are blocked pending reconciliation.
            </p>
          )}
        </div>
      )}

      {/* Period filter */}
      <PeriodFilter value={periodFilter} onChange={onPeriodChange} />

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        <div className="relative space-y-2 overflow-hidden rounded-2xl border border-blue-200 bg-gradient-to-br from-blue-50 to-sky-50 p-4 shadow-sm dark:border-sky-500/35 dark:from-[#163e68] dark:to-[#0d2545]">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-bold uppercase tracking-wider text-sky-700 dark:text-sky-200">Opening</p>
            <span className="rounded-xl bg-sky-100 p-2 text-sky-600 dark:bg-sky-500/20 dark:text-sky-300">
              <Layers3 className="h-4 w-4" aria-hidden="true" />
            </span>
          </div>
          <p className="break-words font-mono text-lg font-extrabold leading-tight tracking-tight tabular-nums text-slate-900 dark:text-white">
            {formatAmount(Math.abs(openingBalance))}
          </p>
          <p className="text-xs text-muted-foreground">{openingSide}</p>
        </div>
        <div className="relative space-y-2 overflow-hidden rounded-2xl border border-rose-200 bg-gradient-to-br from-rose-50 to-red-50 p-4 shadow-sm dark:border-rose-500/45 dark:from-[#542238] dark:to-[#361725]">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-bold uppercase tracking-wider text-red-700 dark:text-red-200">Debit</p>
            <span className="rounded-xl bg-red-100 p-2 text-red-600 dark:bg-red-400/20 dark:text-red-200">
              <ArrowDownRight className="h-4 w-4" aria-hidden="true" />
            </span>
          </div>
          <p className="break-words font-mono text-lg font-extrabold leading-tight tracking-tight tabular-nums text-red-700 dark:text-red-100">
            {formatAmount(periodDebit)}
          </p>
          <p className="text-xs text-muted-foreground">this period</p>
        </div>
        <div className="relative space-y-2 overflow-hidden rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-green-50 p-4 shadow-sm dark:border-emerald-500/45 dark:from-[#0b5038] dark:to-[#073324]">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-200">Credit</p>
            <span className="rounded-xl bg-emerald-100 p-2 text-emerald-600 dark:bg-emerald-400/20 dark:text-emerald-200">
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </span>
          </div>
          <p className="break-words font-mono text-lg font-extrabold leading-tight tracking-tight tabular-nums text-emerald-700 dark:text-emerald-100">
            {formatAmount(periodCredit)}
          </p>
          <p className="text-xs text-muted-foreground">this period</p>
        </div>
        <div
          className={`relative space-y-2 overflow-hidden rounded-2xl border p-4 shadow-sm ${closingSide.toLowerCase() === "cr" ? "border-red-200 bg-red-50/70 dark:border-red-500/45 dark:bg-red-950/30" : "border-green-200 bg-green-50/70 dark:border-green-500/45 dark:bg-green-950/30"}`}
        >
          <div className="flex items-center justify-between gap-2">
            <p className={`text-xs font-bold uppercase tracking-wider ${drCrClass(closingSide)}`}>Closing</p>
            <span className={`rounded-xl p-2 ${closingSide.toLowerCase() === "cr" ? "bg-red-100 dark:bg-red-950" : "bg-green-100 dark:bg-green-950"} ${drCrClass(closingSide)}`}>
              <Flag className="h-4 w-4" aria-hidden="true" />
            </span>
          </div>
          <p
            className={`break-words font-mono text-lg font-extrabold leading-tight tracking-tight tabular-nums ${drCrClass(closingSide)}`}
          >
            {formatAmount(Math.abs(closingBalance))}
          </p>
          <p className={`text-xs font-semibold ${drCrClass(closingSide)}`}>{closingSide}</p>
        </div>
      </div>

      {/* Ledger table */}
      <div ref={printRef} className="print-container">
        {fxWallet && (
          <div className="hidden print:block text-xs mb-3">
            <strong>FX Agent Native Balance:</strong> EUR {fxWallet.state.eur}, USD {fxWallet.state.usd}. Current USD
            equivalent: {fxWallet.currentUsd ?? "FX rate missing"}. Historical journal entries below remain in USD.
          </div>
        )}
        {/* Print-only header */}
        <div className="hidden print:block mb-4">
          <div className="text-center">
            <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>{companyName}</h1>
            <h2 style={{ fontSize: 14, fontWeight: 600, margin: "4px 0 0" }}>Agent Ledger: {selectedAccount.name}</h2>
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

        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-blue-400/25 dark:bg-[#0a1a33] print:rounded-none print:border-0 print:shadow-none">
          <Table mobileLayout="cards">
            <TableHeader>
              <TableRow className="border-b border-slate-200 bg-slate-100/90 hover:bg-slate-100/90 dark:border-blue-400/20 dark:bg-[#142b4d] dark:hover:bg-[#142b4d]">
                <TableHead className="h-11 text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300 w-[120px]">
                  Date
                </TableHead>
                <TableHead className="h-11 text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300 w-[110px]">
                  Type
                </TableHead>
                <TableHead className="h-11 text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300">
                  Particulars
                </TableHead>
                <TableHead className="h-11 text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300 text-right w-[130px]">
                  Debit
                </TableHead>
                <TableHead className="h-11 text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300 text-right w-[130px]">
                  Credit
                </TableHead>
                <TableHead className="h-11 text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300 text-right w-[145px]">
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
                  <TableRow className="bg-slate-50/90 hover:bg-slate-50/90 dark:bg-[#10243e] dark:hover:bg-[#10243e]" data-testid="row-opening-balance">
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
                      <span className="text-xs font-normal text-muted-foreground">{openingSide}</span>
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
                          className={`border-slate-100 transition-colors hover:bg-blue-50/70 dark:border-blue-400/10 dark:hover:bg-blue-500/10 ${idx % 2 === 1 ? "bg-slate-50/60 dark:bg-[#0e203b]" : ""}`}
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
                            {note && (
                              <p
                                className={`text-xs text-muted-foreground ${phone ? "wrap-break-word" : "truncate max-w-xs"}`}
                              >
                                {note}
                              </p>
                            )}
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
                              {balanceSideLabel(bal, selectedAccount.type)}
                            </span>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}

                  {/* Closing Balance row */}
                  {vouchersWithBalance.length > 0 && (
                    <TableRow className="border-t-2 border-blue-200 bg-blue-50/75 hover:bg-blue-50/75 dark:border-blue-400/40 dark:bg-[#142b4d] dark:hover:bg-[#142b4d]" data-testid="row-closing-balance">
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
                      <TableCell className={`py-3 text-right font-mono text-sm font-bold ${drCrClass(closingSide)}`}>
                        {formatAmount(Math.abs(closingBalance))}{" "}
                        <span className={`text-xs font-normal ${drCrClass(closingSide)}`}>{closingSide}</span>
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
  );
}
