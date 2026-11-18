import type { RowsExportSheet } from "@/components/export/RowsExportMenu";
import type { DashboardRow } from "./RetailDashboardRankingTable";

export function rankingSheet(
  name: string,
  rows: DashboardRow[],
  label: (row: DashboardRow) => string,
  showProfit = false
): RowsExportSheet<DashboardRow> {
  return {
    name,
    rows,
    columns: [
      { header: "Name", value: label },
      { header: "Qty", value: (row) => row.quantity, type: "number" },
      { header: "Revenue", value: (row) => row.revenue, type: "number" },
      ...(showProfit ? [{ header: "Profit", value: (row: DashboardRow) => row.profit, type: "number" as const }] : []),
    ],
  };
}

export function stockSheet(
  name: string,
  rows: DashboardRow[],
  mode: "low" | "out" | "slow"
): RowsExportSheet<DashboardRow> {
  return {
    name,
    rows,
    columns: [
      { header: "Product", value: (row) => row.name ?? row.product_name },
      { header: "Code", value: (row) => row.code ?? row.product_code ?? row.barcode },
      { header: "Color", value: (row) => row.color },
      { header: "Size", value: (row) => row.size },
      ...(mode === "low" ? [{ header: "Location", value: (row: DashboardRow) => row.location_name }] : []),
      { header: "Qty", value: (row) => row.quantity, type: "number" },
      ...(mode === "low"
        ? [{ header: "Low at", value: (row: DashboardRow) => row.threshold, type: "number" as const }]
        : []),
      ...(mode === "slow"
        ? [
            {
              header: "Last sale",
              value: (row: DashboardRow) =>
                row.last_sale_at ? new Date(row.last_sale_at).toLocaleDateString() : "Never",
            },
          ]
        : []),
    ],
  };
}

export const productLabel = (row: DashboardRow) => row.product_name ?? row.name ?? "—";
export const brandLabel = (row: DashboardRow) => row.name ?? row.brand_name ?? row.brand ?? "—";
export const sizeLabel = (row: DashboardRow) => row.name ?? row.size ?? "—";
export const locationLabel = (row: DashboardRow) => row.name ?? row.location_name ?? "—";
