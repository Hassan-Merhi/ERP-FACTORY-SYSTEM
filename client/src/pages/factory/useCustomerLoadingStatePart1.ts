// Extracted from ./CustomerLoading.tsx to keep that module under the source-size cap.
import { useFactoryMhdView } from "@/hooks/use-factory-mhd-view";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import type { V5Data } from "./factorystockallocationv5/types";
import {
  buildAvailableStockMap,
  resolveAvailableStock,
  shouldIncludeAvailableStock,
} from "./customerLoadingAvailability";
import type {
  AvailableNegativeFilter,
  AvailableZeroFilter,
  ColumnKey,
  CustomerLoadingProduct,
  CustomerLoadingResponse,
  CustomerOption,
  HistoryResponse,
  LoadingFilter,
} from "./customerLoadingTypes";
import { COLUMN_PREFERENCE_KEY, initialVisibleColumns, PAGE_SIZE, readJson } from "./customerLoadingHelpers";

export function useCustomerLoadingStatePart1() {
  const mhd = useFactoryMhdView();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const recordChanges = useExistingRecordChangeAccess();
  const canCreateProforma = recordChanges.canCreate("POST", "/api/factory/customer-proformas/bulk");
  const [customerId, setCustomerId] = useState("");
  const [search, setSearch] = useState("");
  const [loadingFilter, setLoadingFilter] = useState<LoadingFilter>("ALL");
  const [categoryFilter, setCategoryFilter] = useState("ALL");
  const [weightFilter, setWeightFilter] = useState("ALL");
  const [availableZeroFilter, setAvailableZeroFilter] = useState<AvailableZeroFilter>("SHOW_ZERO");
  const [availableNegativeFilter, setAvailableNegativeFilter] = useState<AvailableNegativeFilter>("SHOW_NEGATIVE");
  const [selectedProductIds, setSelectedProductIds] = useState<Set<number>>(new Set());
  const [draftQuantities, setDraftQuantities] = useState<Record<number, string>>({});
  const [draftPrices, setDraftPrices] = useState<Record<number, string>>({});
  const [previewOpen, setPreviewOpen] = useState(false);
  const [proformaName, setProformaName] = useState("");
  const [proformaDestination, setProformaDestination] = useState("");
  const [historyProduct, setHistoryProduct] = useState<CustomerLoadingProduct | null>(null);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [visibleColumns, setVisibleColumns] = useState<Set<ColumnKey>>(initialVisibleColumns);
  const [page, setPage] = useState(1);
  const qtyRefs = useRef<Record<number, HTMLInputElement | null>>({});

  useEffect(() => {
    try {
      window.localStorage.setItem(COLUMN_PREFERENCE_KEY, JSON.stringify([...visibleColumns]));
    } catch {
      // Preferences are optional when storage is blocked.
    }
  }, [visibleColumns]);

  const customersQuery = useQuery<CustomerOption[]>({
    queryKey: ["/api/factory/customers", "customer-loading-picker"],
    queryFn: () => readJson<CustomerOption[]>("/api/factory/customers"),
    staleTime: 60_000,
  });
  const loadingQuery = useQuery<CustomerLoadingResponse>({
    queryKey: ["/api/factory/customer-loading/products", customerId],
    queryFn: () =>
      readJson<CustomerLoadingResponse>(
        `/api/factory/customer-loading/products?customerId=${encodeURIComponent(customerId)}`
      ),
    enabled: Boolean(customerId),
    staleTime: 30_000,
  });
  const stockAllocationQuery = useQuery<V5Data>({
    queryKey: ["/api/factory/v5/stock-allocation", "customer-loading"],
    queryFn: () => readJson<V5Data>("/api/factory/v5/stock-allocation"),
    enabled: Boolean(customerId),
    retry: 1,
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const historyQuery = useQuery<HistoryResponse>({
    queryKey: ["/api/factory/customer-loading/history", customerId, historyProduct?.id],
    queryFn: () =>
      readJson<HistoryResponse>(
        `/api/factory/customer-loading/history?customerId=${encodeURIComponent(customerId)}&productId=${historyProduct!.id}`
      ),
    enabled: Boolean(customerId && historyProduct),
    staleTime: 30_000,
  });

  const products = useMemo(() => loadingQuery.data?.products ?? [], [loadingQuery.data?.products]);
  const availableStockByCode = useMemo(
    () => buildAvailableStockMap(stockAllocationQuery.data?.rows ?? []),
    [stockAllocationQuery.data?.rows]
  );
  const categories = useMemo(
    () =>
      [...new Set(products.map((p) => p.categoryName).filter((v): v is string => Boolean(v)))].sort((a, b) =>
        a.localeCompare(b)
      ),
    [products]
  );
  const weights = useMemo(
    () =>
      [...new Set(products.map((p) => p.weightPerBaleKg).filter((v): v is string => Boolean(v)))].sort(
        (a, b) => Number(a) - Number(b)
      ),
    [products]
  );
  const filteredProducts = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return products.filter((product) => {
      if (loadingFilter !== "ALL" && product.loadingStatus !== loadingFilter) return false;
      if (categoryFilter !== "ALL" && product.categoryName !== categoryFilter) return false;
      if (weightFilter !== "ALL" && product.weightPerBaleKg !== weightFilter) return false;
      const availableStock = resolveAvailableStock(product, availableStockByCode);
      if (
        !shouldIncludeAvailableStock(availableStock, {
          showZeroStock: availableZeroFilter === "SHOW_ZERO",
          showNegativeStock: availableNegativeFilter === "SHOW_NEGATIVE",
        })
      )
        return false;
      if (!needle) return true;
      return [
        product.name,
        mhd.nameFor(product.articleCode || product.code, product.name),
        product.nameAr,
        product.code,
        product.articleCode,
        product.categoryName,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase().includes(needle));
    });
  }, [
    products,
    loadingFilter,
    categoryFilter,
    weightFilter,
    availableZeroFilter,
    availableNegativeFilter,
    availableStockByCode,
    search,
    mhd,
  ]);

  const displayedProducts = mhd.sortRows(filteredProducts, (product) => product.articleCode || product.code);
  const pageCount = Math.max(1, Math.ceil(filteredProducts.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const visibleProducts = displayedProducts.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const selectedLines = useMemo(
    () =>
      products
        .filter((p) => selectedProductIds.has(p.id))
        .map((product) => {
          const quantity = Math.max(0, Number.parseInt(draftQuantities[product.id] || "0", 10) || 0);
          const rawPrice = draftPrices[product.id] ?? product.sellingPrice ?? "0";
          const parsedPrice = Number(rawPrice);
          const pricePerBale = Number.isFinite(parsedPrice) && parsedPrice >= 0 ? parsedPrice : 0;
          const weightPerBale = Number(product.weightPerBaleKg ?? 0) || 0;
          return {
            product,
            quantity,
            rawPrice,
            pricePerBale,
            priceValid: rawPrice !== "" && Number.isFinite(parsedPrice) && parsedPrice >= 0,
            totalKg: quantity * weightPerBale,
            lineTotal: quantity * pricePerBale,
          };
        }),
    [products, selectedProductIds, draftQuantities, draftPrices]
  );
  const validSelectedLines = selectedLines.filter(
    (line) => line.quantity > 0 && line.priceValid && (line.product.articleCode || line.product.code)
  );
  const hasInvalidSelectedLine = selectedLines.some(
    (line) => line.quantity <= 0 || !line.priceValid || !(line.product.articleCode || line.product.code)
  );
  const selectedTotals = validSelectedLines.reduce(
    (t, line) => ({
      lines: t.lines + 1,
      quantity: t.quantity + line.quantity,
      kg: t.kg + line.totalKg,
      amount: t.amount + line.lineTotal,
    }),
    { lines: 0, quantity: 0, kg: 0, amount: 0 }
  );
  return {
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
  };
}
