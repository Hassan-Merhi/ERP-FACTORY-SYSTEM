import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, ArrowLeftRight, Check, Loader2 } from "lucide-react";
import { useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/PageHeader";
import { productMatchesSearch } from "@shared/factoryProductSearch";

interface BaleProduct {
  id: number;
  code: string;
  articleCode: string | null;
  name: string;
  nameAr: string | null;
  active: boolean;
  totalBales: string;
  inStockBales: string;
}

type Step = "select" | "confirm" | "done";

export default function MergeBaleProducts() {
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const [step, setStep] = useState<Step>("select");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [targetId, setTargetId] = useState<number | null>(null);
  const [result, setResult] = useState<{ movedBales: number; mergedProducts: number; targetName: string } | null>(null);

  const {
    data: products = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery<BaleProduct[]>({
    queryKey: ["/api/factory/bale-products/merge-stats"],
    queryFn: async () => {
      const res = await fetch("/api/factory/bale-products/merge-stats", { credentials: "include" });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message || "Failed to load products");
      }
      return res.json();
    },
    retry: 1,
  });

  const mergeMutation = useMutation({
    mutationFn: async ({ targetId, sourceIds }: { targetId: number; sourceIds: number[] }) => {
      const res = await factoryApiRequest("POST", "/api/factory/bale-products/merge", { targetId, sourceIds });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      return res.json();
    },
    onSuccess: (data) => {
      setResult(data);
      setStep("done");
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products/merge-stats"] });
    },
    onError: (e: ClientErrorLike) => {
      toast({ title: "Merge failed", description: e.message, variant: "destructive" });
    },
  });

  const reset = () => {
    setStep("select");
    setSearch("");
    setSelected(new Set());
    setTargetId(null);
    setResult(null);
  };

  const { filteredProducts, selectedProducts } = useMemo(() => {
    const filteredProducts = search.trim() ? products.filter((p) => productMatchesSearch(p, search)) : products;
    const selectedProducts = products.filter((p) => selected.has(p.id));
    return { filteredProducts, selectedProducts };
  }, [products, search, selected]);

  const canProceed = selected.size >= 2 && targetId !== null;
  const target = products.find((p) => p.id === targetId);
  const sources = products.filter((p) => selected.has(p.id) && p.id !== targetId);

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/factory/settings")} data-testid="button-back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <PageHeader title="Merge Bale Products" icon={<ArrowLeftRight className="h-5 w-5" />} />
          <p className="text-sm text-muted-foreground">
            Select products to combine, then choose which one to keep as the primary. All bales move to the primary and
            the others are deactivated.
          </p>
        </div>
      </div>

      {/* Done */}
      {step === "done" && result ? (
        <div className="rounded-md border p-6 space-y-4">
          <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
            <Check className="h-5 w-5" />
            <p className="font-semibold text-lg">Merge complete</p>
          </div>
          <div className="rounded-md border p-4 space-y-2 text-sm">
            <div>
              <span className="text-muted-foreground">Primary product kept: </span>
              <strong>{result.targetName}</strong>
            </div>
            <div>
              <span className="text-muted-foreground">Duplicates deactivated: </span>
              <strong>{result.mergedProducts}</strong>
            </div>
            <div>
              <span className="text-muted-foreground">Bales reassigned: </span>
              <strong>{result.movedBales}</strong>
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={reset} data-testid="button-merge-again">
              Merge More Products
            </Button>
            <Button variant="outline" onClick={() => navigate("/factory/settings")} data-testid="button-merge-done">
              Back to Settings
            </Button>
          </div>
        </div>
      ) : step === "confirm" ? (
        /* Confirm step */
        <div className="space-y-4">
          <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-800 p-3 text-sm text-amber-800 dark:text-amber-300">
            This cannot be undone. All bales from the source products will be moved to the primary, and the sources will
            be deactivated.
          </div>

          <div className="space-y-3 text-sm">
            <div className="rounded-md border p-3 space-y-1">
              <div className="text-xs text-muted-foreground mb-1">Keeping (primary)</div>
              <div className="font-semibold">{target?.name}</div>
              <div className="text-muted-foreground">
                {target?.code}
                {target?.articleCode ? ` · ${target.articleCode}` : ""}
                {" · "}
                {target?.inStockBales || 0} in stock, {target?.totalBales || 0} total bales
              </div>
            </div>
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">
                Merging into primary ({sources.length} product{sources.length !== 1 ? "s" : ""})
              </div>
              {sources.map((p) => (
                <div key={p.id} className="rounded-md border p-2 flex items-center justify-between gap-2 flex-wrap">
                  <div>
                    <span className="font-medium">{p.name}</span>
                    <span className="text-muted-foreground text-xs ml-2">
                      {p.code}
                      {p.articleCode ? ` · ${p.articleCode}` : ""}
                    </span>
                  </div>
                  <Badge variant="secondary">{p.inStockBales || 0} in stock</Badge>
                </div>
              ))}
            </div>
            <div className="text-muted-foreground">
              {sources.reduce((s, p) => s + parseInt(p.totalBales || "0"), 0)} bale(s) total will move to{" "}
              <strong>{target?.name}</strong>.
            </div>
          </div>

          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => setStep("select")}
              disabled={mergeMutation.isPending}
              data-testid="button-merge-back"
            >
              Back
            </Button>
            <Button
              onClick={() => {
                const sourceIds = Array.from(selected).filter((id) => id !== targetId);
                mergeMutation.mutate({ targetId: targetId!, sourceIds });
              }}
              disabled={mergeMutation.isPending}
              data-testid="button-merge-confirm"
            >
              {mergeMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Merging...
                </>
              ) : (
                <>
                  <ArrowLeftRight className="h-4 w-4 mr-2" />
                  Confirm Merge
                </>
              )}
            </Button>
          </div>
        </div>
      ) : (
        /* Select step */
        <div className="space-y-4">
          <Input
            placeholder="Search by name, code, or article code..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="input-merge-search"
          />

          {/* Product list */}
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : isError ? (
            <div className="rounded-md border p-6 text-center space-y-2">
              <p className="text-sm text-muted-foreground">{(error as Error)?.message || "Failed to load products"}</p>
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                Try Again
              </Button>
            </div>
          ) : filteredProducts.length === 0 ? (
            <div className="rounded-md border p-8 text-center text-sm text-muted-foreground">
              {search ? "No products match your search." : "No bale products found for this company."}
            </div>
          ) : (
            <div className="rounded-md border divide-y max-h-[50vh] overflow-y-auto">
              {filteredProducts.map((p) => {
                const isChecked = selected.has(p.id);
                return (
                  <label
                    key={p.id}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2.5 cursor-pointer hover-elevate",
                      isChecked && "bg-muted/40"
                    )}
                    data-testid={`checkbox-merge-${p.id}`}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => {
                        const next = new Set(selected);
                        if (isChecked) {
                          next.delete(p.id);
                          if (targetId === p.id) setTargetId(null);
                        } else {
                          next.add(p.id);
                        }
                        setSelected(next);
                      }}
                      className="h-4 w-4 shrink-0 accent-primary"
                    />
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium">{p.name}</span>
                      {!p.active && <span className="ml-1.5 text-xs text-muted-foreground">(inactive)</span>}
                      <div className="text-xs text-muted-foreground">
                        {p.code}
                        {p.articleCode ? ` · ${p.articleCode}` : ""}
                      </div>
                    </div>
                    <div className="text-right shrink-0 text-xs text-muted-foreground">
                      <div>{p.inStockBales || 0} in stock</div>
                      <div>{p.totalBales || 0} total</div>
                    </div>
                  </label>
                );
              })}
            </div>
          )}

          {/* Pick primary when 2+ selected */}
          {selectedProducts.length >= 2 && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground font-medium">
                Choose which to keep as primary ({selectedProducts.length} selected):
              </p>
              {selectedProducts.map((p) => {
                const isTarget = targetId === p.id;
                return (
                  <button
                    key={p.id}
                    className={cn(
                      "w-full flex items-center gap-3 rounded-md border px-3 py-2 text-left text-sm",
                      isTarget ? "border-primary bg-primary/5" : "hover-elevate"
                    )}
                    onClick={() => setTargetId(p.id)}
                    data-testid={`radio-merge-target-${p.id}`}
                  >
                    <div
                      className={cn(
                        "h-3.5 w-3.5 shrink-0 rounded-full border-2",
                        isTarget ? "border-primary bg-primary" : "border-muted-foreground"
                      )}
                    />
                    <div className="flex-1 min-w-0">
                      <span className="font-medium">{p.name}</span>
                      {!p.active && <span className="ml-1.5 text-xs text-muted-foreground">(inactive)</span>}
                      <div className="text-xs text-muted-foreground">
                        {p.code}
                        {p.articleCode ? ` · ${p.articleCode}` : ""}
                      </div>
                    </div>
                    <div className="text-right shrink-0 text-xs text-muted-foreground">
                      <div>{p.inStockBales || 0} in stock</div>
                      <div>{p.totalBales || 0} total</div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {selected.size >= 2 && !targetId && (
            <p className="text-xs text-muted-foreground">Pick which product to keep as primary above.</p>
          )}

          <div className="flex gap-2">
            <Button variant="outline" onClick={() => navigate("/factory/settings")} data-testid="button-merge-cancel">
              Cancel
            </Button>
            <Button disabled={!canProceed} onClick={() => setStep("confirm")} data-testid="button-merge-next">
              Next: Review &amp; Confirm
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
