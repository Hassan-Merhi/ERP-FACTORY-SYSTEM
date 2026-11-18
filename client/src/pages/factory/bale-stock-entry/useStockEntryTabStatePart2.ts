// Extracted from ./StockEntryTab.tsx to keep that module under the source-size cap.
import { useState } from "react";
import type { FactoryBaleProduct } from "@shared/schema";
import { eligibleProductionPositions } from "./StockEntryProductionPositions";
import { MAX_ITEMS_PER_ENTRY, useStockEntryTabStatePart1 } from "./useStockEntryTabStatePart1";
import { useStockEntryTabStatePart4 } from "./useStockEntryTabStatePart4";

export function useStockEntryTabStatePart2({
  baleProducts,
  cart,
  locations,
  modeApiRequest,
  pendingAdminAuth,
  productionPositions,
  quickCreateCategoryId,
  quickCreateGrade,
  quickCreateName,
  quickCreateWeight,
  scanInput,
  scanRef,
  selectedLocationId,
  setCart,
  setPendingAdminAuth,
  setPendingCreateName,
  setProductionPositionByProduct,
  setQuickCreateCategoryId,
  setQuickCreateGrade,
  setQuickCreateName,
  setQuickCreateOpen,
  setQuickCreateWeight,
  setScanError,
  setScanInput,
  setSelectedLocationId,
  setShowDropdown,
  toast,
  tr,
}: Pick<
  Awaited<ReturnType<typeof useStockEntryTabStatePart1>>,
  | "baleProducts"
  | "cart"
  | "locations"
  | "modeApiRequest"
  | "pendingAdminAuth"
  | "productionPositions"
  | "quickCreateCategoryId"
  | "quickCreateGrade"
  | "quickCreateName"
  | "quickCreateWeight"
  | "scanInput"
  | "scanRef"
  | "selectedLocationId"
  | "setCart"
  | "setPendingAdminAuth"
  | "setPendingCreateName"
  | "setProductionPositionByProduct"
  | "setQuickCreateCategoryId"
  | "setQuickCreateGrade"
  | "setQuickCreateName"
  | "setQuickCreateOpen"
  | "setQuickCreateWeight"
  | "setScanError"
  | "setScanInput"
  | "setSelectedLocationId"
  | "setShowDropdown"
  | "toast"
  | "tr"
>) {
  const { quickCreateMutation, activeLocations, handleScan, handleScanKeyDown, filteredProducts } =
    useStockEntryTabStatePart4({
      baleProducts,
      cart,
      locations,
      modeApiRequest,
      pendingAdminAuth,
      quickCreateCategoryId,
      quickCreateGrade,
      quickCreateName,
      quickCreateWeight,
      scanInput,
      scanRef,
      selectedLocationId,
      setCart,
      setPendingAdminAuth,
      setPendingCreateName,
      setQuickCreateCategoryId,
      setQuickCreateGrade,
      setQuickCreateName,
      setQuickCreateOpen,
      setQuickCreateWeight,
      setScanError,
      setScanInput,
      setSelectedLocationId,
      setShowDropdown,
      toast,
      tr,
    });

  const selectProduct = (product: FactoryBaleProduct) => {
    const existingInCart = cart.some((item) => item.productId === product.id);
    if (!existingInCart && cart.length >= MAX_ITEMS_PER_ENTRY) {
      toast({
        title: tr("factory.stockEntry.baleLimitReached"),
        description: tr("factory.stockEntry.baleLimitConfirmFirst"),
        variant: "destructive",
      });
      setScanInput("");
      setScanError("");
      setShowDropdown(false);
      return;
    }
    const defaultWeight = product.weightPerBaleKg ? parseFloat(product.weightPerBaleKg) : 25;
    setCart((prev) => {
      const existing = prev.find((item) => item.productId === product.id);
      if (existing) {
        return prev.map((item) => (item.productId === product.id ? { ...item, qty: item.qty + 1 } : item));
      }
      if (prev.length >= MAX_ITEMS_PER_ENTRY) return prev;
      return [
        ...prev,
        {
          productId: product.id,
          product,
          qty: 1,
          weightPerBaleKg: defaultWeight,
          finalizedBy: null,
          overrideLogoId: null,
        },
      ];
    });
    setScanInput("");
    setScanError("");
    setShowDropdown(false);
  };

  const updateQty = (productId: number, delta: number) => {
    setCart((prev) =>
      prev
        .map((item) => (item.productId === productId ? { ...item, qty: Math.max(0, item.qty + delta) } : item))
        .filter((item) => item.qty > 0)
    );
  };

  const setQty = (productId: number, qty: number) => {
    if (qty <= 0) {
      setCart((prev) => prev.filter((item) => item.productId !== productId));
      setProductionPositionByProduct((prev) => {
        if (!(productId in prev)) return prev;
        const next = { ...prev };
        delete next[productId];
        return next;
      });
    } else {
      setCart((prev) => prev.map((item) => (item.productId === productId ? { ...item, qty } : item)));
    }
  };

  const updateWeight = (productId: number, weight: number) => {
    setCart((prev) => prev.map((item) => (item.productId === productId ? { ...item, weightPerBaleKg: weight } : item)));
  };

  const removeItem = (productId: number) => {
    setCart((prev) => prev.filter((item) => item.productId !== productId));
    setProductionPositionByProduct((prev) => {
      if (!(productId in prev)) return prev;
      const next = { ...prev };
      delete next[productId];
      return next;
    });
  };

  const assignWorker = (productId: number, workerId: number | null) => {
    const eligible = eligibleProductionPositions(productionPositions, workerId);
    const autoPositionId = eligible.length === 1 ? eligible[0].id : null;
    setCart((prev) => prev.map((item) => (item.productId === productId ? { ...item, finalizedBy: workerId } : item)));
    setProductionPositionByProduct((prev) => ({ ...prev, [productId]: autoPositionId }));
  };

  const assignProductionPosition = (productId: number, positionId: number | null) => {
    setProductionPositionByProduct((prev) => ({ ...prev, [productId]: positionId }));
  };

  const setLogoOverride = (productId: number, logoId: number | null) => {
    setCart((prev) => prev.map((item) => (item.productId === productId ? { ...item, overrideLogoId: logoId } : item)));
  };

  const [logoPickerOpen, setLogoPickerOpen] = useState<number | null>(null);

  const totalQty = cart.reduce((sum, item) => sum + item.qty, 0);
  return {
    activeLocations,
    assignProductionPosition,
    assignWorker,
    filteredProducts,
    handleScan,
    handleScanKeyDown,
    logoPickerOpen,
    quickCreateMutation,
    removeItem,
    selectProduct,
    setLogoOverride,
    setLogoPickerOpen,
    setQty,
    totalQty,
    updateQty,
    updateWeight,
  };
}
