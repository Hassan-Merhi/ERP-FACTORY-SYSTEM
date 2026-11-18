// Extracted from ./usePosPriceListModel.ts: price-list queries, filters and selection state.
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { getDefaultPeriodValue, type PeriodFilterValue } from "@/components/ui/period-filter";
import type { Location, MasterPriceListResponse, POSPriceListProps, PriceListItem, PriceListRow } from "./types";
import { ALL_LOCATIONS_ID } from "./utils";
import { PRIVILEGED_ROLES } from "./usePosPriceListModel";

export function usePosPriceListDataModel({ posUser }: { posUser: POSPriceListProps["posUser"] }) {
  const { formatAmount } = useCurrencyContext();
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();
  const [selectedLocationId, setSelectedLocationId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState<string>("all");
  const [salesPeriod, setSalesPeriod] = useState<PeriodFilterValue>(() => getDefaultPeriodValue("all_time"));
  const [editingItem, setEditingItem] = useState<{ stockItemId: number; locationId: number; value: string } | null>(
    null
  );
  const [showUnpriced, setShowUnpriced] = useState(false);
  const [hideZeroQty, setHideZeroQty] = useState(false);
  const [showZeroQty, setShowZeroQty] = useState(false);
  const [hiddenUnpricedGroups, setHiddenUnpricedGroups] = useState<Set<string>>(new Set());
  const [hiddenLocations, setHiddenLocations] = useState<Set<number>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const editingItemRef = useRef(editingItem);
  useEffect(() => {
    editingItemRef.current = editingItem;
  }, [editingItem]);
  useEffect(() => {
    if (editingItem) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editingItem]);
  const lastSavedRef = useRef<{ stockItemId: number; locationId: number } | null>(null);
  const skipBlurSaveRef = useRef(false);
  // A navigation blur may be ignored once, but a later manual blur must still save.
  useEffect(() => {
    skipBlurSaveRef.current = false;
  }, [editingItem?.stockItemId, editingItem?.locationId]);

  const { data: currentUser } = useQuery<{ role?: string }>({ queryKey: ["/api/auth/me"] });
  const isPrivileged = PRIVILEGED_ROLES.includes(currentUser?.role || "");

  const { data: posAssignedLocations = [], isLoading: posLocationsLoading } = useQuery<Location[]>({
    queryKey: ["/api/my-locations"],
    enabled: !!posUser,
  });

  const { data: allLocations = [], isLoading: allLocationsLoading } = useQuery<Location[]>({
    queryKey: ["/api/locations"],
    enabled: !posUser,
  });

  const locations = posUser ? posAssignedLocations : allLocations;
  const locationsLoading = posUser ? posLocationsLoading : allLocationsLoading;

  useEffect(() => {
    if (locations.length === 1 && selectedLocationId === null) {
      setSelectedLocationId(locations[0].id);
    }
  }, [locations, selectedLocationId]);

  const isAllMode = selectedLocationId === ALL_LOCATIONS_ID;

  // ── Single-location price list ──────────────────────────────────────────────
  const {
    data: priceList = [],
    isLoading: priceListLoading,
    isError: priceListError,
    error: priceListErrorObj,
  } = useQuery<PriceListItem[]>({
    queryKey: ["/api/pos/price-list", selectedLocationId, salesPeriod.fromDate, salesPeriod.toDate],
    queryFn: async () => {
      const params = new URLSearchParams({ locationId: String(selectedLocationId) });
      if (salesPeriod.fromDate) params.set("fromDate", salesPeriod.fromDate);
      if (salesPeriod.toDate) params.set("toDate", salesPeriod.toDate);
      const res = await fetch(`/api/pos/price-list?${params.toString()}`, {
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ message: "Unknown error" }));
        throw new Error(body.message || "Failed to load price list");
      }
      return res.json();
    },
    enabled: !!selectedLocationId && !isAllMode,
  });

  // ── All-masters price list ──────────────────────────────────────────────────
  const {
    data: mastersData,
    isLoading: mastersLoading,
    isError: mastersError,
    error: mastersErrorObj,
  } = useQuery<MasterPriceListResponse>({
    queryKey: ["/api/pos/price-list-by-masters"],
    queryFn: async () => {
      const res = await fetch("/api/pos/price-list-by-masters", { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ message: "Unknown error" }));
        throw new Error(body.message || "Failed to load price list");
      }
      return res.json();
    },
    enabled: isAllMode,
  });

  const masters = useMemo(() => mastersData?.masters ?? [], [mastersData?.masters]);
  const masterItems = useMemo(() => mastersData?.items ?? [], [mastersData?.items]);

  // ── Merged state ────────────────────────────────────────────────────────────
  const isLoading = isAllMode ? mastersLoading : priceListLoading;
  const isError = isAllMode ? mastersError : priceListError;
  const error = isAllMode ? mastersErrorObj : priceListErrorObj;

  const visibleMasters = useMemo(() => {
    if (!isAllMode) return masters;
    return masters.filter((m) => !hiddenLocations.has(m.id));
  }, [isAllMode, masters, hiddenLocations]);

  const locationPricedList = useMemo<PriceListRow[]>(() => {
    if (isAllMode) return masterItems;
    if (!posUser) return priceList;
    return priceList.filter((item) => {
      // Keep the usual POS view limited to stocked items with a custom price.
      if (item.hasCustomPrice && item.sellingPrice !== null && parseFloat(item.quantity) > 0) {
        return true;
      }
      // "Show 0 Qty" also exposes priced items with no stock at this location.
      // The base-price fallback is valid here; unpriced items remain hidden.
      return showZeroQty && Number(item.quantity) === 0 && item.sellingPrice !== null && Number(item.sellingPrice) > 0;
    });
  }, [priceList, masterItems, posUser, isAllMode, showZeroQty]);

  const stockGroups = useMemo(() => {
    const groups = new Set<string>();
    locationPricedList.forEach((item) => {
      if (item.stockGroupName) groups.add(item.stockGroupName);
    });
    return Array.from(groups).sort();
  }, [locationPricedList]);

  const isItemUnpriced = useCallback(
    (item: PriceListRow): boolean => {
      if (isAllMode) {
        const hasBase = item.baseSellingPrice && parseFloat(item.baseSellingPrice) > 0;
        if (hasBase) return false; // base price covers all locations
        const masterPrices = "masterPrices" in item ? item.masterPrices : undefined;
        const allMasterPrices = masterPrices ? Object.values(masterPrices) : [];
        if (allMasterPrices.length === 0) return true;
        const allHavePrice = allMasterPrices.every((p) => p && parseFloat(p) > 0);
        return !allHavePrice; // unpriced until every location has a price
      }
      const sellingPrice = "sellingPrice" in item ? item.sellingPrice : undefined;
      return !sellingPrice || parseFloat(sellingPrice) === 0;
    },
    [isAllMode]
  );

  const unpricedCount = useMemo(
    () => locationPricedList.filter(isItemUnpriced).length,
    [locationPricedList, isItemUnpriced]
  );

  // Groups that have at least one unpriced item, with their counts — used for the chip picker
  const unpricedByGroup = useMemo<{ name: string; count: number }[]>(() => {
    if (!showUnpriced) return [];
    const map = new Map<string, number>();
    for (const item of locationPricedList) {
      if (!isItemUnpriced(item)) continue;
      const g = item.stockGroupName || "(No Group)";
      map.set(g, (map.get(g) || 0) + 1);
    }
    return Array.from(map.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [showUnpriced, locationPricedList, isItemUnpriced]);

  const itemQty = useCallback(
    (item: PriceListRow): number => {
      const rawQty = isAllMode ? item.totalQuantity : item.quantity;
      const parsed = Number(rawQty ?? 0);
      return Number.isFinite(parsed) ? parsed : 0;
    },
    [isAllMode]
  );

  const zeroQtyCount = useMemo(() => {
    if (posUser && !isAllMode) {
      // Count the additional zero-stock, priced rows even before they are shown.
      return priceList.filter(
        (item) => Number(item.quantity) === 0 && item.sellingPrice !== null && Number(item.sellingPrice) > 0
      ).length;
    }
    return locationPricedList.filter((item) => itemQty(item) === 0).length;
  }, [itemQty, locationPricedList, priceList, posUser, isAllMode]);

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    return locationPricedList.filter((item) => {
      const matchesSearch =
        !q ||
        item.name.toLowerCase().includes(q) ||
        (item.code && item.code.toLowerCase().includes(q)) ||
        (item.stockGroupName && item.stockGroupName.toLowerCase().includes(q));
      const matchesGroup = showUnpriced
        ? !hiddenUnpricedGroups.has(item.stockGroupName || "(No Group)")
        : groupFilter === "all" || item.stockGroupName === groupFilter;
      const matchesUnpriced = !showUnpriced || isItemUnpriced(item);
      const matchesQty = !hideZeroQty || itemQty(item) !== 0;
      return matchesSearch && matchesGroup && matchesUnpriced && matchesQty;
    });
  }, [
    search,
    locationPricedList,
    showUnpriced,
    hiddenUnpricedGroups,
    groupFilter,
    isItemUnpriced,
    hideZeroQty,
    itemQty,
  ]);

  const selectedLocation = locations.find((l) => l.id === selectedLocationId);

  const updatePriceMutation = useMutation({
    mutationFn: async ({
      stockItemId,
      locationId,
      sellingPrice,
    }: {
      stockItemId: number;
      locationId: number;
      sellingPrice: string;
    }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await apiRequest("POST", `/api/stock-items/${stockItemId}/location-prices`, {
        locationId,
        sellingPrice,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ message: "Failed to update price" }));
        throw new Error(body.message || "Failed to update price");
      }
      return res.json();
    },
    onSuccess: () => {
      if (isAllMode) {
        queryClient.invalidateQueries({ queryKey: ["/api/pos/price-list-by-masters"] });
      } else {
        queryClient.invalidateQueries({ queryKey: ["/api/pos/price-list", selectedLocationId] });
      }
      toast({ title: "Price updated" });
      const current = editingItemRef.current;
      const lastSaved = lastSavedRef.current;
      if (
        current &&
        lastSaved &&
        current.stockItemId === lastSaved.stockItemId &&
        current.locationId === lastSaved.locationId
      ) {
        setEditingItem(null);
      }
      lastSavedRef.current = null;
    },
    onError: (err: Error) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  const startEdit = (stockItemId: number, locationId: number, currentPrice: string | null | undefined) => {
    if (posUser || !recordChanges.allowed) return;
    lastSavedRef.current = null; // prevent onSuccess from clearing a re-opened edit
    const hasValue = currentPrice && parseFloat(currentPrice) > 0;
    setEditingItem({ stockItemId, locationId, value: hasValue ? currentPrice : "" });
  };

  /** Price shown for an item in a given master column (falls back to the base price). */
  const masterPriceFor = (item: PriceListRow, locationId: number): string | null =>
    item.masterPrices?.[locationId] ?? item.baseSellingPrice ?? null;

  const editCell = (stockItemId: number, locationId: number, price: string | null | undefined) => {
    const hasValue = price && parseFloat(price) > 0;
    setEditingItem({ stockItemId, locationId, value: hasValue ? price : "" });
  };

  const navigateEdit = (direction: "up" | "down") => {
    const current = editingItemRef.current;
    if (!current) return;
    const items = filteredItems;
    const idx = items.findIndex((i) => i.stockItemId === current.stockItemId);
    if (idx === -1) return;
    const nextIdx = direction === "up" ? idx - 1 : idx + 1;
    if (nextIdx < 0 || nextIdx >= items.length) return;
    const nextItem = items[nextIdx];
    const nextPrice = isAllMode ? masterPriceFor(nextItem, current.locationId) : nextItem.sellingPrice;
    editCell(nextItem.stockItemId, current.locationId, nextPrice);
  };

  const navigateHorizontal = (direction: "left" | "right") => {
    const current = editingItemRef.current;
    if (!current) return;
    if (!isAllMode) {
      // Single-location mode: left/right behaves like up/down
      navigateEdit(direction === "left" ? "up" : "down");
      return;
    }
    const items = filteredItems;
    const idx = items.findIndex((i) => i.stockItemId === current.stockItemId);
    if (idx === -1) return;
    const masterIdx = visibleMasters.findIndex((m) => m.id === current.locationId);
    if (masterIdx === -1) return;
    if (direction === "left") {
      if (masterIdx > 0) {
        const prevMaster = visibleMasters[masterIdx - 1];
        editCell(current.stockItemId, prevMaster.id, masterPriceFor(items[idx], prevMaster.id));
      } else if (idx > 0) {
        const prevItem = items[idx - 1];
        const lastMaster = visibleMasters[visibleMasters.length - 1];
        editCell(prevItem.stockItemId, lastMaster.id, masterPriceFor(prevItem, lastMaster.id));
      } else {
        return;
      }
    } else {
      // direction === "right"
      if (masterIdx < visibleMasters.length - 1) {
        const nextMaster = visibleMasters[masterIdx + 1];
        editCell(current.stockItemId, nextMaster.id, masterPriceFor(items[idx], nextMaster.id));
      } else if (idx < items.length - 1) {
        const nextItem = items[idx + 1];
        const firstMaster = visibleMasters[0];
        editCell(nextItem.stockItemId, firstMaster.id, masterPriceFor(nextItem, firstMaster.id));
      } else {
        return;
      }
    }
  };

  const commitEdit = (): boolean => {
    if (!editingItem || updatePriceMutation.isPending) return false;
    const val = editingItem.value.trim();
    if (!val || !Number.isFinite(Number(val)) || Number(val) < 0) {
      toast({ title: "Invalid price", description: "Enter a valid number.", variant: "destructive" });
      return false;
    }
    lastSavedRef.current = { stockItemId: editingItem.stockItemId, locationId: editingItem.locationId };
    updatePriceMutation.mutate({
      stockItemId: editingItem.stockItemId,
      locationId: editingItem.locationId,
      sellingPrice: val,
    });
    return true;
  };

  return {
    formatAmount,
    toast,
    recordChanges,
    selectedLocationId,
    setSelectedLocationId,
    search,
    setSearch,
    groupFilter,
    setGroupFilter,
    salesPeriod,
    setSalesPeriod,
    editingItem,
    setEditingItem,
    showUnpriced,
    setShowUnpriced,
    hideZeroQty,
    setHideZeroQty,
    showZeroQty,
    setShowZeroQty,
    hiddenUnpricedGroups,
    setHiddenUnpricedGroups,
    hiddenLocations,
    setHiddenLocations,
    inputRef,
    editingItemRef,
    lastSavedRef,
    skipBlurSaveRef,
    currentUser,
    isPrivileged,
    locations,
    locationsLoading,
    isAllMode,
    masters,
    masterItems,
    isLoading,
    isError,
    error,
    visibleMasters,
    locationPricedList,
    stockGroups,
    isItemUnpriced,
    unpricedCount,
    unpricedByGroup,
    zeroQtyCount,
    filteredItems,
    selectedLocation,
    updatePriceMutation,
    startEdit,
    masterPriceFor,
    navigateEdit,
    navigateHorizontal,
    commitEdit,
  };
}
