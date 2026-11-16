// Extracted from ./CustomerLoading.tsx to keep that module under the source-size cap.
import { ChevronLeft, ChevronRight, Columns3, Package, Search, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatNumber } from "./customerLoadingFormat";
import type { AvailableNegativeFilter, AvailableZeroFilter, LoadingFilter } from "./customerLoadingTypes";
import { PAGE_SIZE } from "./customerLoadingHelpers";
import { useCustomerLoadingState } from "./useCustomerLoadingState";

export function CustomerLoadingSection({
  allVisibleSelected,
  isColumnVisible,
  setDraftQuantities,
  setSelectedProductIds,
  visibleProducts,
}: Pick<
  ReturnType<typeof useCustomerLoadingState>,
  "allVisibleSelected" | "isColumnVisible" | "setDraftQuantities" | "setSelectedProductIds" | "visibleProducts"
>) {
  return (
    <thead className="sticky top-0 z-30 bg-slate-100 shadow-[0_1px_0_hsl(var(--border))] dark:bg-[hsl(var(--factory-hue)_39%_24%)]">
      <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-slate-600 dark:text-blue-100/85">
        <th className="sticky left-0 z-40 w-12 bg-slate-100 px-3 py-3 dark:bg-[hsl(var(--factory-hue)_39%_24%)]">
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
        {isColumnVisible("articleCode") && <th className="min-w-[130px] px-4 py-3 font-medium">Article Code</th>}
        {isColumnVisible("product") && <th className="min-w-[220px] px-4 py-3 font-medium">Product</th>}
        {isColumnVisible("arabicName") && <th className="min-w-[180px] px-4 py-3 font-medium">Arabic Name</th>}
        {isColumnVisible("category") && <th className="px-4 py-3 font-medium">Category</th>}
        {isColumnVisible("weight") && <th className="px-4 py-3 text-right font-medium">Wt/Bale</th>}
        {isColumnVisible("sellPrice") && <th className="px-4 py-3 text-right font-medium">Sell Price</th>}
        {isColumnVisible("availableStock") && <th className="px-4 py-3 text-right font-medium">Available Stock</th>}
        {isColumnVisible("status") && <th className="px-4 py-3 font-medium">Status</th>}
        {isColumnVisible("totalLoaded") && <th className="px-4 py-3 text-right font-medium">Total Loaded</th>}
        {isColumnVisible("totalKg") && <th className="px-4 py-3 text-right font-medium">Total KG</th>}
        {isColumnVisible("lastLoaded") && <th className="px-4 py-3 font-medium">Last Loaded</th>}
        {isColumnVisible("qty") && <th className="px-4 py-3 text-right font-medium">Qty</th>}
      </tr>
    </thead>
  );
}

export function CustomerLoadingSection2({
  availableNegativeFilter,
  availableZeroFilter,
  categories,
  categoryFilter,
  filteredProducts,
  loadingFilter,
  products,
  search,
  selectedProductIds,
  setAvailableNegativeFilter,
  setAvailableZeroFilter,
  setCategoryFilter,
  setColumnsOpen,
  setLoadingFilter,
  setPage,
  setSearch,
  setWeightFilter,
  weightFilter,
  weights,
}: Pick<
  ReturnType<typeof useCustomerLoadingState>,
  | "availableNegativeFilter"
  | "availableZeroFilter"
  | "categories"
  | "categoryFilter"
  | "filteredProducts"
  | "loadingFilter"
  | "products"
  | "search"
  | "selectedProductIds"
  | "setAvailableNegativeFilter"
  | "setAvailableZeroFilter"
  | "setCategoryFilter"
  | "setColumnsOpen"
  | "setLoadingFilter"
  | "setPage"
  | "setSearch"
  | "setWeightFilter"
  | "weightFilter"
  | "weights"
>) {
  return (
    <div className="border-b border-slate-200 bg-gradient-to-r from-slate-50 to-indigo-50/60 p-4 dark:border-slate-700/70 dark:from-[hsl(var(--factory-hue)_45%_17%)] dark:to-[hsl(var(--factory-hue)_46%_18%)] sm:p-5">
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
  );
}

export function CustomerLoadingSection3({
  filteredProducts,
  pageCount,
  safePage,
  setPage,
}: Pick<ReturnType<typeof useCustomerLoadingState>, "filteredProducts" | "pageCount" | "safePage" | "setPage">) {
  return (
    <div className="flex flex-col gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-700 dark:bg-[hsl(var(--factory-hue)_44%_16%)] sm:flex-row sm:items-center sm:justify-between">
      <div className="text-xs text-muted-foreground">
        Showing {filteredProducts.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1}–
        {Math.min(safePage * PAGE_SIZE, filteredProducts.length)} of {filteredProducts.length}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={safePage <= 1}>
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
  );
}
