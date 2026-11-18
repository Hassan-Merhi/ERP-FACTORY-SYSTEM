// Extracted from ./StockEntryTab.tsx to keep that module under the source-size cap.
import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import type { LabelData } from "@/lib/labelHtml";
import { printLabels } from "./StockEntryPrinting";
import { eligibleProductionPositions } from "./StockEntryProductionPositions";
import { MAX_ITEMS_PER_ENTRY, useStockEntryTabStatePart1 } from "./useStockEntryTabStatePart1";

export function useStockEntryTabStatePart3({
  baleProducts,
  cart,
  discardCartDraft,
  entryDate,
  modeApiRequest,
  productionPositionByProduct,
  productionPositions,
  productionPositionsLoading,
  selectedCustomerId,
  selectedLocationId,
  selectedLogoId,
  setCart,
  setConfirmDialogOpen,
  setProductionPositionByProduct,
  toast,
  tr,
}: Pick<
  Awaited<ReturnType<typeof useStockEntryTabStatePart1>>,
  | "baleProducts"
  | "cart"
  | "discardCartDraft"
  | "entryDate"
  | "modeApiRequest"
  | "productionPositionByProduct"
  | "productionPositions"
  | "productionPositionsLoading"
  | "selectedCustomerId"
  | "selectedLocationId"
  | "selectedLogoId"
  | "setCart"
  | "setConfirmDialogOpen"
  | "setProductionPositionByProduct"
  | "toast"
  | "tr"
>) {
  const totalKg = cart.reduce((sum, item) => sum + item.qty * item.weightPerBaleKg, 0);

  const handleConfirmClick = () => {
    if (!selectedLocationId) {
      toast({
        title: "Missing information",
        description: "Please select a warehouse location",
        variant: "destructive",
      });
      return;
    }
    if (cart.length === 0) {
      toast({ title: "Missing information", description: "Please add items to the cart", variant: "destructive" });
      return;
    }
    if (cart.length > MAX_ITEMS_PER_ENTRY) {
      toast({
        title: tr("factory.stockEntry.baleLimitReached"),
        description: tr("factory.stockEntry.baleLimitReduceQuantity"),
        variant: "destructive",
      });
      return;
    }
    if (cart.some((item) => !!item.finalizedBy) && productionPositionsLoading) {
      toast({
        title: "Production positions are still loading",
        description: "The worker-to-position assignments must be loaded before Stock Entry can be saved.",
        variant: "destructive",
      });
      return;
    }
    for (const item of cart) {
      if (!item.finalizedBy) continue;
      const eligible = eligibleProductionPositions(productionPositions, item.finalizedBy);
      const selectedId = productionPositionByProduct[item.productId] ?? null;
      const selectedIsValid = selectedId != null && eligible.some((position) => position.id === selectedId);
      if (eligible.length > 1 && !selectedIsValid) {
        toast({
          title: "Production Position required",
          description: `${item.product.name} is assigned to a worker who belongs to multiple production positions. Choose the correct position first.`,
          variant: "destructive",
        });
        return;
      }
      if (selectedId != null && !selectedIsValid) {
        toast({
          title: "Production Position changed",
          description: `The saved position for ${item.product.name} is no longer valid on ${entryDate}. Choose it again.`,
          variant: "destructive",
        });
        return;
      }
    }
    setConfirmDialogOpen(true);
  };

  const [designPickerOpen, setDesignPickerOpen] = useState(false);
  const [pendingPrintLabels, setPendingPrintLabels] = useState<LabelData[] | null>(null);
  const preOpenedWindowsRef = useRef<{ a4: Window | null; sticker: Window | null } | null>(null);

  const stockEntryMutation = useMutation({
    mutationFn: async () => {
      if (cart.length > MAX_ITEMS_PER_ENTRY) {
        throw new Error(tr("factory.stockEntry.baleLimit"));
      }
      const response = await modeApiRequest("POST", "/api/factory/stock-entry", {
        erpLocationId: parseInt(selectedLocationId),
        items: cart.map((item) => ({
          productId: item.productId,
          qty: item.qty,
          weightPerBaleKg: item.weightPerBaleKg,
          finalizedBy: item.finalizedBy,
          productionPositionId: productionPositionByProduct[item.productId] ?? null,
        })),
        entryDate,
        customerId: selectedCustomerId !== "none" ? parseInt(selectedCustomerId) : null,
        logoId: selectedLogoId,
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || "Failed to record stock entry");
      }
      return await response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/stock-entry/in-stock"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales/daily-summary"] });
      const allocated = Number(data.autoPrioritySummary?.allocated ?? 0);
      const leftInStock = Number(data.autoPrioritySummary?.leftInStock ?? data.bales.length - allocated);
      toast({
        title: "Stock Entry Recorded",
        description:
          allocated > 0
            ? `${data.bales.length} bale(s) received; ${allocated} automatically loaded, ${leftInStock} kept unallocated in stock.`
            : `${data.bales.length} bale(s) received into inventory; no automatic loading required.`,
      });
      if (data.automaticPriorityModeEnabled && allocated > 0) {
        void queryClient.invalidateQueries({
          queryKey: ["/api/factory/customer-orders/loading-list/priority-scan-configs"],
        });
        void queryClient.invalidateQueries({
          queryKey: ["/api/factory/customer-orders/loading-list/priority-scan-route"],
        });
        void queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders/loading-list"] });
      }
      void printLabels(
        data.bales,
        cart,
        baleProducts,
        selectedLogoId,
        modeApiRequest,
        toast,
        preOpenedWindowsRef,
        data.autoPriorityAllocations ?? [],
        data.automaticPriorityModeEnabled === true
      );
      setCart([]);
      setProductionPositionByProduct({});
      setConfirmDialogOpen(false);
      discardCartDraft();
    },
    onError: (error: Error) => {
      // Printing windows were opened before the asynchronous Stock Entry request.
      // Close them on failure instead of leaving two permanent about:blank tabs.
      const preOpened = preOpenedWindowsRef.current;
      preOpenedWindowsRef.current = null;
      if (preOpened?.a4 && !preOpened.a4.closed) preOpened.a4.close();
      if (preOpened?.sticker && !preOpened.sticker.closed) preOpened.sticker.close();
      toast({ title: "Stock Entry failed — labels not printed", description: error.message, variant: "destructive" });
    },
  });
  return {
    designPickerOpen,
    handleConfirmClick,
    pendingPrintLabels,
    preOpenedWindowsRef,
    setDesignPickerOpen,
    setPendingPrintLabels,
    stockEntryMutation,
    totalKg,
  };
}
