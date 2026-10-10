import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  MapPin,
  Layers,
  Package,
  Search,
  Printer,
  FileText,
  ClipboardList,
  X,
  FileSpreadsheet,
  Check,
  Pencil,
  Zap,
  Eye,
  AlertTriangle,
  ArrowLeft,
  TrendingUp,
  Weight,
  DollarSign,
  SlidersHorizontal,
  ChevronDown,
  ListFilter,
} from "lucide-react";
import type { SortField } from "./factorylocationinventory/types";
import { StatCard } from "./factorylocationinventory/components/StatCard";
import type { useFactoryLocationInventory } from "./FactoryLocationInventoryModel";
import { createFactoryLocationProductRenderers } from "./FactoryLocationInventoryProductRenderers";
import { createFactoryLocationProductMetrics } from "./factorylocationinventory/productMetrics";
import { FactoryLocationInventoryProductFooterDialogs } from "./factorylocationinventory/ProductFooterDialogs";

type FactoryLocationInventoryModel = ReturnType<typeof useFactoryLocationInventory>;

export function FactoryLocationInventoryProductView({ inventory }: { inventory: FactoryLocationInventoryModel }) {
  const {
    activeInventoryData,
    applyProductionPrices,
    applySellingPrices,
    availableLoading,
    categoryFilter,
    categoryGroups,
    deselectAllVisible,
    editingProformaId,
    filteredProducts,
    fmt,
    formatAmount,
    handleBackToLocations,
    handlePrint,
    hiddenColumns,
    hideAvgCost,
    hideSellingPrice,
    hideZeroAvailable,
    inventoryLoading,
    openRenameDialog,
    printRef,
    prodSortDir,
    prodSortField,
    productSearch,
    proformaAutoSave,
    proformaMode,
    proformaName,
    regularProducts,
    selectAllVisible,
    selectedLocation,
    selections,
    setCategoryFilter,
    setHideZeroAvailable,
    setProdSortDir,
    setProdSortField,
    setProductSearch,
    setShowSelectedOnly,
    setShowZeroStock,
    showSelectedOnly,
    showZeroStock,
    specialProducts,
    toggleProformaAutoSave,
    toggleProformaMode,
  } = inventory;
  if (!selectedLocation) return null;

  // ─── View 2: Product table ────────────────────────────────────────────────
  const {
    allCategoryNames,
    col,
    colSpan,
    spTotalBales,
    spTotalKg,
    spTotalProdValue,
    spTotalSellValue,
    statsBales,
    statsCostValue,
    statsKg,
    statsSellValue,
    toggleCol,
    totalBales,
    totalKg,
    totalProdValue,
    totalSellValue,
  } = createFactoryLocationProductMetrics(inventory);

  const { renderProductRow, renderMobileCard } = createFactoryLocationProductRenderers(inventory);

  return (
    <div className={`p-4 md:p-6 w-full space-y-5 ${proformaMode && selections.size > 0 ? "pb-24" : ""}`}>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleBackToLocations}
            data-testid="breadcrumb-locations"
            title="Back to locations"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl md:text-2xl font-bold tracking-tight" data-testid="text-page-title">
                {selectedLocation.name}
              </h1>
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => openRenameDialog(selectedLocation, e)}
                data-testid="button-rename-selected-location"
                title="Rename location"
              >
                <Pencil className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex items-center gap-1.5 mt-1">
              <Badge variant="outline" className="text-xs font-medium no-default-active-elevate">
                <MapPin className="h-3 w-3 mr-1" />
                Location Inventory
              </Badge>
              <span className="text-xs text-muted-foreground" data-testid="text-subtitle">
                Physical bales · IN_STOCK
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant={proformaMode ? "destructive" : "outline"}
            size="sm"
            onClick={toggleProformaMode}
            data-testid="button-toggle-proforma-mode"
          >
            <ClipboardList className="h-4 w-4 mr-1.5" />
            {proformaMode ? "Exit Proforma" : "Proforma Mode"}
          </Button>
          <Button variant="outline" size="icon" onClick={() => handlePrint()} data-testid="button-print" title="Print">
            <Printer className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => {
              const p = new URLSearchParams();
              if (hideAvgCost) p.set("includeCost", "0");
              if (hideSellingPrice) p.set("includeSellPrice", "0");
              const qs = p.toString();
              window.open(
                `/api/factory/location-inventory/${selectedLocation.id}/export/excel${qs ? "?" + qs : ""}`,
                "_blank"
              );
            }}
            data-testid="button-export-location-excel"
            title="Export Excel"
          >
            <FileSpreadsheet className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* KPI cards */}
      {!inventoryLoading && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          <StatCard
            icon={<Package className="h-4 w-4 text-blue-400" />}
            label="Total Bales"
            value={statsBales.toLocaleString()}
            sub={`${activeInventoryData.filter((p) => p.baleCount > 0).length} products`}
            accent="bg-blue-500/10"
          />
          <StatCard
            icon={<Weight className="h-4 w-4 text-emerald-400" />}
            label="Total KG"
            value={fmt(statsKg)}
            sub={statsBales > 0 ? `~${fmt(statsKg / statsBales)} KG / bale` : undefined}
            accent="bg-emerald-500/10"
          />
          <StatCard
            icon={<Layers className="h-4 w-4 text-purple-400" />}
            label="Categories"
            value={String(categoryGroups.length)}
            sub={`${activeInventoryData.length} products total`}
            accent="bg-purple-500/10"
          />
          {!hideAvgCost && (
            <StatCard
              icon={<DollarSign className="h-4 w-4 text-amber-400" />}
              label="Cost Value"
              value={formatAmount(statsCostValue)}
              sub="production price basis"
              accent="bg-amber-500/10"
            />
          )}
          {!hideSellingPrice && (
            <StatCard
              icon={<TrendingUp className="h-4 w-4 text-green-400" />}
              label="Sell Value"
              value={formatAmount(statsSellValue)}
              sub="at current selling price"
              accent="bg-green-500/10"
            />
          )}
        </div>
      )}

      {/* Proforma advisory — only visible inside proforma mode */}
      {proformaMode && (
        <div
          className="mb-3 flex items-start gap-2 px-3 py-2.5 rounded-md bg-amber-500/10 border border-amber-500/25 text-sm text-amber-800 dark:text-amber-300"
          data-testid="note-proforma-advisory"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
          <span>
            Available quantities shown do not subtract V5 reserved allocations. Check the{" "}
            <span className="font-medium">Stock Allocation V5</span> page for net availability before committing.
          </span>
        </div>
      )}

      {/* Proforma controls */}
      {proformaMode && (
        <div className="mb-4 flex items-center gap-2 flex-wrap">
          {editingProformaId && (
            <div className="w-full flex items-center gap-2 mb-1 p-2 rounded-md bg-primary/10 border border-primary/20">
              <FileText className="h-4 w-4 text-primary shrink-0" />
              <span className="text-sm font-medium text-primary">
                Editing proforma: <span className="font-bold">{proformaName}</span>
              </span>
              <span className="text-xs text-muted-foreground ml-1 flex-1">
                {proformaAutoSave
                  ? "— Changes auto-save 2 s after you stop editing"
                  : "— Select items and click Update Proforma to save changes"}
              </span>
              <button
                onClick={toggleProformaAutoSave}
                className={`flex items-center gap-1.5 px-2.5 h-7 rounded border text-xs font-medium transition-colors shrink-0 ${
                  proformaAutoSave
                    ? "bg-green-500/10 border-green-500/50 text-green-600 dark:text-green-400"
                    : "bg-background border-border text-muted-foreground"
                }`}
                data-testid="button-proforma-autosave-toggle"
              >
                <Zap className={`h-3.5 w-3.5 ${proformaAutoSave ? "fill-green-500 text-green-500" : ""}`} />
                Autosave
                <span
                  className={`w-7 h-3.5 rounded-full relative transition-colors ${proformaAutoSave ? "bg-green-500" : "bg-muted-foreground/30"}`}
                >
                  <span
                    className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white shadow transition-transform ${proformaAutoSave ? "translate-x-3.5" : "translate-x-0.5"}`}
                  />
                </span>
              </button>
            </div>
          )}
          <Button variant="outline" size="sm" onClick={selectAllVisible} data-testid="button-select-all">
            <Check className="h-4 w-4 mr-1" /> Select All
          </Button>
          <Button variant="outline" size="sm" onClick={deselectAllVisible} data-testid="button-deselect-all">
            <X className="h-4 w-4 mr-1" /> Deselect All
          </Button>
          {selections.size > 0 && (
            <>
              <Button variant="outline" size="sm" onClick={applySellingPrices} data-testid="button-apply-selling-price">
                Apply Sell Price
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={applyProductionPrices}
                data-testid="button-apply-production-price"
              >
                Apply Prod Price
              </Button>
            </>
          )}
          <div className="flex items-center gap-1.5 ml-2">
            <Checkbox
              checked={showSelectedOnly}
              onCheckedChange={(v) => setShowSelectedOnly(!!v)}
              id="show-selected-only"
              data-testid="checkbox-show-selected-only"
            />
            <label htmlFor="show-selected-only" className="text-sm cursor-pointer select-none">
              Selected only
            </label>
          </div>
          <Button
            variant={hideZeroAvailable ? "outline" : "secondary"}
            size="sm"
            onClick={() => setHideZeroAvailable((v) => !v)}
            data-testid="button-toggle-zero-available"
          >
            {hideZeroAvailable ? "Show 0" : "Hide 0"}
          </Button>
          {selections.size > 0 && (
            <Badge variant="secondary" className="text-sm ml-auto">
              {selections.size} items, {Array.from(selections.values()).reduce((s, v) => s + v.selectedQty, 0)} bales
            </Badge>
          )}
        </div>
      )}

      {/* Main card — toolbar + table */}
      <div className="rounded-xl border overflow-hidden w-full" ref={printRef}>
        {/* Toolbar strip */}
        <div className="flex flex-col gap-2 px-4 py-3 border-b bg-muted/20">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search product or article code..."
              value={productSearch}
              onChange={(e) => setProductSearch(e.target.value)}
              className="pl-9"
              data-testid="input-search-products"
            />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5 h-8" data-testid="button-category-filter">
                  <ListFilter className="h-3.5 w-3.5" />
                  {categoryFilter.length === 0
                    ? "All Categories"
                    : categoryFilter.length === 1
                      ? categoryFilter[0]
                      : `${categoryFilter.length} categories`}
                  <ChevronDown className="h-3 w-3 opacity-50 ml-0.5" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-60 p-1" align="start">
                <div className="max-h-64 overflow-y-auto">
                  <div
                    className="flex items-center gap-2 px-2 py-1.5 rounded-sm cursor-pointer hover-elevate text-xs"
                    onClick={() => setCategoryFilter([])}
                    data-testid="badge-category-all"
                  >
                    <Checkbox
                      checked={categoryFilter.length === 0}
                      onCheckedChange={() => setCategoryFilter([])}
                      className="h-3 w-3 shrink-0"
                    />
                    <span className="font-medium">All Categories</span>
                  </div>
                  <div className="border-t my-1" />
                  {allCategoryNames.map((name) => (
                    <div
                      key={name}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-sm cursor-pointer hover-elevate text-xs"
                      onClick={() =>
                        setCategoryFilter((prev) =>
                          prev.includes(name) ? prev.filter((c) => c !== name) : [...prev, name]
                        )
                      }
                      data-testid={`badge-category-${name}`}
                    >
                      <Checkbox
                        checked={categoryFilter.includes(name)}
                        onCheckedChange={() =>
                          setCategoryFilter((prev) =>
                            prev.includes(name) ? prev.filter((c) => c !== name) : [...prev, name]
                          )
                        }
                        className="h-3 w-3 shrink-0"
                      />
                      <span className="truncate">{name}</span>
                    </div>
                  ))}
                </div>
                {categoryFilter.length > 0 && (
                  <div className="border-t mt-1 pt-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-full text-xs text-muted-foreground"
                      onClick={() => setCategoryFilter([])}
                    >
                      Clear selection
                    </Button>
                  </div>
                )}
              </PopoverContent>
            </Popover>
            <div className="flex items-center gap-1">
              {(["name", "bales", "kg", "value"] as SortField[]).map((field) => (
                <Badge
                  key={field}
                  variant={prodSortField === field ? "default" : "outline"}
                  className="cursor-pointer"
                  onClick={() => setProdSortField(field)}
                  data-testid={`badge-sort-${field}`}
                >
                  {field === "name" ? "Name" : field === "bales" ? "Bales" : field === "kg" ? "KG" : "Value"}
                </Badge>
              ))}
            </div>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setProdSortDir((d) => (d === "asc" ? "desc" : "asc"))}
              data-testid="button-sort-dir"
            >
              {prodSortDir === "asc" ? "↑" : "↓"}
            </Button>
            {!proformaMode && (
              <Button
                variant={showZeroStock ? "default" : "outline"}
                size="sm"
                onClick={() => setShowZeroStock((v) => !v)}
                data-testid="button-show-zero-stock"
                className="gap-1.5"
              >
                <Eye className="h-4 w-4" />
                {showZeroStock ? "Hide zero" : "Show zero"}
              </Button>
            )}
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5 ml-auto" data-testid="button-columns">
                  <SlidersHorizontal className="h-4 w-4" />
                  Columns
                  {hiddenColumns.size > 0 && (
                    <Badge variant="secondary" className="ml-1 text-xs px-1 py-0">
                      {hiddenColumns.size}
                    </Badge>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-48 p-3" align="end">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                  Show / Hide Columns
                </p>
                <div className="space-y-1">
                  {[
                    { key: "category", label: "Category" },
                    { key: "avg_kg", label: "Avg KG/Bale" },
                    ...(!hideSellingPrice
                      ? [
                          { key: "sell_price", label: "Sell Price" },
                          { key: "sell_value", label: "Sell Value" },
                          { key: "cost_price", label: "Cost Price" },
                          { key: "cost_value", label: "Cost Value" },
                        ]
                      : []),
                    { key: "total_kg", label: "Total KG" },
                    ...(!proformaMode ? [{ key: "actions", label: "Actions" }] : []),
                  ].map(({ key, label }) => (
                    <label key={key} className="flex items-center gap-2 py-0.5 cursor-pointer">
                      <Checkbox
                        checked={!hiddenColumns.has(key)}
                        onCheckedChange={() => toggleCol(key)}
                        data-testid={`checkbox-col-${key}`}
                      />
                      <span className="text-sm">{label}</span>
                    </label>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>

        {/* Loading skeleton */}
        {(inventoryLoading || (proformaMode && availableLoading)) && (
          <div className="p-4 space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        )}

        {/* Mobile cards */}
        {!inventoryLoading && !(proformaMode && availableLoading) && (
          <div className="md:hidden p-4 space-y-3">
            {regularProducts.length === 0 && specialProducts.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground" data-testid="text-no-products">
                No products found
                {productSearch || categoryFilter.length > 0 ? " matching your filters" : " at this location"}
              </div>
            ) : (
              <>
                {regularProducts.map((prod) => renderMobileCard(prod))}
                {regularProducts.length > 0 && (
                  <div className="rounded-xl border p-3 bg-muted/30" data-testid="text-product-totals">
                    <div className="flex items-center justify-between gap-2 font-bold text-sm">
                      <span>
                        Total ({regularProducts.length} products, {totalBales.toLocaleString()} bales)
                      </span>
                      <span className="font-mono">{fmt(totalKg)} KG</span>
                    </div>
                    {!hideSellingPrice && (
                      <div className="flex justify-between text-sm font-mono font-bold">
                        <span>{formatAmount(totalSellValue)} sell</span>
                        <span>{formatAmount(totalProdValue)} prod</span>
                      </div>
                    )}
                  </div>
                )}
                {specialProducts.length > 0 && (
                  <>
                    <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wide pt-2">
                      Wipers &amp; Garbage
                    </p>
                    {specialProducts.map((prod) => renderMobileCard(prod, "-sp"))}
                    <div className="rounded-xl border p-3 bg-muted/30" data-testid="text-special-product-totals">
                      <div className="flex items-center justify-between gap-2 font-bold text-sm">
                        <span>
                          Total ({specialProducts.length} products, {spTotalBales.toLocaleString()} bales)
                        </span>
                        <span className="font-mono">{fmt(spTotalKg)} KG</span>
                      </div>
                      {!hideSellingPrice && (
                        <div className="text-right text-sm font-mono font-bold">
                          {formatAmount(spTotalSellValue)} sell
                        </div>
                      )}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        )}

        {/* Desktop table */}
        {!inventoryLoading && !(proformaMode && availableLoading) && (
          <div className="hidden md:block space-y-0 w-full">
            <div data-horizontal-scroll="true" className="rounded-md border w-full overflow-x-auto">
              <table className="table-fixed text-sm" style={{ minWidth: "820px", width: "100%" }}>
                <colgroup>
                  {proformaMode && <col style={{ width: "36px" }} />}
                  <col style={{ minWidth: "200px" }} />
                  {col("category") && <col style={{ width: "110px" }} />}
                  <col style={{ width: "70px" }} />
                  {proformaMode && <col style={{ width: "80px" }} />}
                  {proformaMode && <col style={{ width: "110px" }} />}
                  {col("avg_kg") && <col style={{ width: "110px" }} />}
                  {!hideSellingPrice && col("sell_price") && <col style={{ width: "110px" }} />}
                  {!hideSellingPrice && col("sell_value") && <col style={{ width: "130px" }} />}
                  {!hideSellingPrice && col("cost_price") && <col style={{ width: "110px" }} />}
                  {!hideSellingPrice && col("cost_value") && <col style={{ width: "130px" }} />}
                  {col("total_kg") && <col style={{ width: "100px" }} />}
                  {!proformaMode && col("actions") && <col style={{ width: "100px" }} />}
                </colgroup>
                <thead className="bg-muted border-b-2 border-border/60 sticky top-0 z-30">
                  <tr className="h-10">
                    {proformaMode && <th className="px-2"></th>}
                    <th className="text-left px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
                      Product
                    </th>
                    {col("category") && (
                      <th className="text-left px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        Category
                      </th>
                    )}
                    <th className="text-right px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
                      {proformaMode ? "Available" : "Bales"}
                    </th>
                    {proformaMode && (
                      <th className="text-right px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        Qty
                      </th>
                    )}
                    {proformaMode && (
                      <th className="text-right px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
                        Price/Bale
                      </th>
                    )}
                    {col("avg_kg") && (
                      <th className="text-right px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
                        Avg KG/Bale
                      </th>
                    )}
                    {!hideSellingPrice && col("sell_price") && (
                      <th className="text-right px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
                        Sell Price
                      </th>
                    )}
                    {!hideSellingPrice && col("sell_value") && (
                      <th className="text-right px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
                        Sell Value
                      </th>
                    )}
                    {!hideSellingPrice && col("cost_price") && (
                      <th className="text-right px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
                        Cost Price
                      </th>
                    )}
                    {!hideSellingPrice && col("cost_value") && (
                      <th className="text-right px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
                        Cost Value
                      </th>
                    )}
                    {col("total_kg") && (
                      <th className="text-right px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
                        Total KG
                      </th>
                    )}
                    {!proformaMode && col("actions") && (
                      <th className="text-center px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        Actions
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {regularProducts.length === 0 && specialProducts.length === 0 ? (
                    <tr>
                      <td
                        colSpan={colSpan}
                        className="text-center py-8 text-muted-foreground"
                        data-testid="text-no-products-desktop"
                      >
                        No products found
                        {productSearch || categoryFilter.length > 0 ? " matching your filters" : " at this location"}
                      </td>
                    </tr>
                  ) : (
                    <>
                      {regularProducts.map((prod) => renderProductRow(prod))}
                      {regularProducts.length > 0 && (
                        <tr className="border-t bg-muted/50 h-12 font-bold">
                          {proformaMode && <td></td>}
                          <td className="px-3" colSpan={col("category") ? 2 : 1}>
                            Total ({regularProducts.length} products)
                          </td>
                          <td className="text-right px-3 font-mono">{totalBales.toLocaleString()}</td>
                          {proformaMode && <td></td>}
                          {proformaMode && <td></td>}
                          {col("avg_kg") && (
                            <td className="text-right px-3 font-mono">{proformaMode ? fmt(totalKg) : ""}</td>
                          )}
                          {!hideSellingPrice && col("sell_price") && <td></td>}
                          {!hideSellingPrice && col("sell_value") && (
                            <td className="text-right px-3 font-mono">{formatAmount(totalSellValue)}</td>
                          )}
                          {!hideSellingPrice && col("cost_price") && <td></td>}
                          {!hideSellingPrice && col("cost_value") && (
                            <td className="text-right px-3 font-mono">{formatAmount(totalProdValue)}</td>
                          )}
                          {col("total_kg") && <td className="text-right px-3 font-mono">{fmt(totalKg)}</td>}
                          {!proformaMode && col("actions") && <td></td>}
                        </tr>
                      )}
                    </>
                  )}
                </tbody>
              </table>
            </div>

            {specialProducts.length > 0 && (
              <div className="mt-6">
                <p className="text-sm font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
                  Wipers &amp; Garbage
                </p>
                <div className="rounded-md border w-full overflow-auto max-h-[500px]">
                  <table className="table-fixed text-sm" style={{ minWidth: "820px", width: "100%" }}>
                    <colgroup>
                      {proformaMode && <col style={{ width: "36px" }} />}
                      <col style={{ minWidth: "200px" }} />
                      {col("category") && <col style={{ width: "110px" }} />}
                      <col style={{ width: "70px" }} />
                      {proformaMode && <col style={{ width: "80px" }} />}
                      {proformaMode && <col style={{ width: "110px" }} />}
                      {col("avg_kg") && <col style={{ width: "110px" }} />}
                      {!hideSellingPrice && col("sell_price") && <col style={{ width: "110px" }} />}
                      {!hideSellingPrice && col("sell_value") && <col style={{ width: "130px" }} />}
                      {!hideSellingPrice && col("cost_price") && <col style={{ width: "110px" }} />}
                      {!hideSellingPrice && col("cost_value") && <col style={{ width: "130px" }} />}
                      {col("total_kg") && <col style={{ width: "100px" }} />}
                      {!proformaMode && col("actions") && <col style={{ width: "100px" }} />}
                    </colgroup>
                    <thead className="bg-muted border-b-2 border-border/60 sticky top-0 z-30">
                      <tr className="h-10">
                        {proformaMode && <th className="px-2"></th>}
                        <th className="text-left px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
                          Product
                        </th>
                        {col("category") && (
                          <th className="text-left px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                            Category
                          </th>
                        )}
                        <th className="text-right px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
                          {proformaMode ? "Available" : "Bales"}
                        </th>
                        {proformaMode && (
                          <th className="text-right px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                            Qty
                          </th>
                        )}
                        {proformaMode && (
                          <th className="text-right px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
                            Price/Bale
                          </th>
                        )}
                        {col("avg_kg") && (
                          <th className="text-right px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
                            Avg KG/Bale
                          </th>
                        )}
                        {!hideSellingPrice && col("sell_price") && (
                          <th className="text-right px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
                            Sell Price
                          </th>
                        )}
                        {!hideSellingPrice && col("sell_value") && (
                          <th className="text-right px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
                            Sell Value
                          </th>
                        )}
                        {!hideSellingPrice && col("cost_price") && (
                          <th className="text-right px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
                            Cost Price
                          </th>
                        )}
                        {!hideSellingPrice && col("cost_value") && (
                          <th className="text-right px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
                            Cost Value
                          </th>
                        )}
                        {col("total_kg") && (
                          <th className="text-right px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
                            Total KG
                          </th>
                        )}
                        {!proformaMode && col("actions") && (
                          <th className="text-center px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                            Actions
                          </th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {specialProducts.map((prod) => renderProductRow(prod, "-sp"))}
                      <tr className="border-t bg-muted/50 h-12 font-bold">
                        {proformaMode && <td></td>}
                        <td className="px-3" colSpan={col("category") ? 2 : 1}>
                          Total ({specialProducts.length} products)
                        </td>
                        <td className="text-right px-3 font-mono">{spTotalBales.toLocaleString()}</td>
                        {proformaMode && <td></td>}
                        {proformaMode && <td></td>}
                        {col("avg_kg") && (
                          <td className="text-right px-3 font-mono">{proformaMode ? fmt(spTotalKg) : ""}</td>
                        )}
                        {!hideSellingPrice && col("sell_price") && <td></td>}
                        {!hideSellingPrice && col("sell_value") && (
                          <td className="text-right px-3 font-mono">{formatAmount(spTotalSellValue)}</td>
                        )}
                        {!hideSellingPrice && col("cost_price") && <td></td>}
                        {!hideSellingPrice && col("cost_value") && (
                          <td className="text-right px-3 font-mono">{formatAmount(spTotalProdValue)}</td>
                        )}
                        {col("total_kg") && <td className="text-right px-3 font-mono">{fmt(spTotalKg)}</td>}
                        {!proformaMode && col("actions") && <td></td>}
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {!inventoryLoading && filteredProducts.length > 0 && (
          <div className="px-4 py-3 border-t text-xs text-muted-foreground">
            Showing {filteredProducts.length} of {activeInventoryData.length} products
          </div>
        )}
      </div>

      <FactoryLocationInventoryProductFooterDialogs inventory={inventory} />
    </div>
  );
}
