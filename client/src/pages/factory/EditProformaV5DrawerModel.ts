// Extracted from ./EditProformaV5Drawer.tsx: state, queries and handlers for EditProformaV5Drawer.
import { useEditProformaV5DrawerState, type ArticleRow, type Props } from "./useEditProformaV5DrawerState";

export function useEditProformaV5DrawerModel(props: Props) {
  const {
    appliedPrice,
    applyCatalogProductionPrice,
    applyCatalogSellingPrice,
    articleRows,
    articleSearch,
    catalogCategories,
    catalogFilter,
    customerPriceListQuery,
    destination,
    hideNonPositive,
    initialized,
    isActive,
    kgPrices,
    onClose,
    prices,
    pricingModes,
    productMap,
    productsQuery,
    proformaName,
    proformaQuery,
    qtyRefs,
    quantities,
    saveMutation,
    setAppliedPrice,
    setArticleSearch,
    setCatalogFilter,
    setDestination,
    setHideNonPositive,
    setIsActive,
    setKgPrices,
    setPrices,
    setPricingModes,
    setProformaName,
    setQuantities,
    setShowGarbageWipers,
    setShowZeroItems,
    showGarbageWipers,
    showZeroItems,
    toast,
  } = useEditProformaV5DrawerState(props);

  function applySavedAgreedPrices() {
    const availableCodes = new Set(articleRows.map((row) => row.articleCode));
    const agreedPrices: Record<string, string> = {};
    for (const row of customerPriceListQuery.data ?? []) {
      if (availableCodes.has(row.article_code) && Number(row.price_per_bale) > 0) {
        agreedPrices[row.article_code] = row.price_per_bale;
      }
    }
    const matchedCodes = Object.keys(agreedPrices);
    if (matchedCodes.length === 0) {
      toast({
        title: "No matching agreed prices",
        description: "No saved customer prices match the articles in this allocation.",
      });
      return;
    }

    // Agreed prices are saved per bale. Switching matched rows to /bale ensures
    // the new price is visible and persisted instead of keeping a stale /kg rate.
    setPrices((prev) => ({ ...prev, ...agreedPrices }));
    setPricingModes((prev) => {
      const next = { ...prev };
      for (const code of matchedCodes) next[code] = "per_bale";
      return next;
    });
    setAppliedPrice("customer");
    toast({
      title: "Agreed prices applied",
      description: `${matchedCodes.length} matching article price${matchedCodes.length === 1 ? "" : "s"} updated. Click Save to save the proforma.`,
    });
  }

  function handleQtyKeyDown(e: React.KeyboardEvent<HTMLInputElement>, rowIdx: number) {
    if (e.key === "ArrowDown" || e.key === "Enter") {
      e.preventDefault();
      const next = qtyRefs.current[rowIdx + 1];
      if (next) {
        next.focus();
        next.select();
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = qtyRefs.current[rowIdx - 1];
      if (prev) {
        prev.focus();
        prev.select();
      }
    } else if (e.key === "Escape") {
      e.currentTarget.blur();
    }
  }

  const map = productMap();

  function isGarbageOrWipers(row: ArticleRow) {
    const n = row.productName.toLowerCase();
    return n.includes("wiper") || n.includes("garbage");
  }

  const zeroItemCount = articleRows.filter((r) => r.stockAvailable === 0).length;
  const nonPositiveCount = articleRows.filter((r) => r.freeToPromise <= 0).length;
  const garbageWipersCount = articleRows.filter(isGarbageOrWipers).length;

  const existingLineCodes = new Set((proformaQuery.data?.lines ?? []).map((l) => l.articleCode));

  // Keep rows that have existing/entered quantities even when hiding zeros
  const visibleRows = (() => {
    let base = showZeroItems
      ? articleRows
      : articleRows.filter(
          (r) =>
            r.stockAvailable > 0 ||
            r.expectedToLoad > 0 ||
            (quantities[r.articleCode] && parseInt(quantities[r.articleCode]) > 0)
        );
    if (hideNonPositive)
      base = base.filter(
        (r) => r.freeToPromise > 0 || (quantities[r.articleCode] && parseInt(quantities[r.articleCode]) > 0)
      );
    if (!showGarbageWipers)
      base = base.filter(
        (r) =>
          !isGarbageOrWipers(r) ||
          existingLineCodes.has(r.articleCode) ||
          (quantities[r.articleCode] && parseInt(quantities[r.articleCode]) > 0)
      );
    if (catalogFilter !== "__all__")
      base = base.filter((r) => (r.categoryName?.trim() || "__uncategorized__") === catalogFilter);
    if (articleSearch.trim()) {
      const term = articleSearch.trim().toLowerCase();
      base = base.filter(
        (row) => row.productName.toLowerCase().includes(term) || row.articleCode.toLowerCase().includes(term)
      );
    }
    return base.slice().sort((a, b) => a.productName.localeCompare(b.productName));
  })();

  const visibleTotalBalance = visibleRows.reduce((s, r) => s + r.freeToPromise, 0);

  // Display-only totals must match the currently visible stock-allocation rows.
  // Saving still includes quantities for every article, even if a filter hides it.
  const filledLines = visibleRows.filter((r) => {
    const v = quantities[r.articleCode];
    return v && parseInt(v) > 0;
  }).length;
  const totalQty = visibleRows.reduce((s, r) => {
    const v = parseInt(quantities[r.articleCode] || "0");
    return s + (isNaN(v) || v < 0 ? 0 : v);
  }, 0);
  const totalKg = visibleRows.reduce((s, r) => {
    const qty = parseInt(quantities[r.articleCode] || "0");
    if (isNaN(qty) || qty <= 0) return s;
    const p = map.get(r.articleCode);
    const w = parseFloat(p?.weightPerBaleKg || "0");
    return s + qty * w;
  }, 0);
  const totalValue = visibleRows.reduce((s, r) => {
    const qty = parseInt(quantities[r.articleCode] || "0");
    if (isNaN(qty) || qty <= 0) return s;
    const mode = pricingModes[r.articleCode] ?? "per_bale";
    if (mode === "per_kg") {
      const pkgRate = parseFloat(kgPrices[r.articleCode] || "0");
      const p = map.get(r.articleCode);
      const avgWt = parseFloat(p?.weightPerBaleKg || "0");
      return s + qty * avgWt * pkgRate;
    }
    const price = parseFloat(prices[r.articleCode] || "0");
    return s + qty * price;
  }, 0);
  const warningCount = visibleRows.filter((r) => {
    const qty = parseInt(quantities[r.articleCode] || "0");
    return !isNaN(qty) && qty > 0 && r.freeToPromise < 0;
  }).length;

  const isLoading = proformaQuery.isLoading;

  return {
    appliedPrice,
    applyCatalogProductionPrice,
    applyCatalogSellingPrice,
    articleRows,
    articleSearch,
    catalogCategories,
    catalogFilter,
    customerPriceListQuery,
    destination,
    hideNonPositive,
    initialized,
    isActive,
    kgPrices,
    onClose,
    prices,
    pricingModes,
    productsQuery,
    proformaName,
    proformaQuery,
    qtyRefs,
    quantities,
    saveMutation,
    setAppliedPrice,
    setArticleSearch,
    setCatalogFilter,
    setDestination,
    setHideNonPositive,
    setIsActive,
    setKgPrices,
    setPrices,
    setPricingModes,
    setProformaName,
    setQuantities,
    setShowGarbageWipers,
    setShowZeroItems,
    showGarbageWipers,
    showZeroItems,
    applySavedAgreedPrices,
    handleQtyKeyDown,
    map,
    zeroItemCount,
    nonPositiveCount,
    garbageWipersCount,
    visibleRows,
    visibleTotalBalance,
    filledLines,
    totalQty,
    totalKg,
    totalValue,
    warningCount,
    isLoading,
  };
}

export type EditProformaV5DrawerModel = ReturnType<typeof useEditProformaV5DrawerModel>;
