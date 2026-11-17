import { ArrowLeft, Boxes, ChevronDown, ChevronRight, MapPin, Pencil, Plus, Upload } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RetailSupplierImportDialog } from "./RetailSupplierImportDialog";
import { ProductEditor } from "./RetailProductEditor";
import { ProductImageGallery } from "./RetailProductImage";
import { RetailCatalogList } from "./RetailCatalogList";
import { useRetailInventoryState } from "./useRetailInventoryState";
import {
  RetailInventorySection,
  RetailInventorySection2,
  RetailInventorySection3,
  RetailInventorySection4,
} from "./RetailInventorySection";

export default function RetailInventory() {
  const {
    actionDialogs,
    brands,
    bulkBar,
    catalogFailed,
    catalogFilters,
    catalogPage,
    categoryKey,
    color,
    colors,
    detailFailed,
    detailMatch,
    detailProduct,
    editingProduct,
    editorOpen,
    expandedBrandKey,
    handleVariantAction,
    isLoading,
    locationId,
    locations,
    locationsLoading,
    navigate,
    navigationData,
    navigationFailed,
    navigationLoading,
    openEditor,
    page,
    products,
    recordChanges,
    retailEnabled,
    search,
    selected,
    selectedCategory,
    selectedLocation,
    setCategoryKey,
    setColor,
    setEditingProduct,
    setEditorOpen,
    setExpandedBrandKey,
    setLocationId,
    setPage,
    setProductActive,
    setSearch,
    setSelected,
    setShowArchived,
    setSize,
    setStockStatus,
    setSupplierImportOpen,
    showArchived,
    size,
    sizes,
    stockStatus,
    supplierImportOpen,
    toggleVariant,
    toggleVariants,
  } = useRetailInventoryState();

  if (!retailEnabled) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="p-6">
            Retail inventory is only available when a Retail / Variant Inventory company is selected.
          </CardContent>
        </Card>
      </div>
    );
  }

  if (detailMatch) {
    if (!detailProduct) {
      return (
        <div className="space-y-3 p-6 text-sm text-muted-foreground">
          <p data-i18n-ui>{detailFailed ? "Retail product not found" : "Loading product…"}</p>
          {detailFailed && (
            <Button variant="outline" onClick={() => navigate("/retail/inventory")}>
              <ArrowLeft className="mr-2 h-4 w-4" /> Inventory
            </Button>
          )}
        </div>
      );
    }
    return (
      <div className="mx-auto max-w-7xl space-y-5 p-4 pb-24 md:p-6 md:pb-24">
        <PageHeader
          title={detailProduct.name}
          meta={
            <span>
              {detailProduct.brand.name}
              {detailProduct.category ? ` · ${detailProduct.category}` : ""}
            </span>
          }
          backTarget="/retail/inventory"
        >
          <Button
            onClick={() => {
              if (!recordChanges.allowed) return;
              setEditingProduct(detailProduct);
              setEditorOpen(true);
            }}
            disabled={!recordChanges.allowed}
            title={recordChanges.reason ?? undefined}
            aria-label={recordChanges.reason ?? "Edit product"}
          >
            <Pencil className="mr-2 h-4 w-4" /> Edit product
          </Button>
        </PageHeader>

        <ProductImageGallery
          product={detailProduct}
          className="max-w-full"
          imageClassName="h-36 w-36 rounded-lg border sm:h-44 sm:w-44"
        />

        <Card>
          <CardHeader>
            <CardTitle>Stock by color and size</CardTitle>
          </CardHeader>
          <CardContent>
            <RetailCatalogList
              products={[detailProduct]}
              filters={{
                ...catalogFilters,
                locationId: "",
                color: "",
                size: "",
                stockStatus: "all",
                showArchived: true,
              }}
              selected={selected}
              onToggle={toggleVariant}
              onToggleProduct={toggleVariants}
              onOpenProduct={() => undefined}
              onEdit={openEditor}
              onArchiveProduct={(product, active) => void setProductActive(product, active)}
              onVariantAction={handleVariantAction}
              changeDisabledReason={recordChanges.reason}
            />
          </CardContent>
        </Card>
        {bulkBar}
        {actionDialogs}

        <ProductEditor
          open={editorOpen}
          onOpenChange={setEditorOpen}
          product={editingProduct}
          brands={brands}
          locations={locations}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1700px] space-y-6 p-4 pb-24 md:p-6 md:pb-24">
      <PageHeader
        title="Retail Inventory"
        subtitle="Browse and manage retail products, variants, and stock."
        icon={<Boxes className="h-6 w-6" />}
      >
        {/* Create Only cannot import stock; View Only sees it disabled. */}
        {!recordChanges.isCreateOnly && (
          <Button
            onClick={() => setSupplierImportOpen(true)}
            disabled={!recordChanges.allowed}
            title={recordChanges.reason ?? undefined}
          >
            <Upload className="mr-2 h-4 w-4" /> Supplier Stock Import
          </Button>
        )}
        <Button
          variant="outline"
          onClick={() => {
            setEditingProduct(null);
            setEditorOpen(true);
          }}
        >
          <Plus className="mr-2 h-4 w-4" /> Add Product
        </Button>
      </PageHeader>

      <RetailInventorySection4
        color={color}
        colors={colors}
        search={search}
        setColor={setColor}
        setSearch={setSearch}
        setSize={setSize}
        setStockStatus={setStockStatus}
        size={size}
        sizes={sizes}
        stockStatus={stockStatus}
      />
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <Checkbox checked={showArchived} onCheckedChange={(value) => setShowArchived(value === true)} />
        <span>Show archived items</span>
      </label>

      <nav
        aria-label="Retail inventory breadcrumbs"
        className="flex flex-wrap items-center gap-1 rounded-xl border border-border/70 bg-card/70 p-2 shadow-sm"
      >
        <Button
          variant={!locationId ? "secondary" : "ghost"}
          size="sm"
          onClick={() => {
            setLocationId("");
            setCategoryKey(null);
            setExpandedBrandKey(null);
            setSelected(new Set());
          }}
        >
          <MapPin className="mr-1 h-4 w-4" /> Locations
        </Button>
        {locationId && (
          <>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
            <Button
              variant={!categoryKey ? "secondary" : "ghost"}
              size="sm"
              onClick={() => {
                setCategoryKey(null);
                setExpandedBrandKey(null);
                setSelected(new Set());
              }}
              data-no-translate
            >
              {selectedLocation?.name ?? "Location"}
            </Button>
          </>
        )}
        {categoryKey && (
          <>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
            <span className="px-2 text-sm font-semibold" data-no-translate>
              {selectedCategory?.name ?? (categoryKey === "__uncategorized__" ? "Uncategorized" : categoryKey)}
            </span>
          </>
        )}
      </nav>

      {!locationId ? (
        <RetailInventorySection3
          locations={locations}
          locationsLoading={locationsLoading}
          setCategoryKey={setCategoryKey}
          setExpandedBrandKey={setExpandedBrandKey}
          setLocationId={setLocationId}
          setSelected={setSelected}
        />
      ) : navigationLoading ? (
        <p className="p-6 text-sm text-muted-foreground">Loading inventory groups…</p>
      ) : navigationFailed ? (
        <p className="rounded-lg border p-6 text-sm text-destructive">
          Could not load inventory categories. Try again.
        </p>
      ) : !categoryKey ? (
        <RetailInventorySection2
          navigationData={navigationData}
          selectedLocation={selectedLocation}
          setCategoryKey={setCategoryKey}
          setExpandedBrandKey={setExpandedBrandKey}
          setSelected={setSelected}
        />
      ) : (
        <section className="space-y-3">
          <h2 className="text-xl font-semibold tracking-tight" data-no-translate>
            Brands in {selectedCategory?.name ?? (categoryKey === "__uncategorized__" ? "Uncategorized" : categoryKey)}
          </h2>
          {!selectedCategory || selectedCategory.brands.length === 0 ? (
            <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
              No brands match this category and the current filters.
            </p>
          ) : (
            <div className="space-y-3">
              {selectedCategory.brands.map((brand) => (
                <div
                  key={brand.key}
                  className="overflow-hidden rounded-2xl border border-border/70 bg-card/70 shadow-sm"
                >
                  <button
                    type="button"
                    className="flex w-full items-center gap-4 bg-gradient-to-r from-primary/10 via-card to-card p-4 text-left transition-colors hover:from-primary/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring sm:p-5"
                    aria-expanded={expandedBrandKey === brand.key}
                    onClick={() => {
                      setExpandedBrandKey((current) => (current === brand.key ? null : brand.key));
                      setPage(1);
                      setSelected(new Set());
                    }}
                  >
                    {expandedBrandKey === brand.key ? (
                      <ChevronDown className="h-5 w-5 text-primary" />
                    ) : (
                      <ChevronRight className="h-5 w-5 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-lg font-bold tracking-tight" data-no-translate>
                      {brand.name}
                    </span>
                    <span className="rounded-full border border-border/70 bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
                      {brand.productCount} products
                    </span>
                  </button>
                  {expandedBrandKey === brand.key && (
                    <RetailInventorySection
                      catalogFailed={catalogFailed}
                      catalogFilters={catalogFilters}
                      catalogPage={catalogPage}
                      handleVariantAction={handleVariantAction}
                      isLoading={isLoading}
                      navigate={navigate}
                      openEditor={openEditor}
                      page={page}
                      products={products}
                      recordChanges={recordChanges}
                      selected={selected}
                      setPage={setPage}
                      setProductActive={setProductActive}
                      toggleVariant={toggleVariant}
                      toggleVariants={toggleVariants}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <ProductEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        product={editingProduct}
        brands={brands}
        locations={locations}
      />
      <RetailSupplierImportDialog open={supplierImportOpen} onOpenChange={setSupplierImportOpen} />
      {bulkBar}
      {actionDialogs}
    </div>
  );
}
