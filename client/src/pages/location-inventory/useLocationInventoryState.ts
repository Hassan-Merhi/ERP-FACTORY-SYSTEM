import { getErrorDetails } from "@shared/errorUtils";
import { useState, useRef, useEffect } from "react";
import { useLocation } from "@/contexts/LocationContext";
import { queryClient } from "@/lib/queryClient";
import { apiRequest } from "@/lib/queryClient";
import { getDefaultPeriodValue } from "@/components/ui/period-filter";
import type {
  InventoryLocation as Location,
  StockGroupSummary,
  StockMovementItem,
  StockMovementMonth,
  StockMovementPeriod,
} from "./locationInventoryTypes";

interface UseLocationInventoryStateParams {
  companyId: number | undefined;
  toast: (opts: { title: string; description?: string; variant?: "destructive" | "default" }) => void;
}

export function useLocationInventoryState({ companyId, toast }: UseLocationInventoryStateParams) {
  const { setSelectedLocation } = useLocation();

  // ─── Main view state ──────────────────────────────────────────────────────
  const [selectedLocationLocal, setSelectedLocationLocal] = useState<Location | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<StockGroupSummary | null>(null);
  const [selectedRowIndex, setSelectedRowIndex] = useState<number>(0);
  const [viewAllItems, setViewAllItems] = useState<boolean>(false);
  const [locationSearchTerm, setLocationSearchTerm] = useState("");
  const [groupSearchTerm, setGroupSearchTerm] = useState("");
  const [itemSearchTerm, setItemSearchTerm] = useState("");
  const [asOfDate, setAsOfDate] = useState<string>("");
  const [fromDate, setFromDate] = useState<string>("");
  const [showNegativeStock, setShowNegativeStock] = useState(false);
  const [showZeroStock, setShowZeroStock] = useState(false);
  const [negativeSearchTerm, setNegativeSearchTerm] = useState("");
  const [showAllStock, setShowAllStock] = useState(false);
  const [allStockGroupFilter, setAllStockGroupFilter] = useState<string>("");
  const [allStockSearchTerm, setAllStockSearchTerm] = useState("");
  const [allStockLocationFilter, setAllStockLocationFilter] = useState<string>("");
  const [allStockCategoryFilter, setAllStockCategoryFilter] = useState<string[]>([]);
  const [itemCategoryFilter, setItemCategoryFilter] = useState<string[]>([]);
  const [groupCategoryFilter, setGroupCategoryFilter] = useState<string>("");
  const tableRef = useRef<HTMLDivElement>(null);
  const [allStockSelectedRowIndex, setAllStockSelectedRowIndex] = useState<number>(-1);
  const [stockMovementOpen, setStockMovementOpen] = useState(false);
  const [stockMovementItem, setStockMovementItem] = useState<StockMovementItem | null>(null);
  const [stockMovementPeriod, setStockMovementPeriod] = useState<StockMovementPeriod>(() =>
    getDefaultPeriodValue("this_month")
  );
  const [drillMonth, setDrillMonth] = useState<StockMovementMonth | null>(null);
  const allStockTableRef = useRef<HTMLDivElement>(null);

  // Keep the shared location context aligned with the Location Inventory page so
  // header-level actions can safely target the exact location currently open.
  useEffect(() => {
    setSelectedLocation(selectedLocationLocal);
  }, [selectedLocationLocal, setSelectedLocation]);

  // ─── Dialog state ─────────────────────────────────────────────────────────
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renamingLocation, setRenamingLocation] = useState<Location | null>(null);
  const [renameInput, setRenameInput] = useState("");
  const [renameDeductionInput, setRenameDeductionInput] = useState("");
  const [waGroupDialogOpen, setWaGroupDialogOpen] = useState(false);
  const [waGroupLocation, setWaGroupLocation] = useState<Location | null>(null);
  const [waGroupSearch, setWaGroupSearch] = useState("");
  const [waGroupSelectedId, setWaGroupSelectedId] = useState<string>("");
  const [createLocationOpen, setCreateLocationOpen] = useState(false);
  const [createLocationName, setCreateLocationName] = useState("");

  // ─── Company-change reset ─────────────────────────────────────────────────
  useEffect(() => {
    setSelectedLocationLocal(null);
    setSelectedGroup(null);
    setViewAllItems(false);
    setLocationSearchTerm("");
    setGroupSearchTerm("");
    setItemSearchTerm("");
    queryClient.invalidateQueries({ queryKey: ["/api/locations"] });
    // The full inventory query key already includes companyId — React Query
    // uses a different cache entry automatically when the company changes,
    // so no manual invalidation is needed here (it would only cause a
    // redundant 1.2 MB refetch for every company switch).
    queryClient.invalidateQueries({ queryKey: ["/api/stock-categories"] });
  }, [companyId]);

  // ─── Dialog openers ───────────────────────────────────────────────────────
  const openRenameDialog = (loc: Location, e?: { stopPropagation: () => void }) => {
    e?.stopPropagation();
    setRenamingLocation(loc);
    setRenameInput(loc.name);
    setRenameDeductionInput(parseFloat(String(loc.supplierPartnerPayableDeductionPerQty ?? "0")).toString());
    setRenameDialogOpen(true);
  };

  const openWaGroupDialog = (loc: Location, e?: { stopPropagation: () => void }) => {
    e?.stopPropagation();
    setWaGroupLocation(loc);
    setWaGroupSelectedId(loc.whatsappGroupChatId ?? "");
    setWaGroupSearch("");
    setWaGroupDialogOpen(true);
  };

  // ─── Action handlers ──────────────────────────────────────────────────────
  const handleDeleteLocation = async () => {
    if (!selectedLocationLocal) return;
    setIsDeleting(true);
    try {
      await apiRequest("DELETE", `/api/locations/${selectedLocationLocal.id}`);
      queryClient.invalidateQueries({ queryKey: ["/api/locations"] });
      toast({ title: "Location Deleted", description: `${selectedLocationLocal.name} deleted` });
      setSelectedLocationLocal(null);
      setDeleteDialogOpen(false);
    } catch (error) {
      toast({ title: "Delete Failed", description: getErrorDetails(error).message, variant: "destructive" });
    } finally {
      setIsDeleting(false);
    }
  };

  const handleArchiveStockGroup = async () => {
    if (!selectedLocationLocal || !selectedGroup) return;
    setIsArchiving(true);
    try {
      await apiRequest("POST", "/api/stock-group-archives", {
        locationId: selectedLocationLocal.id,
        stockGroupId: selectedGroup.groupId,
      });
      queryClient.invalidateQueries({ queryKey: [`/api/locations/${selectedLocationLocal.id}/inventory`] });
      toast({ title: "Stock Group Archived" });
      setSelectedGroup(null);
      setArchiveDialogOpen(false);
    } catch (error) {
      toast({ title: "Archive Failed", description: getErrorDetails(error).message, variant: "destructive" });
    } finally {
      setIsArchiving(false);
    }
  };

  const goBackToLocations = () => {
    setSelectedLocationLocal(null);
    setSelectedGroup(null);
    setViewAllItems(false);
    setGroupSearchTerm("");
    setItemSearchTerm("");
    setGroupCategoryFilter("");
  };

  return {
    // View state
    selectedLocationLocal,
    setSelectedLocationLocal,
    selectedGroup,
    setSelectedGroup,
    selectedRowIndex,
    setSelectedRowIndex,
    viewAllItems,
    setViewAllItems,
    locationSearchTerm,
    setLocationSearchTerm,
    groupSearchTerm,
    setGroupSearchTerm,
    itemSearchTerm,
    setItemSearchTerm,
    asOfDate,
    setAsOfDate,
    fromDate,
    setFromDate,
    showNegativeStock,
    setShowNegativeStock,
    showZeroStock,
    setShowZeroStock,
    negativeSearchTerm,
    setNegativeSearchTerm,
    showAllStock,
    setShowAllStock,
    allStockGroupFilter,
    setAllStockGroupFilter,
    allStockSearchTerm,
    setAllStockSearchTerm,
    allStockLocationFilter,
    setAllStockLocationFilter,
    allStockCategoryFilter,
    setAllStockCategoryFilter,
    itemCategoryFilter,
    setItemCategoryFilter,
    groupCategoryFilter,
    setGroupCategoryFilter,
    tableRef,
    allStockSelectedRowIndex,
    setAllStockSelectedRowIndex,
    stockMovementOpen,
    setStockMovementOpen,
    stockMovementItem,
    setStockMovementItem,
    stockMovementPeriod,
    setStockMovementPeriod,
    drillMonth,
    setDrillMonth,
    allStockTableRef,
    // Dialog state
    deleteDialogOpen,
    setDeleteDialogOpen,
    isDeleting,
    archiveDialogOpen,
    setArchiveDialogOpen,
    isArchiving,
    renameDialogOpen,
    setRenameDialogOpen,
    renamingLocation,
    renameInput,
    setRenameInput,
    renameDeductionInput,
    setRenameDeductionInput,
    waGroupDialogOpen,
    setWaGroupDialogOpen,
    waGroupLocation,
    waGroupSearch,
    setWaGroupSearch,
    waGroupSelectedId,
    setWaGroupSelectedId,
    createLocationOpen,
    setCreateLocationOpen,
    createLocationName,
    setCreateLocationName,
    // Handlers
    openRenameDialog,
    openWaGroupDialog,
    handleDeleteLocation,
    handleArchiveStockGroup,
    goBackToLocations,
  };
}
