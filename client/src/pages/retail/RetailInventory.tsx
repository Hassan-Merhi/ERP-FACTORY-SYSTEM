import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useRoute } from "wouter";
import { ArrowLeft, Boxes, ChevronDown, ChevronRight, FolderOpen, MapPin, Pencil, Plus, Printer, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { RetailSupplierImportDialog } from "./RetailSupplierImportDialog";
import { ProductEditor } from "./RetailProductEditor";
import { ProductImageGallery } from "./RetailProductImage";
import { RetailCatalogList, type RetailCatalogFilters, type RetailVariantAction } from "./RetailCatalogList";
import { RetailLabelPrintDialog, type RetailLabelRequestItem } from "./retailLabels";
import { confirmAction } from "@/components/ConfirmHost";
import {
  getJson,
  type Brand,
  type Location,
  type RetailCatalogFacets,
  type RetailCatalogNavigation,
  type RetailCatalogPage,
  type RetailProduct,
  type RetailVariant,
} from "./retailInventoryTypes";

export default function RetailInventory() {
  const { selectedCompany } = useCompany();
  const [, navigate] = useLocation();
  const [detailMatch, detailParams] = useRoute("/retail/products/:id");
  const [editorOpen, setEditorOpen] = useState(false);
  const [supplierImportOpen, setSupplierImportOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<RetailProduct | null>(null);
  const [search, setSearch] = useState("");
  const [color, setColor] = useState("");
  const [size, setSize] = useState("");
  const [locationId, setLocationId] = useState("");
  const [categoryKey, setCategoryKey] = useState<string | null>(null);
  const [expandedBrandKey, setExpandedBrandKey] = useState<string | null>(null);
  const [stockStatus, setStockStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [labelItems, setLabelItems] = useState<RetailLabelRequestItem[]>([]);
  const [labelOpen, setLabelOpen] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, color, size, categoryKey, expandedBrandKey, locationId, stockStatus, showArchived]);

  const retailEnabled = selectedCompany?.companyType === "retail";
  const companyKey = selectedCompany?.id ?? 0;
  useEffect(() => {
    setLocationId("");
    setCategoryKey(null);
    setExpandedBrandKey(null);
    setSelected(new Set());
  }, [companyKey]);
  const { data: brands = [] } = useQuery<Brand[]>({
    queryKey: ["retail-brands", companyKey],
    queryFn: () => getJson("/api/retail/brands"),
    enabled: retailEnabled,
  });
  const { data: locations = [], isLoading: locationsLoading } = useQuery<Location[]>({
    queryKey: ["retail-locations", companyKey],
    queryFn: () => getJson("/api/locations"),
    enabled: retailEnabled,
  });
  const { data: catalogFacets } = useQuery<RetailCatalogFacets>({
    queryKey: ["retail-catalog-facets", companyKey],
    queryFn: () => getJson("/api/retail/catalog-facets"),
    enabled: retailEnabled,
    staleTime: 60_000,
  });

  // Only fetch the paginated product cards when a brand is expanded. The
  // independent navigation endpoint enumerates *all* matching categories and
  // brands, so pagination cannot hide a group.
  const navigationParams = useMemo(() => {
    const params = new URLSearchParams({ stockStatus });
    if (locationId) params.set("locationId", locationId);
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (color) params.set("color", color);
    if (size) params.set("size", size);
    if (showArchived) params.set("archived", "include");
    return params.toString();
  }, [locationId, debouncedSearch, color, size, stockStatus, showArchived]);

  const { data: navigationData, isLoading: navigationLoading, isError: navigationFailed } =
    useQuery<RetailCatalogNavigation>({
      queryKey: ["retail-catalog-navigation", companyKey, navigationParams],
      queryFn: () => getJson(`/api/retail/catalog-navigation?${navigationParams}`),
      enabled: retailEnabled && Boolean(locationId),
    });
  const selectedLocation = locations.find((entry) => String(entry.id) === locationId);
  const selectedCategory = navigationData?.categories.find((entry) => entry.key === categoryKey);
  const expandedBrand = selectedCategory?.brands.find((entry) => entry.key === expandedBrandKey);

  const catalogParams = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: "60", stockStatus });
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (color) params.set("color", color);
    if (size) params.set("size", size);
    if (categoryKey) params.set("category", categoryKey);
    if (expandedBrandKey) params.set("brandId", expandedBrandKey);
    if (locationId) params.set("locationId", locationId);
    if (showArchived) params.set("archived", "include");
    return params.toString();
  }, [page, debouncedSearch, color, size, categoryKey, expandedBrandKey, locationId, stockStatus, showArchived]);

  const { data: catalogPage, isLoading, isError: catalogFailed } = useQuery<RetailCatalogPage>({
    queryKey: ["retail-products", "page", companyKey, catalogParams],
    queryFn: () => getJson(`/api/retail/products-page?${catalogParams}`),
    enabled: retailEnabled && Boolean(locationId && selectedCategory && expandedBrand),
  });
  const products = catalogPage?.items ?? [];
  const colors = catalogFacets?.colors ?? [];
  const sizes = catalogFacets?.sizes ?? [];

  const productId = detailMatch ? Number(detailParams?.id) : 0;
  const { data: detailProduct, isError: detailFailed } = useQuery<RetailProduct>({
    queryKey: ["retail-product", companyKey, productId],
    queryFn: () => getJson(`/api/retail/products/${productId}`),
    enabled: retailEnabled && productId > 0,
  });

  const catalogFilters: RetailCatalogFilters = { color, size, locationId, stockStatus, showArchived };
  const knownVariants = new Map<number, { product: RetailProduct; variant: RetailVariant }>();
  for (const product of [...products, ...(detailProduct ? [detailProduct] : [])]) {
    for (const variant of product.variants) knownVariants.set(variant.id, { product, variant });
  }
  const labelItemFor = (product: RetailProduct, variant: RetailVariant): RetailLabelRequestItem => ({
    variantId: variant.id,
    title: `${product.brand.name} · ${product.name} · ${variant.color} · ${variant.size}`,
    barcode: variant.barcode,
    stockQuantity: variant.quantity,
  });
  const toggleVariant = (variantId: number) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(variantId)) next.delete(variantId);
      else next.add(variantId);
      return next;
    });
  const toggleVariants = (variantIds: number[], select: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const id of variantIds) {
        if (select) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const openEditor = (product: RetailProduct) => {
    setEditingProduct(product);
    setEditorOpen(true);
  };
  const refreshCatalog = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["retail-products"] }),
      queryClient.invalidateQueries({ queryKey: ["retail-catalog-navigation"] }),
      queryClient.invalidateQueries({ queryKey: ["retail-product"] }),
      queryClient.invalidateQueries({ queryKey: ["retail-pos-items"] }),
    ]);
  const setProductActive = async (product: RetailProduct, active: boolean) => {
    if (!active && !(await confirmAction({ title: `Archive ${product.name}? Its sales and stock history are kept.` })))
      return;
    try {
      await apiRequest("PATCH", `/api/retail/products/${product.id}/active`, { active });
      await refreshCatalog();
      toast({ title: active ? "Style restored" : "Style archived" });
    } catch (error) {
      toast({ title: "Could not update style", description: (error as Error).message, variant: "destructive" });
    }
  };
  const handleVariantAction = async (action: RetailVariantAction, product: RetailProduct, variant: RetailVariant) => {
    if (action === "print") {
      setLabelItems([labelItemFor(product, variant)]);
      setLabelOpen(true);
    } else {
      const active = action === "restore";
      try {
        await apiRequest("PATCH", `/api/retail/variants/${variant.id}/active`, { active });
        await refreshCatalog();
        toast({
          title: active ? "Variant restored" : "Variant archived",
          description: `${variant.color} / ${variant.size}`,
        });
      } catch (error) {
        toast({ title: "Could not update variant", description: (error as Error).message, variant: "destructive" });
      }
    }
  };

  const bulkBar =
    selected.size > 0 ? (
      <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 p-3 backdrop-blur-sm">
        <div className="mx-auto flex max-w-3xl items-center gap-2">
          <span className="flex-1 text-sm" data-i18n-ui>
            Selected for labels: {selected.size}
          </span>
          <Button variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
          <Button
            onClick={() => {
              setLabelItems(
                [...selected]
                  .map((id) => knownVariants.get(id))
                  .filter((entry): entry is { product: RetailProduct; variant: RetailVariant } => Boolean(entry))
                  .map(({ product, variant }) => labelItemFor(product, variant))
              );
              setLabelOpen(true);
            }}
          >
            <Printer className="mr-2 h-4 w-4" /> Print labels
          </Button>
        </div>
      </div>
    ) : null;

  const actionDialogs = (
    <>
      <RetailLabelPrintDialog open={labelOpen} onOpenChange={setLabelOpen} items={labelItems} />
    </>
  );

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
        <div className="flex items-center justify-between gap-3">
          <Button variant="ghost" onClick={() => navigate("/retail/inventory")}>
            <ArrowLeft className="mr-2 h-4 w-4" /> Inventory
          </Button>
          <Button
            onClick={() => {
              setEditingProduct(detailProduct);
              setEditorOpen(true);
            }}
          >
            <Pencil className="mr-2 h-4 w-4" /> Edit product
          </Button>
        </div>

        <div className="flex flex-wrap items-start gap-5">
          <ProductImageGallery
            product={detailProduct}
            className="max-w-full"
            imageClassName="h-36 w-36 rounded-lg border sm:h-44 sm:w-44"
          />
          <div>
            <h1 className="text-3xl font-bold">{detailProduct.name}</h1>
            <p className="mt-1">
              {detailProduct.brand.name}
              {detailProduct.category ? ` · ${detailProduct.category}` : ""}
            </p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Stock by color and size</CardTitle>
          </CardHeader>
          <CardContent>
            <RetailCatalogList
              products={[detailProduct]}
              filters={{ ...catalogFilters, locationId: "", color: "", size: "", stockStatus: "all", showArchived: true }}
              selected={selected}
              onToggle={toggleVariant}
              onToggleProduct={toggleVariants}
              onOpenProduct={() => undefined}
              onEdit={openEditor}
              onArchiveProduct={(product, active) => void setProductActive(product, active)}
              onVariantAction={handleVariantAction}
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
    <div className="mx-auto max-w-[1600px] space-y-5 p-4 pb-24 md:p-6 md:pb-24">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Boxes className="h-6 w-6" />
            <h1 className="text-2xl font-bold">Retail Inventory</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose a location, open a category, then expand a brand to browse its items.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setSupplierImportOpen(true)}>
            <Upload className="mr-2 h-4 w-4" /> Supplier Stock Import
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setEditingProduct(null);
              setEditorOpen(true);
            }}
          >
            <Plus className="mr-2 h-4 w-4" /> Add Product
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <Input
          placeholder="Search style, brand, barcode, SKU, color or size…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="sm:col-span-2 lg:col-span-2"
          aria-label="Search retail inventory"
        />
        <select
          className="h-10 rounded-md border bg-background px-2 text-sm"
          aria-label="Filter by color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
        >
          <option value="">All colors</option>
          {colors.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <select
          className="h-10 rounded-md border bg-background px-2 text-sm"
          aria-label="Filter by size"
          value={size}
          onChange={(e) => setSize(e.target.value)}
        >
          <option value="">All sizes</option>
          {sizes.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <select
          className="h-10 rounded-md border bg-background px-2 text-sm"
          aria-label="Filter by stock status"
          value={stockStatus}
          onChange={(e) => setStockStatus(e.target.value)}
        >
          <option value="all">All stock</option>
          <option value="in">In stock</option>
          <option value="low">Low stock</option>
          <option value="out">Out of stock</option>
        </select>
      </div>
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <Checkbox checked={showArchived} onCheckedChange={(value) => setShowArchived(value === true)} />
        <span>Show archived items</span>
      </label>

      <nav aria-label="Retail inventory breadcrumbs" className="flex flex-wrap items-center gap-1 rounded-lg border bg-card p-2">
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
              {locations.filter((entry) => entry.active !== false).map((location) => (
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
                    <span className="block truncate font-semibold" data-no-translate>{location.name}</span>
                    <span className="block text-xs text-muted-foreground" data-no-translate>{location.code}</span>
                  </span>
                  <ChevronRight className="h-5 w-5 text-muted-foreground" />
                </button>
              ))}
            </div>
          )}
        </section>
      ) : navigationLoading ? (
        <p className="p-6 text-sm text-muted-foreground">Loading inventory groups…</p>
      ) : navigationFailed ? (
        <p className="rounded-lg border p-6 text-sm text-destructive">
          Could not load inventory categories. Try again.
        </p>
      ) : !categoryKey ? (
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
                    <span className="block truncate font-semibold" data-no-translate>{item.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {item.productCount} products
                    </span>
                  </span>
                  <ChevronRight className="h-5 w-5 text-muted-foreground" />
                </button>
              ))}
            </div>
          )}
        </section>
      ) : (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold" data-no-translate>
            Brands in {selectedCategory?.name ?? (categoryKey === "__uncategorized__" ? "Uncategorized" : categoryKey)}
          </h2>
          {!selectedCategory || selectedCategory.brands.length === 0 ? (
            <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
              No brands match this category and the current filters.
            </p>
          ) : (
            <div className="space-y-3">
              {selectedCategory.brands.map((brand) => (
                <div key={brand.key} className="overflow-hidden rounded-lg border bg-card">
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                    aria-expanded={expandedBrandKey === brand.key}
                    onClick={() => {
                      setExpandedBrandKey((current) => current === brand.key ? null : brand.key);
                      setPage(1);
                      setSelected(new Set());
                    }}
                  >
                    {expandedBrandKey === brand.key ? (
                      <ChevronDown className="h-5 w-5 text-primary" />
                    ) : (
                      <ChevronRight className="h-5 w-5 text-muted-foreground" />
                    )}
                    <span className="flex-1 truncate font-semibold" data-no-translate>{brand.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {brand.productCount} products
                    </span>
                  </button>
                  {expandedBrandKey === brand.key && (
                    <div className="space-y-4 border-t p-3 sm:p-4">
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
