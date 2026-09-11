import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useMemo, useEffect, useRef } from "react";
import { useParams, useLocation } from "wouter";
import { useEscapeBack } from "@/hooks/use-escape-back";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ArrowLeft, Check, Plus, Search, X, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { useCompany } from "@/contexts/CompanyContext";
import { getApiRequest } from "@/lib/factoryApi";
import { formatNumber } from "@/lib/formatNumber";
import { PageHeader } from "@/components/PageHeader";

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

export default function ProformaAddLine() {
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

  const { data: allItems = [], isLoading: itemsLoading } = useQuery<StockItem[]>({
    queryKey: ["/api/stock-items/light", selectedCompany?.id],
    enabled: !!selectedCompany,
    staleTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
  });

  const { data: baleProducts = [] } = useQuery<RawBaleProduct[], Error, BaleProductWeight[]>({
    queryKey: ["/api/factory/bale-products"],
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
      toast({ title: "Error", description: e.message, variant: "destructive" });
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

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="sticky top-0 z-20 bg-background border-b px-4 py-3 flex items-center gap-3">
        <Button size="icon" variant="ghost" onClick={goBack} data-testid="button-back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-muted-foreground">Adding line to</p>
          <PageHeader title={proformaName} />
        </div>
        {/* Autosave toggle */}
        <button
          onClick={toggleAutoSave}
          className={`flex items-center gap-1.5 px-3 h-9 rounded-md border text-sm font-medium transition-colors ${
            autoSave
              ? "bg-green-500/10 border-green-500/50 text-green-600 dark:text-green-400"
              : "bg-background border-border text-muted-foreground"
          }`}
          data-testid="button-autosave-toggle"
          title={autoSave ? "Autosave ON — items added automatically" : "Autosave OFF — press Add manually"}
        >
          <Zap className={`h-4 w-4 ${autoSave ? "fill-green-500 text-green-500" : ""}`} />
          <span className="hidden sm:inline">Autosave</span>
          <span
            className={`w-8 h-4 rounded-full relative transition-colors ${autoSave ? "bg-green-500" : "bg-muted-foreground/30"}`}
          >
            <span
              className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${autoSave ? "translate-x-4" : "translate-x-0.5"}`}
            />
          </span>
        </button>
        <Button variant="outline" size="sm" onClick={goBack} data-testid="button-done">
          Done
        </Button>
      </div>

      {/* Search + Group filters */}
      <div className="sticky top-[57px] z-10 bg-background border-b px-4 py-2 space-y-2">
        <div className="relative">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search by name or article code..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
            autoFocus
            data-testid="input-search"
          />
          {search && (
            <button
              className="absolute right-3 top-2.5"
              onClick={() => setSearch("")}
              data-testid="button-clear-search"
            >
              <X className="h-4 w-4 text-muted-foreground" />
            </button>
          )}
        </div>

        {groups.length > 1 && (
          <div className="flex gap-1.5 overflow-x-auto pb-0.5 no-scrollbar">
            {groups.map((g) => (
              <button
                key={g}
                onClick={() => setGroupFilter(g)}
                className={`shrink-0 text-xs px-2.5 py-1 rounded-full border transition-colors ${
                  groupFilter === g
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-background text-muted-foreground border-border hover-elevate"
                }`}
                data-testid={`button-group-${g}`}
              >
                {g === "all" ? "All" : g}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Item count */}
      <div className="px-4 pt-2 pb-1">
        <p className="text-xs text-muted-foreground">
          {itemsLoading
            ? "Loading..."
            : `${filtered.length} item${filtered.length !== 1 ? "s" : ""}${search ? ` matching "${search}"` : ""}`}
        </p>
      </div>

      {/* Items grid — padded at bottom for the sticky bar */}
      <div className={`flex-1 overflow-y-auto px-4 pb-${selectedItem ? "44" : "6"}`}>
        {itemsLoading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 mt-2">
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <Search className="h-8 w-8 mb-2 opacity-30" />
            <p className="text-sm">No items found</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 mt-2">
            {filtered.map((item) => {
              const added = isAdded(item);
              const selected = isSelected(item);
              const effectiveWt = getEffectiveWeight(item);
              const wt = effectiveWt ? parseFloat(effectiveWt) : null;
              const wtFromBaleProduct = !item.weightPerBaleKg || parseFloat(item.weightPerBaleKg) === 0;
              return (
                <button
                  key={item.id}
                  onClick={() => !added && handleSelectItem(item)}
                  disabled={added}
                  className={`relative text-left rounded-md border p-3 transition-colors flex flex-col gap-1
                    ${added ? "opacity-50 cursor-default bg-muted" : "cursor-pointer"}
                    ${selected ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border bg-card hover-elevate"}
                  `}
                  data-testid={`button-item-${item.id}`}
                >
                  {added && (
                    <span className="absolute top-2 right-2 bg-green-500 text-white rounded-full p-0.5">
                      <Check className="h-3 w-3" />
                    </span>
                  )}
                  {selected && !added && (
                    <span className="absolute top-2 right-2 bg-primary text-primary-foreground rounded-full p-0.5">
                      <Check className="h-3 w-3" />
                    </span>
                  )}
                  <p className="text-sm font-medium leading-snug line-clamp-2 pr-5">{item.name}</p>
                  {item.code && <p className="text-xs font-mono text-muted-foreground">{item.code}</p>}
                  {wt !== null && (
                    <p className="text-xs text-muted-foreground mt-auto">
                      {formatNumber(wt)} kg/bale{wtFromBaleProduct && wt > 0 ? " *" : ""}
                    </p>
                  )}
                  {item.salePrice && parseFloat(item.salePrice) > 0 && (
                    <p className="text-xs text-muted-foreground">${parseFloat(item.salePrice).toFixed(2)}</p>
                  )}
                  {item.stockGroup?.name && (
                    <Badge variant="secondary" className="text-xs mt-1 w-fit no-default-active-elevate">
                      {item.stockGroup.name}
                    </Badge>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Sticky bottom panel when item selected */}
      {selectedItem && (
        <div className="fixed bottom-0 left-0 right-0 z-30 bg-background border-t shadow-lg px-4 py-4">
          {/* Autosave progress bar */}
          {autoSave && autoSaveCountdown > 0 && (
            <div className="absolute top-0 left-0 right-0 h-1 bg-muted overflow-hidden rounded-none">
              <div
                className="h-full bg-green-500 transition-all duration-100"
                style={{ width: `${autoSaveCountdown}%` }}
              />
            </div>
          )}
          <div className="max-w-2xl mx-auto">
            <div className="flex items-start gap-3 mb-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold truncate">{selectedItem.name}</p>
                  {autoSave && (
                    <span className="text-xs text-green-600 dark:text-green-400 flex items-center gap-0.5 shrink-0">
                      <Zap className="h-3 w-3 fill-green-500" />
                      {addMutation.isPending ? "Saving…" : "Auto-adding…"}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-0.5">
                  <p className="text-xs text-muted-foreground font-mono">{selectedItem.code}</p>
                  {(() => {
                    const ew = getEffectiveWeight(selectedItem);
                    if (!ew || parseFloat(ew) === 0) return null;
                    const fromBaleProduct =
                      !selectedItem.weightPerBaleKg || parseFloat(selectedItem.weightPerBaleKg) === 0;
                    return (
                      <p className="text-xs text-muted-foreground">
                        {formatNumber(parseFloat(ew))} kg/bale{fromBaleProduct ? " (from product)" : ""}
                      </p>
                    );
                  })()}
                </div>
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="shrink-0"
                onClick={() => {
                  setSelectedItem(null);
                  clearAutoSaveTimers();
                }}
                data-testid="button-deselect"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex gap-3 items-end">
              <div className="flex-1">
                <label className="text-xs font-medium mb-1 block text-muted-foreground">Quantity (bales)</label>
                <Input
                  type="number"
                  min="1"
                  placeholder="Qty"
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowUp" || e.key === "ArrowDown") e.preventDefault();
                    if (e.key === "Enter" && qty && price) addMutation.mutate();
                  }}
                  data-testid="input-qty"
                />
              </div>
              <div className="flex-1">
                <label className="text-xs font-medium mb-1 block text-muted-foreground">Price per bale</label>
                <Input
                  type="number"
                  step="0.01"
                  placeholder="0.00"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowUp" || e.key === "ArrowDown") e.preventDefault();
                    if (e.key === "Enter" && qty && price) addMutation.mutate();
                  }}
                  data-testid="input-price"
                />
              </div>
              <Button
                onClick={() => {
                  clearAutoSaveTimers();
                  addMutation.mutate();
                }}
                disabled={!qty || !price || addMutation.isPending}
                data-testid="button-add-line"
              >
                <Plus className="h-4 w-4 mr-1" />
                {addMutation.isPending ? "Adding..." : "Add"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
