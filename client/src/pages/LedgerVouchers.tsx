import { PageHeader } from "@/components/PageHeader";
import { RowsExportMenu } from "@/components/export/RowsExportMenu";
import { ErpListTable } from "@/erp-core";
import { FileText } from "lucide-react";
import { PeriodFilter } from "@/components/ui/period-filter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/page-state";
import { Badge } from "@/components/ui/badge";
import { isInternalHistoricalSupplierRoutineRow } from "@shared/internalHistoricalSupplierRoutineRow";
import { voucherTypeColors } from "./LedgerVouchersHelpers";
import { useLedgerVouchersState } from "./useLedgerVouchersState";

export default function LedgerVouchers() {
  const {
    navigate,
    formatAmount,
    formatShortDate,
    accountId,
    year,
    month,
    periodFilter,
    setPeriodFilter,
    data,
    isLoading,
    isError,
    refetch,
    handleVoucherClick,
  } = useLedgerVouchersState();

  if (!accountId || !year || !month) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Invalid parameters</p>
      </div>
    );
  }

  // Export rows: the opening line, then the visible vouchers with the same running balance.
  type ExportLine = { date: string; type: string; particulars: string; debit: number; credit: number; balance: number };
  let exportBalance = data?.openingBalance ?? 0;
  const exportLines: ExportLine[] = data
    ? [
        { date: "", type: "", particulars: "Opening Balance", debit: 0, credit: 0, balance: data.openingBalance },
        ...(Array.isArray(data.vouchers) ? data.vouchers : [])
          .map((v) => {
            exportBalance = exportBalance + v.credit - v.debit;
            return { ...v, runningBalance: exportBalance };
          })
          .filter((v) => !isInternalHistoricalSupplierRoutineRow({ ...v, voucherDate: v.date }))
          .map((v) => ({
            date: formatShortDate(v.date),
            type: v.voucherType,
            particulars: v.particulars,
            debit: v.debit,
            credit: v.credit,
            balance: v.runningBalance,
          })),
      ]
    : [];

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="sm:px-4 sm:pt-4">
        <PageHeader
          title={data?.account?.name || "Loading..."}
          onBack={() => navigate(`/ledger-monthly/${accountId}`)}
          meta={<span>Ledger Vouchers</span>}
        >
          <PeriodFilter value={periodFilter} onChange={setPeriodFilter} data-testid="ledger-vouchers-period-filter" />
          <RowsExportMenu
            title={`${data?.account?.name ?? "Ledger"} Vouchers`}
            sheetName="Ledger Vouchers"
            rows={exportLines}
            columns={[
              { header: "Date", value: (line) => line.date },
              { header: "Type", value: (line) => line.type },
              { header: "Particulars", value: (line) => line.particulars },
              { header: "Debit", value: (line) => (line.debit > 0 ? line.debit : null), type: "number" },
              { header: "Credit", value: (line) => (line.credit > 0 ? line.credit : null), type: "number" },
              {
                header: "Balance",
                value: (line) => (line.balance === 0 ? null : Math.abs(line.balance)),
                type: "number",
              },
              { header: "Dr/Cr", value: (line) => (line.balance === 0 ? "" : line.balance >= 0 ? "Cr" : "Dr") },
            ]}
            footer={
              data
                ? [
                    "Current Balance",
                    null,
                    null,
                    data.totals.debit > 0 ? data.totals.debit : null,
                    data.totals.credit > 0 ? data.totals.credit : null,
                    data.closingBalance === 0 ? null : Math.abs(data.closingBalance),
                    data.closingBalance === 0 ? "" : data.closingBalance >= 0 ? "Cr" : "Dr",
                  ]
                : undefined
            }
            period={{ from: periodFilter.fromDate, to: periodFilter.toDate }}
            resource="erp.accounts"
          />
        </PageHeader>
      </div>

      <div className="space-y-6 sm:p-4">
        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-[400px] w-full" />
          </div>
        ) : isError && !data ? (
          <ErrorState onAction={() => void refetch()} actionLabel="Try again" />
        ) : data ? (
          <>
            {/* Vouchers Table */}
            <Card>
              <CardHeader className="pb-0">
                <div className="flex justify-between items-start">
                  <div>
                    <CardTitle className="text-lg flex items-center gap-2">
                      <FileText className="h-5 w-5" />
                      Ledger: {data.account.name}
                    </CardTitle>
                    <p className="text-sm text-muted-foreground">
                      1/{data.monthName.substring(0, 3)}/{data.year} to {new Date(data.year, data.month, 0).getDate()}/
                      {data.monthName.substring(0, 3)}/{data.year}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-muted-foreground">
                      {Array.isArray(data.vouchers)
                        ? data.vouchers.filter(
                            (v) => !isInternalHistoricalSupplierRoutineRow({ ...v, voucherDate: v.date })
                          ).length
                        : 0}{" "}
                      voucher(s)
                    </p>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-4">
                {(() => {
                  let runningBal = data.openingBalance;
                  // Preserve every posted line when calculating the running
                  // balance, then omit just the known internal catchup rows.
                  const vouchersWithBal = (Array.isArray(data.vouchers) ? data.vouchers : [])
                    .map((v) => {
                      runningBal = runningBal + v.credit - v.debit;
                      return { ...v, runningBalance: runningBal };
                    })
                    .filter((v) => !isInternalHistoricalSupplierRoutineRow({ ...v, voucherDate: v.date }));
                  const formatBal = (bal: number) =>
                    bal === 0 ? "—" : `${formatAmount(Math.abs(bal))} ${bal >= 0 ? "Cr" : "Dr"}`;
                  return (
                    <div className="border rounded-lg overflow-x-auto max-sm:border-0">
                      <ErpListTable pageKey="ledger-vouchers" mobileLayout="cards" scrollLabel="Ledger vouchers">
                        <TableHeader className="sticky top-0 z-30 bg-background">
                          <TableRow className="bg-muted/50">
                            <TableHead className="w-28">Date</TableHead>
                            <TableHead className="w-28">Type</TableHead>
                            <TableHead className="hidden sm:table-cell">Particulars</TableHead>
                            <TableHead className="text-right w-32">Debit</TableHead>
                            <TableHead className="text-right w-32">Credit</TableHead>
                            <TableHead className="text-right w-36">Balance</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {/* Opening Balance Row */}
                          <TableRow className="bg-muted/20 font-semibold">
                            <TableCell className="text-sm text-muted-foreground" colSpan={3}>
                              Opening Balance
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm text-muted-foreground">—</TableCell>
                            <TableCell className="text-right font-mono text-sm text-muted-foreground">—</TableCell>
                            <TableCell className="text-right font-mono text-sm">
                              {formatBal(data.openingBalance)}
                            </TableCell>
                          </TableRow>
                          {vouchersWithBal.length === 0 ? (
                            <TableRow>
                              <TableCell colSpan={6} className="text-center py-8">
                                <p className="text-muted-foreground">No vouchers found for this period</p>
                              </TableCell>
                            </TableRow>
                          ) : (
                            vouchersWithBal.map((voucher) => (
                              <TableRow
                                key={voucher.id}
                                className="cursor-pointer hover-elevate"
                                onClick={() => handleVoucherClick(voucher.voucherId)}
                                data-testid={`row-voucher-${voucher.voucherId}`}
                              >
                                <TableCell className="font-mono text-sm whitespace-nowrap">
                                  {formatShortDate(voucher.date)}
                                </TableCell>
                                <TableCell>
                                  <Badge
                                    variant="secondary"
                                    className={`text-xs ${voucherTypeColors[voucher.voucherType] || ""}`}
                                  >
                                    {voucher.voucherType}
                                  </Badge>
                                </TableCell>
                                <TableCell className="text-sm hidden sm:table-cell">{voucher.particulars}</TableCell>
                                <TableCell className="text-right font-mono text-sm">
                                  {voucher.debit > 0 ? (
                                    formatAmount(voucher.debit)
                                  ) : (
                                    <span className="text-muted-foreground">—</span>
                                  )}
                                </TableCell>
                                <TableCell className="text-right font-mono text-sm">
                                  {voucher.credit > 0 ? (
                                    formatAmount(voucher.credit)
                                  ) : (
                                    <span className="text-muted-foreground">—</span>
                                  )}
                                </TableCell>
                                <TableCell className="text-right font-mono text-sm">
                                  {formatBal(voucher.runningBalance)}
                                </TableCell>
                              </TableRow>
                            ))
                          )}
                        </TableBody>
                        <tfoot className="sticky bottom-0 z-20 bg-background">
                          <TableRow className="border-t bg-muted/20 text-sm">
                            <TableCell colSpan={3} className="text-right text-muted-foreground font-medium">
                              Opening Balance:
                            </TableCell>
                            <TableCell className="text-right font-mono text-muted-foreground">—</TableCell>
                            <TableCell className="text-right font-mono text-muted-foreground">—</TableCell>
                            <TableCell className="text-right font-mono">{formatBal(data.openingBalance)}</TableCell>
                          </TableRow>
                          <TableRow className="bg-muted/10 text-sm">
                            <TableCell colSpan={3} className="text-right text-muted-foreground font-medium">
                              Current Total:
                            </TableCell>
                            <TableCell className="text-right font-mono font-semibold">
                              {data.totals.debit > 0 ? formatAmount(data.totals.debit) : "—"}
                            </TableCell>
                            <TableCell className="text-right font-mono font-semibold">
                              {data.totals.credit > 0 ? formatAmount(data.totals.credit) : "—"}
                            </TableCell>
                            <TableCell className="text-right font-mono text-muted-foreground">—</TableCell>
                          </TableRow>
                          <TableRow className="bg-muted/30 font-bold text-sm">
                            <TableCell colSpan={3} className="text-right text-muted-foreground font-semibold">
                              Current Balance:
                            </TableCell>
                            <TableCell className="text-right font-mono text-muted-foreground">—</TableCell>
                            <TableCell className="text-right font-mono text-muted-foreground">—</TableCell>
                            <TableCell
                              className={`text-right font-mono ${data.closingBalance >= 0 ? "" : "text-destructive"}`}
                            >
                              {formatBal(data.closingBalance)}
                            </TableCell>
                          </TableRow>
                        </tfoot>
                      </ErpListTable>
                    </div>
                  );
                })()}
              </CardContent>
            </Card>
          </>
        ) : (
          <Card>
            <CardContent className="p-8 text-center">
              <p className="text-muted-foreground">No data available</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
