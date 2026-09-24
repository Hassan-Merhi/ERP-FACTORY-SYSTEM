import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { useLocation } from "wouter";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { getDefaultPeriodValue, type PeriodFilterValue } from "@/components/ui/period-filter";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatNumber } from "@/lib/formatNumber";
import type {
  ExistingStockTransfer,
  ExistingVoucherHeader,
  Location,
  LocationSummaryResponse,
  OrderItem,
  QuantityPickerState,
  StockItemData,
  StockItemOption,
  StockTransferRevision,
} from "../stocktransferorder/types";
import { DRAFT_KEY, SESSION_STATE_KEY, STORAGE_KEY } from "../stocktransferorder/utils";
import { useMatrixRows, useSelectedLocations } from "./useMatrixDerived";
import { exportStockTransferOrderWorkbook } from "./exportStockTransferOrderWorkbook";
import { useMobileOrderItemAdder } from "./useMobileOrderItemAdder";
import { useStockTransferOrderWorkflows } from "./useStockTransferOrderWorkflows";

function isGloballyHandledError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_handledGlobally" in error &&
    (error as { _handledGlobally?: boolean })._handledGlobally === true
  );
}

export function useStockTransferOrderModel() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const { formatAmount } = useCurrencyContext();

  const editVoucherId = (() => {
    const params = new URLSearchParams(window.location.search);
    const value = params.get("edit");
    return value ? parseInt(value) : null;
  })();

  const [selectedLocationIds, setSelectedLocationIds] = useState<number[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const sessionSnapshot = (() => {
    if (editVoucherId !== null) return null;
    try {
      const saved = sessionStorage.getItem(SESSION_STATE_KEY);
      if (saved) {
        sessionStorage.removeItem(SESSION_STATE_KEY);
        return JSON.parse(saved) as {
          expandedGroups?: number[];
          destinationLocationId?: number | null;
          orderItems?: OrderItem[];
        };
      }
    } catch {
      // Session restoration is a convenience only.
    }
    return null;
  })();

  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(
    () => new Set<number>(sessionSnapshot?.expandedGroups || [])
  );
  const [locationDialogOpen, setLocationDialogOpen] = useState(false);
  const [destinationLocationId, setDestinationLocationId] = useState<number | null>(
    () => sessionSnapshot?.destinationLocationId ?? null
  );
  const [orderItems, setOrderItems] = useState<OrderItem[]>(() => sessionSnapshot?.orderItems || []);
  const [quantityPicker, setQuantityPicker] = useState<QuantityPickerState>({
    open: false,
    stockItem: null,
    locationId: 0,
    locationName: "",
    availableQty: 0,
  });
  const [pickerQuantity, setPickerQuantity] = useState("");
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [transferDate, setTransferDate] = useState<Date>(new Date());
  const [isOptional, setIsOptional] = useState(false);
  const [editDataLoaded, setEditDataLoaded] = useState(false);

  const quantityInputRef = useRef<HTMLInputElement>(null);
  const matrixRef = useRef<HTMLDivElement>(null);
  const [focusedCell, setFocusedCell] = useState<{ row: number; col: number } | null>(null);
  const prevDialogOpen = useRef(false);

  const [autosaveStatus, setAutosaveStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [hasDraft, setHasDraft] = useState(false);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [revisionsExpanded, setRevisionsExpanded] = useState(false);

  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const [mobileSearchTerm, setMobileSearchTerm] = useState("");
  const [mobileSourceLocationId, setMobileSourceLocationId] = useState<number | null>(null);
  const [mobileQty, setMobileQty] = useState("");
  const [mobileSelectedItemId, setMobileSelectedItemId] = useState<number | null>(null);

  const [historyDialogOpen, setHistoryDialogOpen] = useState(false);
  const [historyItem, setHistoryItem] = useState<StockItemData | null>(null);
  const [historyLocation, setHistoryLocation] = useState<Location | null>(null);
  const [historyPeriod, setHistoryPeriod] = useState<PeriodFilterValue>(() => getDefaultPeriodValue("this_year"));

  const [detailOpen, setDetailOpen] = useState(false);
  const [detailYear, setDetailYear] = useState(new Date().getFullYear());
  const [detailMonth, setDetailMonth] = useState(0);
  const [detailMonthName, setDetailMonthName] = useState("");
  const [detailDirection, setDetailDirection] = useState<"in" | "out">("out");

  const { data: locations = [] } = useQuery<Location[]>({ queryKey: ["/api/locations"] });

  const { data: historyData, isLoading: historyLoading } = useQuery<unknown>({
    queryKey: [
      "/api/locations",
      historyLocation?.id,
      "stock-items",
      historyItem?.id,
      "monthly-summary",
      { startDate: historyPeriod.fromDate, endDate: historyPeriod.toDate },
    ],
    queryFn: async () => {
      const response = await fetch(
        `/api/locations/${historyLocation!.id}/stock-items/${historyItem!.id}/monthly-summary?startDate=${historyPeriod.fromDate}&endDate=${historyPeriod.toDate}`,
        { credentials: "include" }
      );
      if (!response.ok) throw new Error("Failed to fetch history");
      return response.json();
    },
    enabled: historyDialogOpen && !!historyItem && !!historyLocation,
  });

  const { data: detailData, isLoading: detailLoading } = useQuery<unknown>({
    queryKey: [
      "/api/locations",
      historyLocation?.id,
      "stock-items",
      historyItem?.id,
      "monthly-detail",
      { year: detailYear, month: detailMonth },
    ],
    queryFn: async () => {
      const response = await fetch(
        `/api/locations/${historyLocation!.id}/stock-items/${historyItem!.id}/monthly-detail?year=${detailYear}&month=${detailMonth}`,
        { credentials: "include" }
      );
      if (!response.ok) throw new Error("Failed to fetch detail");
      return response.json();
    },
    enabled: detailOpen && !!historyItem && !!historyLocation && detailMonth > 0,
  });

  const { data: existingTransfer } = useQuery<ExistingStockTransfer | undefined>({
    queryKey: ["/api/stock-transfers", editVoucherId],
    queryFn: async () => {
      const response = await fetch(`/api/stock-transfers?voucherId=${editVoucherId}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to fetch transfer");
      const data = (await response.json()) as ExistingStockTransfer | ExistingStockTransfer[];
      return Array.isArray(data) ? data[0] : data;
    },
    enabled: !!editVoucherId,
  });

  const { data: existingVoucher } = useQuery<ExistingVoucherHeader | undefined>({
    queryKey: ["/api/vouchers", editVoucherId],
    queryFn: async () => {
      const response = await fetch(`/api/vouchers/${editVoucherId}`, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch voucher");
      return (await response.json()) as ExistingVoucherHeader;
    },
    enabled: !!editVoucherId,
  });

  const { data: stockItems = [] } = useQuery<StockItemOption[]>({
    queryKey: ["/api/stock-items/light", selectedCompany?.id],
    staleTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
  });

  const { data: revisions = [] } = useQuery<StockTransferRevision[]>({
    queryKey: ["/api/stock-transfers", existingTransfer?.id, "revisions"],
    queryFn: async () => {
      const response = await fetch(`/api/stock-transfers/${existingTransfer!.id}/revisions`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to fetch revisions");
      return (await response.json()) as StockTransferRevision[];
    },
    enabled: !!existingTransfer?.id,
  });

  const { data: summaryData, isLoading } = useQuery<LocationSummaryResponse>({
    queryKey: ["/api/location-summary", { locationIds: selectedLocationIds.join(",") }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (selectedLocationIds.length > 0) {
        params.append("locationIds", selectedLocationIds.join(","));
      }
      const response = await fetch(`/api/location-summary?${params.toString()}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to fetch location summary");
      return response.json();
    },
    enabled: selectedLocationIds.length > 0,
  });

  useEffect(() => {
    if (!editVoucherId) localStorage.setItem(STORAGE_KEY, JSON.stringify(selectedLocationIds));
  }, [selectedLocationIds, editVoucherId]);

  useEffect(() => {
    if (!editVoucherId || !existingVoucher) return;
    if (existingVoucher.voucherDate) {
      const parts = existingVoucher.voucherDate.split("-");
      if (parts.length === 3) {
        setTransferDate(new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2])));
      } else {
        setTransferDate(new Date(existingVoucher.voucherDate));
      }
    }
    setIsOptional(existingVoucher.optional === true);
  }, [editVoucherId, existingVoucher]);

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
  }, [editVoucherId, existingTransfer, existingVoucher, locations, stockItems, editDataLoaded]);

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
  }, [editVoucherId]);

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
  }, [destinationLocationId, orderItems, transferDate, isOptional, editVoucherId]);

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
  }, [quantityPicker.open]);

  useEffect(() => {
    if (focusedCell === null) return;
    matrixRef.current?.querySelector('[data-focused="true"]')?.scrollIntoView({
      block: "nearest",
      behavior: "instant",
    });
  }, [focusedCell]);

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
    [toast]
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
    [flatItems, selectedLocations, quantityPicker.open, openQuantityPicker, focusedCell]
  );

  const handleCellClick = async (item: StockItemData, locationId: number, locationName: string, availableQty: number) =>
    openQuantityPicker(item, locationId, locationName, availableQty);

  const handleAddToOrder = async () => {
    const quantity = parseFloat(pickerQuantity);
    if (isNaN(quantity) || quantity === 0) {
      toast({
        title: "Invalid Quantity",
        description: "Please enter a non-zero quantity",
        variant: "destructive",
      });
      return;
    }

    const { stockItem, locationId, locationName, availableQty } = quantityPicker;
    if (!stockItem) return;

    const existingIndex = orderItems.findIndex(
      (item) => item.stockItemId === stockItem.id && item.sourceLocationId === locationId
    );
    const currentAllocated = existingIndex >= 0 ? orderItems[existingIndex].quantity : 0;
    const totalAfterAdd = currentAllocated + quantity;

    if (totalAfterAdd < 0) {
      toast({
        title: "Invalid Quantity",
        description: `Cannot reduce below 0. Current order quantity is ${formatNumber(currentAllocated, 0)}.`,
        variant: "destructive",
      });
      return;
    }

    if (quantity > 0 && totalAfterAdd > availableQty) {
      toast({
        title: "Exceeds Available Stock",
        description: `You can only add up to ${formatNumber(availableQty - currentAllocated, 0)} more units. Available: ${formatNumber(availableQty, 0)}, Already in order: ${formatNumber(currentAllocated, 0)}`,
        variant: "destructive",
      });
      return;
    }

    let updatedItems: OrderItem[];
    if (existingIndex >= 0) {
      updatedItems = [...orderItems];
      updatedItems[existingIndex] = { ...updatedItems[existingIndex], quantity: totalAfterAdd };
    } else {
      const locationData = stockItem.locationData[locationId];
      updatedItems = [
        ...orderItems,
        {
          stockItemId: stockItem.id,
          stockItemName: stockItem.name,
          stockItemCode: stockItem.code,
          uom: stockItem.uom,
          sourceLocationId: locationId,
          sourceLocationName: locationName,
          quantity,
          availableQty,
          rate: locationData?.rate || 0,
        },
      ];
    }

    setOrderItems(sortOrderItems(updatedItems));
    setQuantityPicker({ ...quantityPicker, open: false });
    toast({
      title: "Added to Order",
      description: `${formatNumber(quantity, 0)} ${stockItem.uom} of ${stockItem.name} added`,
    });
  };

  const removeFromOrder = async (index: number) => {
    setOrderItems(orderItems.filter((_, itemIndex) => itemIndex !== index));
  };

  const handleMobileAddItem = useMobileOrderItemAdder({
    mobileSelectedItemId,
    mobileSourceLocationId,
    mobileQty,
    stockItems,
    locations,
    summaryData,
    orderItems,
    setOrderItems,
    setMobileQty,
    setMobileSelectedItemId,
    setMobileSheetOpen,
  });

  const validateOrder = (): string[] => {
    const errors: string[] = [];
    if (!destinationLocationId) errors.push("Please select a destination location");
    if (orderItems.length === 0) errors.push("Order is empty. Please add items to transfer");

    for (const item of orderItems) {
      if (item.quantity > item.availableQty) {
        errors.push(
          `${item.stockItemName} from ${item.sourceLocationName}: Requested ${formatNumber(item.quantity, 0)} but only ${formatNumber(item.availableQty, 0)} available`
        );
      }
      if (item.sourceLocationId === destinationLocationId) {
        errors.push(`${item.stockItemName}: Source and destination cannot be the same location`);
      }
    }
    return errors;
  };

  const handleValidate = async () => {
    const errors = validateOrder();
    setValidationErrors(errors);
    toast(
      errors.length === 0
        ? { title: "Validation Passed", description: "Order is ready to process" }
        : {
            title: "Validation Failed",
            description: `Found ${errors.length} issue(s) that need to be fixed`,
            variant: "destructive",
          }
    );
  };

  const handleExportOrder = async (includeCost: boolean) => {
    if (orderItems.length === 0) {
      toast({
        title: "No data to export",
        description: "Add items to the order before exporting.",
        variant: "destructive",
      });
      return;
    }

    const result = await exportStockTransferOrderWorkbook({
      orderItems,
      locations,
      destinationLocationId,
      transferDate,
      companyName: selectedCompany?.name || "ETS",
      includeCost,
    });
    toast({
      title: "Export successful",
      description: `Downloaded ${result.fileName} with ${result.itemCount} items.`,
    });
  };

  const processOrderMutation = useMutation({
    mutationFn: async (data: {
      orderItems: OrderItem[];
      destinationLocationId: number;
      voucherDate: string;
      optional: boolean;
    }) => {
      if (editVoucherId && existingTransfer?.id) {
        const wasOptional = existingVoucher?.optional === true;
        const wantOptional = data.optional;
        const isFinalizingTransfer = wasOptional && !wantOptional;
        const persistedDescription =
          existingTransfer.notes?.trim() ||
          existingVoucher?.description?.trim() ||
          `Stock Transfer Order - ${data.orderItems.length} items`;
        await apiRequest("PATCH", `/api/vouchers/${editVoucherId}`, {
          voucherDate: data.voucherDate,
          description: persistedDescription,
          ...(wantOptional ? { optional: true } : {}),
        });
        const response = await apiRequest("PUT", `/api/stock-transfers/${existingTransfer.id}`, {
          destinationLocationId: data.destinationLocationId,
          notes: persistedDescription,
          items: data.orderItems.map((item) => ({
            stockItemId: item.stockItemId,
            sourceLocationId: item.sourceLocationId,
            quantity: item.quantity,
            rate: item.rate,
          })),
        });
        if (isFinalizingTransfer) {
          await apiRequest("POST", `/api/vouchers/${editVoucherId}/finalize`, {});
        }
        return response.json();
      }

      const response = await apiRequest("POST", "/api/stock-transfers", {
        destinationLocationId: data.destinationLocationId,
        notes: `Stock Transfer Order - ${data.orderItems.length} items`,
        voucherDate: data.voucherDate,
        optional: data.optional,
        items: data.orderItems.map((item) => ({
          stockItemId: item.stockItemId,
          sourceLocationId: item.sourceLocationId,
          quantity: item.quantity.toString(),
        })),
      });
      return response.json();
    },
    onSuccess: () => {
      localStorage.removeItem(DRAFT_KEY);
      setAutosaveStatus("idle");
      toast({
        title: editVoucherId ? "Order Updated" : "Order Processed",
        description: editVoucherId
          ? "Successfully updated stock transfer voucher"
          : "Successfully created stock transfer voucher",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-transfers", editVoucherId] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory-by-location"] });
      queryClient.invalidateQueries({ queryKey: ["/api/location-summary"] });
      if (editVoucherId) navigate("/daybook");
    },
    onError: (error: unknown) => {
      if (isGloballyHandledError(error)) return;
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to process order",
        variant: "destructive",
      });
    },
  });

  const workflows = useStockTransferOrderWorkflows({
    editVoucherId,
    existingTransfer,
    existingDescription: existingVoucher?.description,
    locations,
    stockItems,
    orderItems,
    setOrderItems,
    summaryData,
    destinationLocationId,
    transferDate,
    isOptional,
    revisionCount: revisions.length,
    validateOrder,
    setValidationErrors,
  });

  const handleProcessOrder = async () => {
    const errors = validateOrder();
    if (errors.length > 0) {
      setValidationErrors(errors);
      toast({
        title: "Cannot Process",
        description: "Please fix validation errors first",
        variant: "destructive",
      });
      return;
    }
    if (!destinationLocationId) return;

    setIsProcessing(true);
    try {
      await processOrderMutation.mutateAsync({
        orderItems,
        destinationLocationId,
        voucherDate: format(transferDate, "yyyy-MM-dd"),
        optional: isOptional,
      });
      if (!editVoucherId) setOrderItems([]);
      setValidationErrors([]);
    } finally {
      setIsProcessing(false);
    }
  };

  const totalBales = orderItems.reduce((sum, item) => sum + item.quantity, 0);

  return {
    navigate,
    editVoucherId,
    selectedLocationIds,
    setSelectedLocationIds,
    expandedGroups,
    locationDialogOpen,
    setLocationDialogOpen,
    destinationLocationId,
    setDestinationLocationId,
    orderItems,
    quantityPicker,
    setQuantityPicker,
    pickerQuantity,
    setPickerQuantity,
    validationErrors,
    isProcessing,
    transferDate,
    setTransferDate,
    isOptional,
    setIsOptional,
    quantityInputRef,
    matrixRef,
    focusedCell,
    setFocusedCell,
    autosaveStatus,
    hasDraft,
    revisionsExpanded,
    setRevisionsExpanded,
    mobileSheetOpen,
    setMobileSheetOpen,
    mobileSearchTerm,
    setMobileSearchTerm,
    mobileSourceLocationId,
    setMobileSourceLocationId,
    mobileQty,
    setMobileQty,
    mobileSelectedItemId,
    setMobileSelectedItemId,
    historyDialogOpen,
    setHistoryDialogOpen,
    historyItem,
    historyLocation,
    historyPeriod,
    setHistoryPeriod,
    detailOpen,
    setDetailOpen,
    detailYear,
    setDetailYear,
    detailMonth,
    setDetailMonth,
    detailMonthName,
    setDetailMonthName,
    detailDirection,
    setDetailDirection,
    locations,
    historyData,
    historyLoading,
    detailData,
    detailLoading,
    existingTransfer,
    stockItems,
    revisions,
    summaryData,
    isLoading,
    formatAmount,
    selectedLocations,
    availableDestinations,
    sortedGroupItems,
    flatRowIndexById,
    toggleGroup,
    toggleLocation,
    handleMatrixKeyDown,
    handleCellClick,
    handleAddToOrder,
    removeFromOrder,
    handleMobileAddItem,
    restoreDraft,
    discardDraft,
    handleValidate,
    handleExportOrder,
    handleProcessOrder,
    totalBales,
    ...workflows,
  };
}
