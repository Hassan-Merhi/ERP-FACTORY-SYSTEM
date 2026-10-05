import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useRoute } from "wouter";
import { ArrowLeft, Boxes, Camera, Pencil, Plus, Printer, ShoppingCart, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { ImportDialog } from "./RetailImportDialog";
import { ProductEditor } from "./RetailProductEditor";
import { ProductImage } from "./RetailProductImage";
import { RetailNav } from "./RetailNav";
import { RetailCatalogList, type RetailCatalogFilters, type RetailVariantAction } from "./RetailCatalogList";
import { RetailLabelHistory, RetailMovementHistory } from "./RetailMovementHistory";
import { RetailLabelPrintDialog, type RetailLabelRequestItem } from "./retailLabels";
import {
  getJson,
  type Brand,
  type Location,
  type RetailCatalogFacets,
  type RetailCatalogPage,
  type RetailProduct,
  type RetailVariant,
} from "./retailInventoryTypes";

export default function RetailInventory() {
  const { selectedCompany } = useCompany();
  const [, navigate] = useLocation();
  const [detailMatch, detailParams] = useRoute("/retail/products/:id");
  const [editorOpen, setEditorOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<RetailProduct | null>(null);
  const [search, setSearch] = useState("");
  const [brandId, setBrandId] = useState("");
  const [color, setColor] = useState("");
  const [size, setSize] = useState("");
  const [category, setCategory] = useState("");
  const [locationId, setLocationId] = useState("");
  const [stockStatus, setStockStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [labelItems, setLabelItems] = useState<RetailLabelRequestItem[]>([]);
  const [labelOpen, setLabelOpen] = useState(false);
  const [historyTarget, setHistoryTarget] = useState<{ product: RetailProduct; variant: RetailVariant } | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, brandId, color, size, category, locationId, stockStatus, showArchived]);

  const retailEnabled = selectedCompany?.companyType === "retail";
  const companyKey = selectedCompany?.id ?? 0;
  const { data: brands = [] } = useQuery<Brand[]>({
    queryKey: ["retail-brands", companyKey],
    queryFn: () => getJson("/api/retail/brands"),
    enabled: retailEnabled,
  });
  const { data: locations = [] } = useQuery<Location[]>({
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

  const catalogParams = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: "60", stockStatus });
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (brandId) params.set("brandId", brandId);
    if (color) params.set("color", color);
    if (size) params.set("size", size);
    if (category) params.set("category", category);
    if (locationId) params.set("locationId", locationId);
    if (showArchived) params.set("archived", "include");
    return params.toString();
  }, [page, debouncedSearch, brandId, color, size, category, locationId, stockStatus, showArchived]);

  const { data: catalogPage, isLoading } = useQuery<RetailCatalogPage>({
    queryKey: ["retail-products", "page", companyKey, catalogParams],
    queryFn: () => getJson(`/api/retail/products-page?${catalogParams}`),
    enabled: retailEnabled,
    placeholderData: (previous) => previous,
  });
  const products = catalogPage?.items ?? [];
  const colors = catalogFacets?.colors ?? [];
  const sizes = catalogFacets?.sizes ?? [];
  const categories = catalogFacets?.categories ?? [];

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
      queryClient.invalidateQueries({ queryKey: ["retail-product"] }),
      queryClient.invalidateQueries({ queryKey: ["retail-pos-items"] }),
    ]);
  const setProductActive = async (product: RetailProduct, active: boolean) => {
    if (!active && !window.confirm(`Archive ${product.name}? Its sales and stock history are kept.`)) return;
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
    } else if (action === "transfer" || action === "adjust") {
      navigate(`/retail/stock?variant=${variant.id}&mode=${action}`);
    } else if (action === "history") {
      setHistoryTarget({ product, variant });
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
      <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 p-3 backdrop-blur">
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
      <Dialog open={Boolean(historyTarget)} onOpenChange={(open) => !open && setHistoryTarget(null)}>
        <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Movement history</DialogTitle>
          </DialogHeader>
          {historyTarget && (
            <div className="space-y-3">
              <p className="text-sm" data-no-translate>
                <strong>
                  {historyTarget.product.brand.name} · {historyTarget.product.name}
                </strong>{" "}
                · {historyTarget.variant.color} / {historyTarget.variant.size} ·{" "}
                <span className="font-mono">{historyTarget.variant.barcode}</span>
              </p>
              <RetailMovementHistory variantId={historyTarget.variant.id} companyKey={companyKey} />
              <RetailLabelHistory variantId={historyTarget.variant.id} companyKey={companyKey} />
            </div>
          )}
        </DialogContent>
      </Dialog>
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

        <div className="flex items-start gap-5">
          <ProductImage product={detailProduct} className="h-32 w-32 rounded-lg border" />
          <div>
            <h1 className="text-3xl font-bold">{detailProduct.name}</h1>
            <p className="mt-1">
              {detailProduct.brand.name}
              {detailProduct.category ? ` · ${detailProduct.category}` : ""}
            </p>
          </div>
        </div>

        {detailProduct.imageUrls.length > 1 && (
          <div className="flex gap-2 overflow-x-auto">
            {detailProduct.imageUrls.map((src) => (
              <img
                key={src}
                src={src}
                alt=""
                loading="lazy"
                decoding="async"
                className="h-20 w-20 rounded border object-cover"
              />
            ))}
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Stock by color and size</CardTitle>
          </CardHeader>
          <CardContent>
            <RetailCatalogList
              products={[detailProduct]}
              filters={{ ...catalogFilters, color: "", size: "", stockStatus: "all", showArchived: true }}
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
      <RetailNav />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Boxes className="h-6 w-6" />
            <h1 className="text-2xl font-bold">Retail Inventory</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Products grouped by brand and style with exact color, size, stock and barcode variants.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => navigate("/retail/pos")}>
            <ShoppingCart className="mr-2 h-4 w-4" /> Open POS
          </Button>
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <Upload className="mr-2 h-4 w-4" /> Import
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
          <Button onClick={() => navigate("/retail/quick-add")}>
            <Camera className="mr-2 h-4 w-4" /> Quick add
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-8">
        <Input
          placeholder="Search style, brand, barcode, SKU, color or size…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="col-span-2"
        />
        <select
          className="h-10 rounded-md border bg-background px-2 text-sm"
          value={brandId}
          onChange={(e) => setBrandId(e.target.value)}
        >
          <option value="">All brands</option>
          {brands.map((brand) => (
            <option key={brand.id} value={brand.id}>
              {brand.name}
            </option>
          ))}
        </select>
        <select
          className="h-10 rounded-md border bg-background px-2 text-sm"
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
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">All categories</option>
          {categories.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <select
          className="h-10 rounded-md border bg-background px-2 text-sm"
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
        >
          <option value="">All locations</option>
          {locations
            .filter((location) => location.active !== false)
            .map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
        </select>
        <select
          className="h-10 rounded-md border bg-background px-2 text-sm"
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

      {isLoading ? (
        <div className="p-8 text-center text-muted-foreground">Loading retail inventory…</div>
      ) : products.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
          No products match these filters.
        </div>
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

      <ProductEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        product={editingProduct}
        brands={brands}
        locations={locations}
      />
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
      {bulkBar}
      {actionDialogs}
    </div>
  );
}
