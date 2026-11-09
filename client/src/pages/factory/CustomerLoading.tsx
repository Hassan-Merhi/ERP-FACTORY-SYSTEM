import { useFactoryMhdView } from "@/hooks/use-factory-mhd-view";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  Columns3,
  History,
  Loader2,
  Package,
  Search,
  ShoppingCart,
  SlidersHorizontal,
  Truck,
  UserRound,
  UsersRound,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
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
const COLUMN_PREFERENCE_KEY = "factory.customer-loading.visible-columns.v1";

/** Only column presentation is persisted; selection, quantities, and proforma data are not stored. */
function initialVisibleColumns(): Set<ColumnKey> {
  const defaults = new Set(COLUMN_OPTIONS.map((column) => column.key));
  if (typeof window === "undefined") return defaults;
  try {
    const stored = window.localStorage.getItem(COLUMN_PREFERENCE_KEY);
    if (stored === null) return defaults;
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return defaults;
    return new Set(COLUMN_OPTIONS.filter((column) => parsed.includes(column.key)).map((column) => column.key));
  } catch {
    return defaults;
  }
}

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.message || "Request failed");
  return payload as T;
}
export default function CustomerLoading() {
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
      <section className="relative isolate overflow-hidden rounded-2xl border border-indigo-200/80 bg-gradient-to-r from-slate-50 via-blue-50/70 to-indigo-100/70 p-5 shadow-sm dark:border-indigo-400/25 dark:from-[#101b30] dark:via-[#142644] dark:to-[#172b4b] sm:p-6">
        <div
          className="pointer-events-none absolute -right-8 -top-20 h-64 w-64 rounded-full bg-indigo-400/10 blur-3xl dark:bg-indigo-400/15"
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute bottom-0 right-12 hidden text-indigo-400/15 dark:text-blue-200/10 lg:block"
          aria-hidden="true"
        >
          <Package className="h-40 w-40 -rotate-12" strokeWidth={1} />
        </div>
        <div className="relative flex items-center gap-4">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-700 text-white shadow-lg shadow-violet-600/20">
            <Truck className="h-7 w-7" />
          </div>
          <div className="min-w-0">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-indigo-700/75 dark:text-indigo-200/75">
              Bale Explorer / Customer History
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-950 dark:text-white sm:text-3xl">
              Customer Loading
            </h1>
            <p className="mt-1 max-w-3xl text-sm text-slate-600 dark:text-blue-100/75">
              See what each customer has loaded, inspect history, select items, and create a proforma directly.
            </p>
          </div>
        </div>
      </section>

      <Card className="overflow-hidden rounded-2xl border-indigo-200 bg-gradient-to-r from-indigo-50 via-white to-violet-50 shadow-sm dark:border-indigo-400/35 dark:from-[#192f57] dark:via-[#1b2b4e] dark:to-[#29254d]">
        <CardContent className="flex flex-col gap-4 p-4 sm:p-5 xl:flex-row xl:items-end xl:justify-between">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-100 text-blue-700 dark:bg-blue-400/15 dark:text-blue-200 sm:flex">
              <UserRound className="h-6 w-6" />
            </div>
            <div className="min-w-0 w-full max-w-xl space-y-2">
              <div className="text-sm font-semibold text-slate-800 dark:text-blue-100">Customer</div>
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
                <SelectTrigger
                  className="h-11 w-full border-indigo-200 bg-white/90 font-medium shadow-sm focus:ring-indigo-500 dark:border-indigo-400/50 dark:bg-[#101d36]/90 dark:text-white"
                  data-testid="customer-loading-customer-select"
                >
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
          </div>
          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center xl:justify-end">
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <History className="h-4 w-4 shrink-0 text-indigo-600 dark:text-violet-200" />
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground dark:text-blue-100/65">Viewing product history for</div>
                <div className="truncate font-semibold text-slate-800 dark:text-white">
                  {loadingQuery.data?.customer?.legalName || "Select a customer to begin"}
                </div>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={!customerId}
              onClick={() => {
                setLoadingFilter("LOADED");
                setPage(1);
              }}
              className="shrink-0 border-violet-300 bg-violet-100/80 text-violet-900 hover:bg-violet-200 dark:border-violet-400/65 dark:bg-violet-500/25 dark:text-violet-100 dark:hover:bg-violet-500/40"
              title="Filter to loaded products; click a Loaded status to inspect its history"
            >
              <History className="mr-2 h-4 w-4" />
              Browse Loading History
            </Button>
          </div>
        </CardContent>
      </Card>

      {!customerId ? (
        <Card>
          <CardContent className="flex min-h-[300px] flex-col items-center justify-center gap-3 rounded-2xl bg-gradient-to-br from-blue-50 to-violet-50 p-8 text-center dark:from-[#12243f] dark:to-[#1f2144]">
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

          <Card className="overflow-hidden rounded-2xl border-slate-200/90 bg-white shadow-sm dark:border-slate-700/70 dark:bg-[#121d30]">
            <div className="border-b border-slate-200 bg-gradient-to-r from-slate-50 to-indigo-50/60 p-4 dark:border-slate-700/70 dark:from-[#182640] dark:to-[#192343] sm:p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-100 text-indigo-700 dark:bg-indigo-400/20 dark:text-indigo-200">
                    <Package className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-lg font-bold tracking-tight text-slate-900 dark:text-white">Product List</h2>
                      <span className="rounded-full border border-violet-200 bg-violet-100 px-2.5 py-0.5 text-xs font-semibold text-violet-800 dark:border-violet-400/30 dark:bg-violet-500/20 dark:text-violet-200">
                        {formatNumber(filteredProducts.length)} products
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {filteredProducts.length} of {products.length} products · {selectedProductIds.size} selected
                    </div>
                  </div>
                </div>
                <Button
                  variant="outline"
                  onClick={() => setColumnsOpen(true)}
                  className="border-slate-300 bg-white shadow-sm dark:border-slate-500 dark:bg-slate-800/60"
                  data-testid="customer-loading-columns-button"
                >
                  <Columns3 className="mr-2 h-4 w-4" />
                  Columns
                </Button>
              </div>
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
                <SlidersHorizontal className="h-3.5 w-3.5" /> Search & filters
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-[minmax(16rem,1.6fr)_repeat(5,minmax(8rem,1fr))]">
                <div className="relative sm:col-span-2 lg:col-span-3 2xl:col-span-1">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setPage(1);
                    }}
                    placeholder="Search name, Arabic, or code..."
                    className="h-10 border-slate-300 bg-white pl-9 shadow-sm dark:border-slate-600 dark:bg-slate-900/60"
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
                  <SelectTrigger
                    className="h-10 min-w-0 border-slate-300 bg-white shadow-sm dark:border-slate-600 dark:bg-slate-900/60"
                    data-testid="customer-loading-status-filter"
                  >
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
                  <SelectTrigger className="h-10 min-w-0 border-slate-300 bg-white shadow-sm dark:border-slate-600 dark:bg-slate-900/60">
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
                  <SelectTrigger className="h-10 min-w-0 border-slate-300 bg-white shadow-sm dark:border-slate-600 dark:bg-slate-900/60">
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
                  <SelectTrigger
                    className="h-10 min-w-0 border-slate-300 bg-white shadow-sm dark:border-slate-600 dark:bg-slate-900/60"
                    data-testid="customer-loading-zero-stock-filter"
                  >
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
                  <SelectTrigger
                    className="h-10 min-w-0 border-slate-300 bg-white shadow-sm dark:border-slate-600 dark:bg-slate-900/60"
                    data-testid="customer-loading-negative-stock-filter"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="SHOW_NEGATIVE">Show Negative</SelectItem>
                    <SelectItem value="HIDE_NEGATIVE">Hide Negative</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="max-h-[62vh] overflow-auto bg-white dark:bg-[#121d30]">
              <table className="w-full min-w-[1280px] border-collapse text-sm">
                <thead className="sticky top-0 z-30 bg-slate-100 shadow-[0_1px_0_hsl(var(--border))] dark:bg-[#263956]">
                  <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-slate-600 dark:text-blue-100/85">
                    <th className="sticky left-0 z-40 w-12 bg-slate-100 px-3 py-3 dark:bg-[#263956]">
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
                        className={`border-b border-slate-100 transition-colors last:border-b-0 hover:bg-blue-50/80 dark:border-slate-700/50 dark:hover:bg-blue-400/10 ${selected ? "bg-indigo-50 dark:bg-indigo-500/10" : "even:bg-slate-50/70 dark:even:bg-white/[0.025]"}`}
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
                        {isColumnVisible("product") && (
                          <td className="px-4 py-3 font-semibold text-slate-900 dark:text-slate-100">
                            {mhd.nameFor(product.articleCode || product.code, product.name)}
                          </td>
                        )}
                        {isColumnVisible("arabicName") && (
                          <td className="px-4 py-3 text-right" dir="rtl">
                            {product.nameAr || "—"}
                          </td>
                        )}
                        {isColumnVisible("category") && (
                          <td className="px-4 py-3">
                            <span className="inline-flex rounded-lg border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-medium text-blue-800 dark:border-blue-400/25 dark:bg-blue-400/10 dark:text-blue-200">
                              {product.categoryName || "—"}
                            </span>
                          </td>
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
                                <Badge
                                  variant="secondary"
                                  className="cursor-pointer border border-emerald-200 bg-emerald-100 font-semibold text-emerald-800 hover:bg-emerald-200 dark:border-emerald-400/30 dark:bg-emerald-400/15 dark:text-emerald-200 dark:hover:bg-emerald-400/25"
                                >
                                  Loaded · {product.loadingCount}
                                </Badge>
                              ) : (
                                <Badge
                                  variant="outline"
                                  className="border-slate-200 bg-slate-100 text-slate-600 dark:border-slate-600 dark:bg-slate-700/40 dark:text-slate-300"
                                >
                                  Never loaded
                                </Badge>
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
            <div className="flex flex-col gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-700 dark:bg-[#17243b] sm:flex-row sm:items-center sm:justify-between">
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
        <div className="fixed inset-x-0 bottom-0 z-50 border-t border-indigo-300 bg-white/95 px-4 py-3 shadow-2xl backdrop-blur-md dark:border-indigo-500/40 dark:bg-[#14213a]/95 md:left-(--sidebar-width,0px)">
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
              {canCreateProforma && (
                <Button onClick={openPreview} disabled={validSelectedLines.length === 0 || hasInvalidSelectedLine}>
                  <ShoppingCart className="mr-2 h-4 w-4" />
                  Create Proforma
                </Button>
              )}
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
        open={canCreateProforma && previewOpen}
        onOpenChange={setPreviewOpen}
        customerName={loadingQuery.data?.customer.legalName}
        proformaName={proformaName}
        onProformaNameChange={setProformaName}
        destination={proformaDestination}
        onDestinationChange={setProformaDestination}
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
