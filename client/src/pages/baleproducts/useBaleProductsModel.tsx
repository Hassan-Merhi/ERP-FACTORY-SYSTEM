import { getErrorDetails } from "@shared/errorUtils";
import type { GroupedProduct, ImportPreviewRow } from "./types";
import { useBaleProductsModelPart1 } from "./useBaleProductsModelPart1";
import { useBaleProductsModelPart2 } from "./useBaleProductsModelPart2";

export function useBaleProductsModel() {
  const {
    activeProducts,
    adminAuthOpen,
    categories,
    categoryMap,
    condensedView,
    createCategoryMutation,
    createDialogOpen,
    deleteCategoryMutation,
    designColors,
    distinctWeights,
    editForm,
    editingCategory,
    editingProduct,
    expandedCategories,
    expandedGroups,
    fileInputRef,
    filterCategoryId,
    filterWeight,
    hiddenProducts,
    hideAvgRate,
    hideSellingPriceBP,
    importDialogOpen,
    importError,
    importFile,
    importPreview,
    isAdmin,
    isLoading,
    modeApiRequest,
    newCategoryName,
    noColorCount,
    pendingAdminAuth,
    pendingDelete,
    products,
    recordChanges,
    searchQuery,
    selectedActiveIds,
    selectedHiddenIds,
    selectedIds,
    setAdminAuthOpen,
    setCreateDialogOpen,
    setEditForm,
    setEditingCategory,
    setEditingProduct,
    setExpandedCategories,
    setExpandedGroups,
    setFilterCategoryId,
    setFilterWeight,
    setImportDialogOpen,
    setImportError,
    setImportFile,
    setImportPreview,
    setNewCategoryName,
    setPendingAdminAuth,
    setPendingDelete,
    setSearchQuery,
    setSelectedIds,
    setShowCategories,
    setShowHidden,
    setShowNoColor,
    setShowZeroPrice,
    showCategories,
    showHidden,
    showNoColor,
    showZeroPrice,
    toast,
    toggleSelectAll,
    toggleSelectId,
    updateCategoryMutation,
  } = useBaleProductsModelPart1();
  const {
    bulkToggleActiveMutation,
    colorUpdateMutation,
    deleteProductMutation,
    editProductMutation,
    handleEditSubmit,
    handleExportExcel,
    handleExportNoPrices,
    importMutation,
  } = useBaleProductsModelPart2({
    activeProducts,
    categoryMap,
    editForm,
    editingProduct,
    hideAvgRate,
    hideSellingPriceBP,
    modeApiRequest,
    recordChanges,
    setEditingProduct,
    setImportDialogOpen,
    setImportFile,
    setImportPreview,
    setSelectedIds,
    toast,
  });
  const { groupedProducts, handleConfirmImport, handleDownloadTemplate, handleFileSelect, toggleGroup } =
    useBaleProductsModelPart3({
      activeProducts,
      fileInputRef,
      importFile,
      importMutation,
      setExpandedGroups,
      setImportDialogOpen,
      setImportError,
      setImportFile,
      setImportPreview,
      toast,
    });

  // prettier-ignore
  return { designColors, createDialogOpen, setCreateDialogOpen, adminAuthOpen, setAdminAuthOpen, pendingAdminAuth, setPendingAdminAuth, importDialogOpen, setImportDialogOpen, importPreview, setImportPreview, importError, setImportFile, condensedView, expandedGroups, showCategories, setShowCategories, expandedCategories, setExpandedCategories, newCategoryName, setNewCategoryName, editingCategory, setEditingCategory, editingProduct, setEditingProduct, editForm, setEditForm, pendingDelete, setPendingDelete, selectedIds, setSelectedIds, showHidden, setShowHidden, showZeroPrice, setShowZeroPrice, showNoColor, setShowNoColor, filterCategoryId, setFilterCategoryId, filterWeight, setFilterWeight, searchQuery, setSearchQuery, fileInputRef, isAdmin, hideAvgRate, hideSellingPriceBP, products, isLoading, categories, categoryMap, noColorCount, distinctWeights, activeProducts, hiddenProducts, toggleSelectId, toggleSelectAll, selectedActiveIds, selectedHiddenIds, createCategoryMutation, updateCategoryMutation, deleteCategoryMutation, importMutation, editProductMutation, colorUpdateMutation, deleteProductMutation, bulkToggleActiveMutation, handleEditSubmit, handleExportExcel, handleExportNoPrices, handleDownloadTemplate, handleFileSelect, handleConfirmImport, toggleGroup, groupedProducts, canChangeExistingRecords: recordChanges.allowed, canCreate: recordChanges.canCreate } as const;
}

