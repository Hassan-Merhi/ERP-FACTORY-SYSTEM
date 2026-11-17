import { searchAny } from "@shared/searchNormalization";
import type { CombinedRow, InventoryRow, StockGroupSummary } from "./useCombinedInventoryState";

interface CombinedInventoryExportOptions {
  selectedCompany: { id: number; name: string } | null | undefined;
  containerDetailsQueries: readonly { isLoading: boolean; isError: boolean; data?: unknown }[];
  includeZero: boolean;
  loadingStockItems: boolean;
  calculateCombinedData: (rows: readonly InventoryRow[]) => CombinedRow[];
  search: string;
  isDrillMode: boolean;
  selectedGroupId: number | null | undefined;
  drillGroup: StockGroupSummary | null | undefined;
  toast: (props: { title: string; description: string; variant?: "destructive" }) => unknown;
}

export async function exportCombinedInventory(options: CombinedInventoryExportOptions): Promise<void> {
  const { selectedCompany, containerDetailsQueries, includeZero, loadingStockItems, calculateCombinedData, search, isDrillMode, selectedGroupId, drillGroup, toast } = options;
    try {
      if (!selectedCompany?.id) throw new Error("Choose a company before exporting");
      if (containerDetailsQueries.some((query) => query.isLoading || query.isError || !query.data)) {
        throw new Error("OTW container details are not fully loaded; refresh before exporting");
      }
      if (includeZero && loadingStockItems) {
        throw new Error("Stock items are still loading; retry after loading completes");
      }

      // The page deliberately previews 100 inventory rows. Export must fetch
      // ALL pages, not the preview, and reject a truncated or moving dataset.
      const pageSize = 100;
      const inventoryForExport: InventoryRow[] = [];
      let expectedTotal: number | null = null;
      let totalPages = 1;
      for (let page = 1; page <= totalPages; page += 1) {
        const response = await fetch("/api/inventory?page=" + page + "&pageSize=" + pageSize, {
          credentials: "include",
        });
        if (!response.ok) throw new Error("Inventory export page " + page + " failed");
        const payload = (await response.json()) as {
          data?: InventoryRow[];
          total?: number;
          totalPages?: number;
          page?: number;
        };
        if (
          !Array.isArray(payload.data) ||
          typeof payload.total !== "number" ||
          !Number.isSafeInteger(payload.total) ||
          payload.total < 0 ||
          typeof payload.totalPages !== "number" ||
          !Number.isSafeInteger(payload.totalPages) ||
          (payload.totalPages < 1 && !(payload.totalPages === 0 && payload.total === 0)) ||
          (payload.totalPages ?? 0) > 10_000 ||
          (payload.page != null && payload.page !== page)
        ) {
          throw new Error("Inventory export returned invalid pagination metadata");
        }
        if (expectedTotal === null) {
          expectedTotal = payload.total!;
          totalPages = Math.max(1, payload.totalPages!);
        } else if (payload.total !== expectedTotal || Math.max(1, payload.totalPages!) !== totalPages) {
          throw new Error("Inventory changed while exporting; please retry");
        }
        inventoryForExport.push(...payload.data);
      }
      if (inventoryForExport.length !== expectedTotal) {
        throw new Error("Inventory export is incomplete; please retry");
      }

      const completeCombined = calculateCombinedData(inventoryForExport);
      const searched = search.trim()
        ? completeCombined.filter((row) => searchAny(search, row.stockItemName, row.stockItemCode))
        : completeCombined;
      const exportRows = isDrillMode ? searched.filter((row) => row.stockGroupId === selectedGroupId) : searched;
      const data = exportRows.map((row) => ({
        "Item Name": row.stockItemName,
        "Stock Group": row.stockGroupName || "Uncategorized",
        "OTW Qty": row.otwQty,
        "In-Hand Qty": row.inHandQty,
        "Total Qty": row.totalQty,
        "Avg Rate": Number(row.avgRate.toFixed(2)),
        "Total Value": Number(row.combinedValue.toFixed(2)),
      }));
      const fileName = isDrillMode
        ? "combined_inventory_" + (drillGroup?.stockGroupName || "group").replace(/\s+/g, "_") + ".xlsx"
        : "combined_inventory.xlsx";
      const { columnsFromOperationalRows, exportOperationalWorkbook } = await import("@/lib/operationalExcelExport");
      await exportOperationalWorkbook({
        title: "Combined Inventory",
        fileName,
        companyName: selectedCompany.name,
        currencyCode: "USD",
        filters: [
          { label: "Search", value: search || "All" },
          { label: "Stock Group", value: isDrillMode ? drillGroup?.stockGroupName || "Uncategorized" : "All" },
        ],
        sheets: [
          {
            name: "Combined Inventory",
            rows: data,
            columns: columnsFromOperationalRows(data, {
              orderedHeaders: [
                "Item Name",
                "Stock Group",
                "OTW Qty",
                "In-Hand Qty",
                "Total Qty",
                "Avg Rate",
                "Total Value",
              ],
              types: {
                "OTW Qty": "decimal",
                "In-Hand Qty": "decimal",
                "Total Qty": "decimal",
                "Avg Rate": "money",
                "Total Value": "money",
              },
            }),
          },
        ],
      });
    } catch (error) {
      // Prefer a useful error to a silently partial workbook.
      toast({
        title: "Inventory export failed",
        description: error instanceof Error ? error.message : "Could not export inventory",
        variant: "destructive",
      });
    }
}
