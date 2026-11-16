import { Loader2, ShoppingCart, UsersRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { resolveAvailableStock } from "./customerLoadingAvailability";
import { CustomerLoadingSummaryCards } from "./CustomerLoadingSummaryCards";
import { CustomerLoadingColumnsDialog } from "./CustomerLoadingColumnsDialog";
import { CustomerLoadingProformaDialog } from "./CustomerLoadingProformaDialog";
import { CustomerLoadingHistoryDialog } from "./CustomerLoadingHistoryDialog";
import { formatDate, formatMoney, formatNumber } from "./customerLoadingFormat";
import { COLUMN_OPTIONS } from "./customerLoadingTypes";
import { CustomerLoadingSection, useCustomerLoadingState } from "./useCustomerLoadingState";
import {
  CustomerLoadingCardSection,
  CustomerLoadingSection2,
  CustomerLoadingSection3,
  CustomerLoadingSection4,
} from "./CustomerLoadingSection2";

export default function CustomerLoading() {
  const {
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
  } = useCustomerLoadingState();
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
      <CustomerLoadingSection4 />

      <CustomerLoadingCardSection
        customerId={customerId}
        customersQuery={customersQuery}
        loadingQuery={loadingQuery}
        resetFilters={resetFilters}
        resetSelection={resetSelection}
        setCustomerId={setCustomerId}
        setHistoryProduct={setHistoryProduct}
        setLoadingFilter={setLoadingFilter}
        setPage={setPage}
        setProformaName={setProformaName}
      />

      {!customerId ? (
        <Card>
          <CardContent className="flex min-h-[300px] flex-col items-center justify-center gap-3 rounded-2xl bg-gradient-to-br from-blue-50 to-violet-50 p-8 text-center dark:from-[hsl(var(--factory-hue)_56%_16%)] dark:to-[hsl(var(--factory-hue)_37%_19%)]">
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

          <Card className="overflow-hidden rounded-2xl border-slate-200/90 bg-white shadow-sm dark:border-slate-700/70 dark:bg-[hsl(var(--factory-hue)_45%_13%)]">
            <CustomerLoadingSection2
              availableNegativeFilter={availableNegativeFilter}
              availableZeroFilter={availableZeroFilter}
              categories={categories}
              categoryFilter={categoryFilter}
              filteredProducts={filteredProducts}
              loadingFilter={loadingFilter}
              products={products}
              search={search}
              selectedProductIds={selectedProductIds}
              setAvailableNegativeFilter={setAvailableNegativeFilter}
              setAvailableZeroFilter={setAvailableZeroFilter}
              setCategoryFilter={setCategoryFilter}
              setColumnsOpen={setColumnsOpen}
              setLoadingFilter={setLoadingFilter}
              setPage={setPage}
              setSearch={setSearch}
              setWeightFilter={setWeightFilter}
              weightFilter={weightFilter}
              weights={weights}
            />

            <div className="max-h-[62vh] overflow-auto bg-white dark:bg-[hsl(var(--factory-hue)_45%_13%)]">
              <table className="w-full min-w-[1280px] border-collapse text-sm">
                <CustomerLoadingSection
                  allVisibleSelected={allVisibleSelected}
                  isColumnVisible={isColumnVisible}
                  setDraftQuantities={setDraftQuantities}
                  setSelectedProductIds={setSelectedProductIds}
                  visibleProducts={visibleProducts}
                />
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
            <CustomerLoadingSection3
              filteredProducts={filteredProducts}
              pageCount={pageCount}
              safePage={safePage}
              setPage={setPage}
            />
          </Card>
        </>
      )}

      {selectedProductIds.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-50 border-t border-indigo-300 bg-white/95 px-4 py-3 shadow-2xl backdrop-blur-md dark:border-indigo-500/40 dark:bg-[hsl(var(--factory-hue)_49%_15%)]/95 md:left-(--sidebar-width,0px)">
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
