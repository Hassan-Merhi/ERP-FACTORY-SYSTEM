import type { ClientErrorLike } from "@/lib/clientError";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { format } from "date-fns";
import { useLocation } from "wouter";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useAppMode, useModePrefix } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { queryClient } from "@/lib/queryClient";
import { utils, writeFile } from "@/lib/excelHelper";
import { parseDateLocal } from "@/components/vouchers/PrintTemplate";
import { useToast } from "@/hooks/use-toast";
import type {
  Location,
  StockAdjustmentFormData,
  StockAdjustmentFormProps,
  StockItem,
} from "../stockadjustmentform/types";
import { stockAdjustmentFormSchema } from "../stockadjustmentform/utils";

interface LocationInventoryRow {
  stockItemId: number;
  quantity?: string;
  averageRate?: string;
}

interface StockAdjustmentRecord {
  id?: number;
  locationId?: number;
  notes?: string;
  items?: { stockItemId?: number; quantity?: string; rate?: string }[];
}

export function useStockAdjustmentFormModel({ voucherIdToEdit }: StockAdjustmentFormProps) {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const modePrefix = useModePrefix();
  const { formatAmount, selectedCurrency, exchangeRate } = useCurrencyContext();
  const [, setLocation] = useLocation();
  const hydratedVoucherIdRef = useRef<number | null>(null);

  const { data: stockItems = [] } = useQuery<StockItem[]>({
    queryKey: ["/api/stock-items/light", selectedCompany?.id],
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const { data: locations = [] } = useQuery<Location[]>({
    queryKey: ["/api/locations", selectedCompany?.id],
  });

  const { data: voucherToEdit } = useQuery({
    queryKey: ["/api/vouchers", voucherIdToEdit],
    enabled: !!voucherIdToEdit,
    queryFn: async () => {
      const res = await fetch(`/api/vouchers/${voucherIdToEdit}`);
      if (!res.ok) throw new Error("Failed to fetch voucher");
      return res.json();
    },
  });

  const { data: stockAdjustmentToEdit } = useQuery<StockAdjustmentRecord>({
    queryKey: ["/api/stock-adjustments", voucherIdToEdit],
    enabled: !!voucherIdToEdit,
    queryFn: async () => {
      const res = await fetch(`/api/stock-adjustments?voucherId=${voucherIdToEdit}`);
      if (!res.ok) throw new Error("Failed to fetch stock adjustment");
      const data = await res.json();
      return Array.isArray(data) ? data[0] : data;
    },
  });

  const stockAdjustmentForm = useForm<StockAdjustmentFormData>({
    resolver: zodResolver(stockAdjustmentFormSchema),
    defaultValues: {
      voucherDate: new Date(),
      locationId: 0,
      entries: [{ type: "CONSUME", stockItemId: 0, stockItemCode: "", stockItemName: "", quantity: "", rate: "" }],
      notes: "",
      optional: false,
    },
  });

  const {
    fields: adjustmentFields,
    append: appendAdjustment,
    remove: removeAdjustment,
  } = useFieldArray({
    control: stockAdjustmentForm.control,
    name: "entries",
  });

  const adjustmentEntries = stockAdjustmentForm.watch("entries") || [];
  const adjustmentLocationId = stockAdjustmentForm.watch("locationId") || 0;

  const consumptionTotal = adjustmentEntries
    .filter((e) => e.type === "CONSUME")
    .reduce((sum, e) => sum + parseFloat(e.quantity || "0") * parseFloat(e.rate || "0"), 0);
  const productionTotal = adjustmentEntries
    .filter((e) => e.type === "PRODUCE")
    .reduce((sum, e) => sum + parseFloat(e.quantity || "0") * parseFloat(e.rate || "0"), 0);
  const currentHasConsumption = adjustmentEntries.some((e) => e.type === "CONSUME");
  const currentHasProduction = adjustmentEntries.some((e) => e.type === "PRODUCE");
  const currentAdjustmentType =
    currentHasConsumption && currentHasProduction ? "Mixed" : currentHasProduction ? "Production" : "Consumption";
  const displayAdjustmentTotal =
    currentAdjustmentType === "Mixed" ? productionTotal - consumptionTotal : consumptionTotal + productionTotal;

  const { data: locationInventory = [] } = useQuery<LocationInventoryRow[]>({
    queryKey: ["/api/adjustment-location-inventory", adjustmentLocationId],
    enabled: adjustmentLocationId > 0,
    queryFn: async () => {
      const response = await fetch(`/api/locations/${adjustmentLocationId}/inventory`);
      if (!response.ok) throw new Error("Failed to fetch inventory");
      return response.json();
    },
  });

  const [adjustmentSearchTerm, setAdjustmentSearchTerm] = useState("");
  const [adjustmentHighlightedIndex, setAdjustmentHighlightedIndex] = useState(0);
  const [activeAdjustmentRow, setActiveAdjustmentRow] = useState<number | null>(null);
  const [showAdjustmentSidebar, setShowAdjustmentSidebar] = useState(false);
  const adjustmentFocusIdRef = useRef(0);
  const adjustmentSidebarRef = useRef<HTMLDivElement>(null);

  const adjustmentItemsWithInventory = useMemo(() => {
    if (!stockItems.length) return [];
    return stockItems
      .map((item) => {
        const inv = locationInventory.find((i) => i.stockItemId === item.id);
        return {
          stockItemId: item.id,
          stockItemCode: item.code,
          stockItemName: item.name,
          quantity: inv?.quantity || "0",
          averageRate: inv?.averageRate || "0",
        };
      })
      .sort((a, b) => a.stockItemName.localeCompare(b.stockItemName));
  }, [stockItems, locationInventory]);

  const filteredAdjustmentItems = useMemo(() => {
    if (!adjustmentSearchTerm.trim()) return adjustmentItemsWithInventory;
    const term = adjustmentSearchTerm.toLowerCase();
    return adjustmentItemsWithInventory.filter(
      (item) => item.stockItemName?.toLowerCase().includes(term) || item.stockItemCode?.toLowerCase().includes(term)
    );
  }, [adjustmentItemsWithInventory, adjustmentSearchTerm]);

  useEffect(() => {
    if (showAdjustmentSidebar && adjustmentSidebarRef.current) {
      const container = adjustmentSidebarRef.current;
      const highlighted = container.querySelector(`[data-adjustment-idx="${adjustmentHighlightedIndex}"]`);
      if (highlighted) highlighted.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [adjustmentHighlightedIndex, showAdjustmentSidebar]);

  useEffect(() => {
    if (stockAdjustmentToEdit && stockAdjustmentToEdit.items && voucherToEdit && stockItems.length > 0) {
      if (hydratedVoucherIdRef.current === voucherIdToEdit) return;
      const formEntries = stockAdjustmentToEdit.items.map((item) => {
        const stockItem = stockItems.find((s) => s.id === item.stockItemId);
        const quantity = parseFloat(item.quantity || "0");
        const type: "CONSUME" | "PRODUCE" = quantity < 0 ? "CONSUME" : "PRODUCE";
        const absQuantity = Math.abs(quantity).toString();
        return {
          type,
          stockItemId: item.stockItemId || 0,
          stockItemCode: stockItem?.code || "",
          stockItemName: stockItem?.name || "",
          quantity: absQuantity,
          rate: item.rate || "0",
        };
      });
      stockAdjustmentForm.reset({
        voucherDate: voucherToEdit ? parseDateLocal(voucherToEdit.voucherDate) : new Date(),
        locationId: stockAdjustmentToEdit.locationId || 0,
        entries:
          formEntries.length > 0
            ? formEntries
            : [
                {
                  type: "PRODUCE",
                  stockItemId: 0,
                  stockItemCode: "",
                  stockItemName: "",
                  quantity: "",
                  rate: "",
                },
              ],
        notes: stockAdjustmentToEdit.notes || "",
        optional: voucherToEdit?.optional || false,
      });
      hydratedVoucherIdRef.current = voucherIdToEdit;
    }
  }, [stockAdjustmentToEdit, voucherToEdit, stockItems, stockAdjustmentForm]); // eslint-disable-line

  const stockAdjustmentMutation = useMutation({
    mutationFn: async (data: StockAdjustmentFormData) => {
      const isEditMode = !!voucherIdToEdit;
      const hasConsumption = data.entries.some((e) => e.type === "CONSUME");
      const hasProduction = data.entries.some((e) => e.type === "PRODUCE");
      const adjustmentType = hasConsumption && hasProduction ? "Mixed" : hasProduction ? "Production" : "Consumption";
      const items = data.entries.map((entry) => ({
        stockItemId: entry.stockItemId,
        quantity: entry.type === "CONSUME" ? (-parseFloat(entry.quantity)).toString() : entry.quantity,
        rate: entry.rate,
      }));
      const localConsumptionTotal = data.entries
        .filter((e) => e.type === "CONSUME")
        .reduce((s, e) => s + parseFloat(e.quantity || "0") * parseFloat(e.rate || "0"), 0);
      const localProductionTotal = data.entries
        .filter((e) => e.type === "PRODUCE")
        .reduce((s, e) => s + parseFloat(e.quantity || "0") * parseFloat(e.rate || "0"), 0);
      const totalAmount =
        adjustmentType === "Mixed"
          ? localProductionTotal - localConsumptionTotal
          : localConsumptionTotal + localProductionTotal;

      if (isEditMode) {
        const voucherRes = await modeApiRequest("PATCH", `/api/vouchers/${voucherIdToEdit}`, {
          voucherDate: format(data.voucherDate, "yyyy-MM-dd"),
          description: `Stock ${adjustmentType.toLowerCase()} at ${locations.find((l) => l.id === data.locationId)?.name}`,
          totalAmount: totalAmount.toString(),
          optional: data.optional,
        });
        if (stockAdjustmentToEdit?.id) {
          await modeApiRequest("PUT", `/api/stock-adjustments/${stockAdjustmentToEdit.id}`, {
            locationId: data.locationId,
            adjustmentType,
            notes: data.notes || "",
            items,
          });
        }
        return await voucherRes.json();
      }

      const voucherRes = await modeApiRequest("POST", "/api/vouchers", {
        companyId: selectedCompany?.id,
        voucherType: adjustmentType,
        voucherNumber: `${adjustmentType.toUpperCase()}-${Date.now()}`,
        voucherDate: format(data.voucherDate, "yyyy-MM-dd"),
        description: `Stock ${adjustmentType.toLowerCase()} at ${locations.find((l) => l.id === data.locationId)?.name}`,
        totalAmount: totalAmount.toString(),
        optional: data.optional,
        currency: selectedCurrency,
        exchangeRate: exchangeRate ? exchangeRate.toString() : undefined,
      });
      const voucher = await voucherRes.json();
      await modeApiRequest("POST", "/api/stock-adjustments", {
        voucherId: voucher.id,
        locationId: data.locationId,
        adjustmentType,
        notes: data.notes || "",
        items,
      });
      return voucher;
    },
    onSuccess: () => {
      const isEditMode = !!voucherIdToEdit;
      toast({
        title: "Success",
        description: `Production/Consumption voucher ${isEditMode ? "updated" : "created"} successfully`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory-by-location"] });
      queryClient.invalidateQueries({ queryKey: ["/api/location-summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-adjustments"] });
      if (isEditMode) {
        setLocation(`${modePrefix}/daybook`);
      } else {
        stockAdjustmentForm.reset({
          voucherDate: new Date(),
          locationId: 0,
          entries: [{ type: "PRODUCE", stockItemId: 0, stockItemCode: "", stockItemName: "", quantity: "", rate: "" }],
          notes: "",
        });
      }
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({
        title: "Error",
        description: error.message || `Failed to ${voucherIdToEdit ? "update" : "create"} stock adjustment`,
        variant: "destructive",
      });
    },
  });

  const handleExportProductionConsumptionVoucher = async (detailed: boolean) => {
    const formData = stockAdjustmentForm.getValues();
    const voucherDate = formData.voucherDate
      ? format(formData.voucherDate, "yyyy-MM-dd")
      : format(new Date(), "yyyy-MM-dd");
    const validEntries = formData.entries.filter((e) => e.stockItemId > 0 && parseFloat(e.quantity) > 0);
    if (validEntries.length === 0) {
      toast({
        title: "No data to export",
        description: "Add at least one entry before exporting.",
        variant: "destructive",
      });
      return;
    }
    const locationName = locations.find((l) => l.id === formData.locationId)?.name || "";
    if (detailed) {
      const exportData = validEntries.map((entry) => ({
        "Entry Type": entry.type?.toUpperCase() === "CONSUME" ? "Consumption" : "Production",
        Date: voucherDate,
        Location: locationName,
        "Item Code": entry.stockItemCode || "",
        "Item Name": entry.stockItemName || "",
        Quantity: parseFloat(entry.quantity).toFixed(2),
        Rate: parseFloat(entry.rate || "0").toFixed(2),
        Amount: (parseFloat(entry.quantity) * parseFloat(entry.rate || "0")).toFixed(2),
        Notes: formData.notes || "",
        Optional: formData.optional ? "Yes" : "No",
      }));
      const worksheet = utils.json_to_sheet(exportData);
      const workbook = utils.book_new();
      utils.book_append_sheet(workbook, worksheet, "Production-Consumption Detailed");
      const fileName = `Production_Consumption_Detailed_${voucherDate}.xlsx`;
      await writeFile(workbook, fileName);
      toast({ title: "Export successful", description: `Downloaded ${fileName} with ${validEntries.length} items.` });
    } else {
      const consumeTotal = validEntries
        .filter((e) => e.type?.toUpperCase() === "CONSUME")
        .reduce((sum: number, e) => sum + parseFloat(e.quantity) * parseFloat(e.rate || "0"), 0);
      const produceTotal = validEntries
        .filter((e) => e.type?.toUpperCase() === "PRODUCE")
        .reduce((sum: number, e) => sum + parseFloat(e.quantity) * parseFloat(e.rate || "0"), 0);
      const exportData = [
        {
          "Voucher Type": "Production/Consumption",
          Date: voucherDate,
          Location: locationName,
          "Consumption Total": consumeTotal.toFixed(2),
          "Production Total": produceTotal.toFixed(2),
          "Number of Items": validEntries.length,
          Notes: formData.notes || "",
          Optional: formData.optional ? "Yes" : "No",
        },
      ];
      const worksheet = utils.json_to_sheet(exportData);
      const workbook = utils.book_new();
      utils.book_append_sheet(workbook, worksheet, "Production-Consumption Summary");
      const fileName = `Production_Consumption_Summary_${voucherDate}.xlsx`;
      await writeFile(workbook, fileName);
      toast({ title: "Export successful", description: `Downloaded ${fileName}.` });
    }
  };

  const onStockAdjustmentSubmit = async (data: StockAdjustmentFormData) => {
    const validEntries = data.entries.filter((e) => e.stockItemId > 0 && parseFloat(e.quantity) > 0);
    if (validEntries.length === 0) {
      toast({ title: "Validation Error", description: "Please add at least one valid entry", variant: "destructive" });
      return;
    }
    stockAdjustmentMutation.mutate(data);
  };

  return {
    locations,
    stockAdjustmentForm,
    adjustmentFields,
    appendAdjustment,
    removeAdjustment,
    adjustmentEntries,
    adjustmentLocationId,
    consumptionTotal,
    productionTotal,
    displayAdjustmentTotal,
    adjustmentSearchTerm,
    setAdjustmentSearchTerm,
    adjustmentHighlightedIndex,
    setAdjustmentHighlightedIndex,
    activeAdjustmentRow,
    setActiveAdjustmentRow,
    showAdjustmentSidebar,
    setShowAdjustmentSidebar,
    adjustmentFocusIdRef,
    adjustmentSidebarRef,
    adjustmentItemsWithInventory,
    filteredAdjustmentItems,
    stockAdjustmentMutation,
    handleExportProductionConsumptionVoucher,
    onStockAdjustmentSubmit,
    formatAmount,
  };
}

export type StockAdjustmentFormModel = ReturnType<typeof useStockAdjustmentFormModel>;
