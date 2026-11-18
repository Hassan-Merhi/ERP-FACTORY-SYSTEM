// Extracted from ./CreditNoteTab.tsx to keep that module under the source-size cap.
import { searchAny } from "@shared/searchNormalization";
import type { ClientErrorLike } from "@/lib/clientError";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { format } from "date-fns";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useCompany } from "@/contexts/CompanyContext";
import {
  creditNoteSchema,
  nextCreditNoteRowKey,
  type CreditNoteData,
  type CreditNoteFormData,
  type CreditNoteItem,
  type CreditNoteTabProps,
  type InventoryItem,
  type Location,
  type StockItem,
} from "./CreditNoteTabTypes";

export function useCreditNoteTabState({ allAccounts, editVoucherId }: CreditNoteTabProps) {
  const { toast } = useToast();
  const { selectedCurrency, displayCurrency } = useCurrencyContext();
  const { selectedCompany } = useCompany();
  const [items, setItems] = useState<CreditNoteItem[]>([]);
  const [selectedLocationId, setSelectedLocationId] = useState<number>(0);
  const [searchTerm, setSearchTerm] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [itemQuantity, setItemQuantity] = useState("1");
  const [refundRate, setRefundRate] = useState("");
  const [isEditMode, setIsEditMode] = useState(false);
  const [editingVoucherId, setEditingVoucherId] = useState<number | null>(null);
  const itemListRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const form = useForm<CreditNoteFormData>({
    resolver: zodResolver(creditNoteSchema),
    defaultValues: {
      noteType: "Credit Note",
      voucherDate: format(new Date(), "yyyy-MM-dd"),
      cashAccountType: "",
      cashAccountId: 0,
      cashAccountName: "",
      description: "",
    },
  });

  const { data: locations = [] } = useQuery<Location[]>({
    queryKey: ["/api/locations"],
  });

  const { data: allStockItems = [] } = useQuery<StockItem[]>({
    queryKey: ["/api/stock-items/light"],
    staleTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
  });

  const { data: locationInventory = [] } = useQuery<InventoryItem[]>({
    queryKey: selectedLocationId ? ["/api/locations", selectedLocationId, "inventory"] : [],
    enabled: selectedLocationId > 0,
  });

  const { data: editData, isLoading: editLoading } = useQuery<CreditNoteData>({
    queryKey: editVoucherId ? ["/api/credit-notes", editVoucherId] : [],
    enabled: !!editVoucherId,
  });

  const noteCurrency = isEditMode
    ? editData?.voucher?.currency === "ZMW"
      ? "ZMW"
      : "USD"
    : selectedCurrency === "ZMW" && displayCurrency === "ZMW"
      ? "ZMW"
      : "USD";
  // Currency changes must never reinterpret prices already entered in the
  // credit-note cart. New notes clear those prices; edits retain the original
  // voucher's locked currency and exchange rate.
  const previousNoteCurrency = useRef(noteCurrency);
  useEffect(() => {
    if (isEditMode) return;
    if (previousNoteCurrency.current !== noteCurrency) {
      previousNoteCurrency.current = noteCurrency;
      setItems([]);
      setRefundRate("");
    }
  }, [noteCurrency, isEditMode]);

  const noteDate = form.watch("voucherDate");
  const { data: datedZmwRate, isFetching: isFetchingNoteRate } = useQuery<{ rate: string } | null>({
    queryKey: ["/api/exchange-rates/latest", selectedCompany?.id, "USD", "ZMW", noteDate, "credit-note"],
    queryFn: async () => {
      const query = new URLSearchParams({
        companyId: String(selectedCompany!.id),
        fromCurrency: "USD",
        toCurrency: "ZMW",
        asOf: noteDate,
      });
      const res = await fetch("/api/exchange-rates/latest?" + query.toString(), { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!selectedCompany?.id && noteCurrency === "ZMW" && !isEditMode && !!noteDate,
    staleTime: 0,
  });
  const savedNoteRate = Number(editData?.voucher?.exchangeRate);
  const datedNoteRate = Number(datedZmwRate?.rate);
  const noteRate =
    noteCurrency === "ZMW"
      ? isEditMode
        ? Number.isFinite(savedNoteRate) && savedNoteRate > 0
          ? savedNoteRate
          : null
        : !isFetchingNoteRate && datedZmwRate && Number.isFinite(datedNoteRate) && datedNoteRate > 0
          ? datedNoteRate
          : null
      : null;

  useEffect(() => {
    if (editData && editVoucherId && !isEditMode) {
      setIsEditMode(true);
      setEditingVoucherId(editVoucherId);

      form.reset({
        noteType: editData.voucher.voucherType as "Credit Note" | "Debit Note",
        voucherDate: editData.voucher.voucherDate,
        cashAccountType: editData.cashAccountType,
        cashAccountId: editData.cashAccountId,
        cashAccountName: "",
        description: editData.voucher.description || "",
      });

      const firstLocationId = editData.items[0]?.locationId || 0;
      setSelectedLocationId(firstLocationId);

      const loadedItems: CreditNoteItem[] = editData.items.map((item, index) => ({
        rowKey: `existing-${editVoucherId}-${index}-${item.stockItemId}-${item.locationId}`,
        stockItemId: item.stockItemId,
        stockItemName: item.stockItemName,
        locationId: item.locationId,
        locationName: item.locationName,
        quantity: item.quantity,
        refundRate:
          editData.voucher.currency === "ZMW" && Number(editData.voucher.exchangeRate) > 0
            ? (Number(item.refundRate) * Number(editData.voucher.exchangeRate)).toFixed(2)
            : item.refundRate,
        inventoryCost: item.inventoryCost || "0",
        uom: item.uom,
      }));
      setItems(loadedItems);
    }
  }, [editData, editVoucherId, isEditMode, form]);

  const inventoryMap = useMemo(() => {
    const map = new Map<number, { quantity: number; rate: number }>();
    for (const inv of locationInventory) {
      map.set(inv.stockItemId, {
        quantity: parseFloat(inv.quantity || "0"),
        rate: parseFloat(inv.averageRate || "0"),
      });
    }
    return map;
  }, [locationInventory]);

  const itemsWithStock = useMemo(() => {
    return allStockItems.map((item) => {
      const inv = inventoryMap.get(item.id);
      return {
        ...item,
        stockQty: inv?.quantity || 0,
        avgRate: inv?.rate || 0,
      };
    });
  }, [allStockItems, inventoryMap]);

  const filteredItems = useMemo(() => {
    if (searchTerm.length === 0) return itemsWithStock;
    return itemsWithStock.filter((item) => searchAny(searchTerm, item.name, item.code));
  }, [itemsWithStock, searchTerm]);

  useEffect(() => {
    setHighlightedIndex(0);
  }, [searchTerm, selectedLocationId]);

  useEffect(() => {
    const list = itemListRef.current;
    if (!list) return;
    const highlighted = list.querySelector(`[data-index="${highlightedIndex}"]`) as HTMLElement | null;
    if (!highlighted) return;
    const itemTop = highlighted.offsetTop;
    const itemBottom = itemTop + highlighted.offsetHeight;
    const visibleTop = list.scrollTop;
    const visibleBottom = visibleTop + list.clientHeight;
    if (itemTop < visibleTop) list.scrollTop = itemTop;
    else if (itemBottom > visibleBottom) list.scrollTop = itemBottom - list.clientHeight;
  }, [highlightedIndex]);

  const createCreditNoteMutation = useMutation({
    mutationFn: async (data: {
      noteType: string;
      voucherDate: string;
      cashAccountId: number;
      cashAccountType: string;
      description: string;
      currency?: string;
      exchangeRate?: string;
      items: Array<{
        stockItemId: number;
        locationId: number;
        quantity: string;
        refundRate: string;
        originalCurrencyRate?: string;
        inventoryCost: string;
      }>;
    }) => {
      const response = await apiRequest("POST", "/api/credit-notes", data);
      return response.json();
    },
    onSuccess: (data) => {
      toast({ title: "Created", description: data.message || "Credit/Debit note created successfully" });
      resetForm();
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/locations", selectedLocationId, "inventory"] });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({
        title: "Save failed",
        description: error.message || "Failed to create credit/debit note",
        variant: "destructive",
      });
    },
  });

  const updateCreditNoteMutation = useMutation({
    mutationFn: async (data: {
      voucherDate: string;
      cashAccountId: number;
      cashAccountType: string;
      description: string;
      items: Array<{
        stockItemId: number;
        locationId: number;
        quantity: string;
        refundRate: string;
        inventoryCost: string;
      }>;
    }) => {
      const response = await apiRequest("PATCH", `/api/credit-notes/${editingVoucherId}`, data);
      return response.json();
    },
    onSuccess: (data) => {
      toast({ title: "Updated", description: data.message || "Credit/Debit note updated successfully" });
      resetForm();
      window.history.pushState({}, "", "/vouchers?tab=credit-note");
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/locations", selectedLocationId, "inventory"] });
      queryClient.invalidateQueries({ queryKey: ["/api/credit-notes", editingVoucherId] });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({
        title: "Update failed",
        description: error.message || "Failed to update credit/debit note",
        variant: "destructive",
      });
    },
  });

  const resetForm = () => {
    form.reset({
      noteType: "Credit Note",
      voucherDate: format(new Date(), "yyyy-MM-dd"),
      cashAccountType: "",
      cashAccountId: 0,
      cashAccountName: "",
      description: "",
    });
    setItems([]);
    setItemQuantity("1");
    setRefundRate("");
    setSearchTerm("");
    setIsEditMode(false);
    setEditingVoucherId(null);
  };

  const addItemToCart = useCallback(
    (item: (typeof itemsWithStock)[0]) => {
      if (!selectedLocationId) {
        toast({ title: "No location selected", description: "Please select a location first", variant: "destructive" });
        return;
      }
      const qty = parseFloat(itemQuantity);
      const rate =
        parseFloat(refundRate) || (noteCurrency === "ZMW" && noteRate ? item.avgRate * noteRate : item.avgRate);
      if (isNaN(qty) || qty <= 0) {
        toast({ title: "Invalid quantity", description: "Please enter a valid quantity", variant: "destructive" });
        return;
      }
      const location = locations.find((candidate) => candidate.id === selectedLocationId);
      if (!location) return;
      setItems((previous) => [
        ...previous,
        {
          rowKey: nextCreditNoteRowKey(`item-${item.id}-${selectedLocationId}`),
          stockItemId: item.id,
          stockItemName: item.name,
          locationId: selectedLocationId,
          locationName: location.name,
          quantity: qty.toString(),
          refundRate: rate.toFixed(2),
          inventoryCost: item.avgRate.toFixed(2),
          uom: item.uom,
        },
      ]);
      setItemQuantity("1");
      setRefundRate("");
      searchInputRef.current?.focus();
    },
    [itemQuantity, locations, refundRate, selectedLocationId, toast, noteCurrency, noteRate]
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Ctrl/⌘+Enter is the shared voucher Save shortcut, not "add the highlighted item".
      if (filteredItems.length === 0 || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      const isEditable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (isEditable && target !== searchInputRef.current) return;

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlightedIndex((previous) => (previous < filteredItems.length - 1 ? previous + 1 : 0));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightedIndex((previous) => (previous > 0 ? previous - 1 : filteredItems.length - 1));
      } else if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        const selectedItem = filteredItems[highlightedIndex];
        if (selectedItem) addItemToCart(selectedItem);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [addItemToCart, filteredItems, highlightedIndex]);

  const removeItem = (index: number) => setItems((previous) => previous.filter((_, itemIndex) => itemIndex !== index));
  const updateItemInventoryCost = (index: number, newCost: string) =>
    setItems((previous) =>
      previous.map((item, itemIndex) => (itemIndex === index ? { ...item, inventoryCost: newCost } : item))
    );

  const totalRefund = items.reduce((sum, item) => sum + parseFloat(item.quantity) * parseFloat(item.refundRate), 0);
  const totalInventoryValue = items.reduce(
    (sum, item) => sum + parseFloat(item.quantity) * parseFloat(item.inventoryCost),
    0
  );
  // Inventory cost remains USD even while the refund price is entered in K.
  const totalRefundUsd = noteCurrency === "ZMW" ? (noteRate ? totalRefund / noteRate : 0) : totalRefund;

  const onSubmit = (values: CreditNoteFormData) => {
    if (noteCurrency === "ZMW" && (!noteRate || !Number.isFinite(noteRate) || noteRate <= 0)) {
      toast({
        title: "USD/ZMW rate required",
        description: "Set an approved exchange rate for the refund date before saving.",
        variant: "destructive",
      });
      return;
    }
    if (items.length === 0) {
      toast({ title: "No items", description: "Please add at least one item", variant: "destructive" });
      return;
    }
    const payload = {
      voucherDate: values.voucherDate,
      cashAccountId: values.cashAccountId,
      cashAccountType: values.cashAccountType,
      description: values.description || "",
      currency: noteCurrency,
      exchangeRate: noteCurrency === "ZMW" && noteRate ? String(noteRate) : undefined,
      items: items.map((item) => ({
        stockItemId: item.stockItemId,
        locationId: item.locationId,
        quantity: item.quantity,
        refundRate:
          noteCurrency === "ZMW" && noteRate ? (Number(item.refundRate) / noteRate).toFixed(6) : item.refundRate,
        originalCurrencyRate: noteCurrency === "ZMW" ? item.refundRate : undefined,
        inventoryCost: item.inventoryCost,
      })),
    };
    if (isEditMode && editingVoucherId) updateCreditNoteMutation.mutate(payload);
    else createCreditNoteMutation.mutate({ ...payload, noteType: values.noteType });
  };

  const noteType = form.watch("noteType");
  const cashAccountId = form.watch("cashAccountId");
  const cashAccountType = form.watch("cashAccountType");
  const cashAccountName = form.watch("cashAccountName");
  const isPending = createCreditNoteMutation.isPending || updateCreditNoteMutation.isPending;
  return {
    addItemToCart,
    allAccounts,
    cashAccountId,
    cashAccountName,
    cashAccountType,
    editLoading,
    filteredItems,
    form,
    highlightedIndex,
    isEditMode,
    isPending,
    itemListRef,
    itemQuantity,
    items,
    locations,
    noteCurrency,
    noteType,
    onSubmit,
    refundRate,
    removeItem,
    resetForm,
    searchInputRef,
    searchTerm,
    selectedLocationId,
    setHighlightedIndex,
    setItemQuantity,
    setRefundRate,
    setSearchTerm,
    setSelectedLocationId,
    totalInventoryValue,
    totalRefund,
    totalRefundUsd,
    updateItemInventoryCost,
  };
}
