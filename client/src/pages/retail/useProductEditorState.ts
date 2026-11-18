// Extracted from ./RetailProductEditor.tsx to keep that module under the source-size cap.
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import {
  ALLOWED_IMAGE_TYPES,
  blankDraft,
  type Brand,
  buildInternalProductCode,
  type DraftVariant,
  type Location,
  MAX_IMAGE_BYTES,
  MAX_PRODUCT_IMAGES,
  MAX_VARIANT_IMAGES,
  NO_BRAND,
  type ProductDraft,
  type RetailProduct,
} from "./retailInventoryTypes";

/** Image order is persisted; the first photo is the inventory cover image. */
export function putPhotoFirst(images: string[], index: number): string[] {
  if (index <= 0 || index >= images.length) return images;
  return [images[index], ...images.filter((_, photoIndex) => photoIndex !== index)];
}

export function useProductEditorState({
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
  // Create Only adds products without opening stock or new brands (both refused by the server).
  const { isCreateOnly } = useExistingRecordChangeAccess();
  const hideInitialStock = isCreateOnly && !product;
  const [draft, setDraft] = useState<ProductDraft>(() => blankDraft());
  const [addingBrand, setAddingBrand] = useState(false);
  const [newBrandName, setNewBrandName] = useState("");
  const [uploadingImages, setUploadingImages] = useState(false);
  const [uploadingVariantIndex, setUploadingVariantIndex] = useState<number | null>(null);
  const [unlockedBarcodes, setUnlockedBarcodes] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!open) return;
    setDraft(
      product
        ? {
            code: product.code,
            name: product.name,
            brandId: product.brand.name === NO_BRAND ? "" : (product.brand.id ?? ""),
            category: product.category ?? "",
            description: product.description ?? "",
            imageUrls: [...(product.imageUrls ?? [])],
            active: product.active,
            variants: product.variants.map((variant) => ({
              id: variant.id,
              color: variant.color,
              size: variant.size,
              imageUrls: [...(variant.imageUrls ?? [])],
              barcode: variant.barcode,
              sku: variant.sku ?? "",
              cost: variant.cost,
              sellingPrice: variant.sellingPrice,
              lowStockThreshold: variant.lowStockThreshold,
              active: variant.active,
              stocks: variant.stocks.length
                ? variant.stocks.map((stock) => ({
                    locationId: stock.locationId,
                    quantity: stock.quantity,
                    expectedQuantity: stock.quantity,
                  }))
                : [{ locationId: "", quantity: 0 }],
            })),
          }
        : blankDraft()
    );
    setAddingBrand(false);
    setNewBrandName("");
    setUnlockedBarcodes(new Set());
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
        uploadedUrls.push(`/api/retail/media/${body.id}`);
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

  const uploadVariantImages = async (variantIndex: number, files?: FileList | null) => {
    if (!files?.length) return;
    const currentImages = draft.variants[variantIndex]?.imageUrls ?? [];
    const remaining = MAX_VARIANT_IMAGES - currentImages.length;
    if (remaining <= 0) {
      toast({
        title: "Variant image limit reached",
        description: `You can upload up to ${MAX_VARIANT_IMAGES} images per variant.`,
      });
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

    setUploadingVariantIndex(variantIndex);
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
        uploadedUrls.push(`/api/retail/media/${body.id}`);
      }
      setDraft((current) => ({
        ...current,
        variants: current.variants.map((variant, index) =>
          index === variantIndex
            ? { ...variant, imageUrls: [...variant.imageUrls, ...uploadedUrls].slice(0, MAX_VARIANT_IMAGES) }
            : variant
        ),
      }));
      toast({ title: selected.length === 1 ? "Variant image uploaded" : `${selected.length} variant images uploaded` });
    } catch (error) {
      toast({
        title: "Variant image upload failed",
        description: error instanceof Error ? error.message : "Could not upload variant image",
        variant: "destructive",
      });
    } finally {
      setUploadingVariantIndex(null);
    }
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const variants = draft.variants.map((variant) => ({
        id: variant.id,
        color: variant.color.trim(),
        size: variant.size.trim(),
        imageUrls: variant.imageUrls,
        barcode: variant.barcode.trim(),
        sku: variant.sku.trim() || null,
        cost: Number(variant.cost),
        sellingPrice: Number(variant.sellingPrice),
        lowStockThreshold: Number(variant.lowStockThreshold),
        active: variant.active,
        stocks: hideInitialStock
          ? []
          : variant.stocks
              .filter((stock) => stock.locationId !== "")
              .map((stock) => ({
                locationId: Number(stock.locationId),
                quantity: Number(stock.quantity),
                expectedQuantity: stock.expectedQuantity,
              })),
      }));

      if (!draft.name.trim()) throw new Error("Item name is required");
      if (!variants.length || variants.some((variant) => !variant.color || !variant.size)) {
        throw new Error("Every variant needs a color and size");
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
        // Description is not edited here; keep whatever the product already has (quick add / import).
        description: draft.description.trim() || null,
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
      queryClient.invalidateQueries({ queryKey: ["retail-catalog-navigation"] });
      queryClient.invalidateQueries({ queryKey: ["retail-catalog-facets"] });
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
  return {
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
  };
}
