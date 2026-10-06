import type { ClientErrorLike } from "@/lib/clientError";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { ArticleRow, BaleProduct, Draft, FactoryCustomer, Props } from "./types";
import { clearDraft, loadDraft, saveDraft } from "./utils";

export function useCreateProformaV5Model({ open, onClose, articleRows, onSuccess }: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const draft = loadDraft();
  const [customerId, setCustomerId] = useState(draft?.customerId ?? "");
  const [proformaName, setProformaName] = useState(draft?.proformaName ?? "");
  const [isActive, setIsActive] = useState(draft?.isActive ?? true);
  const [quantities, setQuantities] = useState<Record<string, string>>(draft?.quantities ?? {});
  const [sellingPrices, setSellingPrices] = useState<Record<string, string>>(draft?.sellingPrices ?? {});
  const [sendToLoading, setSendToLoading] = useState(draft?.sendToLoading ?? false);
  const [containerCount, setContainerCount] = useState(draft?.containerCount ?? "1");
  const [containerNames, setContainerNames] = useState<string[]>(draft?.containerNames ?? ["Container 1"]);
  const [pricingModes, setPricingModes] = useState<Record<string, "per_bale" | "per_kg">>({});
  const [kgPrices, setKgPrices] = useState<Record<string, string>>({});
  const [draftStatus, setDraftStatus] = useState<"idle" | "saved">("idle");
  const [appliedPrice, setAppliedPrice] = useState<"sell" | "prod" | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showZeroItems, setShowZeroItems] = useState(false);
  const [hideNonPositive, setHideNonPositive] = useState(false);
  const [showNegativeOnly, setShowNegativeOnly] = useState(false);
  const [showGarbageWipers, setShowGarbageWipers] = useState(false);
  const [articleSearch, setArticleSearch] = useState("");
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const qtyRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Reset to blank every time the dialog opens
  useEffect(() => {
    if (open) {
      clearDraft();
      setCustomerId("");
      setProformaName("");
      setIsActive(true);
      setQuantities({});
      setSellingPrices({});
      setPricingModes({});
      setKgPrices({});
      setSendToLoading(false);
      setContainerCount("1");
      setContainerNames(["Container 1"]);
      setAppliedPrice(null);
      setErrors({});
      setShowZeroItems(false);
      setHideNonPositive(false);
      setShowNegativeOnly(false);
      setShowGarbageWipers(false);
      setArticleSearch("");
    }
  }, [open]);

  // When container count changes, regenerate default names (preserving user edits)
  useEffect(() => {
    const n = Math.max(1, Math.min(100, parseInt(containerCount) || 1));
    setContainerNames((prev) => {
      const next = [...prev];
      while (next.length < n) next.push(`Container ${next.length + 1}`);
      return next.slice(0, n);
    });
  }, [containerCount]);

  const customersQuery = useQuery<FactoryCustomer[]>({
    queryKey: ["/api/factory/customers"],
    queryFn: async () => {
      const res = await fetch("/api/factory/customers", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load customers");
      return res.json();
    },
    enabled: open,
  });

  const productsQuery = useQuery<BaleProduct[]>({
    queryKey: ["/api/factory/bale-products"],
    queryFn: async () => {
      const res = await fetch("/api/factory/bale-products", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load products");
      return res.json();
    },
    enabled: open,
  });

  // Customer agreed price list — fetched whenever a customer is selected
  const customerPriceListQuery = useQuery<{ article_code: string; price_per_bale: string }[]>({
    queryKey: ["/api/factory/customer-price-lists", customerId],
    queryFn: async () => {
      if (!customerId) return [];
      const res = await fetch(`/api/factory/customer-price-lists/${customerId}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: open && !!customerId,
    staleTime: 30_000,
  });

  // Auto-fill customer agreed prices whenever customer changes (without overwriting already-entered prices)
  useEffect(() => {
    if (!customerPriceListQuery.data || customerPriceListQuery.data.length === 0) return;
    const priceMap = new Map(customerPriceListQuery.data.map((r) => [r.article_code, r.price_per_bale]));
    setSellingPrices((prev) => {
      const next = { ...prev };
      for (const row of articleRows) {
        const agreed = priceMap.get(row.articleCode);
        if (agreed && parseFloat(agreed) > 0) next[row.articleCode] = agreed;
      }
      return next;
    });
    setAppliedPrice("customer" as React.SetStateAction<"sell" | "prod" | null>);
  }, [customerPriceListQuery.data, articleRows]);

  const productMap = useCallback((): Map<string, BaleProduct> => {
    const m = new Map<string, BaleProduct>();
    for (const p of productsQuery.data || []) {
      m.set(p.code, p);
      if (p.articleCode) m.set(p.articleCode, p);
    }
    return m;
  }, [productsQuery.data]);

  useEffect(() => {
    if (!productsQuery.data) return;
    const map = productMap();
    setSellingPrices((prev) => {
      const next = { ...prev };
      for (const row of articleRows) {
        if (!next[row.articleCode]) {
          const p = map.get(row.articleCode);
          if (p?.sellingPrice && parseFloat(p.sellingPrice) > 0) next[row.articleCode] = p.sellingPrice;
        }
      }
      return next;
    });
  }, [productsQuery.data, articleRows, productMap]);

  function resetForm() {
    setCustomerId("");
    setProformaName("");
    setIsActive(true);
    setQuantities({});
    setSellingPrices({});
    setSendToLoading(false);
    setContainerCount("1");
    setContainerNames(["Container 1"]);
    setAppliedPrice(null);
    setErrors({});
    setShowZeroItems(false);
    setHideNonPositive(false);
    setShowNegativeOnly(false);
    setShowGarbageWipers(false);
  }

  const createMutation = useMutation({
    mutationFn: async (payload: object) => apiRequest("POST", "/api/factory/v5/proforma-with-loading", payload),
    onSuccess: async () => {
      // Auto-save any non-zero prices to the customer's price list
      if (customerId) {
        const priceLines = Object.entries(sellingPrices)
          .filter(([, price]) => parseFloat(price) > 0)
          .map(([articleCode, pricePerBale]) => ({ articleCode, pricePerBale }));
        if (priceLines.length > 0) {
          try {
            await fetch(`/api/factory/customer-price-lists/${customerId}`, {
              method: "PUT",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(priceLines),
            });
            qc.invalidateQueries({ queryKey: ["/api/factory/customer-price-lists", customerId] });
          } catch {
            // Cache invalidation is best-effort; the next fetch corrects it and a failure here is not worth surfacing.
          }
        }
      }
      clearDraft();
      resetForm();
      qc.invalidateQueries({ queryKey: ["/api/factory/v5/stock-allocation"], refetchType: "active" });
      toast({
        title: "Proforma created",
        description: sendToLoading
          ? `Proforma + ${containerNames.length} loading container(s) created.`
          : "Stock allocation has been refreshed.",
      });
      onClose();
      onSuccess();
    },
    onError: (e: ClientErrorLike) => {
      toast({ title: "Failed to create proforma", description: e.message, variant: "destructive" });
    },
  });

  const triggerAutosave = useCallback((data: Draft) => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      saveDraft(data);
      setDraftStatus("saved");
      if (draftStatusTimer.current) clearTimeout(draftStatusTimer.current);
      draftStatusTimer.current = setTimeout(() => setDraftStatus("idle"), 2000);
    }, 800);
  }, []);

  // Pending autosave timers must not fire after the drawer unmounts.
  useEffect(
    () => () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
      if (draftStatusTimer.current) clearTimeout(draftStatusTimer.current);
    },
    []
  );

  useEffect(() => {
    triggerAutosave({
      customerId,
      proformaName,
      isActive,
      quantities,
      sellingPrices,
      sendToLoading,
      containerCount,
      containerNames,
      savedAt: Date.now(),
    });
  }, [
    customerId,
    proformaName,
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
    setQuantities((prev) => ({ ...prev, [code]: val }));
    setErrors((prev) => {
      const n = { ...prev };
      delete n[`qty_${code}`];
      return n;
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

  function applyCatalogSellingPrice() {
    const m = productMap();
    const next: Record<string, string> = {};
    for (const row of articleRows) {
      const p = m.get(row.articleCode);
      if (p?.sellingPrice && parseFloat(p.sellingPrice) > 0) next[row.articleCode] = p.sellingPrice;
    }
    setSellingPrices((prev) => ({ ...prev, ...next }));
  }

  function applyCatalogProductionPrice() {
    const m = productMap();
    const next: Record<string, string> = {};
    for (const row of articleRows) {
      const p = m.get(row.articleCode);
      if (p?.productionPrice && parseFloat(p.productionPrice) > 0) next[row.articleCode] = p.productionPrice;
    }
    setSellingPrices((prev) => ({ ...prev, ...next }));
  }

  function updateContainerName(idx: number, val: string) {
    setContainerNames((prev) => {
      const next = [...prev];
      next[idx] = val;
      return next;
    });
  }

  function addContainer() {
    setContainerNames((prev) => [...prev, `Container ${prev.length + 1}`]);
    setContainerCount((prev) => String(parseInt(prev || "1") + 1));
  }
  function removeContainer(idx: number) {
    setContainerNames((prev) => prev.filter((_, i) => i !== idx));
    setContainerCount((prev) => String(Math.max(1, parseInt(prev || "1") - 1)));
  }

  function validate(): boolean {
    const errs: Record<string, string> = {};
    if (!customerId) errs.customerId = "Customer is required";
    if (!proformaName.trim()) errs.proformaName = "Proforma name is required";
    const hasQty = articleRows.some((r) => {
      const v = quantities[r.articleCode];
      return v && parseInt(v) > 0;
    });
    if (!hasQty) errs.lines = "Enter at least one quantity";
    articleRows.forEach((r) => {
      const v = quantities[r.articleCode];
      if (!v || v === "") return;
      const n = parseInt(v);
      if (isNaN(n)) errs[`qty_${r.articleCode}`] = "Must be a number";
      else if (n < 0) errs[`qty_${r.articleCode}`] = "Cannot be negative";
    });
    if (sendToLoading && containerNames.length === 0) errs.containers = "Add at least one container";
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function handleSubmit() {
    if (!validate()) return;
    const lines = articleRows
      .filter((r) => {
        const v = quantities[r.articleCode];
        return v && parseInt(v) > 0;
      })
      .map((r) => {
        const mode = pricingModes[r.articleCode] ?? "per_bale";
        return {
          articleCode: r.articleCode,
          productName: r.productName,
          quantity: parseInt(quantities[r.articleCode]),
          pricePerBale: mode === "per_kg" ? "0" : sellingPrices[r.articleCode] || "0",
          productionPricePerBale: "0",
          pricingMode: mode,
          ...(mode === "per_kg" ? { pricePerKg: kgPrices[r.articleCode] || "0" } : {}),
        };
      });

    const n = containerNames.length;
    // Warning: check shortages using corrected formula
    // balance = stockAvailable - totalLoaded - newRequest; negative = shortage
    const shortages = lines.filter((l) => {
      const row = articleRows.find((r) => r.articleCode === l.articleCode);
      if (!row) return false;
      const balance = row.stockAvailable - row.totalLoaded - l.quantity * n;
      return balance < 0;
    });
    if (shortages.length > 0 && sendToLoading) {
      const msgs = shortages.map((l) => {
        const row = articleRows.find((r) => r.articleCode === l.articleCode)!;
        const shortBy = Math.abs(row.stockAvailable - row.totalLoaded - l.quantity * n);
        return `${l.productName} short by ${shortBy}`;
      });
      toast({
        title: "Stock shortage warning",
        description: `${msgs.join("; ")}. You can continue but more bales must be created before loading completes.`,
        variant: "destructive",
      });
    }

    createMutation.mutate({
      customerId: parseInt(customerId),
      name: proformaName.trim(),
      isActive,
      lines,
      sendToLoading,
      containerNames: sendToLoading ? containerNames : [],
    });
  }

  const map = productMap();
  const n = sendToLoading ? containerNames.length : 0;

  function isGarbageOrWipers(row: ArticleRow) {
    const name = row.productName.toLowerCase();
    return name.includes("wiper") || name.includes("garbage");
  }

  const garbageWipersCount = articleRows.filter(isGarbageOrWipers).length;

  const totalQty = articleRows.reduce((s, r) => {
    const v = parseInt(quantities[r.articleCode] || "0");
    return s + (isNaN(v) || v < 0 ? 0 : v);
  }, 0);
  const totalExpected = sendToLoading && n > 0 ? totalQty * n : totalQty;
  const totalKg = articleRows.reduce((s, r) => {
    const qty = parseInt(quantities[r.articleCode] || "0");
    if (isNaN(qty) || qty <= 0) return s;
    const p = map.get(r.articleCode);
    const w = parseFloat(p?.weightPerBaleKg || "0");
    return s + qty * w;
  }, 0);

  const filledLines = articleRows.filter((r) => {
    const v = quantities[r.articleCode];
    return v && parseInt(v) > 0;
  }).length;

  const warningCount = articleRows.filter((r) => {
    const qty = parseInt(quantities[r.articleCode] || "0");
    if (isNaN(qty) || qty <= 0) return false;
    const request = sendToLoading && n > 0 ? qty * n : qty;
    return r.stockAvailable - r.totalLoaded - request < 0;
  }).length;

  const zeroItemCount = articleRows.filter((r) => r.stockAvailable === 0).length;
  const nonPositiveCount = articleRows.filter((r) => r.freeToPromise <= 0).length;

  const totalValue = articleRows.reduce((s, r) => {
    const qty = parseInt(quantities[r.articleCode] || "0");
    if (isNaN(qty) || qty <= 0) return s;
    const mode = pricingModes[r.articleCode] ?? "per_bale";
    if (mode === "per_kg") {
      const pkgRate = parseFloat(kgPrices[r.articleCode] || "0");
      const p = map.get(r.articleCode);
      const avgWt = parseFloat(p?.weightPerBaleKg || "0");
      return s + qty * avgWt * pkgRate;
    }
    const price = parseFloat(sellingPrices[r.articleCode] || "0");
    return s + qty * price;
  }, 0);

  const negativeCount = articleRows.filter((r) => r.freeToPromise < 0).length;

  const visibleRows = (() => {
    if (showNegativeOnly) {
      let base = articleRows.filter((r) => r.freeToPromise < 0);
      if (articleSearch.trim()) {
        const q = articleSearch.toLowerCase();
        base = base.filter((r) => r.productName.toLowerCase().includes(q) || r.articleCode.toLowerCase().includes(q));
      }
      return base;
    }
    let base = showZeroItems ? articleRows : articleRows.filter((r) => r.stockAvailable > 0 || r.expectedToLoad > 0);
    if (hideNonPositive) base = base.filter((r) => r.freeToPromise > 0);
    if (!showGarbageWipers)
      base = base.filter(
        (r) => !isGarbageOrWipers(r) || (quantities[r.articleCode] && parseInt(quantities[r.articleCode]) > 0)
      );
    if (articleSearch.trim()) {
      const q = articleSearch.toLowerCase();
      base = base.filter((r) => r.productName.toLowerCase().includes(q) || r.articleCode.toLowerCase().includes(q));
    }
    return base;
  })();

  const visibleTotalBalance = visibleRows.reduce((s, r) => s + r.freeToPromise, 0);

  return {
    customerId,
    setCustomerId,
    proformaName,
    setProformaName,
    isActive,
    setIsActive,
    quantities,
    setQuantities,
    sellingPrices,
    setSellingPrices,
    sendToLoading,
    setSendToLoading,
    containerCount,
    setContainerCount,
    containerNames,
    pricingModes,
    setPricingModes,
    kgPrices,
    setKgPrices,
    draftStatus,
    appliedPrice,
    setAppliedPrice,
    errors,
    setErrors,
    showZeroItems,
    setShowZeroItems,
    hideNonPositive,
    setHideNonPositive,
    showNegativeOnly,
    setShowNegativeOnly,
    showGarbageWipers,
    setShowGarbageWipers,
    articleSearch,
    setArticleSearch,
    qtyRefs,
    customersQuery,
    productsQuery,
    customerPriceListQuery,
    createMutation,
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