function useBaleProductsModelPart3({
  activeProducts,
  fileInputRef,
  importFile,
  importMutation,
  setExpandedGroups,
  setImportDialogOpen,
  setImportError,
  setImportFile,
  setImportPreview,
  toast,
}: Pick<
  Awaited<ReturnType<typeof useBaleProductsModelPart1>> & Awaited<ReturnType<typeof useBaleProductsModelPart2>>,
  | "activeProducts"
  | "fileInputRef"
  | "importFile"
  | "importMutation"
  | "setExpandedGroups"
  | "setImportDialogOpen"
  | "setImportError"
  | "setImportFile"
  | "setImportPreview"
  | "toast"
>) {
  const handleDownloadTemplate = async () => {
    try {
      const XLSX = await import("@/lib/excelHelper");
      const templateData = [
        {
          "Article Code": "HMD01000",
          Name: "Sample Product 1",
          Category: "Category A",
          "Weight Per Bale": "45",
          "Production Price": "100.00",
          "Selling Price": "120.00",
        },
        {
          "Article Code": "HMD02000",
          Name: "Sample Product 2",
          Category: "Category B",
          "Weight Per Bale": "50",
          "Production Price": "80.00",
          "Selling Price": "100.00",
        },
      ];
      const ws = XLSX.utils.json_to_sheet(templateData);
      ws["!cols"] = [{ wch: 15 }, { wch: 25 }, { wch: 20 }, { wch: 16 }, { wch: 18 }, { wch: 18 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Bale Products");
      await XLSX.writeFile(wb, "bale_products_template.xlsx");
      toast({ title: "Template downloaded" });
    } catch {
      toast({ title: "Error", description: "Failed to generate template", variant: "destructive" });
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError("");
    setImportPreview([]);
    setImportFile(file);

    try {
      const XLSX = await import("@/lib/excelHelper");
      const buffer = await file.arrayBuffer();
      const workbook = await XLSX.read(buffer, { type: "array" });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(worksheet);

      if (rows.length === 0) {
        setImportError("Excel file is empty");
        setImportFile(null);
        return;
      }

      const preview: ImportPreviewRow[] = rows.map((row) => {
        const itemNumber = row.itemNumber || row.item_number || row.ItemNumber;
        let articleCode = (row["Article Code"] || row.articleCode || row.article_code || row.ArticleCode || "")
          .toString()
          .trim();
        if (!articleCode && itemNumber) {
          const num = parseInt(String(itemNumber));
          if (!isNaN(num) && num >= 1 && num <= 99) {
            articleCode = `HMD${String(num).padStart(2, "0")}000`;
          }
        }
        const rawProdPrice =
          row["Production Price"] ??
          row["production price"] ??
          row.productionPrice ??
          row.production_price ??
          row["Cost Price"] ??
          row.costPrice ??
          null;
        const rawSellPrice =
          row["Selling Price"] ?? row["selling price"] ?? row.sellingPrice ?? row.selling_price ?? null;
        return {
          articleCode: articleCode || "",
          name: (row["Name"] || row.name || row.Name || row["Product Name"] || row.product_name || "")
            .toString()
            .trim(),
          category: (row.category || row.Category || row.category_name || "").toString().trim(),
          description: (row.description || row.Description || "").toString().trim(),
          weightPerBaleKg:
            (row["Weight Per Bale"] || row.weightPerBaleKg || row.weight_per_bale_kg || row.weight || "").toString() ||
            undefined,
          productionPrice:
            rawProdPrice !== null && rawProdPrice !== "" ? parseFloat(String(rawProdPrice)) || undefined : undefined,
          sellingPrice:
            rawSellPrice !== null && rawSellPrice !== "" ? parseFloat(String(rawSellPrice)) || undefined : undefined,
          active: row.active === undefined ? true : Boolean(row.active),
        };
      });

      const missing = preview.filter((r) => !r.articleCode || !r.name);
      if (missing.length > 0) {
        setImportError(`${missing.length} row(s) missing required Article Code or Name`);
      }

      setImportPreview(preview.filter((r) => r.articleCode && r.name));
      setImportDialogOpen(true);
    } catch (err) {
      setImportError(getErrorDetails(err).message || "Failed to parse Excel file");
      setImportFile(null);
      toast({ title: "Parse Error", description: getErrorDetails(err).message, variant: "destructive" });
    }

    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleConfirmImport = () => {
    if (!importFile) {
      toast({ title: "No file", description: "Please select a file first", variant: "destructive" });
      return;
    }
    importMutation.mutate(importFile);
  };

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const groupedProducts: (GroupedProduct & { _key: string })[] = (() => {
    if (!activeProducts) return [];
    const groups: Record<string, GroupedProduct & { _key: string }> = {};
    for (const p of activeProducts) {
      const key = p.articleCode || p.code;
      if (!groups[key]) {
        groups[key] = { _key: key, articleCode: p.articleCode || "", name: p.name, count: 0, items: [] };
      }
      groups[key].count++;
      groups[key].items.push(p);
    }
    return Object.values(groups).sort((a, b) => (a.items[0]?.id ?? 0) - (b.items[0]?.id ?? 0));
  })();
  return { groupedProducts, handleConfirmImport, handleDownloadTemplate, handleFileSelect, toggleGroup };
}
