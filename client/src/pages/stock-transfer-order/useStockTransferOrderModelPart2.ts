// Extracted from ./useStockTransferOrderModel.tsx to keep that module under the source-size cap.
import { useCallback, useEffect } from "react";
import { getDefaultPeriodValue } from "@/components/ui/period-filter";
import type { OrderItem, StockItemData } from "../stocktransferorder/types";
import { DRAFT_KEY } from "../stocktransferorder/utils";
import { useMatrixRows, useSelectedLocations } from "./useMatrixDerived";
import { useStockTransferOrderModelPart1 } from "./useStockTransferOrderModelPart1";

export function useStockTransferOrderModelPart2({
  autosaveTimer,
  destinationLocationId,
  editDataLoaded,
  editVoucherId,
  existingTransfer,
  existingVoucher,
  expandedGroups,
  focusedCell,
  isOptional,
  locations,
  matrixRef,
  orderItems,
  prevDialogOpen,
  quantityInputRef,
  quantityPicker,
  selectedLocationIds,
  setAutosaveStatus,
  setDestinationLocationId,
  setEditDataLoaded,
  setExpandedGroups,
  setFocusedCell,
  setHasDraft,
  setHistoryDialogOpen,
  setHistoryItem,
  setHistoryLocation,
  setHistoryPeriod,
  setIsOptional,
  setOrderItems,
  setPickerQuantity,
  setQuantityPicker,
  setSelectedLocationIds,
  setTransferDate,
  stockItems,
  summaryData,
  toast,
  transferDate,
}: Pick<
  Awaited<ReturnType<typeof useStockTransferOrderModelPart1>>,
  | "autosaveTimer"
  | "destinationLocationId"
  | "editDataLoaded"
  | "editVoucherId"
  | "existingTransfer"
  | "existingVoucher"
  | "expandedGroups"
  | "focusedCell"
  | "isOptional"
  | "locations"
  | "matrixRef"
  | "orderItems"
  | "prevDialogOpen"
  | "quantityInputRef"
  | "quantityPicker"
  | "selectedLocationIds"
  | "setAutosaveStatus"
  | "setDestinationLocationId"
  | "setEditDataLoaded"
  | "setExpandedGroups"
  | "setFocusedCell"
  | "setHasDraft"
  | "setHistoryDialogOpen"
  | "setHistoryItem"
  | "setHistoryLocation"
  | "setHistoryPeriod"
  | "setIsOptional"
  | "setOrderItems"
  | "setPickerQuantity"
  | "setQuantityPicker"
  | "setSelectedLocationIds"
  | "setTransferDate"
  | "stockItems"
  | "summaryData"
  | "toast"
  | "transferDate"
>) {
  useEffect(() => {
    if (
      !editVoucherId ||
      !existingTransfer ||
      !existingVoucher ||
      locations.length === 0 ||
      stockItems.length === 0 ||
      editDataLoaded
    ) {
      return;
    }

    const destinationId = existingTransfer.destinationLocationId;
    if (destinationId) setDestinationLocationId(destinationId);

    if (existingTransfer.items?.length) {
      // Editing a transfer only needs the source locations that are actually
      // referenced by its items. Selecting every company location can turn the
      // inventory matrix into a very large grid and cause severe layout churn
      // and browser freezes while the edit form hydrates.
      const sourceLocationIds = Array.from(
        new Set(
          existingTransfer.items
            .map((item) => item.sourceLocationId)
            .filter((id): id is number => typeof id === "number" && id > 0)
        )
      );
      setSelectedLocationIds(sourceLocationIds);

      const preloaded: OrderItem[] = existingTransfer.items.map((item) => {
        const sourceLocation = locations.find((location) => location.id === item.sourceLocationId);
        const stockItem = stockItems.find((candidate) => candidate.id === item.stockItemId);
        return {
          stockItemId: item.stockItemId,
          stockItemName: stockItem?.name || "",
          stockItemCode: stockItem?.code || "",
          uom: stockItem?.uom || "",
          sourceLocationId: item.sourceLocationId ?? 0,
          sourceLocationName: sourceLocation?.name || "",
          quantity: parseFloat(String(item.quantity)) || 0,
          availableQty: parseFloat(String(item.quantity)) || 0,
          rate: parseFloat(String(item.rate ?? 0)) || 0,
        };
      });
      setOrderItems(preloaded);
    }

    setEditDataLoaded(true);
  }, [
    editVoucherId,
    existingTransfer,
    existingVoucher,
    locations,
    stockItems,
    editDataLoaded,
    setDestinationLocationId,
    setEditDataLoaded,
    setOrderItems,
    setSelectedLocationIds,
  ]);

  useEffect(() => {
    if (editVoucherId !== null) return;
    try {
      const saved = localStorage.getItem(DRAFT_KEY);
      if (!saved) return;
      const draft = JSON.parse(saved) as {
        orderItems?: OrderItem[];
        destinationLocationId?: number | null;
      };
      if (draft.orderItems?.length || draft.destinationLocationId) setHasDraft(true);
    } catch {
      // Draft restoration is best effort only.
    }
  }, [editVoucherId, setHasDraft]);

  useEffect(() => {
    if (editVoucherId !== null) return;
    if (!destinationLocationId && orderItems.length === 0) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);

    autosaveTimer.current = setTimeout(() => {
      setAutosaveStatus("saving");
      try {
        localStorage.setItem(
          DRAFT_KEY,
          JSON.stringify({
            destinationLocationId,
            orderItems,
            transferDate: transferDate.toISOString(),
            isOptional,
            savedAt: new Date().toISOString(),
          })
        );
        setAutosaveStatus("saved");
      } catch {
        setAutosaveStatus("failed");
      }
    }, 800);

    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
  }, [destinationLocationId, orderItems, transferDate, isOptional, editVoucherId, autosaveTimer, setAutosaveStatus]);

  const restoreDraft = async () => {
    try {
      const saved = localStorage.getItem(DRAFT_KEY);
      if (!saved) return;
      const draft = JSON.parse(saved) as {
        destinationLocationId?: number | null;
        orderItems?: OrderItem[];
        transferDate?: string;
        isOptional?: boolean;
      };
      if (draft.destinationLocationId) setDestinationLocationId(draft.destinationLocationId);
      if (draft.orderItems) setOrderItems(draft.orderItems);
      if (draft.transferDate) setTransferDate(new Date(draft.transferDate));
      if (draft.isOptional !== undefined) setIsOptional(draft.isOptional);
      setHasDraft(false);
      toast({ title: "Draft restored" });
    } catch {
      toast({ title: "Could not restore draft", variant: "destructive" });
    }
  };

  const discardDraft = async () => {
    localStorage.removeItem(DRAFT_KEY);
    setHasDraft(false);
  };

  useEffect(() => {
    if (prevDialogOpen.current && !quantityPicker.open) {
      requestAnimationFrame(() => matrixRef.current?.focus({ preventScroll: true }));
    }
    prevDialogOpen.current = quantityPicker.open;
  }, [quantityPicker.open, matrixRef, prevDialogOpen]);

  useEffect(() => {
    if (focusedCell === null) return;
    matrixRef.current?.querySelector('[data-focused="true"]')?.scrollIntoView({
      block: "nearest",
      behavior: "instant",
    });
  }, [focusedCell, matrixRef]);

  const selectedLocations = useSelectedLocations(locations, selectedLocationIds);
  const availableDestinations = locations;

  const toggleGroup = async (groupId: number) => {
    setExpandedGroups((previous) => {
      const next = new Set(previous);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const toggleLocation = async (locationId: number) => {
    setSelectedLocationIds((previous) =>
      previous.includes(locationId) ? previous.filter((id) => id !== locationId) : [...previous, locationId]
    );
  };

  const sortOrderItems = (items: OrderItem[]): OrderItem[] =>
    [...items].sort((left, right) => left.sourceLocationName.localeCompare(right.sourceLocationName));

  const { sortedGroupItems, flatItems, flatRowIndexById } = useMatrixRows(summaryData, expandedGroups);

  const openQuantityPicker = useCallback(
    (item: StockItemData, locationId: number, locationName: string, availableQty: number) => {
      if (availableQty <= 0) {
        toast({
          title: "No Stock",
          description: `${item.name} has no available stock at ${locationName}`,
          variant: "destructive",
        });
        return;
      }

      setQuantityPicker({ open: true, stockItem: item, locationId, locationName, availableQty });
      setPickerQuantity("");
      setTimeout(() => quantityInputRef.current?.focus(), 100);
    },
    [toast, quantityInputRef, setPickerQuantity, setQuantityPicker]
  );

  const handleMatrixKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (quantityPicker.open || flatItems.length === 0 || selectedLocations.length === 0) return;
      const { key } = event;
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " ", "Enter"].includes(key)) return;
      event.preventDefault();

      if (key === "Enter" && focusedCell !== null) {
        const item = flatItems[focusedCell.row];
        const location = selectedLocations[focusedCell.col];
        if (item && location) {
          setHistoryItem(item);
          setHistoryLocation(location);
          setHistoryPeriod(getDefaultPeriodValue("this_year"));
          setHistoryDialogOpen(true);
        }
        return;
      }

      setFocusedCell((current) => {
        const maxRow = flatItems.length - 1;
        const maxCol = selectedLocations.length - 1;
        if (current === null) return { row: 0, col: 0 };

        let { row, col } = current;
        switch (key) {
          case "ArrowUp":
            row = Math.max(0, row - 1);
            break;
          case "ArrowDown":
            row = Math.min(maxRow, row + 1);
            break;
          case "ArrowLeft":
            col = Math.max(0, col - 1);
            break;
          case "ArrowRight":
            col = Math.min(maxCol, col + 1);
            break;
          case " ": {
            const item = flatItems[row];
            const location = selectedLocations[col];
            if (item && location) {
              const quantity = item.locationData[location.id]?.quantity || 0;
              if (quantity > 0) openQuantityPicker(item, location.id, location.name, quantity);
            }
            return current;
          }
        }
        return { row, col };
      });
    },
    [
      flatItems,
      selectedLocations,
      quantityPicker.open,
      openQuantityPicker,
      focusedCell,
      setFocusedCell,
      setHistoryDialogOpen,
      setHistoryItem,
      setHistoryLocation,
      setHistoryPeriod,
    ]
  );

  const handleCellClick = async (item: StockItemData, locationId: number, locationName: string, availableQty: number) =>
    openQuantityPicker(item, locationId, locationName, availableQty);
  return {
    availableDestinations,
    discardDraft,
    flatRowIndexById,
    handleCellClick,
    handleMatrixKeyDown,
    restoreDraft,
    selectedLocations,
    sortOrderItems,
    sortedGroupItems,
    toggleGroup,
    toggleLocation,
  };
}
