// Extracted from ./FactoryLocationInventoryProductView.tsx
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Layers, Search, Eye, SlidersHorizontal, ChevronDown, ListFilter } from "lucide-react";
import type { SortField } from "./factorylocationinventory/types";
import { InventoryTableColumns } from "./factorylocationinventory/components/InventoryTableColumns";
import { SearchField } from "@/components/ui/search-field";
import type { FactoryLocationInventoryModel } from "./FactoryLocationInventoryProductView";
import type { useFactoryMhdView } from "@/hooks/use-factory-mhd-view";
import type { createFactoryLocationProductRenderers } from "./FactoryLocationInventoryProductRenderers";
import type { createFactoryLocationProductMetrics } from "./factorylocationinventory/productMetrics";

export function FactoryLocationInventoryProductTable({
  inventory,
  metrics,
  renderers,
  mhd,
  categorySearch,
  setCategorySearch,
  matchingCategoryNames,
}: {
  inventory: FactoryLocationInventoryModel;
  metrics: ReturnType<typeof createFactoryLocationProductMetrics>;
  renderers: ReturnType<typeof createFactoryLocationProductRenderers>;
  mhd: ReturnType<typeof useFactoryMhdView>;
  categorySearch: string;
  setCategorySearch: (value: string) => void;
  matchingCategoryNames: string[];
}) {
  return (
    <div className="inventory-table-shell rounded-xl border overflow-hidden w-full" ref={inventory.printRef}>
      {/* Toolbar strip */}
      <div className="inventory-toolbar flex flex-col gap-2 px-4 py-3 border-b bg-muted/20">
        <SearchField
          placeholder="Search product or article code..."
          value={inventory.productSearch}
          onValueChange={inventory.setProductSearch}
          className="inventory-search-input"
          data-testid="input-search-products"
        />
        <div className="flex items-center gap-2 flex-wrap">
          <Popover
            onOpenChange={(open) => {
              if (!open) setCategorySearch("");
            }}
          >
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="inventory-filter-button gap-1.5 h-8"
                data-testid="button-category-filter"
              >
                <ListFilter className="h-3.5 w-3.5" />
                {inventory.categoryFilter.length === 0
                  ? "All Categories"
                  : inventory.categoryFilter.length === 1
                    ? inventory.categoryFilter[0]
                    : `${inventory.categoryFilter.length} categories`}
                <ChevronDown className="h-3 w-3 opacity-50 ml-0.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-64 p-1" align="start">
              <div className="relative p-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  value={categorySearch}
                  onChange={(event) => setCategorySearch(event.target.value)}
                  placeholder="Search categories..."
                  aria-label="Search categories"
                  className="h-8 pl-8 text-xs"
                  data-testid="input-search-categories"
                />
              </div>
              <div className="max-h-64 overflow-y-auto">
                <div
                  className="flex items-center gap-2 px-2 py-1.5 rounded-xs cursor-pointer hover-elevate text-xs"
                  onClick={() => inventory.setCategoryFilter([])}
                  data-testid="badge-category-all"
                >
                  <Checkbox
                    checked={inventory.categoryFilter.length === 0}
                    onCheckedChange={() => inventory.setCategoryFilter([])}
                    className="h-3 w-3 shrink-0"
                  />
                  <span className="font-medium">All Categories</span>
                </div>
                <div className="border-t my-1" />
                {matchingCategoryNames.map((name) => (
                  <div
                    key={name}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-xs cursor-pointer hover-elevate text-xs"
                    onClick={() =>
                      inventory.setCategoryFilter((prev) =>
                        prev.includes(name) ? prev.filter((c) => c !== name) : [...prev, name]
                      )
                    }
                    data-testid={`badge-category-${name}`}
                  >
                    <Checkbox
                      checked={inventory.categoryFilter.includes(name)}
                      onClick={(event) => event.stopPropagation()}
                      onCheckedChange={() =>
                        inventory.setCategoryFilter((prev) =>
                          prev.includes(name) ? prev.filter((c) => c !== name) : [...prev, name]
                        )
                      }
                      className="h-3 w-3 shrink-0"
                    />
                    <span className="truncate">{name}</span>
                  </div>
                ))}
                {matchingCategoryNames.length === 0 && (
                  <p className="px-2 py-3 text-xs text-muted-foreground text-center">No matching categories</p>
                )}
              </div>
              {inventory.categoryFilter.length > 0 && (
                <div className="border-t mt-1 pt-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-full text-xs text-muted-foreground"
                    onClick={() => inventory.setCategoryFilter([])}
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
                variant={inventory.prodSortField === field ? "default" : "outline"}
                className={`inventory-sort-chip cursor-pointer ${inventory.prodSortField === field ? "is-active" : ""}`}
                onClick={() => inventory.setProdSortField(field)}
                data-testid={`badge-sort-${field}`}
              >
                {field === "name" ? "Name" : field === "bales" ? "Bales" : field === "kg" ? "KG" : "Value"}
              </Badge>
            ))}
          </div>
          <Button
            variant="outline"
            size="icon"
            onClick={() => inventory.setProdSortDir((d) => (d === "asc" ? "desc" : "asc"))}
            data-testid="button-sort-dir"
          >
            {inventory.prodSortDir === "asc" ? "↑" : "↓"}
          </Button>
          {!inventory.proformaMode && (
            <Button
              variant={inventory.showZeroStock ? "default" : "outline"}
              size="sm"
              onClick={() => inventory.setShowZeroStock((v) => !v)}
              data-testid="button-show-zero-stock"
              className="gap-1.5"
            >
              <Eye className="h-4 w-4" />
              {inventory.showZeroStock ? "Hide zero" : "Show zero"}
            </Button>
          )}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="inventory-columns-button gap-1.5 ml-auto"
                data-testid="button-columns"
              >
                <SlidersHorizontal className="h-4 w-4" />
                Columns
                {inventory.hiddenColumns.size > 0 && (
                  <Badge variant="secondary" className="ml-1 text-xs px-1 py-0">
                    {inventory.hiddenColumns.size}
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
                  ...(!inventory.hideSellingPrice
                    ? [
                        { key: "sell_price", label: "Sell Price" },
                        { key: "sell_value", label: "Sell Value" },
                        { key: "cost_price", label: "Cost Price" },
                        { key: "cost_value", label: "Cost Value" },
                      ]
                    : []),
                  { key: "total_kg", label: "Total KG" },
                  ...(!inventory.proformaMode ? [{ key: "actions", label: "Actions" }] : []),
                ].map(({ key, label }) => (
                  <label key={key} className="flex items-center gap-2 py-0.5 cursor-pointer">
                    <Checkbox
                      checked={!inventory.hiddenColumns.has(key)}
                      onCheckedChange={() => metrics.toggleCol(key)}
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
      {(inventory.inventoryLoading || (inventory.proformaMode && inventory.availableLoading)) && (
        <div className="p-4 space-y-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      )}

      {/* Mobile cards */}
      {!inventory.inventoryLoading && !(inventory.proformaMode && inventory.availableLoading) && (
        <div className="md:hidden p-4 space-y-3">
          {inventory.regularProducts.length === 0 && inventory.specialProducts.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground" data-testid="text-no-products">
              No products found
              {inventory.productSearch || inventory.categoryFilter.length > 0
                ? " matching your filters"
                : " at this location"}
            </div>
          ) : (
            <>
              {mhd
                .sortRows(inventory.regularProducts, (prod) => prod.articleCode)
                .map((prod) => renderers.renderMobileCard(prod))}
              {inventory.regularProducts.length > 0 && (
                <div
                  className="inventory-mobile-total rounded-xl border p-3 bg-muted/30"
                  data-testid="text-product-totals"
                >
                  <div className="flex items-center justify-between gap-2 font-bold text-sm">
                    <span>
                      Total ({inventory.regularProducts.length} products, {metrics.totalBales.toLocaleString()} bales)
                    </span>
                    <span className="font-mono">{inventory.fmt(metrics.totalKg)} KG</span>
                  </div>
                  {!inventory.hideSellingPrice && (
                    <div className="flex justify-between text-sm font-mono font-bold">
                      <span>{inventory.formatAmount(metrics.totalSellValue)} sell</span>
                      <span>{inventory.formatAmount(metrics.totalProdValue)} prod</span>
                    </div>
                  )}
                </div>
              )}
              {inventory.specialProducts.length > 0 && (
                <>
                  <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wide pt-2">
                    Wipers &amp; Garbage
                  </p>
                  {mhd
                    .sortRows(inventory.specialProducts, (prod) => prod.articleCode)
                    .map((prod) => renderers.renderMobileCard(prod, "-sp"))}
                  <div
                    className="inventory-mobile-total rounded-xl border p-3 bg-muted/30"
                    data-testid="text-special-product-totals"
                  >
                    <div className="flex items-center justify-between gap-2 font-bold text-sm">
                      <span>
                        Total ({inventory.specialProducts.length} products, {metrics.spTotalBales.toLocaleString()}{" "}
                        bales)
                      </span>
                      <span className="font-mono">{inventory.fmt(metrics.spTotalKg)} KG</span>
                    </div>
                    {!inventory.hideSellingPrice && (
                      <div className="text-right text-sm font-mono font-bold">
                        {inventory.formatAmount(metrics.spTotalSellValue)} sell
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
      {!inventory.inventoryLoading && !(inventory.proformaMode && inventory.availableLoading) && (
        <div className="hidden md:block space-y-0 w-full">
          <div
            data-horizontal-scroll="true"
            className="inventory-table-frame inventory-scroll-frame rounded-md border w-full overflow-auto"
            role="region"
            aria-label="Regular location inventory items"
            tabIndex={0}
            data-testid="location-inventory-regular-scroll"
          >
            <table className="inventory-stock-table table-fixed text-sm" style={{ minWidth: "820px", width: "100%" }}>
              <InventoryTableColumns
                proformaMode={inventory.proformaMode}
                hideSellingPrice={inventory.hideSellingPrice}
                col={metrics.col}
              />
              <tbody>
                {inventory.regularProducts.length === 0 && inventory.specialProducts.length === 0 ? (
                  <tr>
                    <td
                      colSpan={metrics.colSpan}
                      className="text-center py-8 text-muted-foreground"
                      data-testid="text-no-products-desktop"
                    >
                      No products found
                      {inventory.productSearch || inventory.categoryFilter.length > 0
                        ? " matching your filters"
                        : " at this location"}
                    </td>
                  </tr>
                ) : (
                  <>
                    {mhd
                      .sortRows(inventory.regularProducts, (prod) => prod.articleCode)
                      .map((prod) => renderers.renderProductRow(prod))}
                  </>
                )}
              </tbody>
              <tfoot>
                {inventory.regularProducts.length > 0 && (
                  <tr className="inventory-section-total border-t bg-muted/50 h-12 font-bold">
                    {inventory.proformaMode && <td></td>}
                    <td className="px-3" colSpan={metrics.col("category") ? 2 : 1}>
                      Total ({inventory.regularProducts.length} products)
                    </td>
                    <td className="text-right px-3 font-mono">{metrics.totalBales.toLocaleString()}</td>
                    {inventory.proformaMode && <td></td>}
                    {inventory.proformaMode && <td></td>}
                    {metrics.col("avg_kg") && (
                      <td className="text-right px-3 font-mono">
                        {inventory.proformaMode ? inventory.fmt(metrics.totalKg) : ""}
                      </td>
                    )}
                    {!inventory.hideSellingPrice && metrics.col("sell_price") && <td></td>}
                    {!inventory.hideSellingPrice && metrics.col("sell_value") && (
                      <td className="text-right px-3 font-mono">{inventory.formatAmount(metrics.totalSellValue)}</td>
                    )}
                    {!inventory.hideSellingPrice && metrics.col("cost_price") && <td></td>}
                    {!inventory.hideSellingPrice && metrics.col("cost_value") && (
                      <td className="text-right px-3 font-mono">{inventory.formatAmount(metrics.totalProdValue)}</td>
                    )}
                    {metrics.col("total_kg") && (
                      <td className="text-right px-3 font-mono">{inventory.fmt(metrics.totalKg)}</td>
                    )}
                    {!inventory.proformaMode && metrics.col("actions") && <td></td>}
                  </tr>
                )}
              </tfoot>
            </table>
          </div>

          {inventory.specialProducts.length > 0 && (
            <div className="mt-6">
              <p className="inventory-special-heading text-sm font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
                <Layers className="inventory-special-icon h-4 w-4" /> Wipers &amp; Garbage
              </p>
              <div
                className="inventory-table-frame inventory-scroll-frame rounded-md border w-full overflow-auto"
                role="region"
                aria-label="Wipers and garbage inventory items"
                tabIndex={0}
                data-testid="location-inventory-special-scroll"
              >
                <table
                  className="inventory-stock-table table-fixed text-sm"
                  style={{ minWidth: "820px", width: "100%" }}
                >
                  <InventoryTableColumns
                    proformaMode={inventory.proformaMode}
                    hideSellingPrice={inventory.hideSellingPrice}
                    col={metrics.col}
                  />
                  <tbody>
                    {mhd
                      .sortRows(inventory.specialProducts, (prod) => prod.articleCode)
                      .map((prod) => renderers.renderProductRow(prod, "-sp"))}
                  </tbody>
                  <tfoot>
                    <tr className="inventory-section-total border-t bg-muted/50 h-12 font-bold">
                      {inventory.proformaMode && <td></td>}
                      <td className="px-3" colSpan={metrics.col("category") ? 2 : 1}>
                        Total ({inventory.specialProducts.length} products)
                      </td>
                      <td className="text-right px-3 font-mono">{metrics.spTotalBales.toLocaleString()}</td>
                      {inventory.proformaMode && <td></td>}
                      {inventory.proformaMode && <td></td>}
                      {metrics.col("avg_kg") && (
                        <td className="text-right px-3 font-mono">
                          {inventory.proformaMode ? inventory.fmt(metrics.spTotalKg) : ""}
                        </td>
                      )}
                      {!inventory.hideSellingPrice && metrics.col("sell_price") && <td></td>}
                      {!inventory.hideSellingPrice && metrics.col("sell_value") && (
                        <td className="text-right px-3 font-mono">
                          {inventory.formatAmount(metrics.spTotalSellValue)}
                        </td>
                      )}
                      {!inventory.hideSellingPrice && metrics.col("cost_price") && <td></td>}
                      {!inventory.hideSellingPrice && metrics.col("cost_value") && (
                        <td className="text-right px-3 font-mono">
                          {inventory.formatAmount(metrics.spTotalProdValue)}
                        </td>
                      )}
                      {metrics.col("total_kg") && (
                        <td className="text-right px-3 font-mono">{inventory.fmt(metrics.spTotalKg)}</td>
                      )}
                      {!inventory.proformaMode && metrics.col("actions") && <td></td>}
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {!inventory.inventoryLoading && inventory.filteredProducts.length > 0 && (
        <div className="inventory-table-footer px-4 py-3 border-t text-xs text-muted-foreground">
          Showing {inventory.filteredProducts.length} of {inventory.activeInventoryData.length} products
        </div>
      )}
    </div>
  );
}
