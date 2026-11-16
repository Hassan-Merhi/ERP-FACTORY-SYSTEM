// Extracted from ./useBaleProductsModel.tsx to keep that module under the source-size cap.
import { useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import type { FactoryBaleProduct } from "@shared/schema";
import { downloadNoPriceBaleOrderSheet, downloadPricedBaleOrderSheet } from "./baleOrderSheetExport";
import { useBaleProductsModelPart1 } from "./useBaleProductsModelPart1";

export function useBaleProductsModelPart2({
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
}: Pick<
  Awaited<ReturnType<typeof useBaleProductsModelPart1>>,
  | "activeProducts"
  | "categoryMap"
  | "editForm"
  | "editingProduct"
  | "hideAvgRate"
  | "hideSellingPriceBP"
  | "modeApiRequest"
  | "recordChanges"
  | "setEditingProduct"
  | "setImportDialogOpen"
  | "setImportFile"
  | "setImportPreview"
  | "setSelectedIds"
  | "toast"
>) {
  const importMutation = useMutation({
    mutationFn: async (file: File) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch("/api/factory/bale-products/import-excel", {
        method: "POST",
        body: formData,
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || "Import failed");
      }
      return response.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/categories"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/location-inventory"], exact: false });

      const cols = result.detectedColumns || {};
      const detectedInfo = [
        cols.articleCode ? `Article Code: "${cols.articleCode}"` : null,
        cols.productionPrice ? `Cost Price: "${cols.productionPrice}"` : null,
        cols.sellingPrice ? `Sell Price: "${cols.sellingPrice}"` : null,
      ]
        .filter(Boolean)
        .join(", ");

      const noPriceColsFound = !cols.productionPrice && !cols.sellingPrice;
      const allSkipped = result.skippedNoArticleCode > 0 && result.created + result.updated === 0;

      if (allSkipped || !cols.articleCode) {
        toast({
          title: "Import Warning",
          description: `No products were matched — article code column not found. Your file must have a column named "Article Code". Columns seen: ${
            Object.keys(result.detectedColumns || {})
              .filter((k) => result.detectedColumns[k])
              .map((k: string) => `"${result.detectedColumns[k]}"`)
              .join(", ") || "none detected"
          }`,
          variant: "destructive",
        });
      } else if (noPriceColsFound) {
        toast({
          title: "Import Complete — No Prices Updated",
          description: `${result.updated || 0} updated, ${result.created || 0} created. Column detected: ${detectedInfo}. No price columns found — add "Production Price" and/or "Selling Price" columns to your file.`,
          variant: "destructive",
        });
      } else {
        const parts = [];
        if (result.created) parts.push(`${result.created} created`);
        if (result.updated) parts.push(`${result.updated} updated`);
        if (result.pricesUpdated) parts.push(`${result.pricesUpdated} with prices`);
        if (result.categoriesCreated) parts.push(`${result.categoriesCreated} categories auto-created`);
        toast({
          title: "Import Complete",
          description:
            (parts.join(", ") || "0 products processed") + (detectedInfo ? ` | Columns: ${detectedInfo}` : ""),
        });
      }

      setImportDialogOpen(false);
      setImportPreview([]);
      setImportFile(null);
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Import Error", description: error.message, variant: "destructive" });
    },
  });

  const editProductMutation = useMutation({
    mutationFn: async (
      data: Partial<{
        name: string;
        weightPerBaleKg: number | null;
        articleCode: string;
        description: string;
        categoryId: number | null;
        labelDesignColor: string | null;
        productionPrice: string;
        sellingPrice: string;
        grade: string;
      }>
    ) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      if (!editingProduct) throw new Error("Select a product before saving changes");
      const response = await modeApiRequest(
        "POST",
        `/api/factory/bale-products/${editingProduct.id}/cascade-update`,
        data
      );
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.message || "Failed to update bale product");
      if (!result?.product) throw new Error("The product update returned an invalid response");
      return result;
    },
    onSuccess: (result: { product: FactoryBaleProduct; balesUpdated: number }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/location-inventory"], exact: false });
      setEditingProduct(null);
      toast({
        title: "Product updated",
        description: `${result.balesUpdated} bale(s) also updated`,
      });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const colorUpdateMutation = useMutation({
    mutationFn: async ({ id, labelDesignColor }: { id: number; labelDesignColor: string | null }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const response = await modeApiRequest("POST", `/api/factory/bale-products/${id}/cascade-update`, {
        labelDesignColor,
      });
      if (!response.ok) {
        const details = await response.json().catch(() => ({}));
        throw new Error(details.message || "Failed to update label color");
      }
      return response.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products"] });
      toast({ title: "Label color updated" });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const deleteProductMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const response = await modeApiRequest("DELETE", `/api/factory/bale-products/${id}`);
      if (!response.ok) throw new Error("Failed to delete product");
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products"] });
      setEditingProduct(null);
      toast({ title: "Product deleted", description: "The product has been removed." });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const bulkToggleActiveMutation = useMutation({
    mutationFn: async ({ ids, active }: { ids: number[]; active: boolean }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const response = await modeApiRequest("POST", "/api/factory/bale-products/bulk-toggle-active", { ids, active });
      if (!response.ok) throw new Error("Failed to update products");
      return response.json();
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products"] });
      setSelectedIds(new Set());
      toast({
        title: variables.active ? "Products unhidden" : "Products hidden",
        description: `${variables.ids.length} product(s) updated.`,
      });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const handleEditSubmit = () => {
    if (!editForm.name.trim()) return;
    editProductMutation.mutate({
      name: editForm.name.trim(),
      articleCode: editForm.articleCode.trim(),
      weightPerBaleKg: editForm.weightPerBaleKg ? parseFloat(editForm.weightPerBaleKg) : null,
      categoryId: editForm.categoryId ? parseInt(editForm.categoryId) : null,
      description: editForm.description.trim(),
      productionPrice: editForm.productionPrice,
      sellingPrice: editForm.sellingPrice,
      labelDesignColor: editForm.labelDesignColor || null,
    });
  };

  const handleExportExcel = async (priceType: "selling" | "production") => {
    if (priceType === "selling" && hideSellingPriceBP) {
      toast({ title: "Selling price is hidden for your account", variant: "destructive" });
      return;
    }
    if (priceType === "production" && hideAvgRate) {
      toast({ title: "Production price is hidden for your account", variant: "destructive" });
      return;
    }
    if (!activeProducts || activeProducts.length === 0) {
      toast({ title: "No products to export", variant: "destructive" });
      return;
    }
    try {
      const { priceHeader } = await downloadPricedBaleOrderSheet({
        priceType,
        products: activeProducts,
        categoryMap,
      });
      toast({ title: `Order sheet downloaded — ${priceHeader}` });
    } catch (err) {
      console.error("Export failed", err);
      toast({ title: "Export failed", variant: "destructive" });
    }
  };

  const handleExportNoPrices = async () => {
    if (!activeProducts || activeProducts.length === 0) {
      toast({ title: "No products to export", variant: "destructive" });
      return;
    }
    try {
      await downloadNoPriceBaleOrderSheet({ products: activeProducts, categoryMap });
      toast({ title: "Order sheet (no prices) downloaded" });
    } catch (err) {
      console.error("Export failed", err);
      toast({ title: "Export failed", variant: "destructive" });
    }
  };
  return {
    bulkToggleActiveMutation,
    colorUpdateMutation,
    deleteProductMutation,
    editProductMutation,
    handleEditSubmit,
    handleExportExcel,
    handleExportNoPrices,
    importMutation,
  };
}
