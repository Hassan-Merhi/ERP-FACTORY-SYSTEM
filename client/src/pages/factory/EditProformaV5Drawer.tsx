import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Loader2, CheckCircle2, Save, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface ArticleRow {
  articleCode: string;
  productName: string;
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
  name: string;
  isActive: boolean;
  customerId: number;
  lines: ExistingLine[];
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
  const [appliedPrice, setAppliedPrice] = useState<"sell" | "prod" | null>(null);
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
      onClose();
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
    return base.slice().sort((a, b) => a.productName.localeCompare(b.productName));
  })();

  const visibleTotalBalance = visibleRows.reduce((s, r) => s + r.freeToPromise, 0);

  const filledLines = articleRows.filter((r) => {
    const v = quantities[r.articleCode];
    return v && parseInt(v) > 0;
  }).length;
  const totalQty = articleRows.reduce((s, r) => {
    const v = parseInt(quantities[r.articleCode] || "0");
    return s + (isNaN(v) || v < 0 ? 0 : v);
  }, 0);
  const totalKg = articleRows.reduce((s, r) => {
    const qty = parseInt(quantities[r.articleCode] || "0");
    if (isNaN(qty) || qty <= 0) return s;
    const p = map.get(r.articleCode);
    const w = parseFloat(p?.weightPerBaleKg || "0");
    return s + qty * w;
  }, 0);
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
    const price = parseFloat(prices[r.articleCode] || "0");
    return s + qty * price;
  }, 0);
  const warningCount = articleRows.filter((r) => {
    const qty = parseInt(quantities[r.articleCode] || "0");
    return !isNaN(qty) && qty > 0 && r.freeToPromise < 0;
  }).length;

  const isLoading = proformaQuery.isLoading;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent
        className="max-w-[98vw] w-[98vw] h-[85dvh] sm:h-[96dvh] flex flex-col p-0 gap-0"
        data-testid="dialog-edit-proforma-v5"
      >
        <DialogHeader className="px-5 py-4 border-b shrink-0">
          <DialogTitle className="text-base flex items-center gap-2">
            Edit Proforma
            <Badge variant="secondary" className="text-[10px] font-semibold tracking-wide">
              v5
            </Badge>
          </DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {/* Top fields */}
            <div className="px-5 py-3 border-b shrink-0 flex flex-wrap gap-4 items-end">
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

              {zeroItemCount > 0 && (
                <div className="border-l pl-4">
                  <Button
                    size="default"
                    variant={showZeroItems ? "secondary" : "outline"}
                    onClick={() => setShowZeroItems((v) => !v)}
                    data-testid="button-edit-v5-toggle-zero"
                  >
                    {showZeroItems ? `Hide 0-stock (${zeroItemCount})` : `Show 0-stock (${zeroItemCount})`}
                  </Button>
                </div>
              )}

              {nonPositiveCount > 0 && (
                <div className={zeroItemCount === 0 ? "border-l pl-4" : ""}>
                  <Button
                    size="default"
                    variant={hideNonPositive ? "default" : "outline"}
                    onClick={() => setHideNonPositive((v) => !v)}
                    data-testid="button-edit-v5-hide-non-positive"
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
                  >
                    {showGarbageWipers
                      ? `Hide Garbage/Wipers (${garbageWipersCount})`
                      : `Show Garbage/Wipers (${garbageWipersCount})`}
                  </Button>
                </div>
              )}

              <div className="flex items-center gap-2 ml-auto flex-wrap">
                <Button
                  size="sm"
                  variant={appliedPrice === "sell" ? "secondary" : "outline"}
                  onClick={applyCatalogSellingPrice}
                  disabled={!productsQuery.data}
                  data-testid="button-edit-v5-apply-sell-price"
                  className={cn(appliedPrice === "sell" && "ring-2 ring-primary/40")}
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
                  className={cn(appliedPrice === "prod" && "ring-2 ring-primary/40")}
                >
                  {appliedPrice === "prod" && <CheckCircle2 className="h-3.5 w-3.5 mr-1.5 text-primary" />}
                  Apply Prod Price
                </Button>
              </div>
            </div>

            {/* Table */}
            <div className="flex-1 overflow-auto">
              <table className="w-full text-sm border-collapse min-w-max">
                <thead>
                  <tr className="bg-muted sticky top-0 z-30">
                    <th className="text-left px-3 py-2 font-medium border-b border-r whitespace-nowrap min-w-[200px] sticky left-0 bg-muted z-20">
                      Product
                    </th>
                    <th className="text-right px-3 py-2 font-medium border-b border-r whitespace-nowrap min-w-[130px]">
                      Available Balance
                    </th>
                    <th className="text-center px-3 py-2 font-medium border-b border-r whitespace-nowrap min-w-[110px]">
                      Qty / Container
                    </th>
                    <th className="text-right px-3 py-2 font-medium border-b border-r whitespace-nowrap min-w-[90px] text-muted-foreground">
                      Total KG
                    </th>
                    <th className="text-center px-3 py-2 font-medium border-b whitespace-nowrap min-w-[130px]">
                      Price
                    </th>
                    <th className="text-center px-3 py-2 font-medium border-b whitespace-nowrap w-10"></th>
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
                          idx % 2 === 0 ? "bg-background" : "bg-muted/20",
                          qty > 0 && "bg-blue-50/30 dark:bg-blue-950/20"
                        )}
                        data-testid={`row-v5-edit-${row.articleCode}`}
                      >
                        <td className="px-3 py-1.5 border-r sticky left-0 bg-inherit z-10">
                          <div className="flex items-center gap-1.5">
                            {hasExistingLine && qty > 0 && (
                              <div
                                className="w-1.5 h-1.5 rounded-full bg-primary shrink-0"
                                title="Line exists in proforma"
                              />
                            )}
                            <div>
                              <div
                                className="font-medium truncate max-w-[220px] text-xs leading-tight"
                                title={row.productName}
                              >
                                {row.productName}
                              </div>
                              <div className="text-[10px] text-muted-foreground font-mono">{row.articleCode}</div>
                            </div>
                          </div>
                        </td>

                        <td
                          className={cn(
                            "px-3 py-1.5 border-r text-right font-mono tabular-nums text-xs font-semibold",
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

                        <td className="px-2 py-1 border-r">
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
                              <span className="text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-0.5 whitespace-nowrap">
                                <AlertTriangle className="h-2.5 w-2.5" />
                                Low stock
                              </span>
                            )}
                          </div>
                        </td>

                        <td className="px-3 py-1.5 border-r text-right text-xs text-muted-foreground tabular-nums">
                          {totalKgRow != null ? (
                            <span className="text-foreground font-medium">
                              {totalKgRow.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg
                            </span>
                          ) : (
                            <span className="text-muted-foreground/40">—</span>
                          )}
                        </td>

                        <td className="px-2 py-1">
                          {(() => {
                            const mode = pricingModes[row.articleCode] ?? "per_bale";
                            return (
                              <div className="flex items-center gap-1">
                                <div className="flex rounded border shrink-0 overflow-hidden text-[9px] font-semibold">
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
                  <tr className="bg-muted border-t-2 sticky bottom-0 z-20 text-xs font-semibold">
                    <td className="px-3 py-2 border-r sticky left-0 bg-muted z-10">
                      <span className="text-foreground">Totals</span>
                      <span className="font-normal text-muted-foreground ml-1.5">({visibleRows.length} products)</span>
                    </td>
                    <td
                      className={cn(
                        "px-3 py-2 border-r text-right font-mono tabular-nums",
                        visibleTotalBalance < 0
                          ? "text-destructive"
                          : visibleTotalBalance > 0
                            ? "text-green-700 dark:text-green-400"
                            : "text-muted-foreground"
                      )}
                    >
                      {visibleTotalBalance > 0 ? `+${visibleTotalBalance}` : visibleTotalBalance}
                    </td>
                    <td className="px-3 py-2 border-r text-center font-mono tabular-nums text-foreground">
                      {totalQty > 0 ? totalQty : <span className="text-muted-foreground/40">—</span>}
                    </td>
                    <td className="px-3 py-2 border-r text-right font-mono tabular-nums text-muted-foreground">
                      {totalKg > 0 ? (
                        <span className="text-foreground">
                          {totalKg.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg
                        </span>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-foreground" colSpan={2}>
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
            <div className="px-5 py-3 border-t bg-muted/30 shrink-0 flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
                <span>
                  <span className="font-semibold text-foreground">{filledLines}</span> line
                  {filledLines !== 1 ? "s" : ""}
                </span>
                <span>
                  <span className="font-semibold text-foreground">{totalQty}</span> bales/container
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
                <span className="text-[10px] text-muted-foreground/60">Ctrl/⌘+S to save</span>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={onClose} data-testid="button-edit-v5-cancel">
                  Cancel
                </Button>
                <Button
                  onClick={() => saveMutation.mutate()}
                  disabled={saveMutation.isPending || !proformaName.trim()}
                  data-testid="button-edit-v5-save"
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
      </DialogContent>
    </Dialog>
  );
}
