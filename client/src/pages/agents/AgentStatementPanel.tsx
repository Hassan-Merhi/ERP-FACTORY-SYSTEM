/**
 * Agent statement panel (right side of the Agent Ledger page): header with
 * balance, period filter, stats grid, ledger table, and print output.
 *
 * Extracted from pages/Agents.tsx; markup, calculations, styling, and test
 * ids are unchanged.
 */
import { useMemo, useRef } from "react";
import { TrendingUp, TrendingDown, X, FileDown, Printer, ArrowRightLeft } from "lucide-react";
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
}

export function AgentStatementPanel({
  companyName,
  selectedAccount,
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
            onClick={onExportExcel}
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
            onClick={onClearAccount}
            data-testid="button-clear-account"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Period filter */}
      <PeriodFilter value={periodFilter} onChange={onPeriodChange} />

      {/* Stats grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-xl border bg-muted/30 p-4 space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Opening</p>
          <p className="text-base font-bold font-mono tabular-nums leading-tight">
            {formatAmount(Math.abs(openingBalance))}
          </p>
          <p className="text-xs text-muted-foreground">{openingSide}</p>
        </div>
        <div className="rounded-xl border bg-red-50/50 dark:bg-red-950/20 border-red-200/60 dark:border-red-800/40 p-4 space-y-1.5">
          <p className="text-xs font-medium text-red-600 dark:text-red-400 uppercase tracking-wide">Debit</p>
          <p className="text-base font-bold font-mono tabular-nums text-red-700 dark:text-red-300 leading-tight">
            {formatAmount(periodDebit)}
          </p>
          <p className="text-xs text-muted-foreground">this period</p>
        </div>
        <div className="rounded-xl border bg-emerald-50/50 dark:bg-emerald-950/20 border-emerald-200/60 dark:border-emerald-800/40 p-4 space-y-1.5">
          <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400 uppercase tracking-wide">Credit</p>
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
          <p className="text-xs text-muted-foreground">{closingSide}</p>
        </div>
      </div>

      {/* Ledger table */}
      <div ref={printRef} className="print-container">
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
                              {balanceSideLabel(bal, selectedAccount.type)}
                            </span>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}

                  {/* Closing Balance row */}
                  {vouchersWithBalance.length > 0 && (
                    <TableRow className="bg-muted/40 hover:bg-muted/40 border-t-2" data-testid="row-closing-balance">
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
                        <span className="text-xs font-normal text-muted-foreground">{closingSide}</span>
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
