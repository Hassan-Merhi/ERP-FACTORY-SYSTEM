// Extracted from ./RetailInventory.tsx to keep that module under the source-size cap.
import { ChevronRight, FolderOpen, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RetailCatalogList } from "./RetailCatalogList";
import { useRetailInventoryState } from "./useRetailInventoryState";

export function RetailInventorySection({
  catalogFailed,
  catalogFilters,
  catalogPage,
  handleVariantAction,
  isLoading,
  navigate,
  openEditor,
  page,
  products,
  recordChanges,
  selected,
  setPage,
  setProductActive,
  toggleVariant,
  toggleVariants,
}: Pick<
  ReturnType<typeof useRetailInventoryState>,
  | "catalogFailed"
  | "catalogFilters"
  | "catalogPage"
  | "handleVariantAction"
  | "isLoading"
  | "navigate"
  | "openEditor"
  | "page"
  | "products"
  | "recordChanges"
  | "selected"
  | "setPage"
  | "setProductActive"
  | "toggleVariant"
  | "toggleVariants"
>) {
  return (
    <div className="space-y-4 border-t border-border/60 p-3 sm:p-5">
      {isLoading ? (
        <p className="p-6 text-sm text-muted-foreground">Loading products…</p>
      ) : catalogFailed ? (
        <p className="p-6 text-sm text-destructive">Could not load products. Try again.</p>
      ) : products.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          No products match these filters.
        </p>
      ) : (
        <RetailCatalogList
          products={products}
          filters={catalogFilters}
          selected={selected}
          onToggle={toggleVariant}
          onToggleProduct={toggleVariants}
          onOpenProduct={(product) => navigate(`/retail/products/${product.id}`)}
          onEdit={openEditor}
          onArchiveProduct={(product, active) => void setProductActive(product, active)}
          onVariantAction={handleVariantAction}
          showBrandHeadings={false}
          changeDisabledReason={recordChanges.reason}
        />
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          {catalogPage?.total ?? 0} product{(catalogPage?.total ?? 0) === 1 ? "" : "s"}
          {(catalogPage?.totalPages ?? 0) > 0
            ? ` · Page ${catalogPage?.page ?? page} of ${catalogPage?.totalPages}`
            : ""}
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={(catalogPage?.page ?? page) <= 1 || isLoading}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={
              isLoading ||
              (catalogPage?.totalPages ?? 0) === 0 ||
              (catalogPage?.page ?? page) >= (catalogPage?.totalPages ?? 0)
            }
            onClick={() => setPage((current) => current + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}

export function RetailInventorySection2({
  navigationData,
  selectedLocation,
  setCategoryKey,
  setExpandedBrandKey,
  setSelected,
}: Pick<
  ReturnType<typeof useRetailInventoryState>,
  "navigationData" | "selectedLocation" | "setCategoryKey" | "setExpandedBrandKey" | "setSelected"
>) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold" data-no-translate>
        Categories in {selectedLocation?.name ?? "selected location"}
      </h2>
      {(navigationData?.categories.length ?? 0) === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          No categories match the selected location and filters.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {navigationData?.categories.map((item) => (
            <button
              key={item.key}
              type="button"
              className="flex items-center gap-3 rounded-lg border bg-card p-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => {
                setCategoryKey(item.key);
                setExpandedBrandKey(null);
                setSelected(new Set());
              }}
            >
              <FolderOpen className="h-5 w-5 shrink-0 text-primary" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold" data-no-translate>
                  {item.name}
                </span>
                <span className="block text-xs text-muted-foreground">{item.productCount} products</span>
              </span>
              <ChevronRight className="h-5 w-5 text-muted-foreground" />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export function RetailInventorySection3({
  locations,
  locationsLoading,
  setCategoryKey,
  setExpandedBrandKey,
  setLocationId,
  setSelected,
}: Pick<
  ReturnType<typeof useRetailInventoryState>,
  "locations" | "locationsLoading" | "setCategoryKey" | "setExpandedBrandKey" | "setLocationId" | "setSelected"
>) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Choose a location</h2>
      {locationsLoading ? (
        <p className="p-5 text-sm text-muted-foreground">Loading locations…</p>
      ) : locations.filter((entry) => entry.active !== false).length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          No active locations are available.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {locations
            .filter((entry) => entry.active !== false)
            .map((location) => (
              <button
                key={location.id}
                type="button"
                className="flex items-center gap-3 rounded-lg border bg-card p-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                onClick={() => {
                  setLocationId(String(location.id));
                  setCategoryKey(null);
                  setExpandedBrandKey(null);
                  setSelected(new Set());
                }}
              >
                <MapPin className="h-5 w-5 shrink-0 text-primary" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold" data-no-translate>
                    {location.name}
                  </span>
                  <span className="block text-xs text-muted-foreground" data-no-translate>
                    {location.code}
                  </span>
                </span>
                <ChevronRight className="h-5 w-5 text-muted-foreground" />
              </button>
            ))}
        </div>
      )}
    </section>
  );
}

export function RetailInventorySection4({
  color,
  colors,
  search,
  setColor,
  setSearch,
  setSize,
  setStockStatus,
  size,
  sizes,
  stockStatus,
}: Pick<
  ReturnType<typeof useRetailInventoryState>,
  | "color"
  | "colors"
  | "search"
  | "setColor"
  | "setSearch"
  | "setSize"
  | "setStockStatus"
  | "size"
  | "sizes"
  | "stockStatus"
>) {
  return (
    <div className="grid grid-cols-1 gap-3 rounded-2xl border border-border/70 bg-card/70 p-3 shadow-sm sm:grid-cols-2 lg:grid-cols-5 sm:p-4">
      <SearchField
        placeholder="Search style, brand, barcode, SKU, color or size…"
        value={search}
        onValueChange={setSearch}
        className="h-11 rounded-xl bg-background/60"
        wrapperClassName="sm:col-span-2 lg:col-span-2"
        aria-label="Search retail inventory"
      />
      <Select value={color || "__all__"} onValueChange={(v) => setColor(v === "__all__" ? "" : v)}>
        <SelectTrigger
          className="h-11 rounded-xl border-border/70 bg-background/60 px-3 text-sm"
          aria-label="Filter by color"
        >
          <SelectValue placeholder="All colors" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">All colors</SelectItem>
          {colors.map((value) => (
            <SelectItem key={value} value={value}>
              {value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={size || "__all__"} onValueChange={(v) => setSize(v === "__all__" ? "" : v)}>
        <SelectTrigger className="h-10 px-2 text-sm" aria-label="Filter by size">
          <SelectValue placeholder="All sizes" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">All sizes</SelectItem>
          {sizes.map((value) => (
            <SelectItem key={value} value={value}>
              {value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={stockStatus} onValueChange={setStockStatus}>
        <SelectTrigger className="h-10 px-2 text-sm" aria-label="Filter by stock status">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All stock</SelectItem>
          <SelectItem value="in">In stock</SelectItem>
          <SelectItem value="low">Low stock</SelectItem>
          <SelectItem value="out">Out of stock</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
