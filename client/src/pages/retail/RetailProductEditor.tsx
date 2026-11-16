import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { normalizeRetailImageUrl } from "@/lib/retailImageUrl";
import { MAX_PRODUCT_IMAGES, NO_BRAND, type Brand, type Location, type RetailProduct } from "./retailInventoryTypes";
import { putPhotoFirst, useProductEditorState } from "./useProductEditorState";
import { ProductEditorSection } from "./ProductEditorSection";

export function ProductEditor(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product?: RetailProduct | null;
  brands: Brand[];
  locations: Location[];
}) {
  const {
    addingBrand,
    brands,
    createBrandMutation,
    draft,
    hideInitialStock,
    isCreateOnly,
    locations,
    newBrandName,
    onOpenChange,
    open,
    product,
    saveMutation,
    setAddingBrand,
    setDraft,
    setNewBrandName,
    setUnlockedBarcodes,
    unlockedBarcodes,
    updateVariant,
    uploadImages,
    uploadVariantImages,
    uploadingImages,
    uploadingVariantIndex,
  } = useProductEditorState(props);

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
              {!isCreateOnly && (
                <Button type="button" size="sm" variant="ghost" onClick={() => setAddingBrand((current) => !current)}>
                  <Plus className="mr-1 h-4 w-4" /> Add brand
                </Button>
              )}
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
              <p className="mt-1 text-xs text-muted-foreground">
                Upload JPG, PNG, WEBP or GIF images. Up to 8 images. The first photo is the main inventory image.
              </p>
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
                    className="group relative h-28 w-28 overflow-hidden rounded-lg border bg-muted"
                  >
                    <img
                      src={normalizeRetailImageUrl(src)}
                      alt={`Product photo ${index + 1}`}
                      className="h-full w-full object-cover"
                    />
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
                      aria-label={`Remove product photo ${index + 1}`}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                    {index === 0 ? (
                      <span className="absolute bottom-1 left-1 rounded bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
                        Main
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="absolute bottom-1 left-1 rounded bg-background/95 px-1.5 py-1 text-[10px] font-semibold text-foreground shadow hover:bg-background"
                        onClick={() =>
                          setDraft((current) => ({
                            ...current,
                            imageUrls: putPhotoFirst(current.imageUrls, index),
                          }))
                        }
                        aria-label={`Set product photo ${index + 1} as main image`}
                      >
                        Set main
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <ProductEditorSection
          draft={draft}
          hideInitialStock={hideInitialStock}
          locations={locations}
          setDraft={setDraft}
          setUnlockedBarcodes={setUnlockedBarcodes}
          unlockedBarcodes={unlockedBarcodes}
          updateVariant={updateVariant}
          uploadVariantImages={uploadVariantImages}
          uploadingVariantIndex={uploadingVariantIndex}
        />

        <div className="flex justify-end gap-2 border-t pt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || uploadingImages || uploadingVariantIndex !== null}
          >
            {saveMutation.isPending ? "Saving…" : "Save product"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
