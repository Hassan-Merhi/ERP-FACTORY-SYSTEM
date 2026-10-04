import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Camera, CheckCircle2, Copy, ImagePlus, Loader2, Minus, Palette, Plus, Printer, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { RetailNav } from "./RetailNav";
import { RetailLabelPrintDialog, type RetailLabelRequestItem } from "./retailLabels";
import { uploadRetailPhoto } from "./retailPhotoUpload";
import {
  getJson,
  MAX_VARIANT_IMAGES,
  money,
  NO_BRAND,
  type Brand,
  type Location,
  type RetailCatalogFacets,
} from "./retailInventoryTypes";

const QUICK_SIZES = ["XS", "S", "M", "L", "XL", "XXL"];
const COMMON_COLORS = ["Black", "White", "Beige", "Navy", "Grey", "Brown", "Blue", "Red", "Green", "Pink", "Cream"];
const LOCATION_STORAGE_KEY = "retail-quick-add-location";

interface QuickVariant {
  key: string;
  color: string;
  size: string;
  quantity: number;
  cost: string;
  sellingPrice: string;
  sku: string;
  barcode: string;
  imageUrls: string[];
  pendingPreviews: string[];
}

interface QuickAddResult {
  replayed: boolean;
  productId: number;
  createdProduct: boolean;
  variants: Array<{
    variantId: number;
    name: string;
    brand: string | null;
    color: string;
    size: string;
    barcode: string;
    barcodeSource: string;
    sellingPrice: number;
  }>;
}

let keyCounter = 0;
const nextKey = () => `v${Date.now()}-${(keyCounter += 1)}`;

const blankQuickVariant = (patch: Partial<QuickVariant> = {}): QuickVariant => ({
  key: nextKey(),
  color: "",
  size: "",
  quantity: 1,
  cost: "",
  sellingPrice: "",
  sku: "",
  barcode: "",
  imageUrls: [],
  pendingPreviews: [],
  ...patch,
});

const variantKey = (variant: Pick<QuickVariant, "color" | "size">) =>
  `${variant.color.trim().toLowerCase().replace(/\s+/g, " ")}|${variant.size.trim().toLowerCase().replace(/\s+/g, " ")}`;

function makeIdempotencyKey() {
  const uuid =
    typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return `retail-quick-add-${uuid}`.slice(0, 191);
}

function readStoredLocation(): number | "" {
  try {
    const value = Number(window.localStorage.getItem(LOCATION_STORAGE_KEY));
    return Number.isInteger(value) && value > 0 ? value : "";
  } catch {
    return "";
  }
}

