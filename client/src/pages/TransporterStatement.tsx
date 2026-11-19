import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { ErpMobileFilters } from "@/components/ui/erp-mobile-filters";
import { PeriodFilter } from "@/components/ui/period-filter";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingDown, TrendingUp, Minus, RefreshCw, MessageCircle } from "lucide-react";
import { cn } from "@/lib/utils";

import { fmtAmt, fmtNum, today } from "./transporterstatement/utils";
import { StatusBadge } from "./transporterstatement/components/StatusBadge";
import { DueDateCell } from "./transporterstatement/components/DueDateCell";
import { SettingsPopover } from "./transporterstatement/components/SettingsPopover";
import { useTransporterStatementModel } from "./TransporterStatementModel";
// ─── Types ───────────────────────────────────────────────────────────────────

export default function TransporterStatement({ embedded }: { embedded?: boolean }) {
  const m = useTransporterStatementModel();

  return (
    <>
      {/* ── Print stylesheet ─────────────────────────────────────────────── */}
      <style>{`
        @media print {
          body * { visibility: hidden; }
          #transporter-print-area,
          #transporter-print-area * { visibility: visible; }
          #transporter-print-area { position: absolute; inset: 0; padding: 24px; }

          .print\\:hidden { display: none !important; }

          #transporter-print-area .print-header {
            margin-bottom: 16px;
          }
          #transporter-print-area .print-header h1 {
            font-size: 22px;
            font-weight: 700;
            margin: 0 0 2px;
          }
          #transporter-print-area .print-header p {
            font-size: 13px;
            color: #555;
            margin: 0;
          }

          #transporter-print-area table {
            width: 100%;
            border-collapse: collapse;
            font-size: 11px;
          }
          #transporter-print-area thead tr {
            background: #0d7c66;
            color: white;
          }
          #transporter-print-area thead th {
            padding: 6px 8px;
            text-align: left;
            font-weight: 600;
          }
          #transporter-print-area thead th.text-right {
            text-align: right;
          }
          #transporter-print-area tbody tr:nth-child(even) {
            background: #f0faf8;
          }
          #transporter-print-area tbody td {
            padding: 5px 8px;
            border-bottom: 1px solid #e0e0e0;
          }
          #transporter-print-area tbody td.text-right {
            text-align: right;
          }
          #transporter-print-area .print-footer {
            margin-top: 16px;
            font-size: 10px;
            color: #888;
            text-align: right;
          }
          #transporter-print-area .summary-row td {
            background: #e6f7f3;
            font-weight: 600;
          }
        }
      `}</style>

      <div id="transporter-print-area" className={cn("flex flex-col h-full overflow-hidden", embedded ? "" : "p-4")}>
        {/* ── Print header (only visible when printing) ─── */}
        <div className="print-header hidden print:block">
          <h1>{m.selectedTransporter?.name ?? "Transporter"}</h1>
          <p>Statement of Accounts &nbsp;·&nbsp; Printed on {new Date().toLocaleDateString()}</p>
        </div>

        {/* ── Toolbar (hidden when printing) ──────────── */}
        <div className="flex flex-wrap items-end gap-3 mb-4 shrink-0 print:hidden">
          <ErpMobileFilters
            label="Transporter statement filters"
            primary={m.transporterControl}
            activeCount={m.customPeriodCount}
            onClear={m.resetPeriod}
            className="w-full"
            data-testid="transporter-statement-filters"
          >
            {(layout) => (
              <>
                {layout === "inline" && m.transporterControl}
                <div className="flex w-full flex-col gap-1 sm:w-auto">
                  <Label className="text-xs text-muted-foreground">Period</Label>
                  <PeriodFilter
                    value={{
                      fromDate: m.dateFrom,
                      toDate: m.dateTo,
                      preset: m.dateFrom || m.dateTo ? "custom" : "all_time",
                    }}
                    onChange={(v) => {
                      m.setDateFrom(v.fromDate);
                      m.setDateTo(v.toDate);
                    }}
                    data-testid="transporter-statement-period"
                  />
                </div>
              </>
            )}
          </ErpMobileFilters>

          <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
            {m.selectedAccountId && (
              <>
                {!m.isViewer && (
                  <Button
                    variant="outline"
                    onClick={() => m.reallocateMutation.mutate()}
                    disabled={m.reallocateMutation.isPending}
                    data-testid="btn-reallocate"
                  >
                    <RefreshCw className={cn("h-4 w-4 mr-2", m.reallocateMutation.isPending && "animate-spin")} />
                    {m.reallocateMutation.isPending ? "Running…" : "Reallocate"}
                  </Button>
                )}
                {!m.isViewer && (
                  <Button
                    variant="outline"
                    onClick={m.handleSendWhatsApp}
                    disabled={m.waSending || !m.statement}
                    data-testid="btn-send-whatsapp"
                  >
                    <MessageCircle className={cn("h-4 w-4 mr-2", m.waSending && "animate-pulse")} />
                    {m.waSending ? "Sending…" : "Send WhatsApp"}
                  </Button>
                )}
                <ExportButton
                  label="Export Image"
                  busy={m.pdfExporting}
                  onClick={m.handleExportPDF}
                  disabled={!m.statement}
                  data-testid="btn-print"
                />
              </>
            )}
            {m.selectedAccountId && m.statement && !m.isTester && !m.isViewer && (
              <SettingsPopover
                accountId={parseInt(m.selectedAccountId)}
                paymentTermsDays={m.statement.paymentTermsDays}
                onSaved={m.handleSettingsSaved}
              />
            )}
          </div>
        </div>

        {/* ── Summary strip ────────────────────────────── */}
        {m.selectedAccountId && m.statement && m.stats && (
          <div className="flex flex-wrap gap-3 mb-4 shrink-0 print:hidden">
            <div className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm">
              <TrendingDown className="h-4 w-4 text-destructive" />
              <span className="text-muted-foreground">Total Paid:</span>
              <span className="font-medium tabular-nums">{fmtNum(String(m.stats.totalDebit))}</span>
            </div>
            <div className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm">
              <TrendingUp className="h-4 w-4 text-green-600" />
              <span className="text-muted-foreground">Total Charged:</span>
              <span className="font-medium tabular-nums">{fmtNum(String(m.stats.totalCredit))}</span>
            </div>
            <div className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm">
              <Minus className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">Outstanding:</span>
              <span
                className={cn(
                  "font-medium tabular-nums",
                  m.closingBal > 0 ? "text-amber-600 dark:text-amber-400" : m.closingBal < 0 ? "text-green-600" : ""
                )}
              >
                {fmtNum(m.statement.closingBalance)}
                {m.closingBal > 0 && <span className="ml-1 text-xs">Cr</span>}
                {m.closingBal < 0 && <span className="ml-1 text-xs">Dr</span>}
              </span>
            </div>
            {m.stats.overdueCount > 0 && (
              <div className="flex items-center gap-2 rounded-md border bg-destructive/10 px-3 py-2 text-sm">
                <span className="text-destructive font-medium">{m.stats.overdueCount} overdue</span>
              </div>
            )}
          </div>
        )}

        {/* ── Table ────────────────────────────────────── */}
        <div className="flex-1 overflow-auto rounded-md border bg-card">
          {!m.selectedAccountId ? (
            <div className="flex flex-col items-center justify-center h-48 gap-2 text-muted-foreground print:hidden">
              <p className="text-sm">Select a transporter account to view the statement</p>
            </div>
          ) : m.loadingStatement ? (
            <div className="p-4 space-y-2 print:hidden">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : m.statementError ? (
            <div className="flex flex-col items-center justify-center h-48 gap-2 text-destructive print:hidden">
              <p className="text-sm font-medium">Failed to load statement</p>
              <p className="text-xs text-muted-foreground">{m.statementErrorObj?.message ?? "Unknown error"}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[90px]">Date</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="w-[110px]">Number Plate</TableHead>
                  <TableHead className="w-[110px] text-right">Debit</TableHead>
                  <TableHead className="w-[110px] text-right">Credit</TableHead>
                  <TableHead className="w-[120px] text-right">Balance</TableHead>
                  <TableHead className="w-[150px]">Date to be Paid</TableHead>
                  <TableHead className="w-[110px]">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* Opening balance row */}
                {m.statement && (
                  <TableRow className="bg-muted/30 text-xs text-muted-foreground italic">
                    <TableCell></TableCell>
                    <TableCell>Opening Balance</TableCell>
                    <TableCell></TableCell>
                    <TableCell></TableCell>
                    <TableCell></TableCell>
                    <TableCell className="text-right tabular-nums font-medium text-foreground not-italic">
                      {fmtNum(m.statement.openingBalance)}
                    </TableCell>
                    <TableCell></TableCell>
                    <TableCell></TableCell>
                  </TableRow>
                )}

                {(m.statement?.rows?.length ?? 0) === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground py-10 text-sm">
                      No entries for the selected period
                    </TableCell>
                  </TableRow>
                ) : (
                  m.statement?.rows?.map((row) => {
                    const bal = parseFloat(row.runningBalance);
                    const isOverdue =
                      row.dateToBePaid && row.dateToBePaid < today() && row.status && row.status !== "paid";
                    const isPaid = row.status === "paid";
                    return (
                      <TableRow
                        key={row.id}
                        className={cn(isOverdue ? "bg-destructive/5" : "", isPaid ? "opacity-50" : "")}
                        data-testid={`row-statement-${row.id}`}
                      >
                        <TableCell className="text-sm tabular-nums whitespace-nowrap">
                          {m.formatDate(row.date)}
                        </TableCell>
                        <TableCell className="text-sm max-w-[260px]">
                          <div className="truncate" title={row.description}>
                            {row.description || row.narration || row.voucherNumber}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">
                          {row.numberPlate ? (
                            <Badge variant="outline" className="font-mono text-xs">
                              {row.numberPlate}
                            </Badge>
                          ) : row.containerNumber ? (
                            <span className="text-xs text-muted-foreground">{row.containerNumber}</span>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-sm text-destructive">
                          {fmtAmt(row.debit)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-sm text-green-700 dark:text-green-400">
                          {fmtAmt(row.credit)}
                        </TableCell>
                        <TableCell
                          className={cn(
                            "text-right tabular-nums text-sm font-medium",
                            bal > 0
                              ? "text-amber-700 dark:text-amber-400"
                              : bal < 0
                                ? "text-green-700 dark:text-green-400"
                                : "text-muted-foreground"
                          )}
                        >
                          {fmtNum(row.runningBalance)}
                        </TableCell>
                        <TableCell>
                          {m.isViewer ? (
                            <span className="text-sm">{row.dateToBePaid ? m.formatDate(row.dateToBePaid) : "—"}</span>
                          ) : (
                            <DueDateCell row={row} onSave={m.handleDueDateSave} />
                          )}
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={row.status} paidAmount={row.paidAmount} total={row.credit} />
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}

                {/* Closing balance row */}
                {m.statement?.rows && m.statement.rows.length > 0 && (
                  <TableRow className="bg-muted/30 font-semibold text-xs summary-row">
                    <TableCell></TableCell>
                    <TableCell className="text-muted-foreground italic">Closing Balance</TableCell>
                    <TableCell></TableCell>
                    <TableCell className="text-right tabular-nums text-destructive">
                      {fmtNum(String(m.stats?.totalDebit ?? 0))}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-green-700 dark:text-green-400">
                      {fmtNum(String(m.stats?.totalCredit ?? 0))}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "text-right tabular-nums",
                        m.closingBal > 0
                          ? "text-amber-700 dark:text-amber-400"
                          : m.closingBal < 0
                            ? "text-green-700 dark:text-green-400"
                            : ""
                      )}
                    >
                      {fmtNum(m.statement.closingBalance)}
                      {m.closingBal !== 0 && (
                        <span className="ml-1 font-normal text-xs text-muted-foreground">
                          {m.closingBal > 0 ? "Cr" : "Dr"}
                        </span>
                      )}
                    </TableCell>
                    <TableCell></TableCell>
                    <TableCell></TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </div>

        {/* Print footer */}
        <div className="print-footer hidden print:block">
          Printed on {new Date().toLocaleString()} &nbsp;·&nbsp; {m.selectedTransporter?.name}
        </div>

        {m.isFetching && !m.loadingStatement && (
          <p className="text-xs text-muted-foreground mt-1 shrink-0 print:hidden">Refreshing…</p>
        )}
      </div>
    </>
  );
}
