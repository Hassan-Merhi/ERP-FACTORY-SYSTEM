import type { RowsExportColumn } from "@/components/export/RowsExportMenu";

import { getBaleHistoryStatusLabel } from "./BaleHistoryStatusBadge";
import type { BaleItem } from "./types";

/**
 * Columns of the bale detail tables (one month or all months), as shown:
 * cost columns follow the same hidden-cost keys the table uses.
 */
export function baleHistoryExportColumns(options: {
  hiddenCost: readonly string[];
  sellingPricePerBale: number;
  formatDateTime: (date: string) => string;
}): RowsExportColumn<BaleItem>[] {
  const { hiddenCost, sellingPricePerBale, formatDateTime } = options;
  const showCostPerKg = !hiddenCost.includes("bale_history_cost_per_kg");
  const showTotals = !hiddenCost.includes("bale_history_total_cost");
  return [
    { header: "Bale Code", value: (bale) => bale.baleCode },
    { header: "Reference", value: (bale) => bale.referenceNumber },
    { header: "Weight (KG)", value: (bale) => Number(bale.weightKg), type: "number" },
    ...(showCostPerKg
      ? [{ header: "Cost/KG", value: (bale: BaleItem) => bale.costPerKg, type: "number" as const }]
      : []),
    ...(showTotals
      ? [
          { header: "Cost Price", value: (bale: BaleItem) => bale.totalCost, type: "number" as const },
          {
            header: "Sell Price",
            value: () => (sellingPricePerBale > 0 ? sellingPricePerBale : "—"),
          },
        ]
      : []),
    { header: "Status", value: (bale) => getBaleHistoryStatusLabel(bale) },
    { header: "Date/Time", value: (bale) => formatDateTime(bale.createdAt) },
  ];
}
