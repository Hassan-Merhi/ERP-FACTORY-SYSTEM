// Extracted from ./StockEntryTab.tsx to keep that module under the source-size cap.
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import type { FactoryBaleProduct } from "@shared/schema";
import { productMatchesSearch } from "@shared/factoryProductSearch";
import { eligibleProductionPositions } from "./StockEntryProductionPositions";
import { MAX_ITEMS_PER_ENTRY, useStockEntryTabStatePart1 } from "./useStockEntryTabStatePart1";

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
  const quickCreateMutation = useMutation({
    mutationFn: async () => {
      const body: {
        name: string;
        categoryId?: number;
        weightPerBaleKg?: string;
        grade?: string;
        adminAuth?: { username: string; password: string };
      } = {
        name: quickCreateName,
      };
      if (quickCreateCategoryId) body.categoryId = parseInt(quickCreateCategoryId);
      if (quickCreateWeight) body.weightPerBaleKg = quickCreateWeight;
      if (quickCreateGrade) body.grade = quickCreateGrade;
      if (pendingAdminAuth) body.adminAuth = pendingAdminAuth;
      const response = await modeApiRequest("POST", "/api/factory/bale-products", body);
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || "Failed to create product");
      }
      return await response.json();
    },
    onSuccess: (newProduct: FactoryBaleProduct) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products?profile=picker"] });
      toast({
        title: "Product Created",
        description: `"${newProduct.name}" created with article code ${newProduct.articleCode}`,
      });
      setQuickCreateOpen(false);
      setQuickCreateName("");
      setQuickCreateCategoryId("");
      setQuickCreateWeight("");
      setQuickCreateGrade("");
      setPendingAdminAuth(null);
      setPendingCreateName("");
      setScanInput("");
      setShowDropdown(false);
      const defaultWeight = newProduct.weightPerBaleKg ? parseFloat(newProduct.weightPerBaleKg) : 25;
      if (cart.length >= MAX_ITEMS_PER_ENTRY) {
        toast({
          title: tr("factory.stockEntry.baleLimitReached"),
          description: tr("factory.stockEntry.finishBeforeAdding"),
          variant: "destructive",
        });
        return;
      }
      setCart((prev) => {
        if (prev.length >= MAX_ITEMS_PER_ENTRY) return prev;
        return [
          ...prev,
          {
            productId: newProduct.id,
            product: newProduct,
            qty: 1,
            weightPerBaleKg: defaultWeight,
            finalizedBy: null,
            overrideLogoId: null,
          },
        ];
      });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const activeProducts = (baleProducts || []).filter((p) => p.active);
  const activeLocations = (locations || []).filter((l) => l.active);

  useEffect(() => {
    if (activeLocations && activeLocations.length === 1 && !selectedLocationId) {
      setSelectedLocationId(activeLocations[0].id.toString());
    }
  }, [activeLocations, selectedLocationId, setSelectedLocationId]);

  useEffect(() => {
    const active = document.activeElement;
    const isOtherInputFocused =
      active &&
      active !== scanRef.current &&
      (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT");
    if (scanRef.current && !isOtherInputFocused) scanRef.current.focus();
  }, [cart, scanRef]);

  const handleScan = (value: string) => {
    if (!value.trim()) return;
    setScanError("");

    const trimmed = value.trim().toLowerCase();
    const product = activeProducts?.find(
      (p) => p.articleCode?.toLowerCase() === trimmed || p.code.toLowerCase() === trimmed
    );

    if (!product) {
      setScanError(`Unknown product: "${value}"`);
      setScanInput("");
      return;
    }

    const defaultWeight = product.weightPerBaleKg ? parseFloat(product.weightPerBaleKg) : 25;
    const existingInCart = cart.some((item) => item.productId === product.id);
    if (!existingInCart && cart.length >= MAX_ITEMS_PER_ENTRY) {
      toast({
        title: tr("factory.stockEntry.baleLimitReached"),
        description: tr("factory.stockEntry.baleLimitConfirmFirst"),
        variant: "destructive",
      });
      setScanInput("");
      return;
    }

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
  };

  const handleScanKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleScan(scanInput);
    }
  };

  const filteredProducts =
    scanInput.trim().length > 0
      ? (activeProducts || []).filter((p) => productMatchesSearch(p, scanInput)).slice(0, 1000)
      : [];

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
