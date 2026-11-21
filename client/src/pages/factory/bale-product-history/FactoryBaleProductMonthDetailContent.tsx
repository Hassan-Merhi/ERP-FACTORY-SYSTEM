// Extracted from ./FactoryBaleProductMonthDetail.tsx
import { Pencil } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { BaleHistoryStatusBadge } from "./BaleHistoryStatusBadge";
import { useFactoryBaleProductMonthDetailState } from "./useFactoryBaleProductMonthDetailState";

export function FactoryBaleProductMonthDetailContent({
  data,
  filteredData,
  formatAmount,
  formatDateTime,
  formatNumber,
  hiddenCost,
  navigate,
  sellingPricePerBale,
  setWeightEditBale,
}: Pick<
  ReturnType<typeof useFactoryBaleProductMonthDetailState>,
  | "data"
  | "filteredData"
  | "formatAmount"
  | "formatDateTime"
  | "formatNumber"
  | "hiddenCost"
  | "navigate"
  | "sellingPricePerBale"
  | "setWeightEditBale"
>) {
  return (
    <div className="hidden md:block overflow-x-auto">
      <Table mobileLayout="cards">
        <TableHeader className="sticky top-0 z-30 bg-background">
          <TableRow>
            <TableHead>Bale Code</TableHead>
            <TableHead>Reference</TableHead>
            <TableHead className="text-right">Weight (KG)</TableHead>
            {!hiddenCost.includes("bale_history_cost_per_kg") && <TableHead className="text-right">Cost/KG</TableHead>}
            {!hiddenCost.includes("bale_history_total_cost") && (
              <TableHead className="text-right">Cost Price</TableHead>
            )}
            {!hiddenCost.includes("bale_history_total_cost") && (
              <TableHead className="text-right">Sell Price</TableHead>
            )}
            <TableHead>Status</TableHead>
            <TableHead>Date/Time</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredData.map((bale) => {
            return (
              <TableRow key={bale.id} data-testid={`row-bale-${bale.id}`}>
                <TableCell className="font-medium font-mono" data-testid={`text-bale-code-${bale.id}`}>
                  {bale.baleCode}
                </TableCell>
                <TableCell data-testid={`text-reference-${bale.id}`}>
                  <button
                    className="font-mono text-sm text-primary underline-offset-2 hover:underline cursor-pointer"
                    onClick={() => navigate(`/factory/barcode-lookup?ref=${encodeURIComponent(bale.referenceNumber)}`)}
                    data-testid={`button-ref-lookup-${bale.id}`}
                  >
                    {bale.referenceNumber}
                  </button>
                </TableCell>
                <TableCell className="text-right font-mono" data-testid={`text-weight-${bale.id}`}>
                  <span className="inline-flex items-center gap-1.5 group">
                    {formatNumber(Number(bale.weightKg))}
                    <button
                      className="opacity-0 group-hover:opacity-100 touch:opacity-100 transition-opacity p-0.5 rounded-sm hover:bg-muted"
                      onClick={() =>
                        setWeightEditBale({
                          id: bale.id,
                          referenceNumber: bale.referenceNumber,
                          weightKg: bale.weightKg,
                        })
                      }
                      title="Correct weight"
                      data-testid={`button-edit-weight-${bale.id}`}
                    >
                      <Pencil className="h-3 w-3 text-muted-foreground" />
                    </button>
                  </span>
                </TableCell>
                {!hiddenCost.includes("bale_history_cost_per_kg") && (
                  <TableCell className="text-right font-mono" data-testid={`text-cost-per-kg-${bale.id}`}>
                    {formatAmount(bale.costPerKg)}
                  </TableCell>
                )}
                {!hiddenCost.includes("bale_history_total_cost") && (
                  <TableCell className="text-right font-mono" data-testid={`text-total-cost-${bale.id}`}>
                    {formatAmount(bale.totalCost)}
                  </TableCell>
                )}
                {!hiddenCost.includes("bale_history_total_cost") && (
                  <TableCell className="text-right font-mono" data-testid={`text-sell-price-${bale.id}`}>
                    {sellingPricePerBale > 0 ? formatAmount(sellingPricePerBale) : "—"}
                  </TableCell>
                )}
                <TableCell data-testid={`text-status-${bale.id}`}>
                  <BaleHistoryStatusBadge bale={bale} />
                </TableCell>
                <TableCell data-testid={`text-date-${bale.id}`}>{formatDateTime(bale.createdAt)}</TableCell>
              </TableRow>
            );
          })}
          {(!data || data.length === 0) && (
            <TableRow>
              <TableCell colSpan={8} className="text-center text-muted-foreground py-8" data-testid="text-no-data">
                No bales found for this month
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
