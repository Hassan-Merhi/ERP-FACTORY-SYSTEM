import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertTriangle,
  FilePlus2,
  Package,
  Boxes,
  Truck,
  Scale,
  Save,
  Loader2,
  Plus,
  Trash2,
  Container,
  Search,
  X,
} from "lucide-react";
import { V5ProformaMobileLines } from "./V5ProformaMobileLines";

import type { Props } from "./createproformav5drawer/types";
import { useCreateProformaV5DrawerState } from "./useCreateProformaV5DrawerState";
import { CreateProformaV5DrawerSection } from "./CreateProformaV5DrawerSection";
import { CreateProformaV5DrawerSection2 } from "./CreateProformaV5DrawerSection2";

export default function CreateProformaV5Drawer(props: Props) {
  const {
    addContainer,
    appliedPrice,
    applyCatalogProductionPrice,
    applyCatalogSellingPrice,
    articleRows,
    articleSearch,
    catalogCategories,
    catalogFilter,
    containerCount,
    containerNames,
    createMutation,
    customerId,
    customerPriceListQuery,
    customersQuery,
    destination,
    draftStatus,
    errors,
    filledLines,
    garbageWipersCount,
    handleQtyChange,
    handleQtyKeyDown,
    handleSubmit,
    hideNonPositive,
    isActive,
    kgPrices,
    map,
    n,
    negativeCount,
    nonPositiveCount,
    onClose,
    pricingModes,
    productsQuery,
    proformaName,
    qtyRefs,
    quantities,
    removeContainer,
    sellingPrices,
    sendToLoading,
    setAppliedPrice,
    setArticleSearch,
    setCatalogFilter,
    setContainerCount,
    setCustomerId,
    setDestination,
    setErrors,
    setHideNonPositive,
    setIsActive,
    setKgPrices,
    setPricingModes,
    setProformaName,
    setSellingPrices,
    setSendToLoading,
    setShowGarbageWipers,
    setShowNegativeOnly,
    setShowZeroItems,
    showGarbageWipers,
    showNegativeOnly,
    showZeroItems,
    totalExpected,
    totalKg,
    totalQty,
    totalValue,
    updateContainerName,
    visibleRows,
    visibleTotalBalance,
    warningCount,
    zeroItemCount,
  } = useCreateProformaV5DrawerState(props);

  return (
    <div className="flex min-w-0 flex-col bg-background pb-5" data-testid="page-create-proforma-v5">
      <section className="px-3 pb-3 pt-5 sm:px-5">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-violet-500/30 bg-violet-500/15 text-violet-500">
            <FilePlus2 className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Create Proforma</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">Stock Allocation</p>
          </div>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-2.5 lg:grid-cols-3 xl:grid-cols-5">
          <div className="flex min-w-0 items-center gap-3 rounded-xl border border-violet-500/25 bg-violet-500/[0.07] p-3.5 shadow-sm">
            <Package className="hidden h-9 w-9 shrink-0 rounded-lg bg-violet-500/15 p-2 text-violet-500 sm:block" />
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Total Products</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-violet-500">
                {visibleRows.length.toLocaleString()}
              </p>
            </div>
          </div>
          <div className="flex min-w-0 items-center gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.07] p-3.5 shadow-sm">
            <Boxes className="hidden h-9 w-9 shrink-0 rounded-lg bg-emerald-500/15 p-2 text-emerald-500 sm:block" />
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Qty / Container</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-emerald-500">{totalQty.toLocaleString()}</p>
            </div>
          </div>
          <div className="flex min-w-0 items-center gap-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] p-3.5 shadow-sm">
            <Truck className="hidden h-9 w-9 shrink-0 rounded-lg bg-amber-500/15 p-2 text-amber-500 sm:block" />
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Expected to Load</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-amber-500">{totalExpected.toLocaleString()}</p>
            </div>
          </div>
          <div className="flex min-w-0 items-center gap-3 rounded-xl border border-sky-500/25 bg-sky-500/[0.07] p-3.5 shadow-sm">
            <Scale className="hidden h-9 w-9 shrink-0 rounded-lg bg-sky-500/15 p-2 text-sky-500 sm:block" />
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Total KG</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-sky-500">{totalKg.toLocaleString()}</p>
            </div>
          </div>
          <div className="col-span-2 lg:col-span-1 flex min-w-0 items-center gap-3 rounded-xl border border-rose-500/25 bg-rose-500/[0.07] p-3.5 shadow-sm">
            <AlertTriangle className="hidden h-9 w-9 shrink-0 rounded-lg bg-rose-500/15 p-2 text-rose-500 sm:block" />
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Shortages</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-rose-500">{warningCount.toLocaleString()}</p>
            </div>
          </div>
        </div>
      </section>

      {/* Top fields */}
      <CreateProformaV5DrawerSection2
        appliedPrice={appliedPrice}
        applyCatalogProductionPrice={applyCatalogProductionPrice}
        applyCatalogSellingPrice={applyCatalogSellingPrice}
        articleRows={articleRows}
        containerCount={containerCount}
        customerId={customerId}
        customerPriceListQuery={customerPriceListQuery}
        customersQuery={customersQuery}
        destination={destination}
        draftStatus={draftStatus}
        errors={errors}
        garbageWipersCount={garbageWipersCount}
        hideNonPositive={hideNonPositive}
        isActive={isActive}
        negativeCount={negativeCount}
        nonPositiveCount={nonPositiveCount}
        productsQuery={productsQuery}
        proformaName={proformaName}
        sendToLoading={sendToLoading}
        setAppliedPrice={setAppliedPrice}
        setContainerCount={setContainerCount}
        setCustomerId={setCustomerId}
        setDestination={setDestination}
        setErrors={setErrors}
        setHideNonPositive={setHideNonPositive}
        setIsActive={setIsActive}
        setProformaName={setProformaName}
        setSellingPrices={setSellingPrices}
        setSendToLoading={setSendToLoading}
        setShowGarbageWipers={setShowGarbageWipers}
        setShowNegativeOnly={setShowNegativeOnly}
        setShowZeroItems={setShowZeroItems}
        showGarbageWipers={showGarbageWipers}
        showNegativeOnly={showNegativeOnly}
        showZeroItems={showZeroItems}
        zeroItemCount={zeroItemCount}
      />

      {/* Container names panel */}
      {sendToLoading && (
        <div className="px-5 py-3 border-b shrink-0 bg-muted/20">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-medium text-muted-foreground">Container names — click to rename</p>
            <Button size="sm" variant="outline" onClick={addContainer} data-testid="button-v5-add-container">
              <Plus className="h-3.5 w-3.5 mr-1" />
              Add
            </Button>
          </div>
          {errors.containers && <p className="text-xs text-destructive mb-1">{errors.containers}</p>}
          <div className="flex flex-wrap gap-2 max-h-32 overflow-auto">
            {containerNames.map((name, idx) => (
              <div key={idx} className="flex items-center gap-1 bg-background border rounded-md px-2 py-2.5">
                <Container className="h-3 w-3 text-muted-foreground shrink-0" />
                <Input
                  value={name}
                  onChange={(e) => updateContainerName(idx, e.target.value)}
                  className="h-6 text-xs border-0 p-0 w-28 bg-transparent focus-visible:ring-0"
                  data-testid={`input-v5-container-name-${idx}`}
                />
                {containerNames.length > 1 && (
                  <button
                    onClick={() => removeContainer(idx)}
                    className="text-muted-foreground/60 hover-elevate rounded-sm"
                    data-testid={`button-v5-remove-container-${idx}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {errors.lines && (
        <div className="px-5 py-2 bg-destructive/10 border-b shrink-0">
          <p className="text-xs text-destructive">{errors.lines}</p>
        </div>
      )}

      {/* Search bar */}
      <div className="mx-3 flex flex-wrap items-end gap-3 border-x border-b bg-card/70 px-3.5 py-3 sm:mx-5 sm:px-4">
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input
            value={articleSearch}
            onChange={(e) => setArticleSearch(e.target.value)}
            placeholder="Search product name or code..."
            className="h-10 rounded-lg pl-8 text-sm"
            data-testid="input-v5-create-search"
          />
          {articleSearch && (
            <button
              onClick={() => setArticleSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover-elevate rounded-sm"
              data-testid="button-v5-create-clear-search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="w-full sm:w-56">
          <Label className="mb-1 block text-xs font-medium">Catalog</Label>
          <Select value={catalogFilter} onValueChange={setCatalogFilter}>
            <SelectTrigger className="h-10 rounded-lg" data-testid="select-v5-create-catalog">
              <SelectValue placeholder="All Catalogs" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All Catalogs</SelectItem>
              {catalogCategories.map((category) => (
                <SelectItem key={category} value={category}>
                  {category}
                </SelectItem>
              ))}
              {articleRows.some((row) => !row.categoryName?.trim()) && (
                <SelectItem value="__uncategorized__">Uncategorized</SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Both views write to the same proforma draft; only one is visible. */}
      <V5ProformaMobileLines
        variant="create"
        rows={visibleRows}
        quantities={quantities}
        prices={sellingPrices}
        kgPrices={kgPrices}
        pricingModes={pricingModes}
        onQuantityChange={handleQtyChange}
        onPriceChange={(code, value) => setSellingPrices((previous) => ({ ...previous, [code]: value }))}
        onKgPriceChange={(code, value) => setKgPrices((previous) => ({ ...previous, [code]: value }))}
        onModeChange={(code, value) => setPricingModes((previous) => ({ ...previous, [code]: value }))}
        weightPerBale={(code) => Number(map.get(code)?.weightPerBaleKg || 0)}
        shortageCount={(row, qty) =>
          Math.max(0, qty * (sendToLoading && n > 0 ? n : 1) - (row.stockAvailable - row.totalLoaded))
        }
        multiplier={sendToLoading && n > 0 ? n : 1}
        errors={errors}
      />
      {/* Desktop table remains unchanged for spreadsheet-style editing. */}
      <CreateProformaV5DrawerSection
        errors={errors}
        handleQtyChange={handleQtyChange}
        handleQtyKeyDown={handleQtyKeyDown}
        kgPrices={kgPrices}
        map={map}
        n={n}
        pricingModes={pricingModes}
        qtyRefs={qtyRefs}
        quantities={quantities}
        sellingPrices={sellingPrices}
        sendToLoading={sendToLoading}
        setKgPrices={setKgPrices}
        setPricingModes={setPricingModes}
        setSellingPrices={setSellingPrices}
        totalExpected={totalExpected}
        totalKg={totalKg}
        totalQty={totalQty}
        totalValue={totalValue}
        visibleRows={visibleRows}
        visibleTotalBalance={visibleTotalBalance}
      />

      {/* Footer */}
      <div className="mx-3 mt-3 flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-card/90 px-4 py-3 shadow-sm sm:mx-5">
        <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
          <span>
            <span className="font-semibold text-foreground">{filledLines}</span> line{filledLines !== 1 ? "s" : ""}
          </span>
          <span>
            <span className="font-semibold text-foreground">{totalQty}</span> bales/container
          </span>
          {totalKg > 0 && (
            <span>
              <span className="font-semibold text-foreground">
                {totalKg.toLocaleString(undefined, { maximumFractionDigits: 1 })}
              </span>{" "}
              kg
            </span>
          )}
          {sendToLoading && n > 0 && (
            <span className="text-amber-600 dark:text-amber-400">
              <span className="font-semibold">{totalExpected}</span> total expected ({n} container{n !== 1 ? "s" : ""})
            </span>
          )}
          {warningCount > 0 && (
            <span className="flex items-center gap-1 text-destructive">
              <AlertTriangle className="h-3 w-3" />
              {warningCount} product{warningCount !== 1 ? "s" : ""} with shortage
            </span>
          )}
          <span className="text-[11px] text-muted-foreground/60">Ctrl/⌘+S to save</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="default" onClick={onClose} data-testid="button-v5-cancel-proforma">
            Cancel
          </Button>
          <Button
            size="default"
            onClick={handleSubmit}
            disabled={createMutation.isPending}
            data-testid="button-v5-create-proforma-submit"
            className="bg-violet-600 text-white hover:bg-violet-700"
          >
            {createMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Creating…
              </>
            ) : (
              <>
                <Save className="h-4 w-4 mr-2" />
                {sendToLoading ? `Create + ${n} Container${n !== 1 ? "s" : ""}` : "Create Proforma"}
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
