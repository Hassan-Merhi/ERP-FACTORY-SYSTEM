import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  blankDraft,
  blankVariant,
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
