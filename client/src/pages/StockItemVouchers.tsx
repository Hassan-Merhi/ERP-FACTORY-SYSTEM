import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { RowsExportMenu } from "@/components/export/RowsExportMenu";
import { stockVoucherExportColumns, stockVoucherExportFooter } from "@/pages/stock-ledger/stockVoucherExportColumns";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/page-state";
import { PeriodFilter } from "@/components/ui/period-filter";
import { useStockItemVouchersState } from "./useStockItemVouchersState";

export default function StockItemVouchers() {
  const {
    formatAmount,
    stockItemId,
    navigate,
    periodFilter,
    setPeriodFilter,
    isLoading,
    isError,
    data,
    refetch,
    formatNumber,
    formatDate,
    getTransactionEditUrl,
    handleParticularsClick,
  } = useStockItemVouchersState();

  if (isLoading) {
    return (
      <div className="container mx-auto space-y-6 p-0 sm:p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  if (isError && !data) {
    return (
      <div className="container mx-auto p-0 sm:p-6">
        <ErrorState onAction={() => void refetch()} actionLabel="Try again" />
      </div>
    );
  }

  return (
    <div className="container mx-auto space-y-4 p-0 sm:space-y-6 sm:p-6">
      <PageHeader
        title="Stock Item Vouchers"
        onBack={() => navigate(`/stock-items/${stockItemId}/history`)}
        meta={
          data?.stockItem && (
            <span data-testid="text-item-name">
              {data.stockItem.name} ({data.stockItem.code}) - {data.monthName} {data.year}
            </span>
          )
        }
      >
        <PeriodFilter value={periodFilter} onChange={setPeriodFilter} data-testid="period-filter" />
        <RowsExportMenu
          title={`${data?.stockItem.name ?? "Stock Item"} Vouchers`}
          sheetName="Stock Item Vouchers"
          rows={data?.transactions ?? []}
          columns={stockVoucherExportColumns(formatDate)}
          footer={data && data.transactions.length > 0 ? stockVoucherExportFooter(data.totals) : undefined}
          resource="erp.stock_items"
          period={{ from: periodFilter.fromDate, to: periodFilter.toDate }}
        />
      </PageHeader>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-lg">
            Transactions for {data?.monthName} {data?.year}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="hidden md:block phone-land:hidden overflow-x-auto">
            <Table className="text-sm">
              <TableHeader className="sticky top-0 z-30 bg-background">
                <TableRow>
                  <TableHead rowSpan={2} className="align-bottom border-r w-[80px]">
                    Date
                  </TableHead>
                  <TableHead rowSpan={2} className="align-bottom border-r">
                    Particulars
                  </TableHead>
                  <TableHead rowSpan={2} className="align-bottom border-r">
                    Vch Type
                  </TableHead>
                  <TableHead colSpan={3} className="text-center border-r">
                    Inwards
                  </TableHead>
                  <TableHead colSpan={3} className="text-center border-r">
                    Outwards
                  </TableHead>
                  <TableHead colSpan={3} className="text-center">
                    Closing
                  </TableHead>
                </TableRow>
                <TableRow>
                  <TableHead className="text-right w-[60px]">Qty</TableHead>
                  <TableHead className="text-right w-[60px]">Rate</TableHead>
                  <TableHead className="text-right border-r w-[80px]">Value</TableHead>
                  <TableHead className="text-right w-[60px]">Qty</TableHead>
                  <TableHead className="text-right w-[60px]">Rate</TableHead>
                  <TableHead className="text-right border-r w-[80px]">Value</TableHead>
                  <TableHead className="text-right w-[60px]">Qty</TableHead>
                  <TableHead className="text-right w-[60px]">Rate</TableHead>
                  <TableHead className="text-right w-[80px]">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.transactions.map((txn, idx) => (
                  <TableRow
                    key={idx}
                    data-testid={`row-txn-${idx}`}
                    className={txn.isOpeningBalance ? "bg-muted/30 font-medium" : ""}
                  >
                    <TableCell className="border-r tabular-nums">
                      {txn.isOpeningBalance ? "" : formatDate(txn.date)}
                    </TableCell>
                    <TableCell className={`border-r ${txn.isOpeningBalance ? "font-semibold" : ""}`}>
                      {getTransactionEditUrl(txn) ? (
                        <button
                          onClick={() => handleParticularsClick(txn)}
                          className="text-left text-primary hover:underline cursor-pointer"
                          data-testid={`link-particulars-${idx}`}
                        >
                          {txn.particulars}
                        </button>
                      ) : (
                        txn.particulars
                      )}
                    </TableCell>
                    <TableCell className="border-r text-xs">{txn.vchType}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(txn.inwardQty, 0)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatAmount(txn.inwardRate)}</TableCell>
                    <TableCell className="text-right tabular-nums border-r">{formatAmount(txn.inwardValue)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(txn.outwardQty, 0)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatAmount(txn.isPOS && txn.posSellingRate ? txn.posSellingRate : txn.outwardRate)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums border-r">
                      {formatAmount(txn.isPOS && txn.posSellingValue ? txn.posSellingValue : txn.outwardValue)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {formatNumber(txn.closingQty, 0)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatAmount(txn.closingRate)}</TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {formatAmount(txn.closingValue)}
                    </TableCell>
                  </TableRow>
                ))}

                {data?.transactions.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={12} className="text-center text-muted-foreground py-8">
                      No transactions found for this month
                    </TableCell>
                  </TableRow>
                )}

                {data && data.transactions.length > 0 && (
                  <TableRow className="bg-muted/50 font-bold">
                    <TableCell colSpan={3} className="border-r">
                      Totals
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(data.totals.inwardQty, 0)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatAmount(data.totals.inwardRate)}</TableCell>
                    <TableCell className="text-right tabular-nums border-r">
                      {formatAmount(data.totals.inwardValue)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(data.totals.outwardQty, 0)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatAmount(data.totals.outwardRate)}</TableCell>
                    <TableCell className="text-right tabular-nums border-r">
                      {formatAmount(data.totals.outwardValue)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(data.totals.closingQty, 0)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatAmount(data.totals.closingRate)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatAmount(data.totals.closingValue)}</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <div className="md:hidden phone-land:block space-y-2">
            {data?.transactions.length === 0 && (
              <EmptyState title="No transactions found for this month" className="py-8" />
            )}
            {data?.transactions.map((txn, idx) => (
              <div
                key={idx}
                className={`p-3 rounded-md border text-sm ${txn.isOpeningBalance ? "bg-muted/30" : ""}`}
                data-testid={`row-txn-${idx}`}
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex-1 min-w-0">
                    {getTransactionEditUrl(txn) ? (
                      <button
                        onClick={() => handleParticularsClick(txn)}
                        className="text-left text-primary hover:underline cursor-pointer font-medium truncate block w-full"
                        data-testid={`link-particulars-${idx}`}
                      >
                        {txn.particulars}
                      </button>
                    ) : (
                      <span className={`block truncate ${txn.isOpeningBalance ? "font-semibold" : "font-medium"}`}>
                        {txn.particulars}
                      </span>
                    )}
                    <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                      {!txn.isOpeningBalance && <span>{formatDate(txn.date)}</span>}
                      <span>{txn.vchType}</span>
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  {(txn.inwardQty > 0 || txn.isOpeningBalance) && (
                    <div>
                      <div className="text-muted-foreground">In</div>
                      <div className="font-mono">
                        {formatNumber(txn.inwardQty, 0)} @ {formatAmount(txn.inwardRate)}
                      </div>
                    </div>
                  )}
                  {txn.outwardQty > 0 && (
                    <div>
                      <div className="text-muted-foreground">Out</div>
                      <div className="font-mono">
                        {formatNumber(txn.outwardQty, 0)} @{" "}
                        {formatAmount(txn.isPOS && txn.posSellingRate ? txn.posSellingRate : txn.outwardRate)}
                      </div>
                    </div>
                  )}
                  <div>
                    <div className="text-muted-foreground">Closing</div>
                    <div className="font-mono font-medium">{formatNumber(txn.closingQty, 0)}</div>
                    <div className="font-mono text-muted-foreground">{formatAmount(txn.closingValue)}</div>
                  </div>
                </div>
              </div>
            ))}

            {data && data.transactions.length > 0 && (
              <div className="p-3 rounded-md border bg-muted/50 text-sm font-bold">
                <div className="mb-2">Totals</div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <div className="text-muted-foreground font-normal">Inward</div>
                    <div className="font-mono">{formatNumber(data.totals.inwardQty, 0)}</div>
                    <div className="font-mono text-muted-foreground font-normal">
                      {formatAmount(data.totals.inwardValue)}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground font-normal">Outward</div>
                    <div className="font-mono">{formatNumber(data.totals.outwardQty, 0)}</div>
                    <div className="font-mono text-muted-foreground font-normal">
                      {formatAmount(data.totals.outwardValue)}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground font-normal">Closing</div>
                    <div className="font-mono">{formatNumber(data.totals.closingQty, 0)}</div>
                    <div className="font-mono text-muted-foreground font-normal">
                      {formatAmount(data.totals.closingValue)}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
