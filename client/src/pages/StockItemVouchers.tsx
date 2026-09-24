import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { PeriodFilter, PeriodFilterValue, getDefaultPeriodValue } from "@/components/ui/period-filter";
import { useDateJump } from "@/hooks/use-date-jump";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";

interface Transaction {
  date: string;
  particulars: string;
  vchType: string;
  voucherId: number;
  poId?: number;
  inwardQty: number;
  inwardRate: number;
  inwardValue: number;
  outwardQty: number;
  outwardRate: number;
  outwardValue: number;
  closingQty: number;
  closingRate: number;
  closingValue: number;
  isOpeningBalance?: boolean;
  isPOS?: boolean;
  posSellingRate?: number;
  posSellingValue?: number;
}

interface VouchersData {
  stockItem: {
    id: number;
    code: string;
    name: string;
    uom: string;
  };
  year: number;
  month: number;
  monthName: string;
  transactions: Transaction[];
  totals: {
    inwardQty: number;
    inwardRate: number;
    inwardValue: number;
    outwardQty: number;
    outwardRate: number;
    outwardValue: number;
    closingQty: number;
    closingRate: number;
    closingValue: number;
  };
}

export default function StockItemVouchers() {
  const { formatDisplayDate } = useDateFormat();
  const { formatAmount } = useCurrencyContext();
  const params = useParams();
  const stockItemId = parseInt(params.id || "0");
  const year = parseInt(params.year || "0");
  const month = parseInt(params.month || "0");
  const [_location, navigate] = useLocation();
  useEscapeToParent();

  const [periodFilter, setPeriodFilter] = useState<PeriodFilterValue>(() => getDefaultPeriodValue("this_month"));
  useDateJump((date) => setPeriodFilter({ fromDate: date, toDate: date, preset: "custom" }));

  const { data, isLoading } = useQuery<VouchersData>({
    queryKey: [
      `/api/stock-items/${stockItemId}/vouchers/${year}/${month}`,
      { startDate: periodFilter.fromDate, endDate: periodFilter.toDate },
    ],
    queryFn: async () => {
      const params = new URLSearchParams({
        startDate: periodFilter.fromDate,
        endDate: periodFilter.toDate,
      });
      const res = await fetch(`/api/stock-items/${stockItemId}/vouchers/${year}/${month}?${params}`);
      if (!res.ok) throw new Error("Failed to fetch vouchers");
      return res.json();
    },
    enabled: stockItemId > 0 && year > 0 && month > 0,
  });

  const formatNumber = (num: number, decimals = 2) => {
    if (num === 0) return "";
    return num.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  };

  const formatDate = (dateStr: string) => {
    try {
      return formatDisplayDate(new Date(dateStr));
    } catch {
      return dateStr;
    }
  };

  const getTransactionEditUrl = (txn: Transaction): string | null => {
    if (txn.isOpeningBalance) return null;

    const vchType = txn.vchType.toLowerCase();

    if (vchType === "purchase import") {
      return txn.poId ? `/purchase-orders/${txn.poId}/edit` : null;
    }

    if (vchType === "production" || vchType === "consumption") {
      return txn.voucherId ? `/vouchers/${txn.voucherId}/edit` : null;
    }

    if (vchType.startsWith("pos") || vchType.includes("pos")) {
      return txn.voucherId ? `/pos/edit/${txn.voucherId}` : null;
    }

    if (vchType.startsWith("stock transfer")) {
      return txn.voucherId ? `/vouchers/${txn.voucherId}/edit` : null;
    }

    if (vchType === "sales") {
      return txn.voucherId ? `/vouchers/${txn.voucherId}/edit` : null;
    }

    return null;
  };

  const handleParticularsClick = (txn: Transaction) => {
    const url = getTransactionEditUrl(txn);
    if (url) {
      navigate(url);
    }
  };

  if (isLoading) {
    return (
      <div className="container mx-auto space-y-6 p-0 sm:p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-[400px] w-full" />
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
      </PageHeader>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-lg">
            Transactions for {data?.monthName} {data?.year}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="hidden md:block overflow-x-auto">
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

          <div className="md:hidden space-y-2">
            {data?.transactions.length === 0 && (
              <p className="text-center text-muted-foreground py-8">No transactions found for this month</p>
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
