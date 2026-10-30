/**
 * Extra expected article lines belonging to ONE loading/container only.
 * This is deliberately not a proforma editor and never updates its master.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { queryClient, keyStartsWith } from "@/lib/queryClient";
import { ContainerExtraExcelPanel } from "./ContainerExtraExcelPanel";

type Product = { id: number; articleCode: string | null; name: string; active?: boolean; sellingPrice?: string | null };
type ExtraItem = { articleCode: string; productName: string; expectedQty: number; pricePerBale: string };
type AgreedPrice = { article_code: string; price_per_bale: string };

export function ContainerExtraItemsDialog({
  orderId,
  customerId,
  status,
}: {
  orderId?: string | number | null;
  customerId?: number | null;
  status?: string | null;
}) {
  const { toast } = useToast();
  const appMode = useAppMode();
  const request = getApiRequest(appMode);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedCode, setSelectedCode] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [priceInput, setPriceInput] = useState("");
  const { data: user } = useQuery<{ role?: string }>({ queryKey: ["/api/auth/me"], retry: false });
  const authorized = ["Admin", "Owner", "Developer"].includes(user?.role ?? "");
  const editable = ["DRAFT", "LOADING", "PENDING_VERIFICATION", "VERIFIED"].includes(status || "");
  const enabled = open && authorized && !!orderId && !!customerId;
  const endpoint = `/api/factory/customer-orders/${orderId}/container-extra-items`;

  const { data: extras = [] } = useQuery<ExtraItem[]>({
    queryKey: [endpoint],
    queryFn: async () => {
      const response = await fetch(endpoint, { credentials: "include" });
      if (!response.ok) throw new Error("Could not load this container's extra items");
      return response.json();
    },
    enabled,
  });
  const { data: products = [] } = useQuery<Product[]>({
    queryKey: ["/api/factory/bale-products", "picker"],
    queryFn: async () => {
      const response = await fetch("/api/factory/bale-products?profile=picker", { credentials: "include" });
      if (!response.ok) throw new Error("Could not load article catalog");
      return response.json();
    },
    enabled,
    staleTime: 60_000,
  });
  const { data: prices = [] } = useQuery<AgreedPrice[]>({
    queryKey: ["/api/factory/customer-price-lists", customerId],
    queryFn: async () => {
      const response = await fetch(`/api/factory/customer-price-lists/${customerId}`, { credentials: "include" });
      if (!response.ok) throw new Error("Could not load saved agreed prices");
      return response.json();
    },
    enabled,
    staleTime: 30_000,
  });
  const priceByCode = useMemo(
    () => new Map(prices.map((row) => [row.article_code.trim().toUpperCase(), row.price_per_bale])),
    [prices]
  );
  const selectedProduct = products.find((p) => p.articleCode?.trim().toUpperCase() === selectedCode);
  const price = selectedCode ? priceByCode.get(selectedCode) : undefined;
  const selling = Number(selectedProduct?.sellingPrice ?? 0);
  const suggestedPrice = Number(price ?? 0) > 0 ? Number(price) : selling > 0 ? selling : 0;
  const manualPriceValid = !priceInput.trim() || (/^\d+(?:\.\d{1,4})?$/.test(priceInput.trim()) && Number(priceInput) <= 99999999);
  const matchingProducts = useMemo(() => {
    const term = search.trim().toLowerCase();
    return products
      .filter((p) => p.articleCode && (p.active !== false) &&
        (!term || p.articleCode.toLowerCase().includes(term) || p.name.toLowerCase().includes(term)))
      .slice(0, 60);
  }, [products, search]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: [endpoint] });
    queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
    queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-proformas/capacity"] });
  };
  const save = useMutation({
    mutationFn: async () => {
      const res = await request("PUT", endpoint, { articleCode: selectedCode, quantity: Number(quantity),
        ...(priceInput.trim() ? { pricePerBale: priceInput.trim() } : {}) });
      return res.json();
    },
    onSuccess: () => {
      refresh();
      toast({ title: "Container item saved", description: "Only this loading's expected items were changed." });
      setSelectedCode("");
      setQuantity("1");
      setPriceInput("");
      setSearch("");
    },
    onError: (error: Error) => toast({ title: "Could not save extra item", description: error.message, variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: async (articleCode: string) => {
      await request("DELETE", `${endpoint}/${encodeURIComponent(articleCode)}`);
    },
    onSuccess: () => {
      refresh();
      toast({ title: "Extra item removed from this container" });
    },
    onError: (error: Error) => toast({ title: "Could not remove item", description: error.message, variant: "destructive" }),
  });
  if (!authorized || !orderId || !customerId || !editable) return null;

  const validQty = Number.isSafeInteger(Number(quantity)) && Number(quantity) > 0 && Number(quantity) <= 100000;
  const hasAgreedPrice = price !== undefined && Number(price) > 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" data-testid="button-add-container-items">
          <Plus className="mr-1.5 h-4 w-4" />
          Add Container Items
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto" data-testid="dialog-container-extra-items">
        <DialogHeader>
          <DialogTitle>Additional items for Loading #{orderId}</DialogTitle>
          <DialogDescription>
            These quantities apply only to this container's expected list and comparison.
            The original proforma stays unchanged. Prices use the customer agreed rate, catalog selling rate, or a manual amount.
          </DialogDescription>
        </DialogHeader>

        <ContainerExtraExcelPanel endpoint={endpoint} products={products} prices={prices} onImported={refresh} />

        <div className="space-y-3">
          <Label htmlFor="extra-article-search">Find article by code or product name</Label>
          <Input id="extra-article-search" value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search articles..." data-testid="input-container-extra-search" />
          <div className="max-h-44 space-y-1 overflow-y-auto rounded-md border p-1">
            {matchingProducts.map((p) => {
              const code = p.articleCode!.trim().toUpperCase();
              const agreed = Number(priceByCode.get(code) ?? 0);
              const selling = Number(p.sellingPrice ?? 0);
              return (
                <button type="button" key={p.id} onClick={() => {
                    setSelectedCode(code);
                    const existing = extras.find((e) => e.articleCode.trim().toUpperCase() === code);
                    setQuantity(String(existing?.expectedQty ?? 1));
                    setPriceInput(existing ? String(existing.pricePerBale) : "");
                  }}
                  className={`flex w-full items-center justify-between gap-3 rounded px-3 py-2 text-left text-xs hover:bg-muted ${selectedCode === code ? "bg-primary/10 ring-1 ring-primary/30" : ""}`}
                  data-testid={`select-container-extra-${code}`}
                >
                  <span className="min-w-0 truncate"><strong className="mr-2 font-mono">{code}</strong>{p.name}</span>
                  <span className="shrink-0 tabular-nums">{agreed > 0 ? `${agreed.toFixed(2)} agreed` : selling > 0 ? `${selling.toFixed(2)} selling` : "Unpriced"}</span>
                </button>
              );
            })}
            {!matchingProducts.length && <p className="p-3 text-sm text-muted-foreground">No articles found.</p>}
          </div>
        </div>

        {selectedProduct && (
          <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
            <p className="text-sm font-medium">{selectedProduct.articleCode} — {selectedProduct.name}</p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-32 space-y-1">
                <Label htmlFor="container-extra-qty">Extra bales</Label>
                <Input id="container-extra-qty" type="number" min="1" max="100000" step="1" value={quantity}
                  onChange={(e) => setQuantity(e.target.value)} data-testid="input-container-extra-qty" />
              </div>
              <div className="min-w-[160px] flex-1 space-y-1">
                <Label htmlFor="container-extra-price">Price per bale (optional)</Label>
                <Input id="container-extra-price" value={priceInput} inputMode="decimal"
                  placeholder={suggestedPrice > 0 ? suggestedPrice.toFixed(2) + " auto" : "0.00"}
                  onChange={(e) => setPriceInput(e.target.value)} data-testid="input-container-extra-price" />
              </div>
              <Button disabled={!validQty || !manualPriceValid || save.isPending} onClick={() => save.mutate()}
                data-testid="button-save-container-extra">
                {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save to this container
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {hasAgreedPrice ? "Agreed price: $" + Number(price).toFixed(2)
                : selling > 0 ? "No agreed price · Selling price: $" + selling.toFixed(2)
                  : "No agreed or selling price"}
              {" · Leave blank to use automatic price, or enter a manual price (including 0)."}
            </p>
            {!manualPriceValid && <p className="text-xs text-destructive">Enter a valid non-negative price with up to 4 decimals.</p>}
            {!suggestedPrice && !priceInput.trim() && (
              <p className="text-xs text-amber-600">No price set. You can still save now, then edit the price later.</p>
            )}
            <p className="text-xs text-muted-foreground">
              Saving an existing row replaces its extra quantity; it does not change the master's requested quantity.
            </p>
          </div>
        )}

        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Items added to this container ({extras.length})</h3>
          {extras.map((item) => (
            <div key={item.articleCode} className="flex items-center gap-3 rounded-lg border p-2 text-sm">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{item.articleCode} — {item.productName}</p>
                <p className="text-xs text-muted-foreground">
                  +{item.expectedQty} bales • {Number(item.pricePerBale) > 0 ? "$" + Number(item.pricePerBale).toFixed(2) + " / bale" : "Unpriced — edit to set price"}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => {
                setSearch(item.articleCode);
                setSelectedCode(item.articleCode.trim().toUpperCase());
                setQuantity(String(item.expectedQty));
                setPriceInput(String(item.pricePerBale));
              }}>Edit</Button>
              <Button variant="ghost" size="icon" aria-label={`Remove ${item.articleCode}`}
                disabled={remove.isPending} onClick={() => remove.mutate(item.articleCode)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          {!extras.length && <p className="text-sm text-muted-foreground">No extra items added to this container.</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
