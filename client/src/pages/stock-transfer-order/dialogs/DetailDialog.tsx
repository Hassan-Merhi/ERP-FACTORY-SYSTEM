import type { Dispatch, SetStateAction } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  Location,
  StockItemData,
  StockMovementDetailData,
  StockMovementTransaction,
} from "../../stocktransferorder/types";

type DetailDialogProps = {
  detailData: unknown;
  detailDirection: "in" | "out";
  detailLoading: boolean;
  detailMonthName: string;
  detailOpen: boolean;
  detailYear: number;
  formatAmount: (amount: number) => string;
  historyItem: StockItemData | null;
  historyLocation: Location | null;
  setDetailOpen: Dispatch<SetStateAction<boolean>>;
};

export function DetailDialog({
  detailData,
  detailDirection,
  detailLoading,
  detailMonthName,
  detailOpen,
  detailYear,
  formatAmount,
  historyItem,
  historyLocation,
  setDetailOpen,
}: DetailDialogProps) {
  const typedDetailData = detailData as StockMovementDetailData | undefined;
  const rows =
    detailDirection === "in" ? (typedDetailData?.inTransactions ?? []) : (typedDetailData?.outTransactions ?? []);

  const typeBadgeClass = (type: string) => {
    if (type === "Sale") return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300";
    if (type.startsWith("Transfer In")) return "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300";
    if (type.startsWith("Transfer Out"))
      return "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300";
    if (type.startsWith("Adjustment")) return "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300";
    if (type === "Credit Note") return "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300";
    return "bg-muted text-muted-foreground";
  };

  const displayRate = (transaction: StockMovementTransaction) => {
    if (detailDirection === "out" && transaction.type === "Sale") {
      return transaction.sellingRate ?? transaction.rate ?? 0;
    }
    return transaction.rate || 0;
  };

  const displayValue = (transaction: StockMovementTransaction) => {
    if (detailDirection === "out" && transaction.type === "Sale") {
      return transaction.sellingValue ?? transaction.value ?? 0;
    }
    return transaction.value || 0;
  };

  const totalQty = rows.reduce((sum, row) => sum + (row.qty || 0), 0);
  const totalValue = rows.reduce((sum, row) => sum + displayValue(row), 0);
  const avgRate = totalQty > 0 ? totalValue / totalQty : 0;
  const showReference = detailDirection === "in";

  return (
    <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
      <DialogContent className="max-w-2xl flex flex-col" style={{ maxHeight: "75vh" }}>
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center gap-2">
            {detailDirection === "in" ? (
              <span className="text-green-700 dark:text-green-400">Stock In</span>
            ) : (
              <span className="text-red-700 dark:text-red-400">Stock Out</span>
            )}
            <span className="text-muted-foreground font-normal">—</span>
            <span>
              {detailMonthName} {detailYear}
            </span>
          </DialogTitle>
          <DialogDescription>
            {historyItem?.name} · {historyLocation?.name}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-auto min-h-0 border rounded-md">
          {detailLoading ? (
            <div className="space-y-2 p-4">
              {[1, 2, 3].map((value) => (
                <Skeleton key={value} className="h-8 w-full" />
              ))}
            </div>
          ) : !rows.length ? (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
              No transactions found for this period.
            </div>
          ) : (
            <table className="w-full text-sm border-collapse">
              <thead className="sticky top-0 z-10 bg-muted border-b">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Type</th>
                  <th className="text-left px-3 py-2 font-medium">Date</th>
                  {showReference && <th className="text-left px-3 py-2 font-medium">Reference</th>}
                  <th className="text-right px-3 py-2 font-medium">Qty</th>
                  <th className="text-right px-3 py-2 font-medium">Rate</th>
                  <th className="text-right px-3 py-2 font-medium">Value</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((transaction, index) => (
                  <tr key={index} className="border-b hover:bg-muted/30 transition-colors">
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${typeBadgeClass(transaction.type)}`}
                      >
                        {transaction.type}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{transaction.date}</td>
                    {showReference && (
                      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{transaction.reference}</td>
                    )}
                    <td className="text-right px-3 py-2 tabular-nums font-medium">
                      {(transaction.qty || 0).toLocaleString(undefined, {
                        maximumFractionDigits: 2,
                      })}
                    </td>
                    <td className="text-right px-3 py-2 tabular-nums text-muted-foreground">
                      {displayRate(transaction).toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </td>
                    <td className="text-right px-3 py-2 tabular-nums">{formatAmount(displayValue(transaction))}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="sticky bottom-0 bg-muted border-t-2 font-semibold">
                <tr>
                  <td colSpan={showReference ? 3 : 2} className="px-3 py-2 text-xs text-muted-foreground">
                    {rows.length} transaction{rows.length !== 1 ? "s" : ""} · Avg rate:{" "}
                    {avgRate.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </td>
                  <td className="text-right px-3 py-2 tabular-nums">
                    {totalQty.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </td>
                  <td />
                  <td className="text-right px-3 py-2 tabular-nums">{formatAmount(totalValue)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>

        <DialogFooter className="flex-shrink-0 pt-2">
          <Button variant="outline" onClick={() => setDetailOpen(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
