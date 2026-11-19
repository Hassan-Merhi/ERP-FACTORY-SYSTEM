// Extracted from ./useStockTransferOrderModel.tsx to keep that module under the source-size cap.
import { useMutation } from "@tanstack/react-query";
import { format } from "date-fns";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { OrderItem } from "../stocktransferorder/types";
import { DRAFT_KEY } from "../stocktransferorder/utils";
import { useStockTransferOrderWorkflows } from "./useStockTransferOrderWorkflows";
import { isGloballyHandledError, useStockTransferOrderModelPart1 } from "./useStockTransferOrderModelPart1";
import { useStockTransferOrderModelPart2 } from "./useStockTransferOrderModelPart2";
import { useStockTransferOrderModelPart5 } from "./useStockTransferOrderModelPart5";

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
  const { handleAddToOrder, removeFromOrder, handleMobileAddItem, validateOrder, handleValidate, handleExportOrder } =
    useStockTransferOrderModelPart5({
      destinationLocationId,
      locations,
      mobileQty,
      mobileSelectedItemId,
      mobileSourceLocationId,
      orderItems,
      pickerQuantity,
      quantityPicker,
      selectedCompany,
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
    });

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
