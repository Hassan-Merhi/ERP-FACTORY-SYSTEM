// Extracted from ./useStockTransferOrderModel.tsx to keep that module under the source-size cap.
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { getDefaultPeriodValue, type PeriodFilterValue } from "@/components/ui/period-filter";
import { useToast } from "@/hooks/use-toast";
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
import { SESSION_STATE_KEY, STORAGE_KEY } from "../stocktransferorder/utils";

export function isGloballyHandledError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_handledGlobally" in error &&
    (error as { _handledGlobally?: boolean })._handledGlobally === true
  );
}

export function useStockTransferOrderModelPart1() {
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
  return {
    autosaveStatus,
    autosaveTimer,
    destinationLocationId,
    detailData,
    detailDirection,
    detailLoading,
    detailMonth,
    detailMonthName,
    detailOpen,
    detailYear,
    editDataLoaded,
    editVoucherId,
    existingTransfer,
    existingVoucher,
    expandedGroups,
    focusedCell,
    formatAmount,
    hasDraft,
    historyData,
    historyDialogOpen,
    historyItem,
    historyLoading,
    historyLocation,
    historyPeriod,
    isLoading,
    isOptional,
    isProcessing,
    locationDialogOpen,
    locations,
    matrixRef,
    mobileQty,
    mobileSearchTerm,
    mobileSelectedItemId,
    mobileSheetOpen,
    mobileSourceLocationId,
    navigate,
    orderItems,
    pickerQuantity,
    prevDialogOpen,
    quantityInputRef,
    quantityPicker,
    revisions,
    revisionsExpanded,
    selectedCompany,
    selectedLocationIds,
    setAutosaveStatus,
    setDestinationLocationId,
    setDetailDirection,
    setDetailMonth,
    setDetailMonthName,
    setDetailOpen,
    setDetailYear,
    setEditDataLoaded,
    setExpandedGroups,
    setFocusedCell,
    setHasDraft,
    setHistoryDialogOpen,
    setHistoryItem,
    setHistoryLocation,
    setHistoryPeriod,
    setIsOptional,
    setIsProcessing,
    setLocationDialogOpen,
    setMobileQty,
    setMobileSearchTerm,
    setMobileSelectedItemId,
    setMobileSheetOpen,
    setMobileSourceLocationId,
    setOrderItems,
    setPickerQuantity,
    setQuantityPicker,
    setRevisionsExpanded,
    setSelectedLocationIds,
    setTransferDate,
    setValidationErrors,
    stockItems,
    summaryData,
    toast,
    transferDate,
    validationErrors,
  };
}
