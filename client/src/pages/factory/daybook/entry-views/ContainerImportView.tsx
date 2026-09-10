/**
 * CONTAINER_IMPORT detail view: goods, freight, commission and supplier balance.
 *
 * Extracted from ViewEntryModal, where it was an early-return branch. The
 * branch declared no hooks, so this is a straight move behind a props
 * boundary rather than a behavioural change.
 */
import { DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatNumber } from "@/lib/formatNumber";
import { currencySymbol } from "../daybookUtils";
import type { ContainerImportDetail, DaybookEntry, DisplayDate, Navigate, SupplierBalance } from "./types";

export function ContainerImportView({
  entry,
  containerDetail,
  supplierBalance,
  onClose,
  formatDisplayDate,
  onNavigate,
}: {
  entry: DaybookEntry;
  containerDetail: ContainerImportDetail | null | undefined;
  supplierBalance: SupplierBalance | null | undefined;
  onClose: () => void;
  formatDisplayDate: DisplayDate;
  onNavigate: Navigate;
}) {
  const c = containerDetail;
  const csym = c ? currencySymbol(c.currencyCode || "USD") : "$";
  const fx = c ? parseFloat(c.fxRateToUsd || "1") || 1 : 1;
  const totalKg = c ? parseFloat(c.totalKg || "0") : 0;
  const ratePerKg = c ? parseFloat(c.ratePerKg || "0") : 0;
  const goodsTotal = totalKg * ratePerKg;
  const freight = c ? parseFloat(c.freight || "0") : 0;
  const commission = c ? parseFloat(c.commissionAmount || "0") : 0;
  const grandTotal = c
    ? parseFloat(c.finalPayableAmount || String(goodsTotal + freight + commission)) || goodsTotal + freight + commission
    : 0;
  const grandTotalUsd = c ? parseFloat(c.finalPayableAmountUsd || "0") || grandTotal * fx : 0;
  const balanceUsd: number = supplierBalance?.balance ?? supplierBalance?.outstandingUsd ?? null;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Transaction Details</DialogTitle>
        <DialogDescription>{formatDisplayDate(entry.txDate + "T00:00:00")}</DialogDescription>
      </DialogHeader>
      <div className="space-y-4">
        {/* Supplier card */}
        <div className="rounded-md border p-4 space-y-2">
          {!c ? (
            <p className="text-sm text-muted-foreground">Loading container details…</p>
          ) : (
            <>
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div>
                  <p className="font-semibold text-base">{c.supplierName || "Unknown Supplier"}</p>
                  {balanceUsd !== null && (
                    <p className="text-sm text-muted-foreground mt-0.5">
                      Balance:{" "}
                      <span className="font-mono font-medium text-foreground">${formatNumber(balanceUsd)}</span>
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground mt-0.5">Container: {c.containerNumber}</p>
                  {c.origin && <p className="text-xs text-muted-foreground">Origin: {c.origin}</p>}
                  {totalKg > 0 && parseFloat(c.actualReceivedKg || "0") < totalKg && (
                    <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                      <span className="text-xs text-muted-foreground">Total KG imported:</span>
                      <span className="font-mono text-sm font-semibold">{formatNumber(totalKg)} kg</span>
                      {parseFloat(c.actualReceivedKg || "0") === 0 ? (
                        <Badge
                          variant="outline"
                          className="text-xs bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40"
                        >
                          Pending
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          ({formatNumber(parseFloat(c.actualReceivedKg))} kg received)
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="default"
                  onClick={() => {
                    onClose();
                    onNavigate(`/factory/containers?edit=${entry.referenceId}`);
                  }}
                  data-testid="button-open-container"
                >
                  Open
                </Button>
              </div>
            </>
          )}
        </div>

        {/* Cost breakdown table */}
        {c && (
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/40 border-b">
                  <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Item
                  </th>
                  <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Qty / KG
                  </th>
                  <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Rate
                  </th>
                  <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {/* Goods row */}
                <tr className="border-b">
                  <td className="px-3 py-2 font-medium">Goods (Raw Stock)</td>
                  <td className="px-3 py-2 text-right font-mono text-muted-foreground">{formatNumber(totalKg)} kg</td>
                  <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                    {csym}
                    {formatNumber(ratePerKg)}/kg
                  </td>
                  <td className="px-3 py-2 text-right font-mono font-medium">
                    {csym}
                    {formatNumber(goodsTotal)}
                  </td>
                </tr>
                {/* Freight row */}
                {freight > 0 && (
                  <tr className="border-b">
                    <td className="px-3 py-2 font-medium">Freight</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">—</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">—</td>
                    <td className="px-3 py-2 text-right font-mono font-medium">
                      {currencySymbol(c.freightCurrencyCode || c.currencyCode || "USD")}
                      {formatNumber(freight)}
                    </td>
                  </tr>
                )}
                {/* Commission row */}
                {commission > 0 && (
                  <tr className="border-b">
                    <td className="px-3 py-2 font-medium">Commission</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">—</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">—</td>
                    <td className="px-3 py-2 text-right font-mono font-medium">
                      {currencySymbol(c.commissionCurrencyCode || c.currencyCode || "USD")}
                      {formatNumber(commission)}
                    </td>
                  </tr>
                )}
                {/* Actual received KG info */}
                {parseFloat(c.actualReceivedKg || "0") > 0 && parseFloat(c.actualReceivedKg || "0") !== totalKg && (
                  <tr className="border-b bg-muted/20">
                    <td className="px-3 py-2 text-muted-foreground text-xs" colSpan={2}>
                      Actual Received
                    </td>
                    <td className="px-3 py-2 text-right text-xs text-muted-foreground font-mono" colSpan={2}>
                      {formatNumber(parseFloat(c.actualReceivedKg))} kg
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr className="bg-muted/50 font-bold border-t">
                  <td className="px-3 py-2" colSpan={3}>
                    Grand Total
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    <div>
                      {csym}
                      {formatNumber(grandTotal)}
                    </div>
                    {c.currencyCode !== "USD" && grandTotalUsd > 0 && (
                      <div className="text-xs text-muted-foreground font-normal">${formatNumber(grandTotalUsd)}</div>
                    )}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
