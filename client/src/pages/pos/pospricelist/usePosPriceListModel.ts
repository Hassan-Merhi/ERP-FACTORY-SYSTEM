import { getErrorDetails } from "@shared/errorUtils";
/**
 * Controller hook for the POS Price List page.
 *
 * Owns the location selection (including the synthetic "All Locations" master
 * mode), the two price-list queries, the unpriced detection and filtering, the
 * inline price editor with its keyboard grid navigation, and the Excel
 * template/export/import flows.
 */
import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useToast } from "@/hooks/use-toast";
import type {
  Location,
  MasterItem,
  MasterPriceListResponse,
  POSPriceListProps,
  PriceListItem,
  PriceListRow,
} from "./types";
import { ALL_LOCATIONS_ID } from "./utils";

const PRIVILEGED_ROLES = ["Admin", "Owner", "Manager", "Developer"];

export type ImportPreviewRow = {
  barcode: string;
  name: string;
  changes: { locationId: number; locationName: string; price: string }[];
};

export function usePosPriceListModel({ posUser }: POSPriceListProps) {
  const { formatAmount } = useCurrencyContext();
  const { toast } = useToast();
  const [selectedLocationId, setSelectedLocationId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState<string>("all");
  const [editingItem, setEditingItem] = useState<{ stockItemId: number; locationId: number; value: string } | null>(
    null
  );
  const [showUnpriced, setShowUnpriced] = useState(false);
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
    queryKey: ["/api/pos/price-list", selectedLocationId],
    queryFn: async () => {
      const res = await fetch(`/api/pos/price-list?locationId=${selectedLocationId}`, {
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
    return priceList.filter(
      (item) => item.hasCustomPrice && item.sellingPrice !== null && parseFloat(item.quantity) > 0
    );
  }, [priceList, masterItems, posUser, isAllMode]);

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
      return matchesSearch && matchesGroup && matchesUnpriced;
    });
  }, [search, locationPricedList, showUnpriced, hiddenUnpricedGroups, groupFilter, isItemUnpriced]);

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
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const startEdit = (stockItemId: number, locationId: number, currentPrice: string | null | undefined) => {
    if (posUser) return;
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

  const commitEdit = () => {
    if (!editingItem) return;
    const val = editingItem.value.trim();
    if (!val || isNaN(parseFloat(val))) {
      toast({ title: "Invalid price", description: "Enter a valid number.", variant: "destructive" });
      return;
    }
    lastSavedRef.current = { stockItemId: editingItem.stockItemId, locationId: editingItem.locationId };
    updatePriceMutation.mutate({
      stockItemId: editingItem.stockItemId,
      locationId: editingItem.locationId,
      sellingPrice: val,
    });
  };

  const cancelEdit = () => setEditingItem(null);

  const handleKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
      return;
    }
    const vertical = e.key === "ArrowUp" ? "up" : e.key === "ArrowDown" ? "down" : null;
    if (vertical) {
      e.preventDefault();
      skipBlurSaveRef.current = true;
      commitEdit();
      navigateEdit(vertical);
      return;
    }
    const horizontal = e.key === "ArrowLeft" ? "left" : e.key === "ArrowRight" ? "right" : null;
    if (horizontal) {
      e.preventDefault();
      skipBlurSaveRef.current = true;
      commitEdit();
      navigateHorizontal(horizontal);
    }
  };

  const handleBlur = () => {
    if (skipBlurSaveRef.current) {
      skipBlurSaveRef.current = false;
      return;
    }
    const current = editingItemRef.current;
    if (!current) return;
    const val = current.value.trim();
    if (!val || isNaN(parseFloat(val))) {
      cancelEdit();
      return;
    }
    lastSavedRef.current = { stockItemId: current.stockItemId, locationId: current.locationId };
    updatePriceMutation.mutate({
      stockItemId: current.stockItemId,
      locationId: current.locationId,
      sellingPrice: val,
    });
  };

  const canEdit = !posUser;
  const showCostPrice = (isPrivileged || currentUser?.role === "View Only") && !posUser;

  const [exporting, setExporting] = useState(false);

  // ── Import state ─────────────────────────────────────────────────────────────
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importPreview, setImportPreview] = useState<ImportPreviewRow[]>([]);
  const [importError, setImportError] = useState<string | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);

  const downloadTemplate = async () => {
    if (!isAllMode || masters.length === 0) return;
    const XLSX = await import("@/lib/excelHelper");
    const rows = masterItems.map((item: MasterItem) => {
      const row: Record<string, unknown> = {
        Code: item.code || "",
        "Item Name": item.name,
        Group: item.stockGroupName || "",
      };
      for (const m of masters) {
        const price = masterPriceFor(item, m.id);
        row[m.name] = price && parseFloat(price) > 0 ? parseFloat(price) : "";
      }
      return row;
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Price List");
    const dateStr = new Date().toLocaleDateString("en-CA");
    await XLSX.writeFile(wb, `price_list_template_${dateStr}.xlsx`);
  };

  const handleImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setImportError(null);
    try {
      const { read, utils } = await import("@/lib/excelHelper");
      const wb = await read(file);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rawRows = utils.sheet_to_json(ws, { defval: "" });
      if (rawRows.length === 0) {
        toast({ title: "Empty file", description: "The file has no data rows.", variant: "destructive" });
        return;
      }

      // Build locationName → locationId map from current masters
      const nameToId = new Map<string, number>();
      for (const m of masters) nameToId.set(m.name.toLowerCase().trim(), m.id);
      const locationCols = Object.keys(rawRows[0]).filter((col) => nameToId.has(col.toLowerCase().trim()));
      if (locationCols.length === 0) {
        toast({
          title: "No location columns found",
          description: "Make sure you're uploading the template downloaded from this page.",
          variant: "destructive",
        });
        return;
      }

      const preview: ImportPreviewRow[] = [];
      for (const row of rawRows) {
        const barcode = String(row["Code"] || "").trim();
        const name = String(row["Item Name"] || "").trim();
        if (!barcode) continue;
        const changes: { locationId: number; locationName: string; price: string }[] = [];
        for (const col of locationCols) {
          const raw = row[col];
          const parsed = parseFloat(String(raw));
          if (!isNaN(parsed) && parsed > 0) {
            changes.push({
              locationId: nameToId.get(col.toLowerCase().trim())!,
              locationName: col,
              price: parsed.toFixed(2),
            });
          }
        }
        if (changes.length > 0) preview.push({ barcode, name, changes });
      }
      if (preview.length === 0) {
        toast({
          title: "No prices to update",
          description: "All price cells in the file are blank. Fill in at least one price and try again.",
          variant: "destructive",
        });
        return;
      }
      setImportPreview(preview);
      setImportDialogOpen(true);
    } catch (err) {
      toast({
        title: "Could not read file",
        description: getErrorDetails(err).optionalMessage || "Make sure it is a valid .xlsx file.",
        variant: "destructive",
      });
    }
  };

  const handleImportSubmit = async () => {
    if (importPreview.length === 0) return;
    setImporting(true);
    try {
      const prices: { barcode: string; sellingPrice: string; locationId: number }[] = [];
      for (const item of importPreview) {
        for (const c of item.changes) {
          prices.push({ barcode: item.barcode, sellingPrice: c.price, locationId: c.locationId });
        }
      }
      const res = await apiRequest("POST", "/api/stock-items/bulk-update-prices", { prices });
      const data = await res.json();
      toast({ title: "Price list uploaded", description: data.message || `Updated ${importPreview.length} items.` });
      setImportDialogOpen(false);
      setImportPreview([]);
      queryClient.invalidateQueries({ queryKey: ["/api/pos/price-list-by-masters"] });
      queryClient.invalidateQueries({ queryKey: ["/api/pos/price-list", selectedLocationId] });
    } catch (err) {
      toast({
        title: "Upload failed",
        description: getErrorDetails(err).message || "Something went wrong.",
        variant: "destructive",
      });
    } finally {
      setImporting(false);
    }
  };

  const closeImportDialog = () => {
    setImportDialogOpen(false);
    setImportPreview([]);
  };

  const openImportFilePicker = () => {
    setImportError(null);
    importFileRef.current?.click();
  };

  const exportToExcel = async () => {
    if (filteredItems.length === 0) return;
    setExporting(true);
    try {
      const XLSX = await import("@/lib/excelHelper");

      const rows = filteredItems.map((item) => {
        const row: Record<string, unknown> = {
          Code: item.code || "",
          "Item Name": item.name,
          Group: item.stockGroupName || "",
        };

        if (showCostPrice) {
          row["Cost Price"] = item.costPrice && parseFloat(item.costPrice) > 0 ? parseFloat(item.costPrice) : "";
          const offloadTotal = parseFloat(item.costPrice ?? "0") + parseFloat(item.offloadingCost ?? "0");
          row["Cost + Offloading"] = offloadTotal > 0 ? offloadTotal : "";
        }

        if (isAllMode) {
          for (const m of masters) {
            const price = masterPriceFor(item, m.id);
            row[m.name] = price && parseFloat(price) > 0 ? parseFloat(price) : "";
          }
        } else {
          row["Selling Price"] =
            item.sellingPrice && parseFloat(item.sellingPrice) > 0
              ? parseFloat(item.sellingPrice)
              : item.baseSellingPrice && parseFloat(item.baseSellingPrice) > 0
                ? parseFloat(item.baseSellingPrice)
                : "";
          row["Qty in Stock"] = item.quantity && parseFloat(item.quantity) > 0 ? parseFloat(item.quantity) : "";
        }

        return row;
      });

      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Price List");

      const locationLabel = isAllMode ? "All_Locations" : (selectedLocation?.name.replace(/\s+/g, "_") ?? "Unknown");
      const dateStr = new Date().toLocaleDateString("en-CA");
      const filterPart = showUnpriced
        ? "_unpriced"
        : groupFilter !== "all"
          ? `_${groupFilter.replace(/\s+/g, "_")}`
          : "";
      const searchPart = search.trim() ? `_search-${search.trim().replace(/\s+/g, "_")}` : "";

      await XLSX.writeFile(wb, `price_list_${locationLabel}${filterPart}${searchPart}_${dateStr}.xlsx`);
    } finally {
      setExporting(false);
    }
  };

  const selectLocation = (id: number) => {
    setSelectedLocationId(id);
    setSearch("");
    setGroupFilter("all");
    setEditingItem(null);
    setShowUnpriced(false);
    setHiddenUnpricedGroups(new Set());
  };

  const clearFilters = () => {
    setSearch("");
    setGroupFilter("all");
    setShowUnpriced(false);
    setHiddenUnpricedGroups(new Set());
  };

  const toggleUnpriced = () => {
    setShowUnpriced((v) => !v);
    setHiddenUnpricedGroups(new Set());
    setGroupFilter("all");
  };

  const toggleHiddenLocation = (id: number) =>
    setHiddenLocations((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleHiddenUnpricedGroup = (name: string) =>
    setHiddenUnpricedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return {
    posUser,
    canEdit,
    showCostPrice,
    formatAmount,
    // locations
    locations,
    locationsLoading,
    selectedLocationId,
    selectedLocation,
    selectLocation,
    isAllMode,
    masters,
    visibleMasters,
    hiddenLocations,
    setHiddenLocations,
    toggleHiddenLocation,
    // data
    isLoading,
    isError,
    error,
    locationPricedList,
    filteredItems,
    stockGroups,
    isItemUnpriced,
    unpricedCount,
    unpricedByGroup,
    masterPriceFor,
    // filters
    search,
    setSearch,
    groupFilter,
    setGroupFilter,
    showUnpriced,
    toggleUnpriced,
    hiddenUnpricedGroups,
    setHiddenUnpricedGroups,
    toggleHiddenUnpricedGroup,
    clearFilters,
    // inline editing
    editingItem,
    setEditingItem,
    inputRef,
    startEdit,
    commitEdit,
    cancelEdit,
    handleKeyDown,
    handleBlur,
    updatePriceMutation,
    // excel
    exporting,
    exportToExcel,
    downloadTemplate,
    importFileRef,
    openImportFilePicker,
    handleImportFile,
    handleImportSubmit,
    closeImportDialog,
    importDialogOpen,
    setImportDialogOpen,
    importing,
    importPreview,
    importError,
  };
}

export type PosPriceListModel = ReturnType<typeof usePosPriceListModel>;
