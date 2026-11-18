// Extracted from ./CreateProformaDrawer.tsx: state, queries and handlers for CreateProformaDrawer.
import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { FactoryCustomer, BaleProduct, Draft, Props } from "./CreateProformaDrawer";
import { loadDraft, clearDraft, saveDraft } from "./CreateProformaDrawer";

export function useCreateProformaDrawerModel({
  open,
  onClose,
  articleRows,
  onSuccess,
}: {
  open: Props["open"];
  onClose: Props["onClose"];
  articleRows: Props["articleRows"];
  onSuccess: Props["onSuccess"];
}) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const draft = loadDraft();
  const [customerId, setCustomerId] = useState(draft?.customerId ?? "");
  const [proformaName, setProformaName] = useState(draft?.proformaName ?? "");
  const [destination, setDestination] = useState(draft?.destination ?? "");
  const [isActive, setIsActive] = useState(draft?.isActive ?? true);
  const [quantities, setQuantities] = useState<Record<string, string>>(draft?.quantities ?? {});
  const [sellingPrices, setSellingPrices] = useState<Record<string, string>>(draft?.sellingPrices ?? {});
  const [productionPrices, setProductionPrices] = useState<Record<string, string>>(draft?.productionPrices ?? {});
  const [draftStatus, setDraftStatus] = useState<"idle" | "saved">("idle");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showZeroItems, setShowZeroItems] = useState(false);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const qtyRefs = useRef<(HTMLInputElement | null)[]>([]);

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

  const productMap = useCallback((): Map<string, BaleProduct> => {
    const m = new Map<string, BaleProduct>();
    for (const p of productsQuery.data || []) {
      m.set(p.code, p);
      if (p.articleCode) m.set(p.articleCode, p);
    }
    return m;
  }, [productsQuery.data]);

  // When products load, populate price defaults from product data (only if not already in draft)
  useEffect(() => {
    if (!productsQuery.data) return;
    const map = productMap();
    setSellingPrices((prev) => {
      const next = { ...prev };
      for (const row of articleRows) {
        if (!next[row.articleCode]) {
          const p = map.get(row.articleCode);
          if (p?.sellingPrice && parseFloat(p.sellingPrice) > 0) {
            next[row.articleCode] = p.sellingPrice;
          }
        }
      }
      return next;
    });
    setProductionPrices((prev) => {
      const next = { ...prev };
      for (const row of articleRows) {
        if (!next[row.articleCode]) {
          const p = map.get(row.articleCode);
          if (p?.productionPrice && parseFloat(p.productionPrice) > 0) {
            next[row.articleCode] = p.productionPrice;
          }
        }
      }
      return next;
    });
  }, [productsQuery.data, articleRows, productMap]);

  const createMutation = useMutation({
    mutationFn: async (payload: object) => apiRequest("POST", "/api/factory/customer-proformas/bulk", payload),
    onSuccess: () => {
      clearDraft();
      qc.invalidateQueries({ queryKey: ["/api/factory/v2/stock-allocation"] });
      toast({ title: "Proforma created", description: "Stock allocation has been refreshed." });
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
      setTimeout(() => setDraftStatus("idle"), 2000);
    }, 800);
  }, []);

  useEffect(() => {
    triggerAutosave({
      customerId,
      proformaName,
      destination,
      isActive,
      quantities,
      sellingPrices,
      productionPrices,
      savedAt: Date.now(),
    });
  }, [customerId, proformaName, destination, isActive, quantities, sellingPrices, productionPrices, triggerAutosave]);

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
    // Both buttons target the single visible price column (sellingPrices)
    setSellingPrices((prev) => ({ ...prev, ...next }));
  }

  function validate(): boolean {
    const errs: Record<string, string> = {};
    if (!customerId) errs.customerId = "Customer is required";
    if (!proformaName.trim()) errs.proformaName = "Proforma name is required";
    if (!destination.trim()) errs.destination = "Destination is required";
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
      .map((r) => ({
        articleCode: r.articleCode,
        productName: r.displayName,
        quantity: parseInt(quantities[r.articleCode]),
        pricePerBale: sellingPrices[r.articleCode] || "0",
        productionPricePerBale: productionPrices[r.articleCode] || "0",
      }));
    createMutation.mutate({
      customerId: parseInt(customerId),
      name: proformaName.trim(),
      destination: destination.trim(),
      isActive,
      lines,
    });
  }

  const map = productMap();
  const totalQty = articleRows.reduce((s, r) => {
    const n = parseInt(quantities[r.articleCode] || "0");
    return s + (isNaN(n) || n < 0 ? 0 : n);
  }, 0);
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
    const n = parseInt(quantities[r.articleCode] || "0");
    return !isNaN(n) && n > r.freeToPromise && n > 0;
  }).length;
  const zeroItemCount = articleRows.filter((r) => r.onHand === 0).length;
  const visibleRows = showZeroItems ? articleRows : articleRows.filter((r) => r.onHand > 0);

  return {
    customerId,
    setCustomerId,
    proformaName,
    setProformaName,
    destination,
    setDestination,
    isActive,
    setIsActive,
    quantities,
    sellingPrices,
    setSellingPrices,
    draftStatus,
    errors,
    setErrors,
    showZeroItems,
    setShowZeroItems,
    qtyRefs,
    customersQuery,
    createMutation,
    handleQtyChange,
    handleQtyKeyDown,
    applyCatalogSellingPrice,
    applyCatalogProductionPrice,
    handleSubmit,
    map,
    totalQty,
    totalKg,
    filledLines,
    warningCount,
    zeroItemCount,
    visibleRows,
  };
}

export type CreateProformaDrawerModel = ReturnType<typeof useCreateProformaDrawerModel>;
