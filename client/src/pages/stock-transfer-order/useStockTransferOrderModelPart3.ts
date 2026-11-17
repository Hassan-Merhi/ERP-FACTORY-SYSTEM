// Extracted from ./useStockTransferOrderModel.tsx to keep that module under the source-size cap.
import { useMutation } from "@tanstack/react-query";
import { format } from "date-fns";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatNumber } from "@/lib/formatNumber";
import type { OrderItem } from "../stocktransferorder/types";
import { DRAFT_KEY } from "../stocktransferorder/utils";
import { exportStockTransferOrderWorkbook } from "./exportStockTransferOrderWorkbook";
import { useMobileOrderItemAdder } from "./useMobileOrderItemAdder";
import { useStockTransferOrderWorkflows } from "./useStockTransferOrderWorkflows";
import { isGloballyHandledError, useStockTransferOrderModelPart1 } from "./useStockTransferOrderModelPart1";
import { useStockTransferOrderModelPart2 } from "./useStockTransferOrderModelPart2";

export function useStockTransferOrderModelPart3({
  destinationLocationId,
  editVoucherId,
  existingTransfer,
  existingVoucher,
  locations,
  mobileQty,
  mobileSelectedItemId,
  mobileSourceLocationId,
  navigate,
  orderItems,
  pickerQuantity,
  quantityPicker,
  selectedCompany,
  setAutosaveStatus,
  setMobileQty,
  setMobileSelectedItemId,
  setMobileSheetOpen,
  setOrderItems,
  setQuantityPicker,
  setValidationErrors,
  sortOrderItems,
  stockItems,
  summaryData,
  toast,
  transferDate,
}: Pick<
  Awaited<ReturnType<typeof useStockTransferOrderModelPart1>> &
    Awaited<ReturnType<typeof useStockTransferOrderModelPart2>>,
  | "destinationLocationId"
  | "editVoucherId"
  | "existingTransfer"
  | "existingVoucher"
  | "locations"
  | "mobileQty"
  | "mobileSelectedItemId"
  | "mobileSourceLocationId"
  | "navigate"
  | "orderItems"
  | "pickerQuantity"
  | "quantityPicker"
  | "selectedCompany"
  | "setAutosaveStatus"
  | "setMobileQty"
  | "setMobileSelectedItemId"
  | "setMobileSheetOpen"
  | "setOrderItems"
  | "setQuantityPicker"
  | "setValidationErrors"
  | "sortOrderItems"
  | "stockItems"
  | "summaryData"
  | "toast"
  | "transferDate"
>) {
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

      const response = await apiRequest("POST", "/api/stock-transfer-orders", {
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
        title: "Save failed",
        description: error instanceof Error ? error.message : "Failed to process order",
        variant: "destructive",
      });
    },
  });
  return {
    handleAddToOrder,
    handleExportOrder,
    handleMobileAddItem,
    handleValidate,
    processOrderMutation,
    removeFromOrder,
    validateOrder,
  };
}

export function useStockTransferOrderModelPart4({
  destinationLocationId,
  editVoucherId,
  existingTransfer,
  existingVoucher,
  isOptional,
  locations,
  orderItems,
  processOrderMutation,
  revisions,
  setIsProcessing,
  setOrderItems,
  setValidationErrors,
  stockItems,
  summaryData,
  toast,
  transferDate,
  validateOrder,
}: Pick<
  Awaited<ReturnType<typeof useStockTransferOrderModelPart1>> &
    Awaited<ReturnType<typeof useStockTransferOrderModelPart3>>,
  | "destinationLocationId"
  | "editVoucherId"
  | "existingTransfer"
  | "existingVoucher"
  | "isOptional"
  | "locations"
  | "orderItems"
  | "processOrderMutation"
  | "revisions"
  | "setIsProcessing"
  | "setOrderItems"
  | "setValidationErrors"
  | "stockItems"
  | "summaryData"
  | "toast"
  | "transferDate"
  | "validateOrder"
>) {
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
  return { handleProcessOrder, totalBales, workflows };
}