export default function RetailQuickAdd() {
  const { selectedCompany } = useCompany();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const retailEnabled = selectedCompany?.companyType === "retail";
  const companyKey = selectedCompany?.id ?? 0;

  const [brandChoice, setBrandChoice] = useState<string>("");
  const [newBrandName, setNewBrandName] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const [locationId, setLocationId] = useState<number | "">(() => readStoredLocation());
  const [variants, setVariants] = useState<QuickVariant[]>(() => [blankQuickVariant()]);
  const [uploadingKeys, setUploadingKeys] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<QuickAddResult | null>(null);
  const [labelItems, setLabelItems] = useState<RetailLabelRequestItem[]>([]);
  const [labelOpen, setLabelOpen] = useState(false);
  const attemptRef = useRef<{ fingerprint: string; key: string } | null>(null);

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
  const { data: facets } = useQuery<RetailCatalogFacets>({
    queryKey: ["retail-catalog-facets", companyKey],
    queryFn: () => getJson("/api/retail/catalog-facets"),
    enabled: retailEnabled,
    staleTime: 60_000,
  });
  const selectedBrandId = brandChoice && brandChoice !== "new" ? Number(brandChoice) : null;
  const { data: styles = [] } = useQuery<Array<{ id: number; name: string; category: string | null }>>({
    queryKey: ["retail-styles", companyKey, selectedBrandId],
    queryFn: () => getJson(`/api/retail/styles${selectedBrandId ? `?brandId=${selectedBrandId}` : ""}`),
    enabled: retailEnabled && Boolean(selectedBrandId),
  });

  const activeLocations = locations.filter((location) => location.id > 0 && location.active !== false);
  useEffect(() => {
    if (locationId === "" && activeLocations.length) setLocationId(activeLocations[0].id);
    if (locationId !== "" && activeLocations.length && !activeLocations.some((entry) => entry.id === locationId)) {
      setLocationId(activeLocations[0].id);
    }
  }, [activeLocations, locationId]);

  const existingStyle = useMemo(
    () => styles.find((style) => style.name.trim().toLowerCase() === name.trim().toLowerCase()),
    [styles, name]
  );
  const colorSuggestions = useMemo(
    () => [...new Set([...(facets?.colors ?? []), ...COMMON_COLORS])].filter((color) => color !== "Default"),
    [facets]
  );
  const duplicateKeys = useMemo(() => {
    const counts = new Map<string, number>();
    for (const variant of variants) {
      if (!variant.color.trim() || !variant.size.trim()) continue;
      counts.set(variantKey(variant), (counts.get(variantKey(variant)) ?? 0) + 1);
    }
    return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
  }, [variants]);

  const updateVariant = (key: string, patch: Partial<QuickVariant>) =>
    setVariants((current) => current.map((variant) => (variant.key === key ? { ...variant, ...patch } : variant)));

  const addPhotos = async (key: string, files: FileList | null) => {
    const variant = variants.find((entry) => entry.key === key);
    if (!variant || !files?.length) return;
    const room = MAX_VARIANT_IMAGES - variant.imageUrls.length - variant.pendingPreviews.length;
    if (room <= 0) {
      toast({ title: "Variant image limit reached", description: `Up to ${MAX_VARIANT_IMAGES} photos per variant.` });
      return;
    }
    const selected = Array.from(files).slice(0, room);
    const previews = selected.map((file) => URL.createObjectURL(file));
    setVariants((current) =>
      current.map((entry) =>
        entry.key === key ? { ...entry, pendingPreviews: [...entry.pendingPreviews, ...previews] } : entry
      )
    );
    setUploadingKeys((current) => new Set(current).add(key));
    try {
      for (const [index, file] of selected.entries()) {
        const url = await uploadRetailPhoto(file);
        const preview = previews[index];
        setVariants((current) =>
          current.map((entry) =>
            entry.key === key
              ? {
                  ...entry,
                  imageUrls: [...entry.imageUrls, url].slice(0, MAX_VARIANT_IMAGES),
                  pendingPreviews: entry.pendingPreviews.filter((value) => value !== preview),
                }
              : entry
          )
        );
        URL.revokeObjectURL(preview);
      }
    } catch (error) {
      setVariants((current) =>
        current.map((entry) =>
          entry.key === key
            ? { ...entry, pendingPreviews: entry.pendingPreviews.filter((value) => !previews.includes(value)) }
            : entry
        )
      );
      toast({
        title: "Photo upload failed",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    } finally {
      setUploadingKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  const reset = (keepContext: boolean) => {
    setName("");
    setDescription("");
    if (!keepContext) {
      setBrandChoice("");
      setCategory("");
    }
    setVariants([blankQuickVariant()]);
    setResult(null);
    attemptRef.current = null;
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Style / product name is required");
      if (brandChoice === "new" && !newBrandName.trim()) throw new Error("Enter the new brand name");
      if (!locationId) throw new Error("Choose a location");
      if (variants.some((variant) => !variant.color.trim() || !variant.size.trim())) {
        throw new Error("Every variant needs a color and a size");
      }
      if (variants.some((variant) => variant.sellingPrice === "" || Number(variant.sellingPrice) < 0)) {
        throw new Error("Every variant needs a selling price");
      }
      if (duplicateKeys.size) throw new Error("The same color and size is entered twice");
      if (uploadingKeys.size) throw new Error("Wait for photos to finish uploading");

      const payload = {
        brandId: selectedBrandId ?? undefined,
        brandName: brandChoice === "new" ? newBrandName.trim() : brandChoice === "" ? NO_BRAND : undefined,
        name: name.trim(),
        category: category.trim() || null,
        description: description.trim() || null,
        locationId: Number(locationId),
        variants: variants.map((variant) => ({
          color: variant.color.trim(),
          size: variant.size.trim(),
          quantity: Math.max(0, Number(variant.quantity) || 0),
          cost: Number(variant.cost) || 0,
          sellingPrice: Number(variant.sellingPrice) || 0,
          sku: variant.sku.trim() || null,
          barcode: variant.barcode.trim(),
          imageUrls: variant.imageUrls,
        })),
      };
      const fingerprint = JSON.stringify(payload);
      if (!attemptRef.current || attemptRef.current.fingerprint !== fingerprint) {
        attemptRef.current = { fingerprint, key: makeIdempotencyKey() };
      }
      const response = await apiRequest("POST", "/api/retail/quick-add", {
        ...payload,
        idempotencyKey: attemptRef.current.key,
      });
      return (await response.json()) as QuickAddResult;
    },
    onSuccess: async (data) => {
      attemptRef.current = null;
      setResult(data);
      try {
        window.localStorage.setItem(LOCATION_STORAGE_KEY, String(locationId));
      } catch {
        // Remembering the location is a convenience only.
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["retail-products"] }),
        queryClient.invalidateQueries({ queryKey: ["retail-product"] }),
        queryClient.invalidateQueries({ queryKey: ["retail-brands"] }),
        queryClient.invalidateQueries({ queryKey: ["retail-styles"] }),
        queryClient.invalidateQueries({ queryKey: ["retail-catalog-facets"] }),
        queryClient.invalidateQueries({ queryKey: ["retail-pos-items"] }),
      ]);
      toast({ title: "Item saved", description: `${data.variants.length} variant(s) added to stock` });
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    onError: (error: Error) =>
      toast({ title: "Could not save item", description: error.message, variant: "destructive" }),
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

  const openLabels = (items: QuickAddResult["variants"]) => {
    setLabelItems(
      items.map((variant) => ({
        variantId: variant.variantId,
        title: `${variant.brand ?? NO_BRAND} · ${variant.name} · ${variant.color} · ${variant.size}`,
        barcode: variant.barcode,
        stockQuantity: 1,
      }))
    );
    setLabelOpen(true);
  };

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-3 pb-28 md:p-6">
      <RetailNav />
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Camera className="h-6 w-6" /> Quick add fashion item
        </h1>
        <p className="text-sm text-muted-foreground">
          Photograph the item, pick brand and style, then add each exact color and size.
        </p>
      </div>

      {result && (
        <Card className="border-emerald-500/60 bg-emerald-50/60 dark:bg-emerald-950/20" data-testid="quick-add-result">
          <CardContent className="space-y-3 p-4">
            <div className="flex items-center gap-2 font-semibold text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-5 w-5" />
              <span>{result.replayed ? "Already saved" : "Saved to inventory"}</span>
            </div>
            <div className="space-y-2">
              {result.variants.map((variant) => (
                <div
                  key={variant.variantId}
                  className="flex items-center justify-between gap-2 rounded-md bg-background p-2"
                >
                  <div className="min-w-0" data-no-translate>
                    <div className="truncate text-sm font-medium">
                      {variant.brand ?? NO_BRAND} · {variant.name}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {variant.color} · {variant.size} · {money(variant.sellingPrice)}
                    </div>
                  </div>
                  <div className="text-right font-mono text-xs">{variant.barcode}</div>
                </div>
              ))}
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <Button onClick={() => openLabels(result.variants)}>
                <Printer className="mr-2 h-4 w-4" /> Print labels
              </Button>
              <Button variant="outline" onClick={() => navigate(`/retail/products/${result.productId}`)}>
                View in inventory
              </Button>
              <Button variant="secondary" onClick={() => reset(true)}>
                <Plus className="mr-2 h-4 w-4" /> Add another item
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Style</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="qa-brand">Brand</Label>
            <select
              id="qa-brand"
              className="h-11 w-full rounded-md border bg-background px-3 text-base"
              value={brandChoice}
              onChange={(event) => setBrandChoice(event.target.value)}
            >
              <option value="">{NO_BRAND}</option>
              {brands
                .filter((brand) => !brand.isNoBrand)
                .map((brand) => (
                  <option key={brand.id} value={brand.id}>
                    {brand.name}
                  </option>
                ))}
              <option value="new">+ New brand…</option>
            </select>
            {brandChoice === "new" && (
              <Input
                autoFocus
                className="h-11 text-base"
                placeholder="New brand name"
                value={newBrandName}
                onChange={(event) => setNewBrandName(event.target.value)}
              />
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="qa-name">Style / model *</Label>
            <Input
              id="qa-name"
              className="h-11 text-base"
              list="qa-styles"
              placeholder="e.g. Wide Leg Trouser"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <datalist id="qa-styles">
              {styles.map((style) => (
                <option key={style.id} value={style.name} />
              ))}
            </datalist>
            {existingStyle && (
              <p className="text-xs text-primary" data-i18n-ui>
                Adding new colors/sizes to an existing style.
              </p>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="qa-location">Location *</Label>
              <select
                id="qa-location"
                className="h-11 w-full rounded-md border bg-background px-3 text-base"
                value={locationId}
                onChange={(event) => setLocationId(event.target.value ? Number(event.target.value) : "")}
              >
                <option value="">Select location</option>
                {activeLocations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="qa-category">Category</Label>
              <Input
                id="qa-category"
                className="h-11 text-base"
                list="qa-categories"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
              />
              <datalist id="qa-categories">
                {(facets?.categories ?? []).map((value) => (
                  <option key={value} value={value} />
                ))}
              </datalist>
            </div>
          </div>
          {showDetails ? (
            <div className="space-y-1">
              <Label htmlFor="qa-description">Description</Label>
              <Textarea
                id="qa-description"
                rows={2}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
          ) : (
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowDetails(true)}>
              + Add description
            </Button>
          )}
        </CardContent>
      </Card>

      <datalist id="qa-colors">
        {colorSuggestions.map((color) => (
          <option key={color} value={color} />
        ))}
      </datalist>

      {variants.map((variant, index) => {
        const isDuplicate = duplicateKeys.has(variantKey(variant));
        const uploading = uploadingKeys.has(variant.key);
        const photoCount = variant.imageUrls.length + variant.pendingPreviews.length;
        return (
          <Card
            key={variant.key}
            className={isDuplicate ? "border-destructive" : undefined}
            data-testid="quick-variant"
          >
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-base">Variant #{index + 1}</CardTitle>
              {variants.length > 1 && (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label="Remove variant"
                  onClick={() => setVariants((current) => current.filter((entry) => entry.key !== variant.key))}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {[...variant.imageUrls, ...variant.pendingPreviews].map((src, imageIndex) => {
                  const pending = imageIndex >= variant.imageUrls.length;
                  return (
                    <div key={src} className="relative h-24 w-24 overflow-hidden rounded-lg border bg-muted">
                      <img src={src} alt="" className="h-full w-full object-cover" />
                      {pending ? (
                        <div className="absolute inset-0 flex items-center justify-center bg-background/50">
                          <Loader2 className="h-5 w-5 animate-spin" />
                        </div>
                      ) : (
                        <Button
                          type="button"
                          size="icon"
                          variant="destructive"
                          aria-label="Remove photo"
                          className="absolute right-1 top-1 h-7 w-7"
                          onClick={() =>
                            updateVariant(variant.key, {
                              imageUrls: variant.imageUrls.filter((_, i) => i !== imageIndex),
                            })
                          }
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  );
                })}
                {photoCount < MAX_VARIANT_IMAGES && (
                  <>
                    <label className="flex h-24 w-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed text-xs text-muted-foreground hover:bg-muted">
                      <Camera className="h-6 w-6" />
                      <span>Take photo</span>
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="sr-only"
                        disabled={uploading}
                        onChange={(event) => {
                          void addPhotos(variant.key, event.target.files);
                          event.currentTarget.value = "";
                        }}
                      />
                    </label>
                    <label className="flex h-24 w-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed text-xs text-muted-foreground hover:bg-muted">
                      <ImagePlus className="h-6 w-6" />
                      <span>Upload</span>
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/gif"
                        multiple
                        className="sr-only"
                        disabled={uploading}
                        onChange={(event) => {
                          void addPhotos(variant.key, event.target.files);
                          event.currentTarget.value = "";
                        }}
                      />
                    </label>
                  </>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>Color *</Label>
                  <Input
                    className="h-11 text-base"
                    list="qa-colors"
                    value={variant.color}
                    onChange={(event) => updateVariant(variant.key, { color: event.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Size *</Label>
                  <Input
                    className="h-11 text-base"
                    value={variant.size}
                    onChange={(event) => updateVariant(variant.key, { size: event.target.value })}
                  />
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {QUICK_SIZES.map((size) => (
                  <button
                    key={size}
                    type="button"
                    onClick={() => updateVariant(variant.key, { size })}
                    className={`h-9 min-w-11 rounded-md border px-2 text-sm ${variant.size === size ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted"}`}
                  >
                    {size}
                  </button>
                ))}
              </div>
              {isDuplicate && (
                <p className="text-sm text-destructive" data-i18n-ui>
                  This color and size is already in the list.
                </p>
              )}

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <div className="space-y-1">
                  <Label>Quantity</Label>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      className="h-11 w-11 shrink-0"
                      aria-label="Decrease quantity"
                      onClick={() => updateVariant(variant.key, { quantity: Math.max(0, variant.quantity - 1) })}
                    >
                      <Minus className="h-4 w-4" />
                    </Button>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      className="h-11 text-center text-base"
                      value={variant.quantity}
                      onChange={(event) =>
                        updateVariant(variant.key, { quantity: Math.max(0, Number(event.target.value) || 0) })
                      }
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      className="h-11 w-11 shrink-0"
                      aria-label="Increase quantity"
                      onClick={() => updateVariant(variant.key, { quantity: variant.quantity + 1 })}
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <div className="space-y-1">
                  <Label>Selling price *</Label>
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    className="h-11 text-base"
                    value={variant.sellingPrice}
                    onChange={(event) => updateVariant(variant.key, { sellingPrice: event.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Cost</Label>
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    className="h-11 text-base"
                    value={variant.cost}
                    onChange={(event) => updateVariant(variant.key, { cost: event.target.value })}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>Barcode</Label>
                  <Input
                    className="h-11 font-mono text-base"
                    placeholder="Auto-generate"
                    value={variant.barcode}
                    onChange={(event) => updateVariant(variant.key, { barcode: event.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label>SKU</Label>
                  <Input
                    className="h-11 text-base"
                    value={variant.sku}
                    onChange={(event) => updateVariant(variant.key, { sku: event.target.value })}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground" data-i18n-ui>
                Scan or type the supplier barcode if the item has one. Leave empty to generate a printable barcode.
              </p>

              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    setVariants((current) => {
                      const position = current.findIndex((entry) => entry.key === variant.key);
                      const copy = blankQuickVariant({
                        color: variant.color,
                        quantity: variant.quantity,
                        cost: variant.cost,
                        sellingPrice: variant.sellingPrice,
                        imageUrls: [...variant.imageUrls],
                      });
                      return [...current.slice(0, position + 1), copy, ...current.slice(position + 1)];
                    })
                  }
                >
                  <Copy className="mr-2 h-4 w-4" /> Same color, new size
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    setVariants((current) => {
                      const position = current.findIndex((entry) => entry.key === variant.key);
                      const copy = blankQuickVariant({
                        size: variant.size,
                        quantity: variant.quantity,
                        cost: variant.cost,
                        sellingPrice: variant.sellingPrice,
                      });
                      return [...current.slice(0, position + 1), copy, ...current.slice(position + 1)];
                    })
                  }
                >
                  <Palette className="mr-2 h-4 w-4" /> New color
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}

      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={() => setVariants((current) => [...current, blankQuickVariant()])}
      >
        <Plus className="mr-2 h-4 w-4" /> Add variant
      </Button>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 p-3 backdrop-blur md:static md:border-0 md:bg-transparent md:p-0">
        <div className="mx-auto flex max-w-2xl items-center gap-2">
          <div className="hidden flex-1 text-sm text-muted-foreground sm:block" data-i18n-ui>
            {variants.length} variant(s) · {variants.reduce((sum, variant) => sum + (Number(variant.quantity) || 0), 0)}{" "}
            unit(s)
          </div>
          <Button
            className="h-12 flex-1 text-base sm:flex-none sm:px-8"
            disabled={saveMutation.isPending || uploadingKeys.size > 0}
            onClick={() => saveMutation.mutate()}
          >
            {saveMutation.isPending ? "Saving…" : "Save item"}
          </Button>
        </div>
      </div>

      <RetailLabelPrintDialog open={labelOpen} onOpenChange={setLabelOpen} items={labelItems} />
    </div>
  );
}
