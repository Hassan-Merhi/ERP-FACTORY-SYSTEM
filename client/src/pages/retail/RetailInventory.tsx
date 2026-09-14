import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useRoute } from "wouter";
import { ArrowLeft, Boxes, Pencil, Plus, ShoppingCart, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useCompany } from "@/contexts/CompanyContext";
import { ImportDialog } from "./RetailImportDialog";
import { ProductEditor } from "./RetailProductEditor";
import { ProductImage } from "./RetailProductImage";
import {
  getJson,
  money,
  type Brand,
  type Location,
  type RetailCatalogFacets,
  type RetailCatalogPage,
  type RetailProduct,
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
  const [size, setSize] = useState("");
  const [category, setCategory] = useState("");
  const [locationId, setLocationId] = useState("");
  const [stockStatus, setStockStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, brandId, size, category, locationId, stockStatus]);

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
    if (size) params.set("size", size);
    if (category) params.set("category", category);
    if (locationId) params.set("locationId", locationId);
    return params.toString();
  }, [page, debouncedSearch, brandId, size, category, locationId, stockStatus]);

  const { data: catalogPage, isLoading } = useQuery<RetailCatalogPage>({
    queryKey: ["retail-products", "page", companyKey, catalogParams],
    queryFn: () => getJson(`/api/retail/products-page?${catalogParams}`),
    enabled: retailEnabled,
    placeholderData: (previous) => previous,
  });
  const products = catalogPage?.items ?? [];
  const filteredProducts = products;
  const sizes = catalogFacets?.sizes ?? [];
  const categories = catalogFacets?.categories ?? [];

  const productId = detailMatch ? Number(detailParams?.id) : 0;
  const { data: detailProduct } = useQuery<RetailProduct>({
    queryKey: ["retail-product", companyKey, productId],
    queryFn: () => getJson(`/api/retail/products/${productId}`),
    enabled: retailEnabled && productId > 0,
  });

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
    if (!detailProduct) return <div className="p-6 text-sm text-muted-foreground">Loading product…</div>;
    return (
      <div className="p-4 md:p-6 space-y-5 max-w-7xl mx-auto">
        <div className="flex items-center justify-between gap-3">
          <Button variant="ghost" onClick={() => navigate("/retail")}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Inventory
          </Button>
          <Button
            onClick={() => {
              setEditingProduct(detailProduct);
              setEditorOpen(true);
            }}
          >
            <Pencil className="h-4 w-4 mr-2" />
            Edit product
          </Button>
        </div>
        <div className="flex gap-5 items-start">
          <ProductImage product={detailProduct} className="h-32 w-32 rounded-lg border" />
          <div>
            <p className="text-sm text-muted-foreground">{detailProduct.code}</p>
            <h1 className="text-3xl font-bold">{detailProduct.name}</h1>
            <p className="mt-1">
              {detailProduct.brand.name}
              {detailProduct.category ? ` · ${detailProduct.category}` : ""}
            </p>
            <p className="mt-2 text-sm text-muted-foreground max-w-2xl">{detailProduct.description}</p>
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
            <CardTitle>Stock by size</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="py-2">Size</th>
                  <th>Barcode</th>
                  <th>Cost</th>
                  <th>Selling price</th>
                  <th>Total Qty</th>
                  <th>Locations</th>
                </tr>
              </thead>
              <tbody>
                {detailProduct.variants.map((variant) => (
                  <tr key={variant.id} className="border-b last:border-0">
                    <td className="py-3 font-medium">{variant.size}</td>
                    <td className="font-mono text-xs">{variant.barcode}</td>
                    <td>{money(variant.cost)}</td>
                    <td>{money(variant.sellingPrice)}</td>
                    <td>{variant.quantity}</td>
                    <td>
                      {variant.stocks.length
                        ? variant.stocks.map((stock) => `${stock.locationName}: ${stock.quantity}`).join(" · ")
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
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
    <div className="p-4 md:p-6 space-y-5 max-w-[1600px] mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Boxes className="h-6 w-6" />
            <h1 className="text-2xl font-bold">Retail Inventory</h1>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Products grouped by brand with independent stock and barcodes for every size.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => navigate("/retail/pos")}>
            <ShoppingCart className="h-4 w-4 mr-2" />
            Open POS
          </Button>
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <Upload className="h-4 w-4 mr-2" />
            Import
          </Button>
          <Button
            onClick={() => {
              setEditingProduct(null);
              setEditorOpen(true);
            }}
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Product
          </Button>
        </div>
      </div>

      <div className="grid gap-2 md:grid-cols-6">
        <Input
          placeholder="Search product, code or brand…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="md:col-span-2"
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

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm min-w-[850px]">
            <thead>
              <tr className="border-b bg-muted/40 text-left">
                <th className="p-3 w-16">Image</th>
                <th>Product</th>
                <th>Brand</th>
                <th>Available sizes</th>
                <th className="text-right">Total quantity</th>
                <th className="text-right">Selling price</th>
                <th className="w-24"></th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-muted-foreground">
                    Loading retail inventory…
                  </td>
                </tr>
              ) : filteredProducts.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-muted-foreground">
                    No products match these filters.
                  </td>
                </tr>
              ) : (
                filteredProducts.map((product) => (
                  <tr
                    key={product.id}
                    className="border-b last:border-0 hover:bg-muted/20 cursor-pointer"
                    onClick={() => navigate(`/retail/products/${product.id}`)}
                  >
                    <td className="p-3">
                      <ProductImage product={product} className="h-11 w-11 rounded-md border" />
                    </td>
                    <td>
                      <div className="font-medium">{product.name}</div>
                      <div className="text-xs text-muted-foreground">{product.code}</div>
                    </td>
                    <td>{product.brand.name}</td>
                    <td>{product.availableSizes.length ? product.availableSizes.join(", ") : "—"}</td>
                    <td className="text-right font-medium">{product.totalQuantity}</td>
                    <td className="text-right">
                      {product.minSellingPrice === product.maxSellingPrice
                        ? money(product.minSellingPrice)
                        : `${money(product.minSellingPrice)} – ${money(product.maxSellingPrice)}`}
                    </td>
                    <td className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(event) => {
                          event.stopPropagation();
                          setEditingProduct(product);
                          setEditorOpen(true);
                        }}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

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
    </div>
  );
}
