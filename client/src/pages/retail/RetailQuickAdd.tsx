import { Camera, CheckCircle2, Copy, ImagePlus, Loader2, Minus, Palette, Plus, Printer, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MobileBarcodeScanner } from "@/components/MobileBarcodeScanner";
import { Label } from "@/components/ui/label";
import { RetailNav } from "./RetailNav";
import { RetailLabelPrintDialog } from "./retailLabels";
import { MAX_VARIANT_IMAGES, money, NO_BRAND } from "./retailInventoryTypes";
import { QUICK_SIZES, blankQuickVariant, variantKey, type QuickAddResult } from "./blankQuickVariant";
import { useRetailQuickAddState } from "./useRetailQuickAddState";
import { RetailQuickAddCardSection } from "./RetailQuickAddCardSection";

export default function RetailQuickAdd() {
  const {
    activeLocations,
    addPhotos,
    brandChoice,
    brands,
    category,
    colorSuggestions,
    description,
    duplicateKeys,
    existingStyle,
    facets,
    labelItems,
    labelOpen,
    locationId,
    name,
    navigate,
    newBrandName,
    reset,
    result,
    retailEnabled,
    saveMutation,
    setBrandChoice,
    setCategory,
    setDescription,
    setLabelItems,
    setLabelOpen,
    setLocationId,
    setName,
    setNewBrandName,
    setShowDetails,
    setVariants,
    showDetails,
    styles,
    updateVariant,
    uploadingKeys,
    variants,
  } = useRetailQuickAddState();

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
        stockQuantity: Math.max(1, variant.receivedQuantity ?? 1),
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

      <RetailQuickAddCardSection
        activeLocations={activeLocations}
        brandChoice={brandChoice}
        brands={brands}
        category={category}
        description={description}
        existingStyle={existingStyle}
        facets={facets}
        locationId={locationId}
        name={name}
        newBrandName={newBrandName}
        setBrandChoice={setBrandChoice}
        setCategory={setCategory}
        setDescription={setDescription}
        setLocationId={setLocationId}
        setName={setName}
        setNewBrandName={setNewBrandName}
        setShowDetails={setShowDetails}
        showDetails={showDetails}
        styles={styles}
      />

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
                  <MobileBarcodeScanner
                    onScan={(code) => updateVariant(variant.key, { barcode: code })}
                    className="mt-2"
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

      <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 p-3 backdrop-blur-sm md:static md:border-0 md:bg-transparent md:p-0">
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
