// Extracted from ./useCreateProformaV5Model.ts: draft, customer and catalogue state for the V5 proforma drawer.
import type { ClientErrorLike } from "@/lib/clientError";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { BaleProduct, Draft, FactoryCustomer, Props } from "./types";
import { clearDraft, loadDraft, saveDraft } from "./utils";

export function useCreateProformaV5DataModel({
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
  const [sendToLoading, setSendToLoading] = useState(draft?.sendToLoading ?? false);
  const [containerCount, setContainerCount] = useState(draft?.containerCount ?? "1");
  const [containerNames, setContainerNames] = useState<string[]>(draft?.containerNames ?? ["Container 1"]);
  const [pricingModes, setPricingModes] = useState<Record<string, "per_bale" | "per_kg">>({});
  const [kgPrices, setKgPrices] = useState<Record<string, string>>({});
  const [draftStatus, setDraftStatus] = useState<"idle" | "saved">("idle");
  const [appliedPrice, setAppliedPrice] = useState<"sell" | "prod" | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showZeroItems, setShowZeroItems] = useState(true);
  const [hideNonPositive, setHideNonPositive] = useState(false);
  const [showNegativeOnly, setShowNegativeOnly] = useState(false);
  const [showGarbageWipers, setShowGarbageWipers] = useState(false);
  const [articleSearch, setArticleSearch] = useState("");
  const [catalogFilter, setCatalogFilter] = useState("__all__");
  const catalogCategories = Array.from(
    new Set(articleRows.map((r) => r.categoryName?.trim()).filter((v): v is string => Boolean(v)))
  ).sort((a, b) => a.localeCompare(b));
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const qtyRefs = useRef<(HTMLInputElement | null)[]>([]);
  const lastPriceScopeRef = useRef<string | null>(null);
  const lastAgreedScopeRef = useRef<string | null>(null);

  // Reset to blank every time the dialog opens
  useEffect(() => {
    if (open) {
      clearDraft();
      setCustomerId("");
      setProformaName("");
      setDestination("");
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
      setShowZeroItems(true);
      setHideNonPositive(false);
      setShowNegativeOnly(false);
      setShowGarbageWipers(false);
      setArticleSearch("");
      setCatalogFilter("__all__");
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

  // Price suggestions belong to the selected customer AND destination.
  // Never fall back to another destination's agreed price list.
  const customerPriceListQuery = useQuery<{ article_code: string; price_per_bale: string }[]>({
    queryKey: ["/api/factory/customer-price-lists", customerId, destination.trim().toUpperCase()],
    queryFn: async () => {
      if (!customerId || !destination.trim()) return [];
      const res = await fetch(
        `/api/factory/customer-price-lists/${customerId}?destination=${encodeURIComponent(destination.trim())}`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error("Failed to fetch destination agreed prices");
      return res.json();
    },
    enabled: open && !!customerId && !!destination.trim(),
    staleTime: 30_000,
  });

  // Auto-fill only the chosen customer/destination prices.
  useEffect(() => {
    const scope = `${customerId}:${destination.trim().toUpperCase()}`;
    if (lastPriceScopeRef.current === scope) return;
    lastPriceScopeRef.current = scope;
    lastAgreedScopeRef.current = null;
    if (!customerId || !destination.trim()) return;
    // Switching destinations must not retain the previous destination's prices.
    // Start with catalog defaults, then apply the matching destination's rates.
    const products = productsQuery.data || [];
    const catalog = new Map<string, string>();
    for (const product of products) {
      if (product.sellingPrice && Number(product.sellingPrice) > 0) {
        catalog.set(product.code, product.sellingPrice);
        if (product.articleCode) catalog.set(product.articleCode, product.sellingPrice);
      }
    }
    const next: Record<string, string> = {};
    for (const row of articleRows) {
      const price = catalog.get(row.articleCode);
      if (price) next[row.articleCode] = price;
    }
    setSellingPrices(next);
    setAppliedPrice(null);
  }, [customerId, destination, productsQuery.data, articleRows]);

  useEffect(() => {
    if (!customerPriceListQuery.data || customerPriceListQuery.data.length === 0) return;
    const scope = `${customerId}:${destination.trim().toUpperCase()}`;
    if (lastAgreedScopeRef.current === scope) return;
    lastAgreedScopeRef.current = scope;
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
  }, [customerPriceListQuery.data, articleRows, customerId, destination]);

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
    setShowZeroItems(true);
    setHideNonPositive(false);
    setShowNegativeOnly(false);
    setShowGarbageWipers(false);
  }

  const createMutation = useMutation({
    mutationFn: async (payload: object) => apiRequest("POST", "/api/factory/v5/proforma-with-loading", payload),
    onSuccess: () => {
      // Creating a proforma never rewrites saved agreed-price lists.
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

  return {
    toast,
    customerId,
    setCustomerId,
    proformaName,
    setProformaName,
    destination,
    setDestination,
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
    setContainerNames,
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
    catalogFilter,
    setCatalogFilter,
    catalogCategories,
    qtyRefs,
    customersQuery,
    productsQuery,
    customerPriceListQuery,
    productMap,
    createMutation,
    triggerAutosave,
  };
}
