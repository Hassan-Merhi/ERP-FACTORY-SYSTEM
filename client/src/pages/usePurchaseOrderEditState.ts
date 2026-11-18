// Extracted from ./PurchaseOrderEdit.tsx to keep that module under the source-size cap.
import { searchAny } from "@shared/searchNormalization";
import type { ClientErrorLike } from "@/lib/clientError";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation, useRoute } from "wouter";
import { useBackToParent } from "@/hooks/use-back-to-parent";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useToast } from "@/hooks/use-toast";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCompany } from "@/contexts/CompanyContext";
import { focusScopedTestId } from "@/lib/scopedFocus";
import type { LineItem, PurchaseOrder, StockItem } from "./purchaseorderedit/types";

export function usePurchaseOrderEditState() {
  const [, params] = useRoute("/purchase-orders/:id/edit");
  const [, navigate] = useLocation();
  const handleBack = useBackToParent();
  const { toast } = useToast();
  const poId = params?.id ? parseInt(params.id) : null;
  useEscapeToParent("/containers");
  const { selectedCompany } = useCompany();
  const isFactory = selectedCompany?.companyType === "factory" || selectedCompany?.companyType === "factory_v2";

  const [poNumber, setPoNumber] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [status, setStatus] = useState("Open");
  const [items, setItems] = useState<LineItem[]>([]);
  const [freight, setFreight] = useState("0");
  const [surcharge, setSurcharge] = useState("0");
  const [fumigation, setFumigation] = useState("0");
  const [documentCharges, setDocumentCharges] = useState("0");
  const [discount, setDiscount] = useState("0");
  const [otherCharges, setOtherCharges] = useState("0");
  const [freightPaidBy, setFreightPaidBy] = useState<"supplier" | "own" | "parent">("supplier");
  const [freightOwnAccountId, setFreightOwnAccountId] = useState<number | null>(null);
  const [freightParentAccountId, setFreightParentAccountId] = useState<number | null>(null);

  const [showItemSidebar, setShowItemSidebar] = useState(false);
  const [activeRow, setActiveRow] = useState<number | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [sidebarTop, setSidebarTop] = useState(0);
  const focusIdRef = useRef(0);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const { data: stockItems } = useQuery<StockItem[]>({
    queryKey: ["/api/stock-items/light", selectedCompany?.id],
    staleTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
  });

  const {
    data: po,
    isLoading,
    error,
  } = useQuery<PurchaseOrder>({
    queryKey: [`/api/purchase-orders/${poId}`],
    enabled: !!poId,
  });

  const { data: ledgerAccounts } = useQuery<Array<{ id: number; name: string }>>({
    queryKey: ["/api/ledger-accounts?profile=picker"],
    enabled: isFactory,
  });

  const { data: parentFreightAccounts } = useQuery<
    Array<{ id: number; name: string; code: string; accountType: string }>
  >({
    queryKey: companyQueryKey("/api/purchase-orders/parent-freight-accounts", selectedCompany?.id),
    retry: false,
    enabled: Boolean(selectedCompany?.id) && !isFactory,
  });

  const isNew = poId === null;
  const {
    data: nextPoData,
    refetch: refetchNextPo,
    isFetching: isFetchingNextPo,
  } = useQuery<{ poNumber: string }>({
    queryKey: ["/api/purchase-orders/next-po-number"],
    enabled: isNew,
    staleTime: 15000,
  });

  useEffect(() => {
    if (isNew && nextPoData?.poNumber && !poNumber) setPoNumber(nextPoData.poNumber);
  }, [isNew, nextPoData, poNumber]);

  useEffect(() => {
    if (!po) return;
    setPoNumber(po.poNumber);
    setCurrency(po.currency);
    setStatus(po.status);
    setItems(
      po.items.map((item) => ({
        id: item.id,
        stockItemId: item.stockItemId,
        itemName: item.itemName,
        quantity: item.quantity,
        rate: po.currency === "ZMW" ? (item.nativeRate ?? "") : item.rate,
        lineTotal: po.currency === "ZMW" ? (item.nativeLineTotal ?? "") : item.lineTotal,
      }))
    );
    setFreight((po.currency === "ZMW" ? po.nativeFreight : po.freight) || "0");
    setSurcharge((po.currency === "ZMW" ? po.nativeSurcharge : po.surcharge) || "0");
    setFumigation((po.currency === "ZMW" ? po.nativeFumigation : po.fumigation) || "0");
    setDocumentCharges((po.currency === "ZMW" ? po.nativeDocumentCharges : po.documentCharges) || "0");
    setDiscount((po.currency === "ZMW" ? po.nativeDiscount : po.discount) || "0");
    setOtherCharges((po.currency === "ZMW" ? po.nativeOtherCharges : po.otherCharges) || "0");
    setFreightPaidBy((po.freightPaidBy as "supplier" | "own" | "parent") || "supplier");
    setFreightOwnAccountId(po.freightOwnAccountId ?? null);
    setFreightParentAccountId(po.freightParentAccountId ?? null);
  }, [po]);

  const updateMutation = useMutation({
    mutationFn: async (data: {
      poNumber: string;
      currency: string;
      status: string;
      items: LineItem[];
      freight: string;
      surcharge: string;
      fumigation: string;
      documentCharges: string;
      discount: string;
      otherCharges: string;
      freightPaidBy?: string;
      freightOwnAccountId?: number | null;
      freightParentAccountId?: number | null;
    }) => apiRequest("PATCH", `/api/purchase-orders/${poId}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/containers"] });
      if (po?.containerId) queryClient.invalidateQueries({ queryKey: [`/api/containers/${po.containerId}`] });
      toast({ title: "Purchase Order Updated", description: "The purchase order has been updated successfully." });
      navigate("/daybook");
    },
    onError: (mutationError: ClientErrorLike) => {
      if (mutationError?._handledGlobally) return;
      toast({
        title: "Update Failed",
        description: mutationError.message || "Failed to update purchase order",
        variant: "destructive",
      });
    },
  });

  const syncParentJvMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", `/api/purchase-orders/${poId}/sync-parent-voucher`, {});
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/daybook"] });
      if (po?.containerId) {
        queryClient.invalidateQueries({ queryKey: [`/api/containers/${po.containerId}`] });
        queryClient.invalidateQueries({ queryKey: [`/api/containers/${po.containerId}/sync-voucher`] });
      }
      toast({
        title: data?.found ? "Parent JV Synced" : "No Parent JV Found",
        description:
          data?.message ??
          (data?.found ? `Updated to ${data?.intercoTotal}` : "No INTERCO-PARENT voucher exists for this PO"),
        variant: data?.found ? "default" : "destructive",
      });
    },
    onError: (mutationError: ClientErrorLike) => {
      if (mutationError?._handledGlobally) return;
      toast({
        title: "Sync Failed",
        description: mutationError.message || "Failed to sync parent journal voucher",
        variant: "destructive",
      });
    },
  });

  const handleAddItem = useCallback(() => {
    setItems((previous) => [...previous, { stockItemId: null, itemName: "", quantity: "1", rate: "0" }]);
  }, []);

  const handleRemoveItem = useCallback((index: number) => {
    setItems((previous) => previous.filter((_, itemIndex) => itemIndex !== index));
  }, []);

  const handleItemChange = useCallback(
    (index: number, field: keyof LineItem, value: string | number | null, stockItem?: StockItem) => {
      setItems((previous) => {
        const nextItems = [...previous];
        const existingItem = nextItems[index];
        if (field === "stockItemId") {
          const numericId = typeof value === "string" ? parseInt(value, 10) : value;
          const foundItem = stockItem || stockItems?.find((candidate) => candidate.id === numericId);
          if (foundItem) {
            nextItems[index] = { ...existingItem, stockItemId: foundItem.id, itemName: foundItem.name };
          } else {
            nextItems[index] = {
              ...existingItem,
              stockItemId: typeof numericId === "number" && !isNaN(numericId) ? numericId : existingItem.stockItemId,
            };
          }
        } else {
          nextItems[index] = { ...existingItem, [field]: value };
        }
        return nextItems;
      });
    },
    [stockItems]
  );

  const lineTotals = useMemo(
    () =>
      items.map((item) => {
        const quantity = parseFloat(item.quantity) || 0;
        const rate = parseFloat(item.rate) || 0;
        return (quantity * rate).toFixed(2);
      }),
    [items]
  );

  const itemsTotal = useMemo(
    () => lineTotals.reduce((sum, total) => sum + parseFloat(total), 0).toFixed(2),
    [lineTotals]
  );

  const chargesTotal = useMemo(() => {
    const freightAmount = parseFloat(freight) || 0;
    const surchargeAmount = parseFloat(surcharge) || 0;
    const fumigationAmount = parseFloat(fumigation) || 0;
    const documentChargesAmount = parseFloat(documentCharges) || 0;
    const discountAmount = parseFloat(discount) || 0;
    const otherChargesAmount = parseFloat(otherCharges) || 0;
    return (
      freightAmount +
      surchargeAmount +
      fumigationAmount +
      documentChargesAmount -
      discountAmount +
      otherChargesAmount
    ).toFixed(2);
  }, [freight, surcharge, fumigation, documentCharges, discount, otherCharges]);

  const grandTotal = useMemo(
    () => (parseFloat(itemsTotal) + parseFloat(chargesTotal)).toFixed(2),
    [itemsTotal, chargesTotal]
  );
  const priceSymbol = currency === "ZMW" ? "K" : "$";
  const totalQuantity = useMemo(() => items.reduce((sum, item) => sum + (parseFloat(item.quantity) || 0), 0), [items]);

  const stockItemsList = useMemo(() => (stockItems || []) as StockItem[], [stockItems]);
  const filteredStockItems = useMemo(() => {
    if (!searchTerm.trim()) return stockItemsList.slice(0, 100);
    return stockItemsList.filter((item) => searchAny(searchTerm, item.name, item.code)).slice(0, 100);
  }, [stockItemsList, searchTerm]);

  const handleSelectItem = useCallback(
    (stockItem: StockItem) => {
      if (activeRow === null) return;
      const rowIndex = activeRow;
      handleItemChange(rowIndex, "stockItemId", stockItem.id, stockItem);
      setShowItemSidebar(false);
      setSearchTerm("");
      setActiveRow(null);
      focusScopedTestId(`input-quantity-${rowIndex}`, {
        select: true,
        delay: 50,
        anchor: containerRef.current,
      });
    },
    [activeRow, handleItemChange]
  );

  const handleSave = () => {
    if (!poNumber.trim()) {
      toast({ title: "Validation Error", description: "PO Number is required", variant: "destructive" });
      return;
    }
    if (items.length === 0) {
      toast({ title: "Validation Error", description: "At least one line item is required", variant: "destructive" });
      return;
    }
    if (isFactory && freightPaidBy === "own" && parseFloat(freight) > 0 && !freightOwnAccountId) {
      toast({
        title: "Account Required",
        description: "Select an account for the freight payment.",
        variant: "destructive",
      });
      return;
    }
    if (freightPaidBy === "parent" && parseFloat(freight) > 0 && !freightParentAccountId) {
      toast({
        title: "Account Required",
        description: "Select a parent company account for the freight.",
        variant: "destructive",
      });
      return;
    }

    updateMutation.mutate({
      poNumber,
      currency,
      status,
      items: items.map((item) => ({
        id: item.id,
        stockItemId: item.stockItemId,
        itemName: item.itemName,
        quantity: item.quantity,
        rate: item.rate,
      })),
      freight,
      surcharge,
      fumigation,
      documentCharges,
      discount,
      otherCharges,
      freightPaidBy,
      freightOwnAccountId: freightPaidBy === "own" ? freightOwnAccountId : null,
      freightParentAccountId: freightPaidBy === "parent" ? freightParentAccountId : null,
    });
  };
  return {
    activeRow,
    chargesTotal,
    containerRef,
    currency,
    discount,
    documentCharges,
    error,
    filteredStockItems,
    focusIdRef,
    freight,
    freightOwnAccountId,
    freightPaidBy,
    freightParentAccountId,
    fumigation,
    grandTotal,
    handleAddItem,
    handleBack,
    handleItemChange,
    handleRemoveItem,
    handleSave,
    handleSelectItem,
    highlightedIndex,
    isFactory,
    isFetchingNextPo,
    isLoading,
    isNew,
    items,
    itemsTotal,
    ledgerAccounts,
    lineTotals,
    navigate,
    otherCharges,
    parentFreightAccounts,
    po,
    poNumber,
    priceSymbol,
    refetchNextPo,
    searchTerm,
    setActiveRow,
    setCurrency,
    setDiscount,
    setDocumentCharges,
    setFreight,
    setFreightOwnAccountId,
    setFreightPaidBy,
    setFreightParentAccountId,
    setFumigation,
    setHighlightedIndex,
    setOtherCharges,
    setPoNumber,
    setSearchTerm,
    setShowItemSidebar,
    setSidebarTop,
    setStatus,
    setSurcharge,
    showItemSidebar,
    sidebarRef,
    sidebarTop,
    status,
    surcharge,
    syncParentJvMutation,
    totalQuantity,
    updateMutation,
  };
}
