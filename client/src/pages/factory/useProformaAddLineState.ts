// Extracted from ./ProformaAddLine.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "wouter";
import { useEscapeBack } from "@/hooks/use-escape-back";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { useCompany } from "@/contexts/CompanyContext";
import { getApiRequest } from "@/lib/factoryApi";

const AUTOSAVE_KEY = "proforma-autosave-enabled";

const AUTOSAVE_DELAY_MS = 1500;

interface StockItem {
  id: number;
  code: string;
  name: string;
  weightPerBaleKg?: string | null;
  salePrice?: string | null;
  stockGroup?: { name: string } | null;
}

interface BaleProductWeight {
  articleCode: string;
  weightPerBaleKg: string | null;
}

interface RawBaleProduct {
  articleCode?: string | null;
  code?: string | null;
  weightPerBaleKg?: string | null;
}

interface ProformaLine {
  id: number;
  articleCode: string;
  quantity: number;
  pricePerBale: string;
}

interface Proforma {
  id: number;
  name: string;
  customerId: number;
  lines: ProformaLine[];
}

export function useProformaAddLineState() {
  const { proformaId } = useParams<{ proformaId: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);

  const params = new URLSearchParams(window.location.search);
  const customerId = params.get("customerId") || "";
  const proformaName = params.get("proformaName") || "Proforma";

  useEscapeBack(() => {
    navigate(`/factory/invoicing?tab=proformas${customerId ? `&customerId=${customerId}` : ""}`);
  });

  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState("all");
  const [selectedItem, setSelectedItem] = useState<StockItem | null>(null);
  const [qty, setQty] = useState("1");
  const [price, setPrice] = useState("");
  const [addedCodes, setAddedCodes] = useState<Set<string>>(new Set());
  const [autoSave, setAutoSave] = useState<boolean>(() => {
    try {
      return localStorage.getItem(AUTOSAVE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [autoSaveCountdown, setAutoSaveCountdown] = useState(0);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  const numericProformaId = parseInt(proformaId);
  const {
    data: allItems = [],
    isLoading: itemsLoading,
    isError: itemsError,
    refetch: refetchItems,
  } = useQuery<StockItem[]>({
    queryKey: ["/api/stock-items/light", selectedCompany?.id],
    enabled: !!selectedCompany,
    staleTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
  });

  const { data: baleProducts = [] } = useQuery<RawBaleProduct[], Error, BaleProductWeight[]>({
    queryKey: ["/api/factory/bale-products?profile=picker"],
    select: (data) =>
      data.map((p) => ({ articleCode: p.articleCode || p.code || "", weightPerBaleKg: p.weightPerBaleKg ?? null })),
  });

  const baleWeightMap = useMemo(() => {
    const m = new Map<string, string>();
    baleProducts.forEach((p) => {
      if (p.articleCode && p.weightPerBaleKg && parseFloat(p.weightPerBaleKg) > 0) {
        m.set(p.articleCode, p.weightPerBaleKg);
      }
    });
    return m;
  }, [baleProducts]);

  const getEffectiveWeight = (item: StockItem): string | null => {
    if (item.weightPerBaleKg && parseFloat(item.weightPerBaleKg) > 0) return item.weightPerBaleKg;
    return baleWeightMap.get(item.code) ?? null;
  };

  const { data: proforma } = useQuery<Proforma>({
    queryKey: [`/api/factory/customer-proformas?customerId=${customerId}`, customerId],
    select: (data) => {
      if (Array.isArray(data)) return data.find((p: Proforma) => p.id === numericProformaId) ?? null;
      return null;
    },
    enabled: !!customerId,
  });

  const existingCodes = useMemo(() => {
    const s = new Set<string>();
    proforma?.lines?.forEach((l) => s.add(l.articleCode));
    return s;
  }, [proforma]);

  const groups = useMemo(() => {
    const s = new Set<string>();
    allItems.forEach((it) => {
      if (it.stockGroup?.name) s.add(it.stockGroup.name);
    });
    return ["all", ...Array.from(s).sort()];
  }, [allItems]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return allItems.filter((it) => {
      const matchGroup = groupFilter === "all" || it.stockGroup?.name === groupFilter;
      const matchSearch = !q || it.name?.toLowerCase().includes(q) || it.code?.toLowerCase().includes(q);
      return matchGroup && matchSearch;
    });
  }, [allItems, search, groupFilter]);

  const addMutation = useMutation({
    mutationFn: async () => {
      if (!selectedItem) throw new Error("No item selected");
      const res = await modeApiRequest("POST", "/api/factory/customer-proforma-lines", {
        proformaId: numericProformaId,
        articleCode: selectedItem.code,
        productName: selectedItem.name,
        quantity: parseInt(qty) || 1,
        pricePerBale: price,
        weightPerBaleKg: getEffectiveWeight(selectedItem),
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message || "Failed to add line");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [`/api/factory/customer-proformas?customerId=${customerId}`, customerId],
      });
      setAddedCodes((prev) => new Set([...prev, selectedItem!.code]));
      toast({ title: "Added", description: `${selectedItem!.name} added to proforma` });
      setSelectedItem(null);
      setQty("1");
      setPrice("");
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    },
  });

  const clearAutoSaveTimers = () => {
    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = null;
    }
    if (countdownInterval.current) {
      clearInterval(countdownInterval.current);
      countdownInterval.current = null;
    }
    setAutoSaveCountdown(0);
  };

  const toggleAutoSave = () => {
    const next = !autoSave;
    setAutoSave(next);
    try {
      localStorage.setItem(AUTOSAVE_KEY, String(next));
    } catch {
      // Storage is unavailable in private mode and can throw on quota; the value is a convenience, not state we need.
    }
    if (!next) clearAutoSaveTimers();
  };

  // Start autosave countdown whenever selectedItem, qty, or price change (and autosave is on)
  useEffect(() => {
    clearAutoSaveTimers();
    if (!autoSave || !selectedItem || !qty || !price) return;

    const steps = Math.ceil(AUTOSAVE_DELAY_MS / 100);
    let remaining = steps;
    setAutoSaveCountdown(100);

    countdownInterval.current = setInterval(() => {
      remaining -= 1;
      setAutoSaveCountdown(Math.round((remaining / steps) * 100));
      if (remaining <= 0) {
        if (countdownInterval.current) clearInterval(countdownInterval.current);
      }
    }, 100);

    autoSaveTimer.current = setTimeout(() => {
      addMutation.mutate();
    }, AUTOSAVE_DELAY_MS);

    return clearAutoSaveTimers;
  }, [addMutation, autoSave, price, qty, selectedItem]);

  const handleSelectItem = (item: StockItem) => {
    if (selectedItem?.id === item.id) {
      setSelectedItem(null);
      clearAutoSaveTimers();
      return;
    }
    setSelectedItem(item);
    setQty("1");
    setPrice(item.salePrice ? parseFloat(item.salePrice).toFixed(2) : "");
  };

  const goBack = () => {
    navigate(`/factory/invoicing?tab=proformas${customerId ? `&customerId=${customerId}` : ""}`);
  };

  const isAdded = (item: StockItem) => addedCodes.has(item.code) || existingCodes.has(item.code);
  const isSelected = (item: StockItem) => selectedItem?.id === item.id;
  return {
    allItems,
    refetchItems,
    itemsError,
    addMutation,
    autoSave,
    autoSaveCountdown,
    clearAutoSaveTimers,
    filtered,
    getEffectiveWeight,
    goBack,
    groupFilter,
    groups,
    handleSelectItem,
    isAdded,
    isSelected,
    itemsLoading,
    price,
    proformaName,
    qty,
    search,
    selectedItem,
    setGroupFilter,
    setPrice,
    setQty,
    setSearch,
    setSelectedItem,
    toggleAutoSave,
  };
}
