import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Loader2, Search, ShoppingCart, UsersRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { V5Data } from "./factorystockallocationv5/types";
import {
  buildAvailableStockMap,
  resolveAvailableStock,
  shouldIncludeAvailableStock,
} from "./customerLoadingAvailability";
import { CustomerLoadingSummaryCards } from "./CustomerLoadingSummaryCards";
import { CustomerLoadingColumnsDialog } from "./CustomerLoadingColumnsDialog";
import { CustomerLoadingProformaDialog } from "./CustomerLoadingProformaDialog";
import { CustomerLoadingHistoryDialog } from "./CustomerLoadingHistoryDialog";
import { formatDate, formatMoney, formatNumber } from "./customerLoadingFormat";
import {
  COLUMN_OPTIONS,
  type AvailableNegativeFilter,
  type AvailableZeroFilter,
  type ColumnKey,
  type CustomerLoadingProduct,
  type CustomerLoadingResponse,
  type CustomerOption,
  type HistoryResponse,
  type LoadingFilter,
} from "./customerLoadingTypes";

const PAGE_SIZE = 75;

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.message || "Request failed");
  return payload as T;
}
export default function CustomerLoading() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
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
  const [historyProduct, setHistoryProduct] = useState<CustomerLoadingProduct | null>(null);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [visibleColumns, setVisibleColumns] = useState<Set<ColumnKey>>(
    () => new Set(COLUMN_OPTIONS.map((column) => column.key))
  );
  const [page, setPage] = useState(1);
  const qtyRefs = useRef<Record<number, HTMLInputElement | null>>({});

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
      return [product.name, product.nameAr, product.code, product.articleCode, product.categoryName]
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
  ]);

  const pageCount = Math.max(1, Math.ceil(filteredProducts.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const visibleProducts = filteredProducts.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

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

  const createProformaMutation = useMutation({
    mutationFn: async () => {
      if (!customerId || validSelectedLines.length === 0 || hasInvalidSelectedLine)
        throw new Error("Every selected product needs a quantity and a valid non-negative price.");
      const name = proformaName.trim();
      if (!name) throw new Error("Proforma name is required.");
      const response = await apiRequest("POST", "/api/factory/customer-proformas/bulk", {
        customerId: Number(customerId),
        name,
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
  function openPreview() {
    if (validSelectedLines.length === 0 || hasInvalidSelectedLine) {
      toast({
        title: "Check selected products",
        description: "Every selected product needs a quantity and a valid non-negative price.",
        variant: "destructive",
      });
      return;
    }
    if (!proformaName.trim())
      setProformaName(
        `${loadingQuery.data?.customer.legalName || "Customer"} - ${new Date().toISOString().slice(0, 10)}`
      );
    setPreviewOpen(true);
  }
  function moveQtyFocus(productId: number, direction: number) {
    const index = visibleProducts.findIndex((product) => product.id === productId);
    const next = visibleProducts[index + direction];
    if (!next) return;
    const input = qtyRefs.current[next.id];
    input?.focus();
    input?.select();
  }

  return (
    <div
      className="mx-auto flex w-full max-w-[1800px] flex-col gap-5 p-4 pb-24 md:p-6 md:pb-24"
      data-testid="customer-loading-page"
    >
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Customer Loading</h1>
        <p className="text-sm text-muted-foreground">
          See what each customer has loaded, inspect history, select items, and create a proforma directly.
        </p>
      </div>
      <Card>
        <CardContent className="grid gap-4 p-4 lg:grid-cols-[minmax(280px,420px)_1fr] lg:items-end">
          <div className="space-y-2">
            <div className="text-sm font-medium">Customer</div>
            <Select
              value={customerId}
              onValueChange={(value) => {
                setCustomerId(value);
                resetFilters();
                resetSelection();
                setProformaName("");
                setHistoryProduct(null);
              }}
            >
              <SelectTrigger data-testid="customer-loading-customer-select">
                <SelectValue placeholder={customersQuery.isLoading ? "Loading customers…" : "Choose a customer"} />
              </SelectTrigger>
              <SelectContent>
                {(customersQuery.data ?? []).map((customer) => (
                  <SelectItem key={customer.id} value={String(customer.id)}>
                    {customer.legalName}
                    {customer.code ? ` · ${customer.code}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="text-sm text-muted-foreground lg:text-right">
            {loadingQuery.data?.customer
              ? `Viewing product history for ${loadingQuery.data.customer.legalName}`
              : "Select a customer to begin"}
          </div>
        </CardContent>
      </Card>

      {!customerId ? (
        <Card>
          <CardContent className="flex min-h-[300px] flex-col items-center justify-center gap-3 p-8 text-center">
            <div className="rounded-full bg-muted p-4">
              <UsersRound className="h-7 w-7 text-muted-foreground" />
            </div>
            <div>
              <div className="font-medium">Choose a customer</div>
              <div className="mt-1 text-sm text-muted-foreground">
                Their loaded and never-loaded products will appear here.
              </div>
            </div>
          </CardContent>
        </Card>
      ) : loadingQuery.isLoading ? (
        <div className="flex min-h-[320px] items-center justify-center">
          <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
        </div>
      ) : loadingQuery.isError ? (
        <Card>
          <CardContent className="p-6 text-sm text-destructive">{(loadingQuery.error as Error).message}</CardContent>
        </Card>
      ) : (
        <>
          <CustomerLoadingSummaryCards summary={summary} formatNumber={formatNumber} />

          <Card className="overflow-hidden">
            <div className="flex flex-col gap-3 border-b p-4 xl:flex-row xl:items-center xl:justify-between">
              <div>
                <div className="font-semibold">Product List</div>
                <div className="text-xs text-muted-foreground">
                  {filteredProducts.length} of {products.length} products · {selectedProductIds.size} selected
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 xl:flex xl:items-center">
                <div className="relative sm:col-span-2 xl:w-72">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setPage(1);
                    }}
                    placeholder="Search name, Arabic, or code"
                    className="pl-9"
                    data-testid="customer-loading-search"
                  />
                </div>
                <Select
                  value={loadingFilter}
                  onValueChange={(v) => {
                    setLoadingFilter(v as LoadingFilter);
                    setPage(1);
                  }}
                >
                  <SelectTrigger className="xl:w-44" data-testid="customer-loading-status-filter">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">All statuses</SelectItem>
                    <SelectItem value="LOADED">Loaded</SelectItem>
                    <SelectItem value="NEVER_LOADED">Never loaded</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={categoryFilter}
                  onValueChange={(v) => {
                    setCategoryFilter(v);
                    setPage(1);
                  }}
                >
                  <SelectTrigger className="xl:w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">All categories</SelectItem>
                    {categories.map((category) => (
                      <SelectItem key={category} value={category}>
                        {category}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={weightFilter}
                  onValueChange={(v) => {
                    setWeightFilter(v);
                    setPage(1);
                  }}
                >
                  <SelectTrigger className="xl:w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">All weights</SelectItem>
                    {weights.map((weight) => (
                      <SelectItem key={weight} value={weight}>
                        {formatNumber(Number(weight), 2)} kg
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={availableZeroFilter}
                  onValueChange={(v) => {
                    setAvailableZeroFilter(v as AvailableZeroFilter);
                    setPage(1);
                  }}
                >
                  <SelectTrigger className="xl:w-36" data-testid="customer-loading-zero-stock-filter">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="SHOW_ZERO">Show 0</SelectItem>
                    <SelectItem value="HIDE_ZERO">Hide 0</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={availableNegativeFilter}
                  onValueChange={(v) => {
                    setAvailableNegativeFilter(v as AvailableNegativeFilter);
                    setPage(1);
                  }}
                >
                  <SelectTrigger className="xl:w-44" data-testid="customer-loading-negative-stock-filter">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="SHOW_NEGATIVE">Show Negative</SelectItem>
                    <SelectItem value="HIDE_NEGATIVE">Hide Negative</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  onClick={() => setColumnsOpen(true)}
                  data-testid="customer-loading-columns-button"
                >
                  Columns
                </Button>
              </div>
            </div>

            <div className="max-h-[62vh] overflow-auto">
              <table className="w-full min-w-[1100px] border-collapse text-sm">
                <thead className="sticky top-0 z-30 bg-card shadow-[0_1px_0_hsl(var(--border))]">
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="sticky left-0 z-40 w-12 bg-card px-3 py-3">
                      <Checkbox
                        checked={allVisibleSelected}
                        onCheckedChange={(checked) => {
                          setSelectedProductIds((current) => {
                            const next = new Set(current);
                            for (const p of visibleProducts) checked ? next.add(p.id) : next.delete(p.id);
                            return next;
                          });
                          if (checked)
                            setDraftQuantities((current) => {
                              const next = { ...current };
                              visibleProducts.forEach((p) => {
                                if (!next[p.id]) next[p.id] = "1";
                              });
                              return next;
                            });
                        }}
                        aria-label="Select visible products"
                      />
                    </th>
                    {isColumnVisible("articleCode") && (
                      <th className="min-w-[130px] px-4 py-3 font-medium">Article Code</th>
                    )}
                    {isColumnVisible("product") && <th className="min-w-[220px] px-4 py-3 font-medium">Product</th>}
                    {isColumnVisible("arabicName") && (
                      <th className="min-w-[180px] px-4 py-3 font-medium">Arabic Name</th>
                    )}
                    {isColumnVisible("category") && <th className="px-4 py-3 font-medium">Category</th>}
                    {isColumnVisible("weight") && <th className="px-4 py-3 text-right font-medium">Wt/Bale</th>}
                    {isColumnVisible("sellPrice") && <th className="px-4 py-3 text-right font-medium">Sell Price</th>}
                    {isColumnVisible("availableStock") && (
                      <th className="px-4 py-3 text-right font-medium">Available Stock</th>
                    )}
                    {isColumnVisible("status") && <th className="px-4 py-3 font-medium">Status</th>}
                    {isColumnVisible("totalLoaded") && (
                      <th className="px-4 py-3 text-right font-medium">Total Loaded</th>
                    )}
                    {isColumnVisible("totalKg") && <th className="px-4 py-3 text-right font-medium">Total KG</th>}
                    {isColumnVisible("lastLoaded") && <th className="px-4 py-3 font-medium">Last Loaded</th>}
                    {isColumnVisible("qty") && <th className="px-4 py-3 text-right font-medium">Qty</th>}
                  </tr>
                </thead>
                <tbody>
                  {visibleProducts.map((product) => {
                    const selected = selectedProductIds.has(product.id);
                    const rawPrice = draftPrices[product.id] ?? product.sellingPrice ?? "0";
                    const availableStock = resolveAvailableStock(product, availableStockByCode);
                    return (
                      <tr
                        key={product.id}
                        className={`border-b last:border-b-0 hover:bg-muted/30 ${selected ? "bg-primary/5" : ""}`}
                        data-testid={`customer-loading-product-${product.id}`}
                      >
                        <td className="sticky left-0 z-20 bg-inherit px-3 py-3">
                          <Checkbox
                            checked={selected}
                            onCheckedChange={(checked) => toggleProduct(product, Boolean(checked))}
                            aria-label={`Select ${product.name}`}
                          />
                        </td>
                        {isColumnVisible("articleCode") && (
                          <td className="whitespace-nowrap px-4 py-3 font-mono text-xs">
                            {product.articleCode || product.code}
                          </td>
                        )}
                        {isColumnVisible("product") && <td className="px-4 py-3 font-medium">{product.name}</td>}
                        {isColumnVisible("arabicName") && (
                          <td className="px-4 py-3 text-right" dir="rtl">
                            {product.nameAr || "—"}
                          </td>
                        )}
                        {isColumnVisible("category") && (
                          <td className="px-4 py-3 text-muted-foreground">{product.categoryName || "—"}</td>
                        )}
                        {isColumnVisible("weight") && (
                          <td className="px-4 py-3 text-right tabular-nums">
                            {product.weightPerBaleKg ? `${formatNumber(Number(product.weightPerBaleKg), 2)} kg` : "—"}
                          </td>
                        )}
                        {isColumnVisible("sellPrice") && (
                          <td className="px-4 py-2 text-right">
                            {selected ? (
                              <Input
                                value={rawPrice}
                                onChange={(e) =>
                                  setDraftPrices((current) => ({ ...current, [product.id]: e.target.value }))
                                }
                                inputMode="decimal"
                                className="ml-auto h-8 w-24 text-right tabular-nums"
                                aria-label={`Price for ${product.name}`}
                              />
                            ) : (
                              <span className="tabular-nums">{formatMoney(product.sellingPrice)}</span>
                            )}
                          </td>
                        )}
                        {isColumnVisible("availableStock") && (
                          <td
                            className={`px-4 py-3 text-right font-medium tabular-nums ${availableStock !== null && availableStock < 0 ? "text-destructive" : ""}`}
                          >
                            {stockAllocationQuery.isLoading
                              ? "…"
                              : availableStock === null
                                ? "—"
                                : formatNumber(availableStock)}
                          </td>
                        )}
                        {isColumnVisible("status") && (
                          <td className="px-4 py-3">
                            <button
                              type="button"
                              className="text-left"
                              onClick={() => product.loadingStatus === "LOADED" && setHistoryProduct(product)}
                              disabled={product.loadingStatus !== "LOADED"}
                            >
                              {product.loadingStatus === "LOADED" ? (
                                <Badge variant="secondary" className="cursor-pointer hover:bg-secondary/80">
                                  Loaded · {product.loadingCount}
                                </Badge>
                              ) : (
                                <Badge variant="outline">Never loaded</Badge>
                              )}
                            </button>
                          </td>
                        )}
                        {isColumnVisible("totalLoaded") && (
                          <td className="px-4 py-3 text-right font-medium tabular-nums">
                            {formatNumber(product.totalBalesLoaded)}
                          </td>
                        )}
                        {isColumnVisible("totalKg") && (
                          <td className="px-4 py-3 text-right tabular-nums">
                            {formatNumber(product.totalKgLoaded, 1)}
                          </td>
                        )}
                        {isColumnVisible("lastLoaded") && (
                          <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                            {formatDate(product.lastLoadedAt)}
                          </td>
                        )}
                        {isColumnVisible("qty") && (
                          <td className="px-4 py-2 text-right">
                            <Input
                              ref={(node) => {
                                qtyRefs.current[product.id] = node;
                              }}
                              inputMode="numeric"
                              min={0}
                              value={draftQuantities[product.id] ?? ""}
                              onChange={(e) => {
                                const value = e.target.value.replace(/[^0-9]/g, "");
                                setDraftQuantities((current) => ({ ...current, [product.id]: value }));
                                if (Number(value) > 0) selectProductFromQuantity(product.id);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === "ArrowDown") {
                                  e.preventDefault();
                                  moveQtyFocus(product.id, 1);
                                } else if (e.key === "ArrowUp") {
                                  e.preventDefault();
                                  moveQtyFocus(product.id, -1);
                                }
                              }}
                              placeholder="0"
                              className="ml-auto h-8 w-20 text-right tabular-nums"
                              aria-label={`Quantity for ${product.name}`}
                            />
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {filteredProducts.length === 0 && (
                <div className="p-10 text-center text-sm text-muted-foreground">
                  No products match the current filters.
                </div>
              )}
            </div>
            <div className="flex flex-col gap-2 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-xs text-muted-foreground">
                Showing {filteredProducts.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1}–
                {Math.min(safePage * PAGE_SIZE, filteredProducts.length)} of {filteredProducts.length}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={safePage <= 1}
                >
                  <ChevronLeft className="h-4 w-4" /> Previous
                </Button>
                <span className="text-xs text-muted-foreground">
                  Page {safePage} of {pageCount}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                  disabled={safePage >= pageCount}
                >
                  Next <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </Card>
        </>
      )}

      {selectedProductIds.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-50 border-t bg-background/95 px-4 py-3 shadow-2xl backdrop-blur-sm md:left-(--sidebar-width,0px)">
          <div className="mx-auto flex max-w-[1800px] flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
              <span>
                <strong>{selectedTotals.lines}</strong> ready products
              </span>
              <span>
                <strong>{formatNumber(selectedTotals.quantity)}</strong> bales
              </span>
              <span>
                <strong>{formatNumber(selectedTotals.kg, 1)}</strong> kg
              </span>
              <span>
                <strong>{formatMoney(selectedTotals.amount)}</strong> total
              </span>
              {hasInvalidSelectedLine && <span className="text-destructive">Fix selected lines before creating</span>}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={resetSelection}>
                Clear
              </Button>
              <Button onClick={openPreview} disabled={validSelectedLines.length === 0 || hasInvalidSelectedLine}>
                <ShoppingCart className="mr-2 h-4 w-4" />
                Create Proforma
              </Button>
            </div>
          </div>
        </div>
      )}

      <CustomerLoadingColumnsDialog
        open={columnsOpen}
        onOpenChange={setColumnsOpen}
        visibleColumns={visibleColumns}
        onToggleColumn={toggleColumn}
        onShowAll={() => setVisibleColumns(new Set(COLUMN_OPTIONS.map((column) => column.key)))}
      />

      <CustomerLoadingProformaDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        customerName={loadingQuery.data?.customer.legalName}
        proformaName={proformaName}
        onProformaNameChange={setProformaName}
        lines={validSelectedLines}
        totals={selectedTotals}
        isPending={createProformaMutation.isPending}
        onCreate={() => createProformaMutation.mutate()}
      />

      <CustomerLoadingHistoryDialog
        product={historyProduct}
        onClose={() => setHistoryProduct(null)}
        customerName={loadingQuery.data?.customer.legalName}
        isLoading={historyQuery.isLoading}
        isError={historyQuery.isError}
        error={historyQuery.error as Error | null}
        data={historyQuery.data}
      />
    </div>
  );
}
