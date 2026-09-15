import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  ALLOWED_IMAGE_TYPES,
  blankDraft,
  blankVariant,
  buildInternalProductCode,
  MAX_IMAGE_BYTES,
  MAX_PRODUCT_IMAGES,
  NO_BRAND,
  type Brand,
  type DraftVariant,
  type Location,
  type ProductDraft,
  type RetailProduct,
} from "./retailInventoryTypes";

export function ProductEditor({
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
