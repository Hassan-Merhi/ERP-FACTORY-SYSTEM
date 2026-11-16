// Extracted from ./RetailProductEditor.tsx to keep that module under the source-size cap.
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MobileBarcodeScanner } from "@/components/MobileBarcodeScanner";
import { Label } from "@/components/ui/label";
import { confirmAction } from "@/components/ConfirmHost";
import { normalizeRetailImageUrl } from "@/lib/retailImageUrl";
import { blankVariant, MAX_VARIANT_IMAGES } from "./retailInventoryTypes";
import { putPhotoFirst, useProductEditorState } from "./useProductEditorState";

export function ProductEditorSection({
  draft,
  hideInitialStock,
  locations,
  setDraft,
  setUnlockedBarcodes,
  unlockedBarcodes,
  updateVariant,
  uploadVariantImages,
  uploadingVariantIndex,
}: Pick<
  ReturnType<typeof useProductEditorState>,
  | "draft"
  | "hideInitialStock"
  | "locations"
  | "setDraft"
  | "setUnlockedBarcodes"
  | "unlockedBarcodes"
  | "updateVariant"
  | "uploadVariantImages"
  | "uploadingVariantIndex"
>) {
  return (
    <div className="space-y-3 border-t pt-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold">Colors / Sizes / Variants</h3>
          <p className="text-xs text-muted-foreground">
            Each color and size combination has its own barcode, photos, pricing and location stock.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => setDraft((current) => ({ ...current, variants: [...current.variants, blankVariant()] }))}
        >
          <Plus className="mr-1 h-4 w-4" /> Add variant
        </Button>
      </div>

      {draft.variants.map((variant, variantIndex) => (
        <Card key={variant.id ?? `new-${variantIndex}`}>
          <CardContent className="space-y-4 p-4">
            <div className="grid gap-3 md:grid-cols-7">
              <div className="space-y-1">
                <Label>Color *</Label>
                <Input value={variant.color} onChange={(e) => updateVariant(variantIndex, { color: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label>Size *</Label>
                <Input value={variant.size} onChange={(e) => updateVariant(variantIndex, { size: e.target.value })} />
              </div>
              <div className="space-y-1 md:col-span-2">
                <Label>Barcode</Label>
                <div className="flex gap-1">
                  <Input
                    className="font-mono"
                    placeholder="Auto-generate"
                    value={variant.barcode}
                    // Existing barcodes are printed on labels; editing requires an explicit unlock.
                    readOnly={Boolean(variant.id) && !unlockedBarcodes.has(variantIndex)}
                    onChange={(e) => updateVariant(variantIndex, { barcode: e.target.value })}
                  />
                  <MobileBarcodeScanner
                    onScan={(code) => updateVariant(variantIndex, { barcode: code })}
                    disabled={Boolean(variant.id) && !unlockedBarcodes.has(variantIndex)}
                  />
                  {variant.id && !unlockedBarcodes.has(variantIndex) && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        if (
                          await confirmAction({
                            title: "Printed labels with the old barcode will stop scanning. Change this barcode?",
                          })
                        ) {
                          setUnlockedBarcodes((current) => new Set(current).add(variantIndex));
                        }
                      }}
                    >
                      Change
                    </Button>
                  )}
                </div>
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
              <div>
                <Label>Variant images</Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  Optional photos for this exact color and size. Up to {MAX_VARIANT_IMAGES} images. The first is the
                  variant cover photo.
                </p>
              </div>
              <Input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                multiple
                disabled={uploadingVariantIndex !== null || variant.imageUrls.length >= MAX_VARIANT_IMAGES}
                onChange={(e) => {
                  void uploadVariantImages(variantIndex, e.target.files);
                  e.currentTarget.value = "";
                }}
              />
              {uploadingVariantIndex === variantIndex && (
                <p className="text-sm text-muted-foreground">Uploading variant image…</p>
              )}
              {variant.imageUrls.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {variant.imageUrls.map((src, imageIndex) => (
                    <div
                      key={`${src}-${imageIndex}`}
                      className="relative h-24 w-24 overflow-hidden rounded-md border bg-muted"
                    >
                      <img
                        src={normalizeRetailImageUrl(src)}
                        alt={`Variant photo ${imageIndex + 1}`}
                        className="h-full w-full object-cover"
                      />
                      <Button
                        type="button"
                        size="icon"
                        variant="destructive"
                        className="absolute right-1 top-1 h-6 w-6"
                        onClick={() =>
                          updateVariant(variantIndex, {
                            imageUrls: variant.imageUrls.filter((_, index) => index !== imageIndex),
                          })
                        }
                        aria-label={`Remove variant photo ${imageIndex + 1}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                      {imageIndex === 0 ? (
                        <span className="absolute bottom-1 left-1 rounded bg-primary px-1 py-0.5 text-[10px] font-semibold text-primary-foreground">
                          Main
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="absolute bottom-1 left-1 rounded bg-background/95 px-1 py-0.5 text-[10px] font-semibold shadow hover:bg-background"
                          onClick={() =>
                            updateVariant(variantIndex, {
                              imageUrls: putPhotoFirst(variant.imageUrls, imageIndex),
                            })
                          }
                          aria-label={`Set variant photo ${imageIndex + 1} as main image`}
                        >
                          Set main
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {!hideInitialStock && (
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
            )}

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
                Remove variant
              </Button>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
