// Extracted from ./RetailQuickAdd.tsx to keep that module under the source-size cap.
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { RetailLabelRequestItem } from "./retailLabels";
import { uploadRetailPhoto } from "./retailPhotoUpload";
import {
  type Brand,
  getJson,
  type Location,
  MAX_VARIANT_IMAGES,
  NO_BRAND,
  type RetailCatalogFacets,
} from "./retailInventoryTypes";
import {
  COMMON_COLORS,
  LOCATION_STORAGE_KEY,
  blankQuickVariant,
  makeIdempotencyKey,
  readStoredLocation,
  variantKey,
  type QuickAddResult,
  type QuickVariant,
} from "./blankQuickVariant";

export function useRetailQuickAddState() {
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
        queryClient.invalidateQueries({ queryKey: ["retail-catalog-navigation"] }),
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
  return {
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
  };
}
