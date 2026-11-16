// Extracted from ./CustomerLoading.tsx to keep that module under the source-size cap.
import {
  ChevronLeft,
  ChevronRight,
  Columns3,
  History,
  Package,
  Search,
  SlidersHorizontal,
  Truck,
  UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatNumber } from "./customerLoadingFormat";
import type { AvailableNegativeFilter, AvailableZeroFilter, LoadingFilter } from "./customerLoadingTypes";
import { PAGE_SIZE } from "./customerLoadingHelpers";
import { useCustomerLoadingState } from "./useCustomerLoadingState";

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

export function CustomerLoadingCardSection({
  customerId,
  customersQuery,
  loadingQuery,
  resetFilters,
  resetSelection,
  setCustomerId,
  setHistoryProduct,
  setLoadingFilter,
  setPage,
  setProformaName,
}: Pick<
  ReturnType<typeof useCustomerLoadingState>,
  | "customerId"
  | "customersQuery"
  | "loadingQuery"
  | "resetFilters"
  | "resetSelection"
  | "setCustomerId"
  | "setHistoryProduct"
  | "setLoadingFilter"
  | "setPage"
  | "setProformaName"
>) {
  return (
    <Card className="overflow-hidden rounded-2xl border-indigo-200 bg-gradient-to-r from-indigo-50 via-white to-violet-50 shadow-sm dark:border-indigo-400/35 dark:from-[hsl(var(--factory-hue)_55%_22%)] dark:via-[hsl(var(--factory-hue)_49%_21%)] dark:to-[hsl(var(--factory-hue)_35%_22%)]">
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
                className="h-11 w-full border-indigo-200 bg-white/90 font-medium shadow-sm focus:ring-indigo-500 dark:border-indigo-400/50 dark:bg-[hsl(var(--factory-hue)_54%_14%)]/90 dark:text-white"
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
  );
}

export function CustomerLoadingSection4() {
  return (
    <section className="relative isolate overflow-hidden rounded-2xl border border-indigo-200/80 bg-gradient-to-r from-slate-50 via-blue-50/70 to-indigo-100/70 p-5 shadow-sm dark:border-indigo-400/25 dark:from-[hsl(var(--factory-hue)_50%_13%)] dark:via-[hsl(var(--factory-hue)_55%_17%)] dark:to-[hsl(var(--factory-hue)_53%_19%)] sm:p-6">
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
  );
}
