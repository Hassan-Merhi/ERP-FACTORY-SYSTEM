// Extracted from ./CustomerLoading.tsx to keep that module under the source-size cap.
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { ColumnKey, CustomerLoadingProduct } from "./customerLoadingTypes";
import { useCustomerLoadingStatePart1 } from "./useCustomerLoadingStatePart1";

export function useCustomerLoadingState() {
  const {
    availableNegativeFilter,
    availableStockByCode,
    availableZeroFilter,
    canCreateProforma,
    categories,
    categoryFilter,
    columnsOpen,
    customerId,
    customersQuery,
    draftPrices,
    draftQuantities,
    filteredProducts,
    hasInvalidSelectedLine,
    historyProduct,
    historyQuery,
    loadingFilter,
    loadingQuery,
    mhd,
    pageCount,
    previewOpen,
    products,
    proformaDestination,
    proformaName,
    qtyRefs,
    queryClient,
    safePage,
    search,
    selectedProductIds,
    selectedTotals,
    setAvailableNegativeFilter,
    setAvailableZeroFilter,
    setCategoryFilter,
    setColumnsOpen,
    setCustomerId,
    setDraftPrices,
    setDraftQuantities,
    setHistoryProduct,
    setLoadingFilter,
    setPage,
    setPreviewOpen,
    setProformaDestination,
    setProformaName,
    setSearch,
    setSelectedProductIds,
    setVisibleColumns,
    setWeightFilter,
    stockAllocationQuery,
    toast,
    validSelectedLines,
    visibleColumns,
    visibleProducts,
    weightFilter,
    weights,
  } = useCustomerLoadingStatePart1();
  const {
    allVisibleSelected,
    createProformaMutation,
    isColumnVisible,
    resetFilters,
    resetSelection,
    selectProductFromQuantity,
    summary,
    toggleColumn,
    toggleProduct,
  } = useCustomerLoadingStatePart2({
    customerId,
    draftQuantities,
    hasInvalidSelectedLine,
    loadingQuery,
    proformaDestination,
    proformaName,
    queryClient,
    selectedProductIds,
    setAvailableNegativeFilter,
    setAvailableZeroFilter,
    setCategoryFilter,
    setDraftPrices,
    setDraftQuantities,
    setLoadingFilter,
    setPage,
    setPreviewOpen,
    setProformaDestination,
    setProformaName,
    setSearch,
    setSelectedProductIds,
    setVisibleColumns,
    setWeightFilter,
    toast,
    validSelectedLines,
    visibleColumns,
    visibleProducts,
  });
  return {
    allVisibleSelected,
    availableNegativeFilter,
    availableStockByCode,
    availableZeroFilter,
    canCreateProforma,
    categories,
    categoryFilter,
    columnsOpen,
    createProformaMutation,
    customerId,
    customersQuery,
    draftPrices,
    draftQuantities,
    filteredProducts,
    hasInvalidSelectedLine,
    historyProduct,
    historyQuery,
    isColumnVisible,
    loadingFilter,
    loadingQuery,
    mhd,
    pageCount,
    previewOpen,
    products,
    proformaDestination,
    proformaName,
    qtyRefs,
    resetFilters,
    resetSelection,
    safePage,
    search,
    selectProductFromQuantity,
    selectedProductIds,
    selectedTotals,
    setAvailableNegativeFilter,
    setAvailableZeroFilter,
    setCategoryFilter,
    setColumnsOpen,
    setCustomerId,
    setDraftPrices,
    setDraftQuantities,
    setHistoryProduct,
    setLoadingFilter,
    setPage,
    setPreviewOpen,
    setProformaDestination,
    setProformaName,
    setSearch,
    setSelectedProductIds,
    setVisibleColumns,
    setWeightFilter,
    stockAllocationQuery,
    summary,
    toast,
    toggleColumn,
    toggleProduct,
    validSelectedLines,
    visibleColumns,
    visibleProducts,
    weightFilter,
    weights,
  };
}

