import { StatementResponse, type StatementDisplayRow } from "./factorySupplierTypes";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowRightLeft, Pencil, Trash2, Package } from "lucide-react";

interface SupplierStatementRowsProps {
  statementData: StatementResponse;
  primaryCc: string;
  sfTotalPurchases: number;
  sfTotalPayments: number;
  sfPurchasesQty: number;
  sfTxCount: number;
  currencyTotals: Record<string, number>;
  statDateFilter: "all" | "today" | "yesterday" | "this_month" | "this_year";
  setStatDateFilter: (val: "all" | "today" | "yesterday" | "this_month" | "this_year") => void;
  displayedRows: StatementDisplayRow[];
  balanceByKey: Record<string, { bal: number; cc: string }>;
  formatDate: (val: string) => string;
  formatNum: (val: string) => string;
  typeBadge: (type: string) => React.ReactNode;
  statusColor: (
    status: string
  ) => "default" | "destructive" | "outline" | "secondary" | "success" | "warning" | "info" | "muted";
  statusDisplayLabel: (status: string) => string;
  onEditPayment: (p: Record<string, unknown>) => void;
  onDeletePayment: (id: number) => void;
}

export function SupplierStatementRows({
  statementData: _statementData,
  primaryCc,
  sfTotalPurchases,
  sfTotalPayments,
  sfPurchasesQty,
  sfTxCount,
  currencyTotals,
  statDateFilter,
  setStatDateFilter,
  displayedRows,
  balanceByKey,
  formatDate,
  formatNum,
  typeBadge,
  statusColor,
  statusDisplayLabel,
  onEditPayment: _onEditPayment,
  onDeletePayment: _onDeletePayment,
}: SupplierStatementRowsProps) {
  if (displayedRows.length === 0)
    return (
      <div className="text-center py-8 text-muted-foreground">
        <Package className="h-12 w-12 mx-auto mb-3 opacity-50" />
        <p className="text-lg font-medium">No activity yet</p>
      </div>
    );

  const fmtCcAmt = (cc: string, amt: number) =>
    cc !== "USD"
      ? `${cc} ${formatNum(String(Math.abs(amt).toFixed(2)))}`
      : `$${formatNum(String(Math.abs(amt).toFixed(2)))}`;

  const finalBalanceStr =
    Object.entries(currencyTotals)
      .filter(([, v]) => Math.abs(v) > 0.005)
      .map(([cc, v]) => fmtCcAmt(cc, v) + (v > 0 ? " CR" : " DR"))
      .join(" / ") || "—";

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <div className="rounded-lg border bg-muted/30 px-3 py-2">
          <p className="text-xs text-muted-foreground mb-1">Total Purchases</p>
          <p className="font-mono font-semibold text-sm">{fmtCcAmt(primaryCc, sfTotalPurchases)}</p>
        </div>
        <div className="rounded-lg border bg-muted/30 px-3 py-2">
          <p className="text-xs text-muted-foreground mb-1">Total Payments</p>
          <p className="font-mono font-semibold text-sm text-green-600 dark:text-green-400">
            {fmtCcAmt(primaryCc, sfTotalPayments)}
          </p>
        </div>
        <div className="rounded-lg border bg-muted/30 px-3 py-2">
          <p className="text-xs text-muted-foreground mb-1">Purchases Qty</p>
          <p className="font-semibold text-sm">{sfPurchasesQty}</p>
        </div>
        <div className="rounded-lg border bg-muted/30 px-3 py-2">
          <p className="text-xs text-muted-foreground mb-1">Transactions</p>
          <p className="font-semibold text-sm">{sfTxCount}</p>
        </div>
        <div className="rounded-lg border bg-muted/30 px-3 py-2">
          <p className="text-xs text-muted-foreground mb-1">Balance</p>
          <p className="font-mono font-semibold text-sm tabular-nums">{finalBalanceStr}</p>
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {(["all", "today", "yesterday", "this_month", "this_year"] as const).map((f) => (
          <Button
            key={f}
            variant={statDateFilter === f ? "default" : "outline"}
            size="sm"
            className="text-xs"
            onClick={() => setStatDateFilter(f)}
            data-testid={`button-stat-date-filter-${f}`}
          >
            {f === "all"
              ? "All"
              : f === "today"
                ? "Today"
                : f === "yesterday"
                  ? "Yesterday"
                  : f === "this_month"
                    ? "This Month"
                    : "This Year"}
          </Button>
        ))}
        {statDateFilter !== "all" && (
          <span className="ml-1 text-xs text-muted-foreground">
            {sfTxCount} result{sfTxCount !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      <div className="table-responsive">
        <Table>
          <TableHeader className="sticky top-0 z-30">
            <TableRow className="bg-muted border-b-2 border-border/60 hover:bg-muted">
              <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                Date
              </TableHead>
              <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                Type
              </TableHead>
              <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                Reference
              </TableHead>
              <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                Amount
              </TableHead>
              <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                Balance
              </TableHead>
              <TableHead className="w-8 py-2" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {displayedRows.map((row) => {
              const balEntry = balanceByKey[row.key];
              const balCc = balEntry?.cc ?? row.rowCc;
              const bal = balEntry?.bal ?? 0;
              return (
                <TableRow key={row.key}>
                  <TableCell className="whitespace-nowrap text-sm">{formatDate(row.date || "")}</TableCell>
                  <TableCell>{typeBadge(row.type)}</TableCell>
                  <TableCell className="text-sm font-medium">
                    <div className="flex flex-col gap-0.5">
                      <div className="flex items-center gap-1 flex-wrap">
                        <span>{row.ref}</span>
                        {row.status && (
                          <Badge variant={statusColor(row.status)} className="text-xs ml-1">
                            {statusDisplayLabel(row.status)}
                          </Badge>
                        )}
                      </div>
                      {row.detail && <span className="text-xs text-muted-foreground font-normal">{row.detail}</span>}
                    </div>
                  </TableCell>
                  <TableCell
                    className={`text-right text-sm tabular-nums font-medium ${row.optional ? "text-muted-foreground line-through" : row.type === "payment" ? "text-green-600 dark:text-green-400" : row.type === "purchase" || row.type === "freight" || row.type === "commission" ? "text-red-600 dark:text-red-400" : row.amountIsNeg ? "text-destructive" : ""}`}
                  >
                    {row.type !== "payment" &&
                    row.type !== "purchase" &&
                    row.type !== "freight" &&
                    row.type !== "commission" &&
                    row.amountIsNeg
                      ? "−"
                      : ""}
                    {row.amount}
                    {!row.optional &&
                      (row.type === "purchase" || row.type === "freight" || row.type === "commission") && (
                        <span className="ml-1 text-xs font-normal opacity-70">CR</span>
                      )}
                    {!row.optional && row.type === "payment" && (
                      <span className="ml-1 text-xs font-normal opacity-70">DR</span>
                    )}
                    {row.optional && <span className="ml-1 text-xs font-normal opacity-70">(Optional)</span>}
                  </TableCell>
                  <TableCell
                    className={`text-right text-sm tabular-nums font-medium ${bal > 0 ? "text-red-600 dark:text-red-400" : bal < 0 ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}`}
                  >
                    {fmtCcAmt(balCc, bal)}
                    {bal > 0 ? " CR" : bal < 0 ? " DR" : ""}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      {row.onMove && (
                        <Button variant="ghost" size="icon" title="Move to another supplier" onClick={row.onMove}>
                          <ArrowRightLeft className="h-3.5 w-3.5 text-blue-500" />
                        </Button>
                      )}
                      {row.onEdit && (
                        <Button variant="ghost" size="icon" onClick={row.onEdit}>
                          <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                        </Button>
                      )}
                      {row.onDelete && (
                        <Button variant="ghost" size="icon" onClick={row.onDelete}>
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {Object.entries(currencyTotals)
              .filter(([, v]) => v !== 0)
              .map(([cc, total]) => (
                <TableRow key={`total-${cc}`} className="border-t-2 bg-muted/30">
                  <TableCell colSpan={3} className="text-sm font-semibold text-muted-foreground">
                    {cc} Net Balance
                  </TableCell>
                  <TableCell />
                  <TableCell
                    className={`text-right text-sm tabular-nums font-bold ${total > 0 ? "text-red-600 dark:text-red-400" : total < 0 ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}`}
                  >
                    {fmtCcAmt(cc, total)}
                    {total > 0 ? " CR" : total < 0 ? " DR" : ""}
                  </TableCell>
                  <TableCell />
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </div>
      {Object.entries(currencyTotals).some(([, v]) => v < -0.005) && (
        <div className="mt-3 rounded-md border border-amber-400 dark:border-amber-500 bg-amber-50 dark:bg-amber-950/40 px-4 py-3 flex flex-col gap-1">
          <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">Overpayment detected</p>
          {Object.entries(currencyTotals)
            .filter(([, v]) => v < -0.005)
            .map(([cc, total]) => (
              <p key={cc} className="text-sm text-amber-700 dark:text-amber-300 tabular-nums">
                {fmtCcAmt(cc, Math.abs(total))} {cc} overpaid (excess credit on account)
              </p>
            ))}
        </div>
      )}
    </div>
  );
}
