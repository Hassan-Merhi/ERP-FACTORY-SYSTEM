// Extracted from ./FactoryPriceList.tsx to keep that module under the source-size cap.
import { styleFactoryOperationalWorkbook } from "@shared/universal-excel/factoryOperationalStyle";
import { downloadBlob } from "@/lib/downloadBlob";
import { exportFileName } from "@/lib/exportFile";
import { getErrorDetails } from "@shared/errorUtils";
import { queryClient } from "@/lib/queryClient";
import { ExcelJS, readFile } from "@/lib/excelHelper";
import { productMatchesSearch } from "@shared/factoryProductSearch";
import { useFactoryPriceListStatePart1 } from "./useFactoryPriceListStatePart1";

export function useFactoryPriceListState() {
  const {
    mhd,
    toast,
    modeApiRequest,
    recordChanges,
    search,
    setSearch,
    categoryFilter,
    setCategoryFilter,
    showZeroOnly,
    setShowZeroOnly,
    editingCell,
    setEditingCell,
    setIsUploading,
    isUploading,
    inputRef,
    fileInputRef,
    products,
    refetchProducts,
    productsError,
    isLoading,
    categories,
    updatePriceMutation,
    handleStartEdit,
  } = useFactoryPriceListStatePart1();

  const handleSave = (advance = false) => {
    if (!editingCell || updatePriceMutation.isPending) return;
    const val = Number(editingCell.value.trim());
    if (!Number.isFinite(val) || val < 0) {
      toast({ title: "Update failed", description: "Please enter a valid price.", variant: "destructive" });
      return;
    }

    // Enter follows the editable cells in table order:
    // Sell Price → Prod. Cost → next product's Sell Price.
    // Prod. Cost is hidden on narrow screens, so skip it there.
    let nextCell: { productId: number; field: "sellingPrice" | "productionPrice"; value: string } | undefined;
    if (advance) {
      const index = filteredProducts.findIndex((product) => product.id === editingCell.productId);
      const currentProduct = filteredProducts[index];
      if (editingCell.field === "sellingPrice" && currentProduct && window.innerWidth >= 640) {
        nextCell = {
          productId: currentProduct.id,
          field: "productionPrice",
          value: currentProduct.productionPrice || "0",
        };
      } else if (index >= 0 && index + 1 < filteredProducts.length) {
        const nextProduct = filteredProducts[index + 1];
        nextCell = { productId: nextProduct.id, field: "sellingPrice", value: nextProduct.sellingPrice || "0" };
      }
    }

    updatePriceMutation.mutate({
      id: editingCell.productId,
      field: editingCell.field,
      value: val.toFixed(2),
      nextCell,
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSave(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setEditingCell(null);
    }
  };

  const downloadTemplate = async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Price List");

    ws.columns = [
      { header: "ID (do not edit)", key: "id", width: 18 },
      { header: "Article Code", key: "articleCode", width: 18 },
      { header: "Bale Name", key: "name", width: 36 },
      { header: "Selling Price ($/bale)", key: "sellingPrice", width: 24 },
      { header: "Production Cost ($/bale)", key: "productionPrice", width: 26 },
    ];

    const headerRow = ws.getRow(1);
    headerRow.font = { bold: true, color: { argb: "FF1F4E79" } };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFBDD7EE" } };
    headerRow.alignment = { vertical: "middle" };
    headerRow.height = 18;

    const activeProducts = products.filter((p) => p.active);
    for (const p of activeProducts) {
      const sp = parseFloat(p.sellingPrice || "0");
      const pp = parseFloat(p.productionPrice || "0");
      const row = ws.addRow({
        id: p.id,
        articleCode: p.articleCode || p.code || "",
        name: p.name,
        sellingPrice: sp > 0 ? sp : "",
        productionPrice: pp > 0 ? pp : "",
      });
      // Gray out read-only columns (ID, Article Code, Bale Name)
      for (let c = 1; c <= 3; c++) {
        row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } };
        row.getCell(c).font = { color: { argb: "FF666666" } };
      }
      // Highlight editable price columns
      for (let c = 4; c <= 5; c++) {
        row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF9E6" } };
      }
    }

    ws.views = [{ state: "frozen", ySplit: 1 }];
    // Import contract stays unchanged: headers remain at row 1 and editable
    // price cells retain their visual cues.
    styleFactoryOperationalWorkbook(wb, [{ name: "Price List", headerRow: 1 }]);
    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer as ArrayBuffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    downloadBlob(blob, exportFileName("factory price list", "xlsx"));
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !recordChanges.allowed) return;
    e.target.value = "";

    setIsUploading(true);
    try {
      const wb = await readFile(file);
      const ws = wb.worksheets[0];
      if (!ws) throw new Error("No worksheet found in the file");

      const prices: { id: number; sellingPrice?: string; productionPrice?: string }[] = [];

      ws.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // skip header
        const rawId = row.getCell(1).value;
        const id = parseInt(String(rawId ?? ""));
        if (isNaN(id) || id <= 0) return;

        const rawSell = row.getCell(4).value;
        const rawProd = row.getCell(5).value;

        prices.push({
          id,
          sellingPrice: rawSell !== null && rawSell !== undefined ? String(rawSell) : undefined,
          productionPrice: rawProd !== null && rawProd !== undefined ? String(rawProd) : undefined,
        });
      });

      if (prices.length === 0) throw new Error("No valid rows found — make sure the file matches the template format");

      const res = await modeApiRequest("POST", "/api/factory/bale-products/bulk-update-prices", { prices });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Upload failed");
      }
      const result = await res.json();
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products"] });
      toast({
        title: "Prices Updated",
        description: `${result.updated} product(s) updated${result.skipped > 0 ? `, ${result.skipped} skipped` : ""}.`,
      });
    } catch (err) {
      toast({ title: "Upload Failed", description: getErrorDetails(err).message, variant: "destructive" });
    } finally {
      setIsUploading(false);
    }
  };

  const filteredProducts = mhd
    .sortRows(products, (p) => p.articleCode)
    .filter((p) => {
      if (!p.active) return false;
      const matchSearch =
        productMatchesSearch(p, search) ||
        (Boolean(search.trim()) &&
          mhd.nameFor(p.articleCode, p.name).toLowerCase().includes(search.trim().toLowerCase()));
      const matchCategory = categoryFilter === "all" || String(p.categoryId) === categoryFilter;
      // Keep a row visible while Enter moves from its selling price to production cost.
      // Otherwise a "Show unpriced" refresh would unmount the second editable cell.
      const matchZeroOnly = !showZeroOnly || parseFloat(p.sellingPrice || "0") === 0 || editingCell?.productId === p.id;
      return matchSearch && matchCategory && matchZeroOnly;
    });

  const categoryMap = new Map(categories.map((c) => [c.id, c.name]));

  const updatedCount = products.filter((p) => p.active && parseFloat(p.sellingPrice || "0") > 0).length;
  const totalActive = products.filter((p) => p.active).length;
  return {
    refetchProducts,
    productsError,
    categories,
    categoryFilter,
    categoryMap,
    downloadTemplate,
    editingCell,
    fileInputRef,
    filteredProducts,
    handleKeyDown,
    handleSave,
    handleStartEdit,
    handleUpload,
    inputRef,
    isLoading,
    isUploading,
    mhd,
    products,
    recordChanges,
    search,
    setCategoryFilter,
    setEditingCell,
    setSearch,
    setShowZeroOnly,
    showZeroOnly,
    totalActive,
    updatePriceMutation,
    updatedCount,
  };
}
