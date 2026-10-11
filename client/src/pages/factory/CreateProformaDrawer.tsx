import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, Save, Loader2, CheckCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

const DRAFT_KEY = "create-proforma-draft-v2";

interface ArticleRow {
  articleCode: string;
  displayName: string;
  onHand: number;
  reservedNotYetLoaded: number;
  inLoading: number;
  freeToPromise: number;
}

interface FactoryCustomer {
  id: number;
  legalName: string;
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
  articleRows: ArticleRow[];
  onSuccess: () => void;
}

interface Draft {
  customerId: string;
  proformaName: string;
  isActive: boolean;
  quantities: Record<string, string>;
  sellingPrices: Record<string, string>;
  productionPrices: Record<string, string>;
  savedAt: number;
}

function loadDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function saveDraft(d: Draft) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...d, savedAt: Date.now() }));
  } catch {
    // Storage is unavailable in private mode and can throw on quota; the value is a convenience, not state we need.
  }
}
function clearDraft() {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Storage is unavailable in private mode and can throw on quota; the value is a convenience, not state we need.
  }
}

export default function CreateProformaDrawer({ open, onClose, articleRows, onSuccess }: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const draft = loadDraft();
  const [customerId, setCustomerId] = useState(draft?.customerId ?? "");
  const [proformaName, setProformaName] = useState(draft?.proformaName ?? "");
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
      isActive,
      quantities,
      sellingPrices,
      productionPrices,
      savedAt: Date.now(),
    });
  }, [customerId, proformaName, isActive, quantities, sellingPrices, productionPrices, triggerAutosave]);

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
    createMutation.mutate({ customerId: parseInt(customerId), name: proformaName.trim(), isActive, lines });
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

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent
        className="max-w-[98vw] w-[98vw] h-[85dvh] sm:h-[96dvh] flex flex-col p-0 gap-0"
        data-testid="dialog-create-proforma"
      >
        <DialogHeader className="px-5 py-4 border-b shrink-0">
          <DialogTitle className="text-base">Create Proforma from Stock Allocation</DialogTitle>
        </DialogHeader>

        {/* Top fields row */}
        <div className="px-5 py-3 border-b shrink-0 flex flex-wrap gap-4 items-end">
          <div className="flex flex-col gap-1.5 min-w-[200px] flex-1">
            <Label htmlFor="proforma-customer" className="text-xs font-medium">
              Customer <span className="text-destructive">*</span>
            </Label>
            <Select
              value={customerId}
              onValueChange={(v) => {
                setCustomerId(v);
                setErrors((p) => {
                  const n = { ...p };
                  delete n.customerId;
                  return n;
                });
              }}
            >
              <SelectTrigger
                id="proforma-customer"
                data-testid="select-proforma-customer"
                className={cn(errors.customerId && "border-destructive")}
              >
                <SelectValue placeholder="Select customer…" />
              </SelectTrigger>
              <SelectContent>
                {customersQuery.isLoading && (
                  <SelectItem value="__loading" disabled>
                    Loading…
                  </SelectItem>
                )}
                {(customersQuery.data || []).map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.legalName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.customerId && <p className="text-xs text-destructive">{errors.customerId}</p>}
          </div>

          <div className="flex flex-col gap-1.5 min-w-[200px] flex-1">
            <Label htmlFor="proforma-name" className="text-xs font-medium">
              Proforma Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="proforma-name"
              data-testid="input-proforma-name"
              value={proformaName}
              onChange={(e) => {
                setProformaName(e.target.value);
                setErrors((p) => {
                  const n = { ...p };
                  delete n.proformaName;
                  return n;
                });
              }}
              placeholder="e.g. Proforma #001"
              className={cn(errors.proformaName && "border-destructive")}
            />
            {errors.proformaName && <p className="text-xs text-destructive">{errors.proformaName}</p>}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs font-medium">Status</Label>
            <div className="flex items-center gap-2 h-9">
              <Switch checked={isActive} onCheckedChange={setIsActive} data-testid="switch-proforma-active" />
              <span className="text-sm text-muted-foreground">{isActive ? "Active" : "Inactive"}</span>
            </div>
          </div>

          {/* Global pricing controls */}
          <div className="flex items-center gap-2 border-l pl-4">
            <Button
              size="default"
              variant="outline"
              onClick={applyCatalogSellingPrice}
              data-testid="button-apply-selling-price"
            >
              Apply Sell Price
            </Button>
            <Button
              size="default"
              variant="outline"
              onClick={applyCatalogProductionPrice}
              data-testid="button-apply-production-price"
            >
              Apply Prod Price
            </Button>
          </div>

          {zeroItemCount > 0 && (
            <div className="border-l pl-4">
              <Button
                size="default"
                variant={showZeroItems ? "secondary" : "outline"}
                onClick={() => setShowZeroItems((v) => !v)}
                data-testid="button-toggle-zero-items"
              >
                {showZeroItems ? `Hide 0-bale (${zeroItemCount})` : `Show 0-bale (${zeroItemCount})`}
              </Button>
            </div>
          )}

          <div className="flex items-center gap-1.5 text-xs text-muted-foreground h-9 ml-auto">
            {draftStatus === "saved" && (
              <>
                <CheckCircle className="h-3 w-3 text-green-500" />
                Draft autosaved
              </>
            )}
          </div>
        </div>

        {errors.lines && (
          <div className="px-5 py-2 bg-destructive/10 border-b shrink-0">
            <p className="text-xs text-destructive">{errors.lines}</p>
          </div>
        )}

        {/* Table */}
        <div className="flex-1 overflow-auto">
          <table className="w-full text-sm border-collapse min-w-max">
            <thead>
              <tr className="bg-muted sticky top-0 z-30">
                <th className="text-left px-3 py-2 font-medium border-b border-r whitespace-nowrap min-w-[200px] sticky left-0 bg-muted z-20">
                  Product
                </th>
                <th className="text-right px-3 py-2 font-medium border-b border-r whitespace-nowrap min-w-[72px]">
                  On Hand
                </th>
                <th className="text-right px-3 py-2 font-medium border-b border-r whitespace-nowrap min-w-[80px] text-amber-600 dark:text-amber-400">
                  Reserved
                </th>
                <th className="text-right px-3 py-2 font-medium border-b border-r whitespace-nowrap min-w-[85px] text-blue-600 dark:text-blue-400">
                  In Loading
                </th>
                <th className="text-right px-3 py-2 font-medium border-b border-r whitespace-nowrap min-w-[95px] text-green-700 dark:text-green-400">
                  Free to Promise
                </th>
                <th className="text-center px-3 py-2 font-medium border-b border-r whitespace-nowrap min-w-[110px]">
                  Qty
                </th>
                <th className="text-right px-3 py-2 font-medium border-b border-r whitespace-nowrap min-w-[90px] text-muted-foreground">
                  Total KG
                </th>
                <th className="text-center px-3 py-2 font-medium border-b whitespace-nowrap min-w-[130px]">Price</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, idx) => {
                const rawVal = quantities[row.articleCode] ?? "";
                const parsed = parseInt(rawVal);
                const qty = isNaN(parsed) ? 0 : parsed;
                const overFtp = qty > 0 && qty > row.freeToPromise;
                const overBy = qty - row.freeToPromise;
                const hasError = !!errors[`qty_${row.articleCode}`];
                const product = map.get(row.articleCode);
                const weightPerBale = parseFloat(product?.weightPerBaleKg || "0");
                const totalRowKg = qty > 0 && weightPerBale > 0 ? qty * weightPerBale : null;

                return (
                  <tr
                    key={row.articleCode}
                    className={cn(
                      "border-b transition-colors",
                      idx % 2 === 0 ? "bg-background" : "bg-muted/20",
                      qty > 0 && "bg-blue-50/30 dark:bg-blue-950/20"
                    )}
                    data-testid={`row-create-${row.articleCode}`}
                  >
                    {/* Product */}
                    <td className="px-3 py-1.5 border-r sticky left-0 bg-inherit z-10">
                      <div className="font-medium truncate max-w-[220px] text-xs leading-tight" title={row.displayName}>
                        {row.displayName}
                      </div>
                      {row.displayName !== row.articleCode && (
                        <div className="text-[11px] text-muted-foreground font-mono">{row.articleCode}</div>
                      )}
                    </td>

                    {/* On Hand */}
                    <td className="px-3 py-1.5 border-r text-right font-mono tabular-nums text-xs">{row.onHand}</td>

                    {/* Reserved */}
                    <td
                      className={cn(
                        "px-3 py-1.5 border-r text-right font-mono tabular-nums text-xs",
                        row.reservedNotYetLoaded > 0 && "text-amber-600 dark:text-amber-400"
                      )}
                    >
                      {row.reservedNotYetLoaded > 0 ? (
                        row.reservedNotYetLoaded
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>

                    {/* In Loading */}
                    <td
                      className={cn(
                        "px-3 py-1.5 border-r text-right font-mono tabular-nums text-xs",
                        row.inLoading > 0 && "text-blue-600 dark:text-blue-400"
                      )}
                    >
                      {row.inLoading > 0 ? row.inLoading : <span className="text-muted-foreground/40">—</span>}
                    </td>

                    {/* FTP */}
                    <td
                      className={cn(
                        "px-3 py-1.5 border-r text-right font-mono tabular-nums text-xs font-semibold",
                        row.freeToPromise > 0
                          ? "text-green-700 dark:text-green-400"
                          : row.freeToPromise === 0
                            ? "text-muted-foreground"
                            : "text-destructive"
                      )}
                    >
                      {row.freeToPromise}
                    </td>

                    {/* Qty */}
                    <td className="px-2 py-1 border-r">
                      <div className="flex flex-col gap-0.5 items-center">
                        <Input
                          ref={(el) => {
                            qtyRefs.current[idx] = el;
                          }}
                          type="number"
                          min={0}
                          value={rawVal}
                          onChange={(e) => handleQtyChange(row.articleCode, e.target.value)}
                          onKeyDown={(e) => handleQtyKeyDown(e, idx)}
                          onFocus={(e) => e.target.select()}
                          placeholder="0"
                          className={cn(
                            "h-7 text-center text-xs font-mono w-20 px-1 tabular-nums",
                            hasError && "border-destructive",
                            overFtp && !hasError && "border-amber-400 dark:border-amber-500",
                            qty > 0 && !overFtp && !hasError && "border-blue-400 dark:border-blue-500"
                          )}
                          data-testid={`input-qty-${row.articleCode}`}
                        />
                        {hasError && (
                          <span className="text-[11px] text-destructive">{errors[`qty_${row.articleCode}`]}</span>
                        )}
                        {overFtp && !hasError && (
                          <span className="text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-0.5 whitespace-nowrap">
                            <AlertTriangle className="h-2.5 w-2.5" />+{overBy} over FTP
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Total KG */}
                    <td className="px-3 py-1.5 border-r text-right font-mono tabular-nums text-xs text-muted-foreground">
                      {totalRowKg != null ? (
                        <span className="text-foreground font-medium">
                          {totalRowKg.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg
                        </span>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>

                    {/* Price (selling or production, depending on which Apply button was used) */}
                    <td className="px-2 py-1">
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        value={sellingPrices[row.articleCode] ?? ""}
                        onChange={(e) => setSellingPrices((prev) => ({ ...prev, [row.articleCode]: e.target.value }))}
                        onFocus={(e) => e.target.select()}
                        placeholder="0.00"
                        className="h-7 text-right text-xs font-mono w-24 px-2 tabular-nums"
                        data-testid={`input-price-${row.articleCode}`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t bg-muted/30 shrink-0 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
            <span>
              <span className="font-semibold text-foreground">{filledLines}</span> line{filledLines !== 1 ? "s" : ""}
            </span>
            <span>
              <span className="font-semibold text-foreground">{totalQty}</span> total bales
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
              <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-3 w-3" />
                {warningCount} over Free to Promise
              </span>
            )}
            <span className="text-[11px] text-muted-foreground/60">Ctrl/⌘+S to save</span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="default" onClick={onClose} data-testid="button-cancel-proforma">
              Cancel
            </Button>
            <Button
              size="default"
              onClick={handleSubmit}
              disabled={createMutation.isPending}
              data-testid="button-create-proforma-submit"
            >
              {createMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating…
                </>
              ) : (
                <>
                  <Save className="h-4 w-4 mr-2" />
                  Create Proforma
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
