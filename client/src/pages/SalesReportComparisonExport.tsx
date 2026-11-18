import { RowsExportMenu } from "@/components/export/RowsExportMenu";
import { getAiResult, type Company, type ItemRow } from "./salesReportComparisonModel";

/** Excel export of the company comparison table: per company qty sold, average price and profit. */
export function SalesReportComparisonExport({
  rows,
  companies,
  from,
  to,
}: {
  rows: ItemRow[];
  companies: Company[];
  from: string;
  to: string;
}) {
  return (
    <RowsExportMenu
      title="Company Sales Comparison"
      period={{ from, to }}
      rows={rows}
      columns={[
        { header: "Item", value: (row) => row.stockItemName },
        { header: "Group", value: (row) => row.stockGroupName },
        ...companies.flatMap((c) => [
          {
            header: `${c.name} Qty Sold`,
            value: (row: ItemRow) => row.byCompany[c.code]?.totalQty ?? null,
            type: "number" as const,
          },
          {
            header: `${c.name} Av Price`,
            value: (row: ItemRow) => {
              const entry = row.byCompany[c.code];
              return entry && entry.totalQty ? entry.totalSales / entry.totalQty : null;
            },
            type: "number" as const,
          },
          {
            header: `${c.name} Profit`,
            value: (row: ItemRow) => row.byCompany[c.code]?.costProfit || null,
            type: "number" as const,
          },
        ]),
        { header: "AI Result", value: (row) => getAiResult(row, companies) },
      ]}
      resource="erp.sales"
      data-testid="button-export-sales-comparison"
    />
  );
}
