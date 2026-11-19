import type React from "react";
import { useEffect } from "react";
import type { ArticleRow, Props } from "./types";
import { useCreateProformaV5DataModel } from "./useCreateProformaV5DataModel";

export function useCreateProformaV5Model({ open, onClose, articleRows, onSuccess }: Props) {
  const hs = useCreateProformaV5DataModel({ open, onClose, articleRows, onSuccess });

  const {
    triggerAutosave,
    customerId,
    proformaName,
    destination,
    isActive,
    quantities,
    sellingPrices,
    sendToLoading,
    containerCount,
    containerNames,
  } = hs;
  useEffect(() => {
    triggerAutosave({
      customerId: customerId,
      proformaName: proformaName,
      destination: destination,
      isActive: isActive,
      quantities: quantities,
      sellingPrices: sellingPrices,
      sendToLoading: sendToLoading,
      containerCount: containerCount,
      containerNames: containerNames,
      savedAt: Date.now(),
    });
  }, [
    customerId,
    proformaName,
    destination,
    isActive,
    quantities,
    sellingPrices,
    sendToLoading,
    containerCount,
    containerNames,
    triggerAutosave,
  ]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        handleSubmit();
      }
    };
    if (open) window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  function handleQtyChange(code: string, val: string) {
    hs.setQuantities((prev) => ({ ...prev, [code]: val }));
    hs.setErrors((prev) => {
      const n = { ...prev };
      delete n[`qty_${code}`];
      return n;
    });
  }

  function handleQtyKeyDown(e: React.KeyboardEvent<HTMLInputElement>, rowIdx: number) {
    if (e.key === "ArrowDown" || e.key === "Enter") {
      e.preventDefault();
      const next = hs.qtyRefs.current[rowIdx + 1];
      if (next) {
        next.focus();
        next.select();
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = hs.qtyRefs.current[rowIdx - 1];
      if (prev) {
        prev.focus();
        prev.select();
      }
    } else if (e.key === "Escape") {
      e.currentTarget.blur();
    }
  }

  function applyCatalogSellingPrice() {
    const m = hs.productMap();
    const next: Record<string, string> = {};
    for (const row of articleRows) {
      const p = m.get(row.articleCode);
      if (p?.sellingPrice && parseFloat(p.sellingPrice) > 0) next[row.articleCode] = p.sellingPrice;
    }
    hs.setSellingPrices((prev) => ({ ...prev, ...next }));
  }

  function applyCatalogProductionPrice() {
    const m = hs.productMap();
    const next: Record<string, string> = {};
    for (const row of articleRows) {
      const p = m.get(row.articleCode);
      if (p?.productionPrice && parseFloat(p.productionPrice) > 0) next[row.articleCode] = p.productionPrice;
    }
    hs.setSellingPrices((prev) => ({ ...prev, ...next }));
  }

  function updateContainerName(idx: number, val: string) {
    hs.setContainerNames((prev) => {
      const next = [...prev];
      next[idx] = val;
      return next;
    });
  }

  function addContainer() {
    hs.setContainerNames((prev) => [...prev, `Container ${prev.length + 1}`]);
    hs.setContainerCount((prev) => String(parseInt(prev || "1") + 1));
  }
  function removeContainer(idx: number) {
    hs.setContainerNames((prev) => prev.filter((_, i) => i !== idx));
    hs.setContainerCount((prev) => String(Math.max(1, parseInt(prev || "1") - 1)));
  }

  function validate(): boolean {
    const errs: Record<string, string> = {};
    if (!hs.customerId) errs.customerId = "Customer is required";
    if (!hs.proformaName.trim()) errs.proformaName = "Proforma name is required";
    if (!hs.destination.trim()) errs.destination = "Destination is required";
    const hasQty = articleRows.some((r) => {
      const v = hs.quantities[r.articleCode];
      return v && parseInt(v) > 0;
    });
    if (!hasQty) errs.lines = "Enter at least one quantity";
    articleRows.forEach((r) => {
      const v = hs.quantities[r.articleCode];
      if (!v || v === "") return;
      const n = parseInt(v);
      if (isNaN(n)) errs[`qty_${r.articleCode}`] = "Must be a number";
      else if (n < 0) errs[`qty_${r.articleCode}`] = "Cannot be negative";
    });
    if (hs.sendToLoading && hs.containerNames.length === 0) errs.containers = "Add at least one container";
    hs.setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function handleSubmit() {
    if (!validate()) return;
    const lines = articleRows
      .filter((r) => {
        const v = hs.quantities[r.articleCode];
        return v && parseInt(v) > 0;
      })
      .map((r) => {
        const mode = hs.pricingModes[r.articleCode] ?? "per_bale";
        return {
          articleCode: r.articleCode,
          productName: r.productName,
          quantity: parseInt(hs.quantities[r.articleCode]),
          pricePerBale: mode === "per_kg" ? "0" : hs.sellingPrices[r.articleCode] || "0",
          productionPricePerBale: "0",
          pricingMode: mode,
          ...(mode === "per_kg" ? { pricePerKg: hs.kgPrices[r.articleCode] || "0" } : {}),
        };
      });

    const n = hs.containerNames.length;
    // Warning: check shortages using corrected formula
    // balance = stockAvailable - totalLoaded - newRequest; negative = shortage
    const shortages = lines.filter((l) => {
      const row = articleRows.find((r) => r.articleCode === l.articleCode);
      if (!row) return false;
      const balance = row.stockAvailable - row.totalLoaded - l.quantity * n;
      return balance < 0;
    });
    if (shortages.length > 0 && hs.sendToLoading) {
      const msgs = shortages.map((l) => {
        const row = articleRows.find((r) => r.articleCode === l.articleCode)!;
        const shortBy = Math.abs(row.stockAvailable - row.totalLoaded - l.quantity * n);
        return `${l.productName} short by ${shortBy}`;
      });
      hs.toast({
        title: "Stock shortage warning",
        description: `${msgs.join("; ")}. You can continue but more bales must be created before loading completes.`,
        variant: "destructive",
      });
    }

    hs.createMutation.mutate({
      customerId: parseInt(hs.customerId),
      name: hs.proformaName.trim(),
      destination: hs.destination.trim(),
      isActive: hs.isActive,
      lines,
      sendToLoading: hs.sendToLoading,
      containerNames: hs.sendToLoading ? hs.containerNames : [],
    });
  }

  const map = hs.productMap();
  const n = hs.sendToLoading ? hs.containerNames.length : 0;

  function isGarbageOrWipers(row: ArticleRow) {
    const name = row.productName.toLowerCase();
    return name.includes("wiper") || name.includes("garbage");
  }

  const garbageWipersCount = articleRows.filter(isGarbageOrWipers).length;

  const totalQty = articleRows.reduce((s, r) => {
    const v = parseInt(hs.quantities[r.articleCode] || "0");
    return s + (isNaN(v) || v < 0 ? 0 : v);
  }, 0);
  const totalExpected = hs.sendToLoading && n > 0 ? totalQty * n : totalQty;
  const totalKg = articleRows.reduce((s, r) => {
    const qty = parseInt(hs.quantities[r.articleCode] || "0");
    if (isNaN(qty) || qty <= 0) return s;
    const p = map.get(r.articleCode);
    const w = parseFloat(p?.weightPerBaleKg || "0");
    return s + qty * w;
  }, 0);

  const filledLines = articleRows.filter((r) => {
    const v = hs.quantities[r.articleCode];
    return v && parseInt(v) > 0;
  }).length;

  const warningCount = articleRows.filter((r) => {
    const qty = parseInt(hs.quantities[r.articleCode] || "0");
    if (isNaN(qty) || qty <= 0) return false;
    const request = hs.sendToLoading && n > 0 ? qty * n : qty;
    return r.stockAvailable - r.totalLoaded - request < 0;
  }).length;

  const zeroItemCount = articleRows.filter((r) => r.stockAvailable === 0).length;
  const nonPositiveCount = articleRows.filter((r) => r.freeToPromise <= 0).length;

  const totalValue = articleRows.reduce((s, r) => {
    const qty = parseInt(hs.quantities[r.articleCode] || "0");
    if (isNaN(qty) || qty <= 0) return s;
    const mode = hs.pricingModes[r.articleCode] ?? "per_bale";
    if (mode === "per_kg") {
      const pkgRate = parseFloat(hs.kgPrices[r.articleCode] || "0");
      const p = map.get(r.articleCode);
      const avgWt = parseFloat(p?.weightPerBaleKg || "0");
      return s + qty * avgWt * pkgRate;
    }
    const price = parseFloat(hs.sellingPrices[r.articleCode] || "0");
    return s + qty * price;
  }, 0);

  const negativeCount = articleRows.filter((r) => r.freeToPromise < 0).length;

  const visibleRows = (() => {
    if (hs.showNegativeOnly) {
      let base = articleRows.filter((r) => r.freeToPromise < 0);
      if (hs.articleSearch.trim()) {
        const q = hs.articleSearch.toLowerCase();
        base = base.filter((r) => r.productName.toLowerCase().includes(q) || r.articleCode.toLowerCase().includes(q));
      }
      if (hs.catalogFilter !== "__all__")
        base = base.filter((r) => (r.categoryName?.trim() || "__uncategorized__") === hs.catalogFilter);
      return base;
    }
    let base = hs.showZeroItems ? articleRows : articleRows.filter((r) => r.stockAvailable > 0 || r.expectedToLoad > 0);
    if (hs.hideNonPositive) base = base.filter((r) => r.freeToPromise > 0);
    if (!hs.showGarbageWipers)
      base = base.filter(
        (r) => !isGarbageOrWipers(r) || (hs.quantities[r.articleCode] && parseInt(hs.quantities[r.articleCode]) > 0)
      );
    if (hs.articleSearch.trim()) {
      const q = hs.articleSearch.toLowerCase();
      base = base.filter((r) => r.productName.toLowerCase().includes(q) || r.articleCode.toLowerCase().includes(q));
    }
    if (hs.catalogFilter !== "__all__")
      base = base.filter((r) => (r.categoryName?.trim() || "__uncategorized__") === hs.catalogFilter);
    return base;
  })();

  const visibleTotalBalance = visibleRows.reduce((s, r) => s + r.freeToPromise, 0);

  return {
    customerId: hs.customerId,
    setCustomerId: hs.setCustomerId,
    proformaName: hs.proformaName,
    setProformaName: hs.setProformaName,
    destination: hs.destination,
    setDestination: hs.setDestination,
    isActive: hs.isActive,
    setIsActive: hs.setIsActive,
    quantities: hs.quantities,
    setQuantities: hs.setQuantities,
    sellingPrices: hs.sellingPrices,
    setSellingPrices: hs.setSellingPrices,
    sendToLoading: hs.sendToLoading,
    setSendToLoading: hs.setSendToLoading,
    containerCount: hs.containerCount,
    setContainerCount: hs.setContainerCount,
    containerNames: hs.containerNames,
    pricingModes: hs.pricingModes,
    setPricingModes: hs.setPricingModes,
    kgPrices: hs.kgPrices,
    setKgPrices: hs.setKgPrices,
    draftStatus: hs.draftStatus,
    appliedPrice: hs.appliedPrice,
    setAppliedPrice: hs.setAppliedPrice,
    errors: hs.errors,
    setErrors: hs.setErrors,
    showZeroItems: hs.showZeroItems,
    setShowZeroItems: hs.setShowZeroItems,
    hideNonPositive: hs.hideNonPositive,
    setHideNonPositive: hs.setHideNonPositive,
    showNegativeOnly: hs.showNegativeOnly,
    setShowNegativeOnly: hs.setShowNegativeOnly,
    showGarbageWipers: hs.showGarbageWipers,
    setShowGarbageWipers: hs.setShowGarbageWipers,
    articleSearch: hs.articleSearch,
    setArticleSearch: hs.setArticleSearch,
    catalogFilter: hs.catalogFilter,
    setCatalogFilter: hs.setCatalogFilter,
    catalogCategories: hs.catalogCategories,
    qtyRefs: hs.qtyRefs,
    customersQuery: hs.customersQuery,
    productsQuery: hs.productsQuery,
    customerPriceListQuery: hs.customerPriceListQuery,
    createMutation: hs.createMutation,
    handleQtyChange,
    handleQtyKeyDown,
    applyCatalogSellingPrice,
    applyCatalogProductionPrice,
    updateContainerName,
    addContainer,
    removeContainer,
    handleSubmit,
    map,
    n,
    garbageWipersCount,
    totalQty,
    totalExpected,
    totalKg,
    filledLines,
    warningCount,
    zeroItemCount,
    nonPositiveCount,
    totalValue,
    negativeCount,
    visibleRows,
    visibleTotalBalance,
  };
}