function useCustomerLoadingStatePart2({
  customerId,
  draftQuantities,
  hasInvalidSelectedLine,
  loadingQuery,
  proformaDestination,
  proformaName,
  queryClient,
  selectedProductIds,
  setAvailableNegativeFilter,
  setAvailableZeroFilter,
  setCategoryFilter,
  setDraftPrices,
  setDraftQuantities,
  setLoadingFilter,
  setPage,
  setPreviewOpen,
  setProformaDestination,
  setProformaName,
  setSearch,
  setSelectedProductIds,
  setVisibleColumns,
  setWeightFilter,
  toast,
  validSelectedLines,
  visibleColumns,
  visibleProducts,
}: Pick<
  Awaited<ReturnType<typeof useCustomerLoadingStatePart1>>,
  | "customerId"
  | "draftQuantities"
  | "hasInvalidSelectedLine"
  | "loadingQuery"
  | "proformaDestination"
  | "proformaName"
  | "queryClient"
  | "selectedProductIds"
  | "setAvailableNegativeFilter"
  | "setAvailableZeroFilter"
  | "setCategoryFilter"
  | "setDraftPrices"
  | "setDraftQuantities"
  | "setLoadingFilter"
  | "setPage"
  | "setPreviewOpen"
  | "setProformaDestination"
  | "setProformaName"
  | "setSearch"
  | "setSelectedProductIds"
  | "setVisibleColumns"
  | "setWeightFilter"
  | "toast"
  | "validSelectedLines"
  | "visibleColumns"
  | "visibleProducts"
>) {
  const createProformaMutation = useMutation({
    mutationFn: async () => {
      if (!customerId || validSelectedLines.length === 0 || hasInvalidSelectedLine)
        throw new Error("Every selected product needs a quantity and a valid non-negative price.");
      const name = proformaName.trim();
      if (!name) throw new Error("Proforma name is required.");
      if (!proformaDestination.trim()) throw new Error("Proforma destination is required.");
      const response = await apiRequest("POST", "/api/factory/customer-proformas/bulk", {
        customerId: Number(customerId),
        name,
        destination: proformaDestination.trim(),
        isActive: true,
        lines: validSelectedLines.map(({ product, quantity, pricePerBale }) => ({
          articleCode: product.articleCode || product.code,
          productName: product.name,
          quantity,
          pricePerBale: String(pricePerBale),
          productionPricePerBale: String(product.productionPrice ?? "0"),
          pricingMode: "per_bale",
        })),
      });
      return response.json();
    },
    onSuccess: (created) => {
      setPreviewOpen(false);
      resetSelection();
      setProformaName("");
      setProformaDestination("");
      void queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-proformas"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/factory/v2/stock-allocation"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/factory/v5/stock-allocation"] });
      toast({
        title: "Proforma created",
        description: created?.name
          ? `${created.name} was created successfully.`
          : "The proforma was created successfully.",
      });
    },
    onError: (error: Error) =>
      toast({ title: "Failed to create proforma", description: error.message, variant: "destructive" }),
  });

  const summary = loadingQuery.data?.summary;
  const allVisibleSelected = visibleProducts.length > 0 && visibleProducts.every((p) => selectedProductIds.has(p.id));
  const isColumnVisible = (key: ColumnKey) => visibleColumns.has(key);

  function resetSelection() {
    setSelectedProductIds(new Set());
    setDraftQuantities({});
    setDraftPrices({});
  }
  function resetFilters() {
    setSearch("");
    setLoadingFilter("ALL");
    setCategoryFilter("ALL");
    setWeightFilter("ALL");
    setAvailableZeroFilter("SHOW_ZERO");
    setAvailableNegativeFilter("SHOW_NEGATIVE");
    setPage(1);
  }
  function toggleProduct(product: CustomerLoadingProduct, checked: boolean) {
    setSelectedProductIds((current) => {
      const next = new Set(current);
      checked ? next.add(product.id) : next.delete(product.id);
      return next;
    });
    if (checked && !draftQuantities[product.id]) setDraftQuantities((current) => ({ ...current, [product.id]: "1" }));
  }
  function selectProductFromQuantity(productId: number) {
    setSelectedProductIds((current) => {
      if (current.has(productId)) return current;
      const next = new Set(current);
      next.add(productId);
      return next;
    });
  }
  function toggleColumn(key: ColumnKey, checked: boolean) {
    setVisibleColumns((current) => {
      const next = new Set(current);
      checked ? next.add(key) : next.delete(key);
      return next;
    });
  }
  return {
    allVisibleSelected,
    createProformaMutation,
    isColumnVisible,
    resetFilters,
    resetSelection,
    selectProductFromQuantity,
    summary,
    toggleColumn,
    toggleProduct,
  };
}
