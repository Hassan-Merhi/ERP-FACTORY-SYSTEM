// Extracted from ./useStockItems.ts to keep that module under the source-size cap.
import { loadStockItemsForExport } from "./stockItemsExport";
import { useStockItemsPart1 } from "./useStockItemsPart1";
import { useStockItemsPart2 } from "./useStockItemsPart2";

export function useStockItemsPart3({
  exportingStockItems,
  getCategoryName,
  getGradeName,
  getStockGroupName,
  hideStockRates,
  locations,
  myErpPages,
  searchTerm,
  selectedCategoryFilter,
  selectedCompany,
  selectedGradeFilter,
  selectedGroupFilter,
  setExportingStockItems,
  toast,
}: Pick<
  Awaited<ReturnType<typeof useStockItemsPart1>> & Awaited<ReturnType<typeof useStockItemsPart2>>,
  | "exportingStockItems"
  | "getCategoryName"
  | "getGradeName"
  | "getStockGroupName"
  | "hideStockRates"
  | "locations"
  | "myErpPages"
  | "searchTerm"
  | "selectedCategoryFilter"
  | "selectedCompany"
  | "selectedGradeFilter"
  | "selectedGroupFilter"
  | "setExportingStockItems"
  | "toast"
>) {
  const exportToExcel = async () => {
    if (exportingStockItems) return;
    if (!navigator.onLine) {
      toast({ title: "Not available offline", description: "Exports require a connection", variant: "destructive" });
      return;
    }
    setExportingStockItems(true);
    try {
      // Do not request or serialize hidden prices while the page-access
      // response is still loading or this user's stock rate field is hidden.
      const allowStockRates = myErpPages !== undefined && !hideStockRates;
      const [allItems, pricesRes, costDubaiRes, aliasesRes] = await Promise.all([
        loadStockItemsForExport({
          search: searchTerm,
          stockGroupId: selectedGroupFilter,
          gradeId: selectedGradeFilter,
          categoryId: selectedCategoryFilter,
        }),
        allowStockRates
          ? fetch("/api/stock-item-location-prices/all", { credentials: "include" })
          : Promise.resolve(null),
        allowStockRates ? fetch("/api/stock-items/cost-dubai", { credentials: "include" }) : Promise.resolve(null),
        fetch("/api/stock-items/all-code-aliases", { credentials: "include" }),
      ]);
      if (!aliasesRes.ok || (allowStockRates && (!pricesRes?.ok || !costDubaiRes?.ok))) {
        throw new Error("Failed to fetch stock item pricing or aliases");
      }
      if (allItems.length === 0) {
        toast({ title: "No stock items", description: "No items match the current filters." });
        return;
      }
      const locationPrices: {
        stockItemId: number;
        locationId: number;
        locationName: string;
        sellingPrice: string;
      }[] = pricesRes ? await pricesRes.json() : [];
      const costDubaiData: { stockItemId: number; costDubai: string }[] = costDubaiRes ? await costDubaiRes.json() : [];
      const aliasData: { stockItemId: number; aliasCode: string }[] = await aliasesRes.json();

      const costDubaiMap = new Map<number, string>();
      for (const cost of costDubaiData) costDubaiMap.set(cost.stockItemId, cost.costDubai);
      const priceMap = new Map<number, Record<string, string>>();
      for (const price of locationPrices) {
        let itemPrices = priceMap.get(price.stockItemId);
        if (!itemPrices) {
          itemPrices = {};
          priceMap.set(price.stockItemId, itemPrices);
        }
        itemPrices[String(price.locationId)] = price.sellingPrice;
      }
      const aliasMap = new Map<number, string[]>();
      for (const alias of aliasData) {
        if (!aliasMap.has(alias.stockItemId)) aliasMap.set(alias.stockItemId, []);
        aliasMap.get(alias.stockItemId)!.push(alias.aliasCode);
      }

      const { buildStockItemReportColumns } = await import("@shared/universal-excel/reportSchemas");
      const { exportOperationalWorkbook } = await import("@/lib/operationalExcelExport");
      const data = allItems.map((item) => ({
        code: item.code,
        name: item.name,
        barcode: item.barcode || "",
        aliasCodes: (aliasMap.get(item.id) ?? []).join(", "),
        uom: item.uom,
        stockGroup: getStockGroupName(item.stockGroupId) ?? "— No Group —",
        grade: getGradeName(item.gradeId) || "",
        category: getCategoryName(item.categoryId) || "",
        defaultSellingPrice: allowStockRates ? item.sellingPrice || "0" : null,
        costDubai: allowStockRates ? (costDubaiMap.get(item.id) ?? null) : null,
        pricesByLocation: allowStockRates ? (priceMap.get(item.id) ?? {}) : {},
        active: item.active ? "Yes" : "No",
      }));
      await exportOperationalWorkbook({
        title: "Stock Items",
        fileName: "stock-items.xlsx",
        companyName: selectedCompany?.name,
        filters: [
          { label: "Search", value: searchTerm || "All" },
          { label: "Group", value: String(selectedGroupFilter ?? "All") },
          { label: "Grade", value: String(selectedGradeFilter ?? "All") },
          { label: "Category", value: String(selectedCategoryFilter ?? "All") },
        ],
        allowedColumnTags: allowStockRates ? ["stock-rates", "stock-cost"] : [],
        sheets: [
          {
            name: "Stock Items",
            columns: buildStockItemReportColumns(locations),
            rows: data,
          },
        ],
      });
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Could not export stock items",
        variant: "destructive",
      });
    } finally {
      setExportingStockItems(false);
    }
  };
  return { exportToExcel };
}
