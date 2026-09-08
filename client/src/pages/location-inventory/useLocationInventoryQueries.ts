import { useQuery } from "@tanstack/react-query";
import { locationInventoryFullUrl } from "@/api/inventoryApi";
import type { InventoryLocation as Location } from "./locationInventoryTypes";

interface InventoryItem {
  inventoryId: number | null;
  locationId: number;
  stockItemId: number;
  quantity: string;
  averageRate: string | null;
  totalValue: string | null;
  stockItemCode: string;
  stockItemName: string;
  stockItemUom: string;
  stockGroupId: number | null;
  stockGroupName: string | null;
  stockGroupCode: string | null;
  stockItemActive: boolean | null;
  categoryId?: number | null;
  categoryName?: string | null;
}

interface UseLocationInventoryQueriesParams {
  waGroupDialogOpen: boolean;
  posUser?: any;
  companyId: number | undefined;
  selectedLocationLocal: Location | null;
  showZeroStock: boolean;
  fromDate: string;
  asOfDate: string;
  showAllStock: boolean;
  showNegativeStock: boolean;
}

export function useLocationInventoryQueries({
  waGroupDialogOpen,
  posUser,
  companyId,
  selectedLocationLocal,
  showZeroStock,
  fromDate,
  asOfDate,
  showAllStock,
  showNegativeStock,
}: UseLocationInventoryQueriesParams) {
  // Fail closed in the UI if the permission service is unavailable. The server
  // remains the authoritative permission boundary for every group/config write.
  const { data: whatsappCapability } = useQuery<{ canManage: boolean }>({
    queryKey: companyId ? ["/api/location-inventory/whatsapp/capability", companyId] : [],
    queryFn: async () => {
      const res = await fetch("/api/location-inventory/whatsapp/capability", { credentials: "include" });
      if (!res.ok) return { canManage: false };
      return res.json();
    },
    enabled: !posUser && !!companyId,
    staleTime: 5 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const canManageWhatsapp = !posUser && whatsappCapability?.canManage === true;

  const { data: waChats = [], isLoading: waChatsLoading } = useQuery<{ id: string; name: string; type: string }[]>({
    queryKey: ["/api/location-inventory/whatsapp/groups"],
    queryFn: async () => {
      const res = await fetch("/api/location-inventory/whatsapp/groups", { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || `Failed to fetch WhatsApp groups: ${res.status}`);
      }
      return res.json();
    },
    enabled: waGroupDialogOpen && canManageWhatsapp,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const { data: allLocations = [], isLoading: allLocationsLoading } = useQuery<Location[]>({
    // Keep companyId as a second array element for cache scoping (different companies
    // get separate cache entries), but do NOT embed it in the URL.
    // The server reads the company from the session (req.session.currentCompanyId).
    // Putting ?companyId=X in the URL triggers requireAuth's cross-company guard,
    // which compares it against resolveActiveCompanyId(req) — that returns
    // factoryCompanyId first, causing 403s for admin users who have been in factory mode.
    queryKey: companyId ? ["/api/locations", companyId] : [],
    queryFn: async () => {
      const res = await fetch("/api/locations", { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to fetch locations: ${res.status}`);
      return res.json();
    },
    enabled: !posUser && !!companyId,
    staleTime: 5 * 60 * 1000,
  });

  const { data: posAssignedLocations = [], isLoading: posLocationsLoading } = useQuery<Location[]>({
    queryKey: posUser ? ["/api/my-locations"] : [],
    enabled: !!posUser,
  });

  const locations = posUser ? posAssignedLocations : allLocations;
  const locationsLoading = posUser ? posLocationsLoading : allLocationsLoading;

  // Inventory URLs are the cache identity. Do not append companyId as another
  // query-key element: location IDs are globally unique and the server enforces
  // company/location access. Using the exact URL lets every identical caller
  // share the same TanStack Query cache entry and in-flight request.
  const currentInventoryUrl = selectedLocationLocal
    ? locationInventoryFullUrl(selectedLocationLocal.id, showZeroStock ? "includeZero=true" : "")
    : null;
  const { data: inventoryData = [], isLoading: inventoryLoading } = useQuery<InventoryItem[]>({
    queryKey: currentInventoryUrl ? [currentInventoryUrl] : [],
    enabled: !!currentInventoryUrl && !!companyId,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const openingInventoryUrl =
    selectedLocationLocal && fromDate
      ? locationInventoryFullUrl(selectedLocationLocal.id, `asOfDate=${encodeURIComponent(fromDate)}`)
      : null;
  const { data: openingInventoryData = [], isLoading: openingInventoryLoading } = useQuery<InventoryItem[]>({
    queryKey: openingInventoryUrl ? [openingInventoryUrl] : [],
    enabled: !!openingInventoryUrl && !!companyId,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const closingInventoryUrl =
    selectedLocationLocal && asOfDate
      ? locationInventoryFullUrl(selectedLocationLocal.id, `asOfDate=${encodeURIComponent(asOfDate)}`)
      : null;
  const { data: closingInventoryData = [], isLoading: closingInventoryLoading } = useQuery<InventoryItem[]>({
    queryKey: closingInventoryUrl ? [closingInventoryUrl] : [],
    enabled: !!closingInventoryUrl && !!companyId,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const { data: allInventoryRaw, isLoading: allInventoryLoading } = useQuery({
    queryKey: companyId ? ["/api/inventory", companyId] : [],
    queryFn: async () => {
      // Fetch the first page at the maximum allowed page size.
      const PAGE_SIZE = 5000;
      const res = await fetch(`/api/inventory?page=1&pageSize=${PAGE_SIZE}`, { credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      const first = await res.json();

      // Legacy non-paginated response — return as-is.
      if (Array.isArray(first)) return first;

      const { data, totalPages } = first;
      if (!totalPages || totalPages <= 1) return data;

      // Fetch any remaining pages in parallel so large inventories are not truncated.
      const remaining = await Promise.all(
        Array.from({ length: totalPages - 1 }, (_, i) => i + 2).map(async (page) => {
          const r = await fetch(`/api/inventory?page=${page}&pageSize=${PAGE_SIZE}`, { credentials: "include" });
          if (!r.ok) throw new Error(await r.text());
          const d = await r.json();
          return Array.isArray(d) ? d : (d.data ?? []);
        })
      );
      return [...data, ...remaining.flat()];
    },
    enabled: showAllStock && !!companyId,
    // Extended stale time: the full inventory list is expensive; avoid re-downloading
    // it on every mutation or focus event. Users can navigate away and back to refresh.
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    retry: false,
  });
  // queryFn always resolves to a flat array of inventory rows.
  const allInventoryData = Array.isArray(allInventoryRaw) ? allInventoryRaw : [];

  const { data: allNegativeStock = [], isLoading: negativeStockLoading } = useQuery({
    queryKey: companyId ? ["/api/inventory/negative", companyId] : [],
    queryFn: async () => {
      const res = await fetch("/api/inventory/negative", { credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    enabled: !posUser && !!companyId && showNegativeStock && !selectedLocationLocal,
    staleTime: 30000,
  });

  const { data: categoriesList = [] } = useQuery<{ id: number; name: string; active: boolean }[]>({
    queryKey: companyId ? ["/api/stock-categories", companyId] : [],
    queryFn: async () => {
      const res = await fetch("/api/stock-categories", { credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    enabled: !!companyId,
    staleTime: 5 * 60 * 1000,
  });

  return {
    canManageWhatsapp,
    waChats,
    waChatsLoading,
    locations,
    locationsLoading,
    inventoryData,
    inventoryLoading,
    openingInventoryData,
    openingInventoryLoading,
    closingInventoryData,
    closingInventoryLoading,
    allInventoryData,
    allInventoryLoading,
    allNegativeStock,
    negativeStockLoading,
    categoriesList,
  };
}
