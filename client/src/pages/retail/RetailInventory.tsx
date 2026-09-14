import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation, useRoute } from "wouter";
import { ArrowLeft, Boxes, ImageIcon, Pencil, Plus, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { read, utils, writeFile } from "@/lib/excelHelper";

interface Brand {
  id: number;
  name: string;
  isNoBrand: boolean;
}

interface Location {
  id: number;
  code: string;
  name: string;
  active?: boolean;
}

interface RetailStock {
  locationId: number;
  locationName: string;
  quantity: number;
}

interface RetailVariant {
  id: number;
  size: string;
  barcode: string;
  sku: string | null;
  cost: number;
  sellingPrice: number;
  lowStockThreshold: number;
  active: boolean;
  quantity: number;
  stocks: RetailStock[];
}

interface RetailProduct {
  id: number;
  code: string;
  name: string;
  category: string | null;
  description: string | null;
  imageUrls: string[];
  active: boolean;
  brand: { id: number | null; name: string };
  variants: RetailVariant[];
  availableSizes: string[];
  totalQuantity: number;
  minSellingPrice: number;
  maxSellingPrice: number;
}

interface DraftStock {
  locationId: number | "";
  quantity: number;
}

interface DraftVariant {
  id?: number;
  size: string;
  barcode: string;
  sku: string;
  cost: number;
  sellingPrice: number;
  lowStockThreshold: number;
  active: boolean;
  stocks: DraftStock[];
}

interface ProductDraft {
  code: string;
  name: string;
  brandId: number | "";
  brandName: string;
  category: string;
  description: string;
  imageUrls: string;
  active: boolean;
  variants: DraftVariant[];
}

const blankVariant = (): DraftVariant => ({
  size: "",
  barcode: "",
  sku: "",
  cost: 0,
  sellingPrice: 0,
  lowStockThreshold: 0,
  active: true,
  stocks: [{ locationId: "", quantity: 0 }],
});

const blankDraft = (): ProductDraft => ({
  code: "",
  name: "",
  brandId: "",
  brandName: "",
  category: "",
  description: "",
  imageUrls: "",
  active: true,
  variants: [blankVariant()],
});

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `Request failed (${response.status})`);
  }
  return response.json();
}

function money(value: number) {
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value || 0);
}

