import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, Loader2, CheckCircle2, Save, Trash2, BookmarkCheck, FilePenLine, Package, Boxes, Scale, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface ArticleRow {
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

interface Props {
  open: boolean;
  onClose: () => void;
  proformaId: number;
  articleRows: ArticleRow[];
  onSuccess: () => void;
}

export default function EditProformaV5Drawer({ open, onClose, proformaId, articleRows, onSuccess }: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [proformaName, setProformaName] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [pricingModes, setPricingModes] = useState<Record<string, "per_bale" | "per_kg">>({});
  const [kgPrices, setKgPrices] = useState<Record<string, string>>({});
  const [showZeroItems, setShowZeroItems] = useState(false);
  const [hideNonPositive, setHideNonPositive] = useState(false);
  const [showGarbageWipers, setShowGarbageWipers] = useState(false);
  const [catalogFilter, setCatalogFilter] = useState("__all__");
  const [articleSearch, setArticleSearch] = useState("");
  const catalogCategories = Array.from(new Set(articleRows.map((r) => r.categoryName?.trim()).filter((v): v is string => Boolean(v)))).sort((a, b) => a.localeCompare(b));
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

  // Saved prices are scoped to the customer on this proforma, never to the last selected customer.
  const customerId = proformaQuery.data?.customerId;
  const customerPriceListQuery = useQuery<AgreedPriceRow[]>({
    queryKey: ["/api/factory/customer-price-lists", customerId, proformaQuery.data?.companyId],
    queryFn: async () => {
      const res = await fetch(`/api/factory/customer-price-lists/${customerId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load saved agreed prices");
      return res.json();
    },
    enabled: open && !!customerId && !!proformaQuery.data?.companyId,
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
      setAppliedPrice(null);
      setShowZeroItems(false);
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
      const lineMap = new Map<string, ExistingLine>();
      for (const l of pf.lines) lineMap.set(l.articleCode, l);

      // 1. Update proforma header
      await apiRequest("PUT", `/api/factory/customer-proformas/${proformaId}`, {
        name: proformaName.trim(),
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
      description: `${matchedCodes.length} matching article price${matchedCodes.length === 1 ? "" : "s"} updated. Click Save Changes to save the proforma.`,
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
    if (catalogFilter !== "__all__") base = base.filter((r) => (r.categoryName?.trim() || "__uncategorized__") === catalogFilter);
    if (articleSearch.trim()) {
      const term = articleSearch.trim().toLowerCase();
      base = base.filter((row) => row.productName.toLowerCase().includes(term) || row.articleCode.toLowerCase().includes(term));
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

  return (
    <div className="flex min-w-0 flex-col bg-background pb-5" data-testid="page-edit-proforma-v5">
      <section className="px-3 pb-3 pt-5 sm:px-5">
        <div className="flex items-center gap-3"><div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-violet-500/30 bg-violet-500/15 text-violet-500"><FilePenLine className="h-6 w-6" /></div><div><h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Edit Proforma</h1><p className="mt-0.5 text-sm text-muted-foreground">Stock Allocation</p></div></div>
        {!isLoading && !proformaQuery.isError && <div className="mt-5 grid grid-cols-2 gap-2.5 lg:grid-cols-3 xl:grid-cols-5"><div className="flex min-w-0 items-center gap-3 rounded-xl border border-violet-500/25 bg-violet-500/[0.07] p-3.5 shadow-sm"><Package className="hidden h-9 w-9 shrink-0 rounded-lg bg-violet-500/15 p-2 text-violet-500 sm:block" /><div className="min-w-0"><p className="text-xs text-muted-foreground">Total Products</p><p className="mt-1 text-2xl font-bold tabular-nums text-violet-500">{visibleRows.length.toLocaleString()}</p></div></div>
<div className="flex min-w-0 items-center gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.07] p-3.5 shadow-sm"><Boxes className="hidden h-9 w-9 shrink-0 rounded-lg bg-emerald-500/15 p-2 text-emerald-500 sm:block" /><div className="min-w-0"><p className="text-xs text-muted-foreground">Qty / Container</p><p className="mt-1 text-2xl font-bold tabular-nums text-emerald-500">{totalQty.toLocaleString()}</p></div></div>
<div className="flex min-w-0 items-center gap-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] p-3.5 shadow-sm"><Scale className="hidden h-9 w-9 shrink-0 rounded-lg bg-amber-500/15 p-2 text-amber-500 sm:block" /><div className="min-w-0"><p className="text-xs text-muted-foreground">Total KG</p><p className="mt-1 text-2xl font-bold tabular-nums text-amber-500">{totalKg.toLocaleString()}</p></div></div>
<div className="flex min-w-0 items-center gap-3 rounded-xl border border-sky-500/25 bg-sky-500/[0.07] p-3.5 shadow-sm"><Save className="hidden h-9 w-9 shrink-0 rounded-lg bg-sky-500/15 p-2 text-sky-500 sm:block" /><div className="min-w-0"><p className="text-xs text-muted-foreground">Total Value</p><p className="mt-1 text-2xl font-bold tabular-nums text-sky-500">{totalValue.toLocaleString()}</p></div></div>
<div className="col-span-2 lg:col-span-1 flex min-w-0 items-center gap-3 rounded-xl border border-rose-500/25 bg-rose-500/[0.07] p-3.5 shadow-sm"><AlertTriangle className="hidden h-9 w-9 shrink-0 rounded-lg bg-rose-500/15 p-2 text-rose-500 sm:block" /><div className="min-w-0"><p className="text-xs text-muted-foreground">Shortages</p><p className="mt-1 text-2xl font-bold tabular-nums text-rose-500">{warningCount.toLocaleString()}</p></div></div></div>}
      </section>

        {isLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : proformaQuery.isError ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-5 text-center" role="alert">
            <AlertTriangle className="h-6 w-6 text-destructive" />
            <p className="text-sm text-destructive">Could not load this proforma: {proformaQuery.error.message}</p>
            <Button variant="outline" onClick={() => proformaQuery.refetch()}>Retry</Button>
          </div>
        ) : (
          <>
            {/* Top fields */}
            <div className="mx-3 flex flex-wrap items-end gap-4 rounded-t-xl border bg-card/70 p-3.5 shadow-sm sm:mx-5 sm:p-4">
              <div className="flex flex-col gap-1.5 min-w-[200px] flex-1">
                <Label htmlFor="edit-v5-proforma-name" className="text-xs font-medium">
                  Proforma Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="edit-v5-proforma-name"
                  data-testid="input-edit-v5-proforma-name"
                  value={proformaName}
                  onChange={(e) => setProformaName(e.target.value)}
                  placeholder="Proforma name"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label className="text-xs font-medium">Status</Label>
                <div className="flex items-center gap-2 h-9">
                  <Switch
                    checked={isActive}
                    onCheckedChange={setIsActive}
                    data-testid="switch-edit-v5-proforma-active"
                  />
                  <span className="text-sm text-muted-foreground">{isActive ? "Active" : "Inactive"}</span>
                </div>
              </div>

              <div className="relative w-full sm:w-72">
                <Label className="mb-1 block text-xs font-medium">Search</Label>
                <Search className="pointer-events-none absolute bottom-3 left-3 h-4 w-4 text-muted-foreground" />
                <Input value={articleSearch} onChange={(event) => setArticleSearch(event.target.value)} placeholder="Search product name or code..." className="h-10 rounded-lg pl-9 pr-8 text-sm" data-testid="input-v5-edit-search" />
                {articleSearch && <button type="button" onClick={() => setArticleSearch("")} className="absolute bottom-3 right-3 text-muted-foreground hover:text-foreground" data-testid="button-v5-edit-clear-search" aria-label="Clear search"><X className="h-4 w-4" /></button>}
              </div>
              <div className="w-full sm:w-56">
                <Label className="mb-1 block text-xs font-medium">Catalog</Label>
                <Select value={catalogFilter} onValueChange={setCatalogFilter}>
                  <SelectTrigger className="h-10 rounded-lg" data-testid="select-v5-edit-catalog"><SelectValue placeholder="All Catalogs" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">All Catalogs</SelectItem>
                    {catalogCategories.map((category) => (
                      <SelectItem key={category} value={category}>{category}</SelectItem>
                    ))}
                    {articleRows.some((row) => !row.categoryName?.trim()) && (
                      <SelectItem value="__uncategorized__">Uncategorized</SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>

            </div>
            <div className="mx-3 flex flex-wrap items-center gap-2 border-x border-b bg-card/70 px-3.5 py-3 sm:mx-5 sm:px-4">
              {zeroItemCount > 0 && (
                <div className="">
                  <Button
                    size="default"
                    variant={showZeroItems ? "secondary" : "outline"}
                    onClick={() => setShowZeroItems((v) => !v)}
                    data-testid="button-edit-v5-toggle-zero"
                    className="h-9 rounded-full px-4 text-xs font-semibold"
                  >
                    {showZeroItems ? `Hide 0-stock (${zeroItemCount})` : `Show 0-stock (${zeroItemCount})`}
                  </Button>
                </div>
              )}

              {nonPositiveCount > 0 && (
                <div className="">
                  <Button
                    size="default"
                    variant={hideNonPositive ? "default" : "outline"}
                    onClick={() => setHideNonPositive((v) => !v)}
                    data-testid="button-edit-v5-hide-non-positive"
                    className="h-9 rounded-full px-4 text-xs font-semibold"
                  >
                    {hideNonPositive
                      ? `Show all (${nonPositiveCount} hidden)`
                      : `Hide 0 & negative (${nonPositiveCount})`}
                  </Button>
                </div>
              )}

              {garbageWipersCount > 0 && (
                <div>
                  <Button
                    size="default"
                    variant={showGarbageWipers ? "secondary" : "outline"}
                    onClick={() => setShowGarbageWipers((v) => !v)}
                    data-testid="button-edit-v5-toggle-garbage-wipers"
                    className="h-9 rounded-full px-4 text-xs font-semibold"
                  >
                    {showGarbageWipers
                      ? `Hide Garbage/Wipers (${garbageWipersCount})`
                      : `Show Garbage/Wipers (${garbageWipersCount})`}
                  </Button>
                </div>
              )}

              <div className="ml-auto flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant={appliedPrice === "sell" ? "secondary" : "outline"}
                  onClick={applyCatalogSellingPrice}
                  disabled={!productsQuery.data}
                  data-testid="button-edit-v5-apply-sell-price"
                  className={cn("h-9 rounded-full px-4 text-xs font-semibold", appliedPrice === "sell" && "ring-2 ring-violet-500/40")}
                >
                  {appliedPrice === "sell" && <CheckCircle2 className="h-3.5 w-3.5 mr-1.5 text-primary" />}
                  Apply Sell Price
                </Button>
                <Button
                  size="sm"
                  variant={appliedPrice === "prod" ? "secondary" : "outline"}
                  onClick={applyCatalogProductionPrice}
                  disabled={!productsQuery.data}
                  data-testid="button-edit-v5-apply-prod-price"
                  className={cn("h-9 rounded-full px-4 text-xs font-semibold", appliedPrice === "prod" && "ring-2 ring-violet-500/40")}
                >
                  {appliedPrice === "prod" && <CheckCircle2 className="h-3.5 w-3.5 mr-1.5 text-primary" />}
                  Apply Prod Price
                </Button>
                <Button
                  size="sm"
                  variant={appliedPrice === "customer" ? "secondary" : "outline"}
                  onClick={applySavedAgreedPrices}
                  disabled={!initialized || customerPriceListQuery.isFetching || customerPriceListQuery.isError || !customerPriceListQuery.data?.length}
                  data-testid="button-edit-v5-apply-customer-price"
                  title={customerPriceListQuery.isError
                    ? "Could not load saved agreed prices for this customer"
                    : customerPriceListQuery.data?.length
                      ? `Apply ${customerPriceListQuery.data.length} saved agreed price(s) for this customer`
                      : "No agreed prices saved for this customer yet"}
                  className={cn("h-9 rounded-full px-4 text-xs font-semibold", appliedPrice === "customer" && "ring-2 ring-violet-500/40")}
                >
                  {appliedPrice === "customer" && <CheckCircle2 className="h-3.5 w-3.5 mr-1.5 text-primary" />}
                  <BookmarkCheck className="h-3.5 w-3.5 mr-1.5" />
                  Apply Saved Agreed Prices
                  {customerPriceListQuery.data && customerPriceListQuery.data.length > 0 && (
                    <span className="ml-1 text-[11px] opacity-70">({customerPriceListQuery.data.length})</span>
                  )}
                </Button>
              </div>
            </div>

            {/* Table */}
            <div className="mx-3 min-w-0 overflow-x-auto rounded-b-xl border border-t-0 bg-card shadow-sm sm:mx-5">
              <table className="w-full min-w-[1120px] table-fixed border-collapse text-sm">
                <colgroup><col style={{ width: "27%" }} /><col style={{ width: "10%" }} /><col style={{ width: "15%" }} /><col style={{ width: "13%" }} /><col style={{ width: "12%" }} /><col style={{ width: "19%" }} /><col style={{ width: "4%" }} /></colgroup>
                <thead><tr className="sticky top-0 z-30 bg-slate-100 text-slate-700 dark:bg-slate-800/95 dark:text-slate-200">
                    <th className="sticky left-0 z-20 border-b border-r bg-slate-100 px-4 py-3 text-left text-xs font-semibold dark:bg-slate-800/95">Product</th><th className="border-b border-r px-3 py-3 text-left text-xs font-semibold">Code</th>
                    <th className="border-b border-r px-2 py-3 text-center text-xs font-semibold whitespace-nowrap">
                      Available Balance
                    </th>
                    <th className="border-b border-r px-2 py-3 text-center text-xs font-semibold whitespace-nowrap">
                      Qty / Container
                    </th>
                    <th className="border-b border-r px-2 py-3 text-center text-xs font-semibold whitespace-nowrap text-muted-foreground">
                      Total KG
                    </th>
                    <th className="border-b px-2 py-3 text-center text-xs font-semibold whitespace-nowrap">
                      Price
                    </th>
                    <th className="border-b px-2 py-3 text-center text-xs font-semibold"></th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row, idx) => {
                    const rawVal = quantities[row.articleCode] ?? "";
                    const parsed = parseInt(rawVal);
                    const qty = isNaN(parsed) ? 0 : parsed;
                    const shortage = qty > 0 && row.freeToPromise < 0;
                    const p = map.get(row.articleCode);
                    const w = parseFloat(p?.weightPerBaleKg || "0");
                    const totalKgRow = qty > 0 && w > 0 ? qty * w : null;
                    const hasExistingLine = !!proformaQuery.data?.lines.find((l) => l.articleCode === row.articleCode);

                    return (
                      <tr
                        key={row.articleCode}
                        className={cn(
                          "border-b transition-colors",
                          idx % 2 === 0 ? "bg-card" : "bg-muted/25",
                          qty > 0 && "bg-violet-500/[0.06]"
                        )}
                        data-testid={`row-v5-edit-${row.articleCode}`}
                      >
                        <td className="sticky left-0 z-10 border-r bg-inherit px-4 py-2.5"><div className="flex min-w-0 items-center gap-2">{hasExistingLine && qty > 0 && <span className="h-2 w-2 shrink-0 rounded-full bg-violet-500" title="Line exists in proforma" />}<span className="block truncate text-xs font-semibold sm:text-sm" title={row.productName}>{row.productName}</span></div></td>
                        <td className="border-r px-3 py-2.5 font-mono text-xs text-muted-foreground" title={row.articleCode}>{row.articleCode}</td>

                        <td
                          className={cn(
                            "border-r px-2 py-2.5 text-center font-mono tabular-nums text-xs font-semibold",
                            row.freeToPromise < 0
                              ? "text-destructive"
                              : row.freeToPromise === 0
                                ? "text-muted-foreground"
                                : "text-green-700 dark:text-green-400"
                          )}
                        >
                          {row.freeToPromise < 0 && <AlertTriangle className="inline h-3 w-3 mr-0.5 mb-0.5" />}
                          {row.freeToPromise > 0 ? "+" : ""}
                          {row.freeToPromise.toLocaleString()}
                        </td>

                        <td className="border-r px-2 py-2.5">
                          <div className="flex flex-col gap-0.5 items-center">
                            <Input
                              ref={(el) => {
                                qtyRefs.current[idx] = el;
                              }}
                              type="number"
                              min={0}
                              value={rawVal}
                              onChange={(e) =>
                                setQuantities((prev) => ({ ...prev, [row.articleCode]: e.target.value }))
                              }
                              onFocus={(e) => e.target.select()}
                              onKeyDown={(e) => handleQtyKeyDown(e, idx)}
                              placeholder="0"
                              className={cn(
                                "h-7 text-center text-xs tabular-nums w-full",
                                shortage && "border-amber-400 bg-amber-50/30 dark:bg-amber-950/20"
                              )}
                              data-testid={`input-edit-v5-qty-${row.articleCode}`}
                            />
                            {shortage && (
                              <span className="text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-0.5 whitespace-nowrap">
                                <AlertTriangle className="h-2.5 w-2.5" />
                                Low stock
                              </span>
                            )}
                          </div>
                        </td>

                        <td className="border-r px-2 py-2.5 text-center text-xs text-muted-foreground tabular-nums">
                          {totalKgRow != null ? (
                            <span className="text-foreground font-medium">
                              {totalKgRow.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg
                            </span>
                          ) : (
                            <span className="text-muted-foreground/40">—</span>
                          )}
                        </td>

                        <td className="px-2 py-2.5">
                          {(() => {
                            const mode = pricingModes[row.articleCode] ?? "per_bale";
                            return (
                              <div className="flex items-center gap-1">
                                <div className="flex rounded-sm border shrink-0 overflow-hidden text-[11px] font-semibold">
                                  <button
                                    className={cn(
                                      "px-1.5 py-0.5 transition-colors",
                                      mode === "per_bale"
                                        ? "bg-primary text-primary-foreground"
                                        : "text-muted-foreground hover:bg-muted"
                                    )}
                                    onClick={() =>
                                      setPricingModes((prev) => ({ ...prev, [row.articleCode]: "per_bale" }))
                                    }
                                    data-testid={`button-edit-v5-mode-bale-${row.articleCode}`}
                                    title="Price per bale"
                                  >
                                    /bale
                                  </button>
                                  <button
                                    className={cn(
                                      "px-1.5 py-0.5 transition-colors",
                                      mode === "per_kg"
                                        ? "bg-primary text-primary-foreground"
                                        : "text-muted-foreground hover:bg-muted"
                                    )}
                                    onClick={() =>
                                      setPricingModes((prev) => ({ ...prev, [row.articleCode]: "per_kg" }))
                                    }
                                    data-testid={`button-edit-v5-mode-kg-${row.articleCode}`}
                                    title="Price per kg"
                                  >
                                    /kg
                                  </button>
                                </div>
                                {mode === "per_kg" ? (
                                  <Input
                                    type="number"
                                    min={0}
                                    step="0.001"
                                    value={kgPrices[row.articleCode] ?? ""}
                                    onChange={(e) =>
                                      setKgPrices((prev) => ({ ...prev, [row.articleCode]: e.target.value }))
                                    }
                                    onFocus={(e) => e.target.select()}
                                    placeholder="0.000"
                                    className="h-7 text-right text-xs tabular-nums w-full"
                                    data-testid={`input-edit-v5-kgprice-${row.articleCode}`}
                                  />
                                ) : (
                                  <Input
                                    type="number"
                                    min={0}
                                    value={prices[row.articleCode] ?? ""}
                                    onChange={(e) =>
                                      setPrices((prev) => ({ ...prev, [row.articleCode]: e.target.value }))
                                    }
                                    onFocus={(e) => e.target.select()}
                                    placeholder="0.00"
                                    className="h-7 text-right text-xs tabular-nums w-full"
                                    data-testid={`input-edit-v5-price-${row.articleCode}`}
                                  />
                                )}
                              </div>
                            );
                          })()}
                        </td>

                        <td className="px-1 py-1 text-center">
                          {hasExistingLine && qty > 0 && (
                            <button
                              className="text-muted-foreground/40 hover:text-destructive transition-colors"
                              title="Remove line (set qty to 0)"
                              onClick={() => setQuantities((prev) => ({ ...prev, [row.articleCode]: "0" }))}
                              data-testid={`button-edit-v5-clear-${row.articleCode}`}
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="sticky bottom-0 z-20 border-t-2 bg-slate-100 text-xs font-semibold dark:bg-slate-800">
                    <td className="sticky left-0 z-10 border-r bg-slate-100 px-4 py-3 dark:bg-slate-800"><span className="text-foreground">Totals</span><span className="ml-1.5 font-normal text-muted-foreground">({visibleRows.length} visible products)</span></td>
                    <td className="border-r px-3 py-3 text-xs text-muted-foreground">Total</td>
                    <td
                      className={cn(
                        "border-r px-2 py-3 text-center font-mono tabular-nums",
                        visibleTotalBalance < 0
                          ? "text-destructive"
                          : visibleTotalBalance > 0
                            ? "text-green-700 dark:text-green-400"
                            : "text-muted-foreground"
                      )}
                    >
                      {visibleTotalBalance > 0 ? `+${visibleTotalBalance}` : visibleTotalBalance}
                    </td>
                    <td className="border-r px-2 py-3 text-center font-mono tabular-nums text-foreground">
                      {totalQty > 0 ? totalQty : <span className="text-muted-foreground/40">—</span>}
                    </td>
                    <td className="border-r px-2 py-3 text-center font-mono tabular-nums text-muted-foreground">
                      {totalKg > 0 ? (
                        <span className="text-foreground">
                          {totalKg.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg
                        </span>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>
                    <td className="px-2 py-3 text-center font-mono tabular-nums text-foreground" colSpan={2}>
                      {totalValue > 0 ? (
                        `$${totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Footer */}
            <div className="mx-3 mt-3 flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-card/90 px-4 py-3 shadow-sm sm:mx-5">
              <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
                <span>
                  <span className="font-semibold text-foreground">{filledLines}</span> line
                  {filledLines !== 1 ? "s" : ""} visible
                </span>
                <span>
                  <span className="font-semibold text-foreground">{totalQty}</span> visible bales
                </span>
                {totalKg > 0 && (
                  <span>
                    <span className="font-semibold text-foreground">
                      {totalKg.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                    </span>{" "}
                    kg
                  </span>
                )}
                {warningCount > 0 && (
                  <span className="flex items-center gap-1 text-destructive">
                    <AlertTriangle className="h-3 w-3" />
                    {warningCount} product{warningCount !== 1 ? "s" : ""} with shortage
                  </span>
                )}
                <span className="text-[11px] text-muted-foreground/60">Ctrl/⌘+S to save</span>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={onClose} data-testid="button-edit-v5-cancel">
                  Cancel
                </Button>
                <Button
                  onClick={() => saveMutation.mutate()}
                  disabled={saveMutation.isPending || !proformaName.trim()}
                  data-testid="button-edit-v5-save"
                    className="bg-violet-600 text-white hover:bg-violet-700"
                >
                  {saveMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : (
                    <Save className="h-4 w-4 mr-2" />
                  )}
                  Save Changes
                </Button>
              </div>
            </div>
          </>
        )}
    </div>
  );
}
