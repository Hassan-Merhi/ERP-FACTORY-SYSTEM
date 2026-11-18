// Extracted from ./RetailInventory.tsx to keep that module under the source-size cap.
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useRoute } from "wouter";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import type { RetailCatalogFilters, RetailVariantAction } from "./RetailCatalogList";
import { RetailLabelPrintDialog, type RetailLabelRequestItem } from "./retailLabels";
import { confirmAction } from "@/components/ConfirmHost";
import {
  type Brand,
  getJson,
  type Location,
  type RetailCatalogFacets,
  type RetailCatalogNavigation,
  type RetailCatalogPage,
  type RetailProduct,
  type RetailVariant,
} from "./retailInventoryTypes";

export function useRetailInventoryState() {
  const { selectedCompany } = useCompany();
  const [, navigate] = useLocation();
  // View Only and Create Only roles cannot edit, archive or import into existing products.
  const recordChanges = useExistingRecordChangeAccess();
  const [detailMatch, detailParams] = useRoute("/retail/products/:id");
  const [editorOpen, setEditorOpen] = useState(false);
  const [supplierImportOpen, setSupplierImportOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<RetailProduct | null>(null);
  const [search, setSearch] = useState("");
  const [color, setColor] = useState("");
  const [size, setSize] = useState("");
  const [locationId, setLocationId] = useState("");
  const [categoryKey, setCategoryKey] = useState<string | null>(null);
  const [expandedBrandKey, setExpandedBrandKey] = useState<string | null>(null);
  const [stockStatus, setStockStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [labelItems, setLabelItems] = useState<RetailLabelRequestItem[]>([]);
  const [labelOpen, setLabelOpen] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, color, size, categoryKey, expandedBrandKey, locationId, stockStatus, showArchived]);

  const retailEnabled = selectedCompany?.companyType === "retail";
  const companyKey = selectedCompany?.id ?? 0;
  useEffect(() => {
    setLocationId("");
    setCategoryKey(null);
    setExpandedBrandKey(null);
    setSelected(new Set());
  }, [companyKey]);
  const { data: brands = [] } = useQuery<Brand[]>({
    queryKey: ["retail-brands", companyKey],
    queryFn: () => getJson("/api/retail/brands"),
    enabled: retailEnabled,
  });
  const { data: locations = [], isLoading: locationsLoading } = useQuery<Location[]>({
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

  // Only fetch the paginated product cards when a brand is expanded. The
  // independent navigation endpoint enumerates *all* matching categories and
  // brands, so pagination cannot hide a group.
  const navigationParams = useMemo(() => {
    const params = new URLSearchParams({ stockStatus });
    if (locationId) params.set("locationId", locationId);
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (color) params.set("color", color);
    if (size) params.set("size", size);
    if (showArchived) params.set("archived", "include");
    return params.toString();
  }, [locationId, debouncedSearch, color, size, stockStatus, showArchived]);

  const {
    data: navigationData,
    isLoading: navigationLoading,
    isError: navigationFailed,
  } = useQuery<RetailCatalogNavigation>({
    queryKey: ["retail-catalog-navigation", companyKey, navigationParams],
    queryFn: () => getJson(`/api/retail/catalog-navigation?${navigationParams}`),
    enabled: retailEnabled && Boolean(locationId),
  });
  const selectedLocation = locations.find((entry) => String(entry.id) === locationId);
  const selectedCategory = navigationData?.categories.find((entry) => entry.key === categoryKey);
  const expandedBrand = selectedCategory?.brands.find((entry) => entry.key === expandedBrandKey);

  const catalogParams = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: "60", stockStatus });
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (color) params.set("color", color);
    if (size) params.set("size", size);
    if (categoryKey) params.set("category", categoryKey);
    if (expandedBrandKey) params.set("brandId", expandedBrandKey);
    if (locationId) params.set("locationId", locationId);
    if (showArchived) params.set("archived", "include");
    return params.toString();
  }, [page, debouncedSearch, color, size, categoryKey, expandedBrandKey, locationId, stockStatus, showArchived]);

  const {
    data: catalogPage,
    isLoading,
    isError: catalogFailed,
  } = useQuery<RetailCatalogPage>({
    queryKey: ["retail-products", "page", companyKey, catalogParams],
    queryFn: () => getJson(`/api/retail/products-page?${catalogParams}`),
    enabled: retailEnabled && Boolean(locationId && selectedCategory && expandedBrand),
  });
  const products = catalogPage?.items ?? [];
  const colors = catalogFacets?.colors ?? [];
  const sizes = catalogFacets?.sizes ?? [];

  const productId = detailMatch ? Number(detailParams?.id) : 0;
  const { data: detailProduct, isError: detailFailed } = useQuery<RetailProduct>({
    queryKey: ["retail-product", companyKey, productId],
    queryFn: () => getJson(`/api/retail/products/${productId}`),
    enabled: retailEnabled && productId > 0,
  });

  const catalogFilters: RetailCatalogFilters = { color, size, locationId, stockStatus, showArchived };
  const knownVariants = new Map<number, { product: RetailProduct; variant: RetailVariant }>();
  for (const product of [...products, ...(detailProduct ? [detailProduct] : [])]) {
    for (const variant of product.variants) knownVariants.set(variant.id, { product, variant });
  }
  const labelItemFor = (product: RetailProduct, variant: RetailVariant): RetailLabelRequestItem => ({
    variantId: variant.id,
    title: `${product.brand.name} · ${product.name} · ${variant.color} · ${variant.size}`,
    barcode: variant.barcode,
    stockQuantity: variant.quantity,
  });
  const toggleVariant = (variantId: number) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(variantId)) next.delete(variantId);
      else next.add(variantId);
      return next;
    });
  const toggleVariants = (variantIds: number[], select: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const id of variantIds) {
        if (select) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const openEditor = (product: RetailProduct) => {
    if (!recordChanges.allowed) return;
    setEditingProduct(product);
    setEditorOpen(true);
  };
  const refreshCatalog = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["retail-products"] }),
      queryClient.invalidateQueries({ queryKey: ["retail-catalog-navigation"] }),
      queryClient.invalidateQueries({ queryKey: ["retail-product"] }),
      queryClient.invalidateQueries({ queryKey: ["retail-pos-items"] }),
    ]);
  const setProductActive = async (product: RetailProduct, active: boolean) => {
    if (!recordChanges.allowed) return;
    if (!active && !(await confirmAction({ title: `Archive ${product.name}? Its sales and stock history are kept.` })))
      return;
    try {
      await apiRequest("PATCH", `/api/retail/products/${product.id}/active`, { active });
      await refreshCatalog();
      toast({ title: active ? "Style restored" : "Style archived" });
    } catch (error) {
      toast({ title: "Could not update style", description: (error as Error).message, variant: "destructive" });
    }
  };
  const handleVariantAction = async (action: RetailVariantAction, product: RetailProduct, variant: RetailVariant) => {
    if (action === "print") {
      setLabelItems([labelItemFor(product, variant)]);
      setLabelOpen(true);
    } else {
      if (!recordChanges.allowed) return;
      const active = action === "restore";
      try {
        await apiRequest("PATCH", `/api/retail/variants/${variant.id}/active`, { active });
        await refreshCatalog();
        toast({
          title: active ? "Variant restored" : "Variant archived",
          description: `${variant.color} / ${variant.size}`,
        });
      } catch (error) {
        toast({ title: "Could not update variant", description: (error as Error).message, variant: "destructive" });
      }
    }
  };

  const bulkBar =
    selected.size > 0 ? (
      <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 p-3 backdrop-blur-sm">
        <div className="mx-auto flex max-w-3xl items-center gap-2">
          <span className="flex-1 text-sm" data-i18n-ui>
            Selected for labels: {selected.size}
          </span>
          <Button variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
          <Button
            onClick={() => {
              setLabelItems(
                [...selected]
                  .map((id) => knownVariants.get(id))
                  .filter((entry): entry is { product: RetailProduct; variant: RetailVariant } => Boolean(entry))
                  .map(({ product, variant }) => labelItemFor(product, variant))
              );
              setLabelOpen(true);
            }}
          >
            <Printer className="mr-2 h-4 w-4" /> Print labels
          </Button>
        </div>
      </div>
    ) : null;

  const actionDialogs = (
    <>
      <RetailLabelPrintDialog open={labelOpen} onOpenChange={setLabelOpen} items={labelItems} />
    </>
  );
  return {
    actionDialogs,
    brands,
    bulkBar,
    catalogFailed,
    catalogFilters,
    catalogPage,
    categoryKey,
    color,
    colors,
    detailFailed,
    detailMatch,
    detailProduct,
    editingProduct,
    editorOpen,
    expandedBrandKey,
    handleVariantAction,
    isLoading,
    locationId,
    locations,
    locationsLoading,
    navigate,
    navigationData,
    navigationFailed,
    navigationLoading,
    openEditor,
    page,
    products,
    recordChanges,
    retailEnabled,
    search,
    selected,
    selectedCategory,
    selectedLocation,
    setCategoryKey,
    setColor,
    setEditingProduct,
    setEditorOpen,
    setExpandedBrandKey,
    setLocationId,
    setPage,
    setProductActive,
    setSearch,
    setSelected,
    setShowArchived,
    setSize,
    setStockStatus,
    setSupplierImportOpen,
    showArchived,
    size,
    sizes,
    stockStatus,
    supplierImportOpen,
    toggleVariant,
    toggleVariants,
  };
}
