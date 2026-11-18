import type { RowsExportColumn } from "@/components/export/RowsExportMenu";
import type { ProductionValuationMode, ReportData } from "../types";

type ExportProduct = ReportData["production"]["byProduct"][number];
type ExportBatch = ReportData["rawMaterial"]["batches"][number];

/** Export: the product rows of "Production by Category" and the Mix Batches table, as shown. */
export function productionOverviewExport(
  data: ReportData | undefined,
  costsHidden: boolean,
  valuationMode: ProductionValuationMode
) {
  const products: ExportProduct[] = [
    ...(data?.production.byProduct ?? []),
    ...(data?.wipersGarbage.products ?? []).map((product) => ({ ...product, categoryName: "Wipers & Garbage" })),
  ];
  const productColumns: RowsExportColumn<ExportProduct>[] = [
    { header: "Category", value: (p) => p.categoryName },
    { header: "Article Code", value: (p) => p.articleCode },
    { header: "Product", value: (p) => p.productName },
    { header: "Qty", value: (p) => p.qty, type: "number" },
    { header: "Weight (kg)", value: (p) => p.totalWeightKg, type: "number" },
    ...(costsHidden
      ? []
      : [
          {
            header: valuationMode === "selling" ? "Selling / Bale" : "Cost / Bale",
            value: (p: ExportProduct) => p.pricePerBale,
            type: "number" as const,
          },
          { header: "Value", value: (p: ExportProduct) => p.totalValue, type: "number" as const },
        ]),
  ];
  const batchColumns: RowsExportColumn<ExportBatch>[] = [
    { header: "Batch Code", value: (b) => b.batchCode },
    { header: "Name", value: (b) => b.name || "—" },
    { header: "Date", value: (b) => b.batchDate || b.createdAt?.slice(0, 10) || "—" },
    { header: "Weight (kg)", value: (b) => parseFloat(b.totalWeightKg), type: "number" },
    ...(costsHidden
      ? []
      : [
          {
            header: "Cost / kg",
            value: (b: ExportBatch) => Number(b.costPerKg || 0).toFixed(4),
            type: "number" as const,
          },
          { header: "Total Cost", value: (b: ExportBatch) => parseFloat(b.totalCost), type: "number" as const },
        ]),
  ];
  return { products, productColumns, batches: data?.rawMaterial.batches ?? [], batchColumns };
}
