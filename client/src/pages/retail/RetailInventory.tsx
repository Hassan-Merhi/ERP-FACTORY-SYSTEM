import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation, useRoute } from "wouter";
import { ArrowLeft, Boxes, ImageIcon, Pencil, Plus, ShoppingCart, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { read, utils, writeFile } from "@/lib/excelHelper";

const NO_BRAND = "Other / No Brand";
const MAX_PRODUCT_IMAGES = 8;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

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
  imageUrls: string[];
  active: boolean;
  brand: { id: number | null; name: string };
  variants: RetailVariant[];
  availableSizes: string[];
  totalQuantity: number;
  minSellingPrice: number;
  maxSellingPrice: number;
}

interface RetailCatalogPage {
  items: RetailProduct[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

interface RetailCatalogFacets {
  sizes: string[];
  categories: string[];
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
  category: string;
  imageUrls: string[];
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
  category: "",
  imageUrls: [],
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

function buildInternalProductCode(name: string, brand: string) {
  const identity = `${brand}-${name}`
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}-]+/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `RTL-${identity || "item"}`.slice(0, 100);
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
  const [addingBrand, setAddingBrand] = useState(false);
  const [newBrandName, setNewBrandName] = useState("");
  const [uploadingImages, setUploadingImages] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(
      product
        ? {
            code: product.code,
            name: product.name,
            brandId: product.brand.name === NO_BRAND ? "" : (product.brand.id ?? ""),
            category: product.category ?? "",
            imageUrls: [...(product.imageUrls ?? [])],
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
    setAddingBrand(false);
    setNewBrandName("");
  }, [open, product]);

  const createBrandMutation = useMutation({
    mutationFn: async (name: string) => {
      const response = await apiRequest("POST", "/api/retail/brands", { name });
      return response.json() as Promise<Brand>;
    },
    onSuccess: (brand) => {
      queryClient.invalidateQueries({ queryKey: ["retail-brands"] });
      setDraft((current) => ({ ...current, brandId: brand.id }));
      setNewBrandName("");
      setAddingBrand(false);
      toast({ title: "Brand added", description: brand.name });
    },
    onError: (error: Error) =>
      toast({ title: "Could not add brand", description: error.message, variant: "destructive" }),
  });

  const uploadImages = async (files?: FileList | null) => {
    if (!files?.length) return;
    const remaining = MAX_PRODUCT_IMAGES - draft.imageUrls.length;
    if (remaining <= 0) {
      toast({ title: "Image limit reached", description: `You can upload up to ${MAX_PRODUCT_IMAGES} images.` });
      return;
    }

    const selected = Array.from(files).slice(0, remaining);
    const invalidType = selected.find((file) => !ALLOWED_IMAGE_TYPES.has(file.type));
    if (invalidType) {
      toast({
        title: "Unsupported image",
        description: "Use JPG, PNG, WEBP or GIF images.",
        variant: "destructive",
      });
      return;
    }
    const tooLarge = selected.find((file) => file.size > MAX_IMAGE_BYTES);
    if (tooLarge) {
      toast({
        title: "Image too large",
        description: `${tooLarge.name} is larger than 10 MB.`,
        variant: "destructive",
      });
      return;
    }

    setUploadingImages(true);
    try {
      const uploadedUrls: string[] = [];
      for (const file of selected) {
        const formData = new FormData();
        formData.append("file", file);
        const response = await fetch("/api/files/upload", {
          method: "POST",
          body: formData,
          credentials: "include",
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !body.id) throw new Error(body.message || `Could not upload ${file.name}`);
        uploadedUrls.push(new URL(`/api/files/${body.id}/preview`, window.location.origin).toString());
      }
      setDraft((current) => ({
        ...current,
        imageUrls: [...current.imageUrls, ...uploadedUrls].slice(0, MAX_PRODUCT_IMAGES),
      }));
      toast({ title: selected.length === 1 ? "Image uploaded" : `${selected.length} images uploaded` });
    } catch (error) {
      toast({
        title: "Image upload failed",
        description: error instanceof Error ? error.message : "Could not upload image",
        variant: "destructive",
      });
    } finally {
      setUploadingImages(false);
    }
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
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

      if (!draft.name.trim()) throw new Error("Item name is required");
      if (!variants.length || variants.some((variant) => !variant.size || !variant.barcode)) {
        throw new Error("Every size needs a size value and barcode");
      }

      const selectedBrandName =
        draft.brandId === "" ? NO_BRAND : brands.find((brand) => brand.id === Number(draft.brandId))?.name || NO_BRAND;
      const internalCode = draft.code.trim() || buildInternalProductCode(draft.name, selectedBrandName);
      const payload = {
        code: internalCode,
        name: draft.name.trim(),
        brandId: draft.brandId === "" ? undefined : Number(draft.brandId),
        brandName: draft.brandId === "" ? NO_BRAND : undefined,
        category: draft.category.trim() || null,
        description: null,
        imageUrls: draft.imageUrls,
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
          <div className="space-y-2 md:col-span-2">
            <Label>Item name *</Label>
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label>Brand</Label>
              <Button type="button" size="sm" variant="ghost" onClick={() => setAddingBrand((current) => !current)}>
                <Plus className="mr-1 h-4 w-4" /> Add brand
              </Button>
            </div>
            <select
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={draft.brandId}
              onChange={(e) => setDraft({ ...draft, brandId: e.target.value ? Number(e.target.value) : "" })}
            >
              <option value="">{NO_BRAND}</option>
              {brands
                .filter((brand) => !brand.isNoBrand)
                .map((brand) => (
                  <option key={brand.id} value={brand.id}>
                    {brand.name}
                  </option>
                ))}
            </select>
            {addingBrand && (
              <div className="flex gap-2">
                <Input
                  value={newBrandName}
                  placeholder="New brand name"
                  onChange={(e) => setNewBrandName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (newBrandName.trim()) createBrandMutation.mutate(newBrandName.trim());
                    }
                  }}
                />
                <Button
                  type="button"
                  disabled={!newBrandName.trim() || createBrandMutation.isPending}
                  onClick={() => createBrandMutation.mutate(newBrandName.trim())}
                >
                  Save
                </Button>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label>Category</Label>
            <Input value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} />
          </div>

          <div className="space-y-3 md:col-span-2">
            <div>
              <Label>Product images</Label>
              <p className="mt-1 text-xs text-muted-foreground">Upload JPG, PNG, WEBP or GIF images. Up to 8 images.</p>
            </div>
            <Input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              multiple
              disabled={uploadingImages || draft.imageUrls.length >= MAX_PRODUCT_IMAGES}
              onChange={(e) => {
                void uploadImages(e.target.files);
                e.currentTarget.value = "";
              }}
            />
            {uploadingImages && <p className="text-sm text-muted-foreground">Uploading image…</p>}
            {draft.imageUrls.length > 0 && (
              <div className="flex flex-wrap gap-3">
                {draft.imageUrls.map((src, index) => (
                  <div
                    key={`${src}-${index}`}
                    className="group relative h-24 w-24 overflow-hidden rounded-lg border bg-muted"
                  >
                    <img src={src} alt="" className="h-full w-full object-cover" />
                    <Button
                      type="button"
                      size="icon"
                      variant="destructive"
                      className="absolute right-1 top-1 h-7 w-7"
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          imageUrls: current.imageUrls.filter((_, imageIndex) => imageIndex !== index),
                        }))
                      }
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-3 border-t pt-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold">Sizes / Variants</h3>
              <p className="text-xs text-muted-foreground">
                Each size has its own barcode, selling price, cost and location stock.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDraft((current) => ({ ...current, variants: [...current.variants, blankVariant()] }))}
            >
              <Plus className="mr-1 h-4 w-4" /> Add size
            </Button>
          </div>

          {draft.variants.map((variant, variantIndex) => (
            <Card key={variant.id ?? `new-${variantIndex}`}>
              <CardContent className="space-y-4 p-4">
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
          <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || uploadingImages}>
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
      const response = await apiRequest("POST", "/api/retail/import", {
        rows,
        idempotencyKey: `retail-import-${
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random()}`
        }`,
      });
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
        const name = String(row.get("name") ?? "").trim();
        const brand = String(row.get("brand") ?? NO_BRAND).trim() || NO_BRAND;
        const suppliedCode = String(row.get("code") ?? "").trim();
        return {
          code: suppliedCode || buildInternalProductCode(name, brand),
          name,
          brand,
          size: String(row.get("size") ?? "").trim(),
          barcode: String(row.get("barcode") ?? "").trim(),
          cost: Number(row.get("cost") ?? 0),
          price: Number(row.get("price") ?? 0),
          qty: Number(row.get("qty") ?? 0),
          location: String(row.get("location") ?? "").trim(),
          category: String(row.get("category") ?? "").trim() || undefined,
        };
      });
      const required = ["name", "size", "barcode", "location"] as const;
      const badIndex = mapped.findIndex((row) => required.some((key) => !String(row[key] ?? "").trim()));
      if (badIndex >= 0) throw new Error(`Row ${badIndex + 2} is missing Name, Size, Barcode or Location`);
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
          Columns: Name | Brand | Size | Barcode | Cost | Price | Qty | Location | Category. Brand can be left blank for
          Other / No Brand. Rows with the same product name and brand are grouped together automatically.
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
      <div className="mx-auto max-w-7xl space-y-5 p-4 md:p-6">
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
    <div className="mx-auto max-w-[1600px] space-y-5 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Boxes className="h-6 w-6" />
            <h1 className="text-2xl font-bold">Retail Inventory</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Products grouped by brand with independent stock and barcodes for every size.
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
            onClick={() => {
              setEditingProduct(null);
              setEditorOpen(true);
            }}
          >
            <Plus className="mr-2 h-4 w-4" /> Add Product
          </Button>
        </div>
      </div>

      <div className="grid gap-2 md:grid-cols-6">
        <Input
          placeholder="Search product or brand…"
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
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left">
                <th className="w-16 p-3">Image</th>
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
              ) : products.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-muted-foreground">
                    No products match these filters.
                  </td>
                </tr>
              ) : (
                products.map((product) => (
                  <tr
                    key={product.id}
                    className="cursor-pointer border-b last:border-0 hover:bg-muted/20"
                    onClick={() => navigate(`/retail/products/${product.id}`)}
                  >
                    <td className="p-3">
                      <ProductImage product={product} className="h-11 w-11 rounded-md border" />
                    </td>
                    <td>
                      <div className="font-medium">{product.name}</div>
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