function ProductImage({ product, className }: { product: RetailProduct; className?: string }) {
  const src = product.imageUrls?.[0];
  if (!src) {
    return (
      <div className={`flex items-center justify-center bg-muted text-muted-foreground ${className ?? ""}`}>
        <ImageIcon className="h-5 w-5" />
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={product.name}
      loading="lazy"
      decoding="async"
      className={`object-cover bg-muted ${className ?? ""}`}
    />
  );
}

function ProductEditor({
  open,
  onOpenChange,
  product,
  brands,
  locations,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product?: RetailProduct | null;
  brands: Brand[];
  locations: Location[];
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<ProductDraft>(() => blankDraft());
  const [loadedProductId, setLoadedProductId] = useState<number | null>(null);

  if (open) {
    const targetId = product?.id ?? 0;
    if (loadedProductId !== targetId) {
      setLoadedProductId(targetId);
      setDraft(
        product
          ? {
              code: product.code,
              name: product.name,
              brandId: product.brand.id ?? "",
              brandName: "",
              category: product.category ?? "",
              description: product.description ?? "",
              imageUrls: (product.imageUrls ?? []).join("\n"),
              active: product.active,
              variants: product.variants.map((variant) => ({
                id: variant.id,
                size: variant.size,
                barcode: variant.barcode,
                sku: variant.sku ?? "",
                cost: variant.cost,
                sellingPrice: variant.sellingPrice,
                lowStockThreshold: variant.lowStockThreshold,
                active: variant.active,
                stocks: variant.stocks.length
                  ? variant.stocks.map((stock) => ({ locationId: stock.locationId, quantity: stock.quantity }))
                  : [{ locationId: "", quantity: 0 }],
              })),
            }
          : blankDraft()
      );
    }
  } else if (loadedProductId !== null) {
    setLoadedProductId(null);
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const imageUrls = draft.imageUrls
        .split(/\n|,/)
        .map((url) => url.trim())
        .filter(Boolean);
      const variants = draft.variants.map((variant) => ({
        id: variant.id,
        size: variant.size.trim(),
        barcode: variant.barcode.trim(),
        sku: variant.sku.trim() || null,
        cost: Number(variant.cost),
        sellingPrice: Number(variant.sellingPrice),
        lowStockThreshold: Number(variant.lowStockThreshold),
        active: variant.active,
        stocks: variant.stocks
          .filter((stock) => stock.locationId !== "")
          .map((stock) => ({ locationId: Number(stock.locationId), quantity: Number(stock.quantity) })),
      }));
      if (!draft.name.trim() || !draft.code.trim()) throw new Error("Product code and name are required");
      if (!variants.length || variants.some((variant) => !variant.size || !variant.barcode)) {
        throw new Error("Every variant needs a size and barcode");
      }
      const payload = {
        code: draft.code.trim(),
        name: draft.name.trim(),
        brandId: draft.brandId === "" ? undefined : Number(draft.brandId),
        brandName: draft.brandId === "" ? draft.brandName.trim() || "Other / No Brand" : undefined,
        category: draft.category.trim() || null,
        description: draft.description.trim() || null,
        imageUrls,
        active: draft.active,
        variants,
      };
      const response = await apiRequest(
        product ? "PATCH" : "POST",
        product ? `/api/retail/products/${product.id}` : "/api/retail/products",
        payload
      );
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["retail-products"] });
      queryClient.invalidateQueries({ queryKey: ["retail-product"] });
      queryClient.invalidateQueries({ queryKey: ["retail-brands"] });
      toast({ title: product ? "Product updated" : "Product created" });
      onOpenChange(false);
    },
    onError: (error: Error) =>
      toast({ title: "Could not save product", description: error.message, variant: "destructive" }),
  });

  const updateVariant = (index: number, patch: Partial<DraftVariant>) => {
    setDraft((current) => ({
      ...current,
      variants: current.variants.map((variant, i) => (i === index ? { ...variant, ...patch } : variant)),
    }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{product ? `Edit ${product.name}` : "Add Retail Product"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Item name *</Label>
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label>SKU / Item code *</Label>
            <Input value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label>Brand</Label>
            <select
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={draft.brandId}
              onChange={(e) => setDraft({ ...draft, brandId: e.target.value ? Number(e.target.value) : "" })}
            >
              <option value="">Other / No Brand or custom brand</option>
              {brands.map((brand) => (
                <option key={brand.id} value={brand.id}>
                  {brand.name}
                </option>
              ))}
            </select>
          </div>
          {draft.brandId === "" && (
            <div className="space-y-2">
              <Label>Custom brand (optional)</Label>
              <Input
                value={draft.brandName}
                placeholder="Leave empty for Other / No Brand"
                onChange={(e) => setDraft({ ...draft, brandName: e.target.value })}
              />
            </div>
          )}
          <div className="space-y-2">
            <Label>Category</Label>
            <Input value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label>Product image URLs</Label>
            <Textarea
              value={draft.imageUrls}
              placeholder="One image URL per line (up to 8)"
              onChange={(e) => setDraft({ ...draft, imageUrls: e.target.value })}
            />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label>Description</Label>
            <Textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </div>
        </div>

        <div className="space-y-3 border-t pt-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold">Sizes / Variants</h3>
              <p className="text-xs text-muted-foreground">
                Each size has its own barcode, price, cost and location stock.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDraft((current) => ({ ...current, variants: [...current.variants, blankVariant()] }))}
            >
              <Plus className="h-4 w-4 mr-1" /> Add size
            </Button>
          </div>

          {draft.variants.map((variant, variantIndex) => (
            <Card key={variant.id ?? `new-${variantIndex}`}>
              <CardContent className="p-4 space-y-4">
                <div className="grid gap-3 md:grid-cols-6">
                  <div className="space-y-1">
                    <Label>Size *</Label>
                    <Input
                      value={variant.size}
                      onChange={(e) => updateVariant(variantIndex, { size: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1 md:col-span-2">
                    <Label>Barcode *</Label>
                    <Input
                      value={variant.barcode}
                      onChange={(e) => updateVariant(variantIndex, { barcode: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Cost</Label>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={variant.cost}
                      onChange={(e) => updateVariant(variantIndex, { cost: Number(e.target.value) })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Selling price</Label>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={variant.sellingPrice}
                      onChange={(e) => updateVariant(variantIndex, { sellingPrice: Number(e.target.value) })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Low stock</Label>
                    <Input
                      type="number"
                      min="0"
                      step="1"
                      value={variant.lowStockThreshold}
                      onChange={(e) => updateVariant(variantIndex, { lowStockThreshold: Number(e.target.value) })}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Stock by location</Label>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        updateVariant(variantIndex, { stocks: [...variant.stocks, { locationId: "", quantity: 0 }] })
                      }
                    >
                      + Location
                    </Button>
                  </div>
                  {variant.stocks.map((stock, stockIndex) => (
                    <div key={`${variantIndex}-${stockIndex}`} className="flex gap-2">
                      <select
                        className="h-10 flex-1 rounded-md border bg-background px-3 text-sm"
                        value={stock.locationId}
                        onChange={(e) => {
                          const stocks = variant.stocks.map((item, i) =>
                            i === stockIndex
                              ? { ...item, locationId: e.target.value ? Number(e.target.value) : ("" as const) }
                              : item
                          );
                          updateVariant(variantIndex, { stocks });
                        }}
                      >
                        <option value="">Select location</option>
                        {locations
                          .filter((location) => location.active !== false)
                          .map((location) => (
                            <option key={location.id} value={location.id}>
                              {location.name}
                            </option>
                          ))}
                      </select>
                      <Input
                        className="w-36"
                        type="number"
                        step="0.001"
                        value={stock.quantity}
                        onChange={(e) => {
                          const stocks = variant.stocks.map((item, i) =>
                            i === stockIndex ? { ...item, quantity: Number(e.target.value) } : item
                          );
                          updateVariant(variantIndex, { stocks });
                        }}
                      />
                      {variant.stocks.length > 1 && (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          onClick={() =>
                            updateVariant(variantIndex, { stocks: variant.stocks.filter((_, i) => i !== stockIndex) })
                          }
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
                {draft.variants.length > 1 && !variant.id && (
                  <Button
                    type="button"
                    variant="ghost"
                    className="text-destructive"
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        variants: current.variants.filter((_, i) => i !== variantIndex),
                      }))
                    }
                  >
                    Remove size
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="flex justify-end gap-2 border-t pt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? "Saving…" : "Save product"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { toast } = useToast();
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [fileName, setFileName] = useState("");

  const downloadTemplate = async () => {
    const sheet = utils.json_to_sheet([
      {
        Code: "SHOE-001",
        Name: "Runner",
        Brand: "Acme",
        Size: "42",
        Barcode: "6001234567890",
        Cost: 25,
        Price: 49.99,
        Qty: 12,
        Location: "MAIN",
        Category: "Shoes",
      },
      {
        Code: "SHOE-001",
        Name: "Runner",
        Brand: "Acme",
        Size: "43",
        Barcode: "6001234567891",
        Cost: 25,
        Price: 49.99,
        Qty: 8,
        Location: "MAIN",
        Category: "Shoes",
      },
    ]);
    const book = utils.book_new();
    utils.book_append_sheet(book, sheet, "Retail Products");
    await writeFile(book, "retail_variant_inventory_template.xlsx");
  };

  const importMutation = useMutation({
    mutationFn: async () => {
      if (!rows.length) throw new Error("Choose a populated Excel file first");
      const response = await apiRequest("POST", "/api/retail/import", { rows });
      return response.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["retail-products"] });
      queryClient.invalidateQueries({ queryKey: ["retail-brands"] });
      toast({
        title: "Retail import complete",
        description: `${result.rowsProcessed} rows · ${result.productsCreated} new products · ${result.variantsCreated} new variants`,
      });
      onOpenChange(false);
      setRows([]);
      setFileName("");
    },
    onError: (error: Error) => toast({ title: "Import failed", description: error.message, variant: "destructive" }),
  });

  const handleFile = async (file?: File) => {
    if (!file) return;
    try {
      const workbook = await read(await file.arrayBuffer());
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const raw = utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
      const mapped = raw.map((source) => {
        const row = new Map(Object.entries(source).map(([key, value]) => [key.trim().toLowerCase(), value]));
        return {
          code: String(row.get("code") ?? "").trim(),
          name: String(row.get("name") ?? "").trim(),
          brand: String(row.get("brand") ?? "Other / No Brand").trim() || "Other / No Brand",
          size: String(row.get("size") ?? "").trim(),
          barcode: String(row.get("barcode") ?? "").trim(),
          cost: Number(row.get("cost") ?? 0),
          price: Number(row.get("price") ?? 0),
          qty: Number(row.get("qty") ?? 0),
          location: String(row.get("location") ?? "").trim(),
          category: String(row.get("category") ?? "").trim() || undefined,
          description: String(row.get("description") ?? "").trim() || undefined,
          imageUrl: String(row.get("image url") ?? row.get("imageurl") ?? "").trim() || undefined,
        };
      });
      const required = ["code", "name", "size", "barcode", "location"] as const;
      const badIndex = mapped.findIndex((row) => required.some((key) => !String(row[key] ?? "").trim()));
      if (badIndex >= 0) throw new Error(`Row ${badIndex + 2} is missing Code, Name, Size, Barcode or Location`);
      setRows(mapped);
      setFileName(file.name);
      toast({ title: "File ready", description: `${mapped.length} rows validated for import` });
    } catch (error) {
      setRows([]);
      toast({
        title: "Could not read file",
        description: error instanceof Error ? error.message : "Invalid Excel file",
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Import Retail Products</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Required columns: Code | Name | Brand | Size | Barcode | Cost | Price | Qty | Location. Multiple sizes with
          the same Code are grouped under one product.
        </p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={downloadTemplate}>
            Download template
          </Button>
        </div>
        <Input type="file" accept=".xlsx,.xls" onChange={(e) => handleFile(e.target.files?.[0])} />
        {fileName && (
          <p className="text-sm">
            {fileName}: <strong>{rows.length}</strong> rows ready
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!rows.length || importMutation.isPending} onClick={() => importMutation.mutate()}>
            {importMutation.isPending ? "Importing…" : "Import"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

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
  const { data: products = [], isLoading } = useQuery<RetailProduct[]>({
    queryKey: ["retail-products", companyKey],
    queryFn: () => getJson("/api/retail/products"),
    enabled: retailEnabled,
  });
  const productId = detailMatch ? Number(detailParams?.id) : 0;
  const { data: detailProduct } = useQuery<RetailProduct>({
    queryKey: ["retail-product", companyKey, productId],
    queryFn: () => getJson(`/api/retail/products/${productId}`),
    enabled: retailEnabled && productId > 0,
  });

  const sizes = useMemo(() => [...new Set(products.flatMap((product) => product.availableSizes))].sort(), [products]);
  const categories = useMemo(
    () =>
      [
        ...new Set(products.map((product) => product.category).filter((value): value is string => Boolean(value))),
      ].sort(),
    [products]
  );
  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((product) => {
      if (q && !`${product.code} ${product.name} ${product.brand.name}`.toLowerCase().includes(q)) return false;
      if (brandId && product.brand.id !== Number(brandId)) return false;
      if (size && !product.availableSizes.includes(size)) return false;
      if (category && product.category !== category) return false;
      if (
        locationId &&
        !product.variants.some((variant) => variant.stocks.some((stock) => stock.locationId === Number(locationId)))
      )
        return false;
      if (stockStatus === "out" && product.totalQuantity !== 0) return false;
      if (stockStatus === "in" && product.totalQuantity <= 0) return false;
      if (
        stockStatus === "low" &&
        !product.variants.some((variant) => variant.quantity > 0 && variant.quantity <= variant.lowStockThreshold)
      )
        return false;
      return true;
    });
  }, [products, search, brandId, size, category, locationId, stockStatus]);

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
