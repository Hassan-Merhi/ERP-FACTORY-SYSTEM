// Extracted from ./EditProformaV5Drawer.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export interface ArticleRow {
  articleCode: string;
  productName: string;
  categoryName?: string;
  stockAvailable: number;
  totalLoaded: number;
  expectedToLoad: number;
  freeToPromise: number;
}

interface ExistingLine {
  id: number;
  articleCode: string;
  productName: string;
  quantity: number;
  pricePerBale: string;
  weightPerBaleKg: string;
  pricingMode?: string;
  pricePerKg?: string | null;
}

interface ProformaData {
  id: number;
  companyId: number;
  name: string;
  isActive: boolean;
  customerId: number;
  destination?: string | null;
  lines: ExistingLine[];
}

interface AgreedPriceRow {
  article_code: string;
  price_per_bale: string;
}

interface BaleProduct {
  id: number;
  code: string;
  articleCode: string | null;
  weightPerBaleKg: string | null;
  sellingPrice: string | null;
  productionPrice: string | null;
}

export interface Props {
  open: boolean;
  onClose: () => void;
  proformaId: number;
  articleRows: ArticleRow[];
  onSuccess: () => void;
}

export function useEditProformaV5DrawerState({ open, onClose, proformaId, articleRows, onSuccess }: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [proformaName, setProformaName] = useState("");
  const [destination, setDestination] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [pricingModes, setPricingModes] = useState<Record<string, "per_bale" | "per_kg">>({});
  const [kgPrices, setKgPrices] = useState<Record<string, string>>({});
  const [showZeroItems, setShowZeroItems] = useState(true);
  const [hideNonPositive, setHideNonPositive] = useState(false);
  const [showGarbageWipers, setShowGarbageWipers] = useState(false);
  const [catalogFilter, setCatalogFilter] = useState("__all__");
  const [articleSearch, setArticleSearch] = useState("");
  const catalogCategories = Array.from(
    new Set(articleRows.map((r) => r.categoryName?.trim()).filter((v): v is string => Boolean(v)))
  ).sort((a, b) => a.localeCompare(b));
  const [appliedPrice, setAppliedPrice] = useState<"sell" | "prod" | "customer" | null>(null);
  const [initialized, setInitialized] = useState(false);
  const qtyRefs = useRef<(HTMLInputElement | null)[]>([]);

  const proformaQuery = useQuery<ProformaData>({
    queryKey: ["/api/factory/customer-proformas", proformaId],
    queryFn: async () => {
      const res = await fetch(`/api/factory/customer-proformas/${proformaId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load proforma");
      return res.json();
    },
    enabled: open && !!proformaId,
  });

  // Price lookup is always scoped to customer + chosen destination.
  // Linking an old proforma never automatically changes its existing line prices.
  const customerId = proformaQuery.data?.customerId;
  const customerPriceListQuery = useQuery<AgreedPriceRow[]>({
    queryKey: [
      "/api/factory/customer-price-lists",
      customerId,
      proformaQuery.data?.companyId,
      destination.trim().toUpperCase(),
    ],
    queryFn: async () => {
      const res = await fetch(
        `/api/factory/customer-price-lists/${customerId}?destination=${encodeURIComponent(destination.trim())}`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error("Failed to load destination agreed prices");
      return res.json();
    },
    enabled: open && !!customerId && !!proformaQuery.data?.companyId && !!destination.trim(),
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

  // Pre-fill from loaded proforma data
  useEffect(() => {
    if (!proformaQuery.data || initialized) return;
    const pf = proformaQuery.data;
    setProformaName(pf.name);
    setDestination(pf.destination ?? "");
    setIsActive(pf.isActive ?? true);
    const qtys: Record<string, string> = {};
    const prs: Record<string, string> = {};
    const modes: Record<string, "per_bale" | "per_kg"> = {};
    const kgs: Record<string, string> = {};
    for (const line of pf.lines) {
      qtys[line.articleCode] = String(line.quantity);
      prs[line.articleCode] = line.pricePerBale ?? "";
      if (line.pricingMode === "per_kg") {
        modes[line.articleCode] = "per_kg";
        kgs[line.articleCode] = line.pricePerKg ?? "";
      }
    }
    setQuantities(qtys);
    setPrices(prs);
    setPricingModes(modes);
    setKgPrices(kgs);
    setInitialized(true);
  }, [proformaQuery.data, initialized]);

  // Reset when dialog closes/reopens
  useEffect(() => {
    if (!open) {
      setInitialized(false);
      setQuantities({});
      setPrices({});
      setPricingModes({});
      setKgPrices({});
      setProformaName("");
      setDestination("");
      setAppliedPrice(null);
      setShowZeroItems(true);
      setHideNonPositive(false);
      setShowGarbageWipers(false);
      setCatalogFilter("__all__");
    }
  }, [open]);

  // Ctrl+S to save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (!saveMutation.isPending && proformaName.trim()) saveMutation.mutate();
      }
    };
    if (open) window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const pf = proformaQuery.data!;
      if (!destination.trim()) throw new Error("Select a destination before saving this proforma");
      const lineMap = new Map<string, ExistingLine>();
      for (const l of pf.lines) lineMap.set(l.articleCode, l);

      // 1. Update proforma header
      await apiRequest("PUT", `/api/factory/customer-proformas/${proformaId}`, {
        name: proformaName.trim(),
        destination: destination.trim(),
        isActive,
      });

      // 2. Process each article row
      const ops: Promise<unknown>[] = [];
      for (const row of articleRows) {
        const rawQty = quantities[row.articleCode] ?? "";
        const qty = parseInt(rawQty);
        const validQty = !isNaN(qty) && qty > 0 ? qty : 0;
        const price = prices[row.articleCode] ?? "0";
        const existing = lineMap.get(row.articleCode);

        const mode = pricingModes[row.articleCode] ?? "per_bale";
        const kgPrice = kgPrices[row.articleCode] ?? "0";
        const effectivePrice = mode === "per_kg" ? "0" : price;
        const existingMode = existing?.pricingMode ?? "per_bale";
        const existingKgPrice = existing?.pricePerKg ?? null;

        if (existing) {
          if (validQty === 0) {
            ops.push(apiRequest("DELETE", `/api/factory/customer-proforma-lines/${existing.id}`, undefined));
          } else if (
            validQty !== existing.quantity ||
            effectivePrice !== existing.pricePerBale ||
            mode !== existingMode ||
            (mode === "per_kg" && kgPrice !== (existingKgPrice ?? ""))
          ) {
            ops.push(
              apiRequest("PUT", `/api/factory/customer-proforma-lines/${existing.id}`, {
                quantity: validQty,
                pricePerBale: effectivePrice,
                pricingMode: mode,
                pricePerKg: mode === "per_kg" ? kgPrice : null,
              })
            );
          }
        } else if (validQty > 0) {
          ops.push(
            apiRequest("POST", "/api/factory/customer-proforma-lines", {
              proformaId,
              articleCode: row.articleCode,
              productName: row.productName,
              quantity: validQty,
              pricePerBale: effectivePrice || "0",
              productionPricePerBale: "0",
              pricingMode: mode,
              pricePerKg: mode === "per_kg" ? kgPrice : null,
            })
          );
        }
      }
      await Promise.all(ops);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/factory/v5/stock-allocation"], refetchType: "active" });
      qc.invalidateQueries({ queryKey: ["/api/factory/customer-proformas", proformaId] });
      qc.invalidateQueries({
        predicate: (q) => {
          const k = q.queryKey[0];
          return typeof k === "string" && k.startsWith("/api/factory/customer-proformas");
        },
      });
      toast({ title: "Proforma updated", description: "All changes saved." });
      onSuccess();
    },
    onError: (e: ClientErrorLike) => {
      toast({ title: "Failed to save", description: e.message, variant: "destructive" });
    },
  });

  function applyCatalogSellingPrice() {
    const m = productMap();
    const next: Record<string, string> = {};
    for (const row of articleRows) {
      const p = m.get(row.articleCode);
      if (p?.sellingPrice && parseFloat(p.sellingPrice) > 0) next[row.articleCode] = p.sellingPrice;
    }
    setPrices((prev) => ({ ...prev, ...next }));
    setAppliedPrice("sell");
  }

  function applyCatalogProductionPrice() {
    const m = productMap();
    const next: Record<string, string> = {};
    for (const row of articleRows) {
      const p = m.get(row.articleCode);
      if (p?.productionPrice && parseFloat(p.productionPrice) > 0) next[row.articleCode] = p.productionPrice;
    }
    setPrices((prev) => ({ ...prev, ...next }));
    setAppliedPrice("prod");
  }
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
  };
}
