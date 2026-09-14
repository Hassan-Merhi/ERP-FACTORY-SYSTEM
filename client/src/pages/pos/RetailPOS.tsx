import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRightLeft, ImageIcon, Minus, Plus, RotateCcw, Search, ShoppingCart, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCompany } from "@/contexts/CompanyContext";
import { useLocation as useLocationContext } from "@/contexts/LocationContext";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface Location {
  id: number;
  code: string;
  name: string;
  city: string | null;
  state: string | null;
  country: string | null;
}

interface RetailPosItem {
  variantId: number;
  productId: number;
  code: string;
  name: string;
  brand: string;
  imageUrls: string[];
  size: string;
  sku: string | null;
  barcode: string;
  price: number;
  quantity: number;
}

interface CartLine extends RetailPosItem {
  cartQuantity: number;
}

interface SaleItem {
  id: number;
  variantId: number;
  quantity: number;
  returnedQuantity: number;
  unitPrice: number;
  name: string;
  code: string;
  size: string;
  barcode: string;
  sku: string | null;
  imageUrls: string[];
  brand: string;
}

interface RetailSale {
  id: number;
  locationId: number;
  status: string;
  totalAmount: number;
  createdAt: string;
  items: SaleItem[];
}

async function readJson<T>(url: string): Promise<T> {
  const response = await apiRequest("GET", url);
  return (await response.json()) as T;
}

function makeKey(prefix: string): string {
  const uuid =
    typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return `${prefix}-${uuid}`.slice(0, 191);
}

function money(value: number): string {
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value || 0);
}

function ItemImage({ item }: { item: Pick<RetailPosItem, "imageUrls" | "name"> }) {
  const src = item.imageUrls?.[0];
  if (!src) {
    return (
      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <ImageIcon className="h-5 w-5" />
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={item.name}
      loading="lazy"
      decoding="async"
      className="h-14 w-14 shrink-0 rounded-md object-cover"
    />
  );
}

function useBarcodeScanner(onScan: (barcode: string) => void) {
  const bufferRef = useRef("");
  const lastKeyAtRef = useRef(0);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      const now = Date.now();
      if (now - lastKeyAtRef.current > 120) bufferRef.current = "";
      lastKeyAtRef.current = now;

      if (event.key === "Enter") {
        const barcode = bufferRef.current.trim();
        bufferRef.current = "";
        if (barcode.length >= 3) {
          event.preventDefault();
          onScan(barcode);
        }
        return;
      }
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        bufferRef.current += event.key;
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onScan]);
}

export default function RetailPOS() {
  const { selectedCompany } = useCompany();
  const { selectedLocation, setSelectedLocation } = useLocationContext();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [transferVariantId, setTransferVariantId] = useState<number | "">("");
  const [transferToLocationId, setTransferToLocationId] = useState<number | "">("");
  const [transferQuantity, setTransferQuantity] = useState(1);
  const saleAttemptRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const transferAttemptRef = useRef<{ fingerprint: string; key: string } | null>(null);

  const locationsQuery = useQuery({
    queryKey: ["retail-pos-locations", selectedCompany?.id],
    queryFn: () => readJson<Location[]>("/api/locations"),
    enabled: selectedCompany?.companyType === "retail",
  });
  const isPosRole = selectedCompany?.role === "POS";
  const assignedLocationId = selectedCompany?.assignedLocationId ?? null;
  const locations = (locationsQuery.data ?? [])
    .filter((location) => location.id > 0)
    .filter((location) => !isPosRole || location.id === assignedLocationId);

  useEffect(() => {
    if (isPosRole) {
      const assignedLocation = locations.find((location) => location.id === assignedLocationId) ?? null;
      if (selectedLocation?.id !== assignedLocation?.id) setSelectedLocation(assignedLocation);
      return;
    }
    if (!selectedLocation && locations.length === 1) setSelectedLocation(locations[0]);
  }, [assignedLocationId, isPosRole, locations, selectedLocation, setSelectedLocation]);

  useEffect(() => {
    setCart([]);
    setSearch("");
    setTransferVariantId("");
    setTransferToLocationId("");
  }, [selectedCompany?.id, selectedLocation?.id]);

  const itemsQuery = useQuery({
    queryKey: ["retail-pos-items", selectedCompany?.id, selectedLocation?.id, search],
    queryFn: () =>
      readJson<RetailPosItem[]>(
        `/api/pos/retail/items?locationId=${selectedLocation!.id}&search=${encodeURIComponent(search.trim())}&limit=60`
      ),
    enabled: selectedCompany?.companyType === "retail" && Boolean(selectedLocation?.id),
  });

  const salesQuery = useQuery({
    queryKey: ["retail-pos-sales", selectedCompany?.id, selectedLocation?.id],
    queryFn: () => readJson<RetailSale[]>(`/api/pos/retail/sales?locationId=${selectedLocation!.id}&limit=12`),
    enabled: selectedCompany?.companyType === "retail" && Boolean(selectedLocation?.id),
  });

  const refreshRetailPos = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["retail-pos-items"] }),
      queryClient.invalidateQueries({ queryKey: ["retail-pos-sales"] }),
      queryClient.invalidateQueries({ queryKey: ["retail-products"] }),
    ]);
  };

  const addItem = (item: RetailPosItem, quantity = 1) => {
    setCart((current) => {
      const existing = current.find((line) => line.variantId === item.variantId);
      if (existing) {
        return current.map((line) =>
          line.variantId === item.variantId ? { ...line, cartQuantity: line.cartQuantity + quantity } : line
        );
      }
      return [...current, { ...item, cartQuantity: quantity }];
    });
  };

  const scanBarcode = async (barcode: string) => {
    if (!selectedLocation?.id) {
      toast({ title: "Select a location first", variant: "destructive" });
      return;
    }
    try {
      const item = await readJson<RetailPosItem>(
        `/api/pos/retail/barcodes/${encodeURIComponent(barcode)}?locationId=${selectedLocation.id}`
      );
      addItem(item);
      toast({ title: `${item.name} · ${item.size}`, description: "Scanned into cart" });
    } catch (error) {
      toast({
        title: "Barcode not found",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    }
  };

  useBarcodeScanner(scanBarcode);

  const saleMutation = useMutation({
    mutationFn: async () => {
      if (!selectedLocation?.id || !cart.length) throw new Error("Select a location and add at least one item");
      const items = cart.map((line) => ({ variantId: line.variantId, quantity: line.cartQuantity }));
      const fingerprint = `${selectedLocation.id}|${items
        .map((item) => `${item.variantId}:${item.quantity}`)
        .sort()
        .join("|")}`;
      if (!saleAttemptRef.current || saleAttemptRef.current.fingerprint !== fingerprint) {
        saleAttemptRef.current = { fingerprint, key: makeKey("retail-sale") };
      }
      const response = await apiRequest("POST", "/api/pos/retail/sales", {
        locationId: selectedLocation.id,
        idempotencyKey: saleAttemptRef.current.key,
        items,
      });
      return response.json();
    },
    onSuccess: async () => {
      saleAttemptRef.current = null;
      setCart([]);
      await refreshRetailPos();
      toast({ title: "Sale completed", description: "Exact variant stock was deducted." });
    },
    onError: (error) => toast({ title: "Sale failed", description: error.message, variant: "destructive" }),
  });

  const returnMutation = useMutation({
    mutationFn: async ({
      saleId,
      saleItemId,
      returnedQuantity,
    }: {
      saleId: number;
      saleItemId: number;
      returnedQuantity: number;
    }) => {
      if (!selectedLocation?.id) throw new Error("Select a location first");
      const response = await apiRequest("POST", `/api/pos/retail/sales/${saleId}/returns`, {
        locationId: selectedLocation.id,
        idempotencyKey: `retail-return-${saleId}-${saleItemId}-${returnedQuantity}`,
        items: [{ saleItemId, quantity: 1 }],
      });
      return response.json();
    },
    onSuccess: async () => {
      await refreshRetailPos();
      toast({ title: "Return completed", description: "The exact size was restored to this location." });
    },
    onError: (error) => toast({ title: "Return failed", description: error.message, variant: "destructive" }),
  });

  const cancelMutation = useMutation({
    mutationFn: async (saleId: number) => {
      if (!selectedLocation?.id) throw new Error("Select a location first");
      const response = await apiRequest("POST", `/api/pos/retail/sales/${saleId}/cancel`, {
        locationId: selectedLocation.id,
        idempotencyKey: `retail-cancel-${saleId}`,
        reason: "POS sale cancellation",
      });
      return response.json();
    },
    onSuccess: async () => {
      await refreshRetailPos();
      toast({ title: "Sale canceled", description: "Unreturned quantities were restored exactly once." });
    },
    onError: (error) => toast({ title: "Cancellation failed", description: error.message, variant: "destructive" }),
  });

  const transferMutation = useMutation({
    mutationFn: async () => {
      if (!selectedLocation?.id || !transferVariantId || !transferToLocationId || transferQuantity <= 0) {
        throw new Error("Choose an item, destination and quantity");
      }
      const fingerprint = `${selectedLocation.id}|${transferToLocationId}|${transferVariantId}|${transferQuantity}`;
      if (!transferAttemptRef.current || transferAttemptRef.current.fingerprint !== fingerprint) {
        transferAttemptRef.current = { fingerprint, key: makeKey("retail-transfer") };
      }
      const response = await apiRequest("POST", "/api/pos/retail/transfers", {
        idempotencyKey: transferAttemptRef.current.key,
        variantId: Number(transferVariantId),
        fromLocationId: selectedLocation.id,
        toLocationId: Number(transferToLocationId),
        quantity: Number(transferQuantity),
      });
      return response.json();
    },
    onSuccess: async () => {
      transferAttemptRef.current = null;
      setTransferVariantId("");
      setTransferToLocationId("");
      setTransferQuantity(1);
      await refreshRetailPos();
      toast({ title: "Transfer completed", description: "The exact variant moved between locations." });
    },
    onError: (error) => toast({ title: "Transfer failed", description: error.message, variant: "destructive" }),
  });

  const total = useMemo(() => cart.reduce((sum, line) => sum + line.price * line.cartQuantity, 0), [cart]);

  if (selectedCompany?.companyType !== "retail") return null;

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 p-3 md:p-5">
      <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Retail POS</h1>
          <p className="text-sm text-muted-foreground">
            Scan a barcode or search by name, SKU, barcode, brand, or size.
          </p>
        </div>
        <div className="w-full md:w-72">
          <Label htmlFor="retail-pos-location">Selling location</Label>
          <select
            id="retail-pos-location"
            disabled={isPosRole}
            value={selectedLocation?.id ?? ""}
            onChange={(event) => {
              const location = locations.find((entry) => entry.id === Number(event.target.value)) ?? null;
              setSelectedLocation(location);
            }}
            className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="">Select location</option>
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(360px,0.7fr)]">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">Find item</CardTitle>
            <form
              className="relative"
              onSubmit={(event) => {
                event.preventDefault();
                const value = search.trim();
                if (value) void scanBarcode(value);
              }}
            >
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Scan barcode or search product / SKU / brand / size"
                className="pl-9"
              />
            </form>
          </CardHeader>
          <CardContent>
            {!selectedLocation ? (
              <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                Select a location to load retail stock.
              </div>
            ) : itemsQuery.isLoading ? (
              <div className="p-8 text-center text-sm text-muted-foreground">Loading variants…</div>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {(itemsQuery.data ?? []).map((item) => (
                  <button
                    type="button"
                    key={item.variantId}
                    onClick={() => addItem(item)}
                    className="flex min-h-24 items-center gap-3 rounded-lg border p-3 text-left transition hover:border-primary hover:bg-muted/40"
                  >
                    <ItemImage item={item} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{item.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {item.brand} · Size {item.size}
                      </span>
                      <span className="mt-1 flex items-center justify-between text-sm">
                        <strong>${money(item.price)}</strong>
                        <span className={item.quantity <= 0 ? "font-medium text-destructive" : "text-muted-foreground"}>
                          Qty {item.quantity}
                        </span>
                      </span>
                    </span>
                  </button>
                ))}
                {!itemsQuery.isLoading && !(itemsQuery.data ?? []).length && (
                  <div className="col-span-full rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                    No matching retail variants.
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="h-fit xl:sticky xl:top-3">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <ShoppingCart className="h-5 w-5" /> Cart
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {cart.map((line) => (
              <div key={line.variantId} className="flex items-center gap-3 rounded-lg border p-3">
                <ItemImage item={line} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{line.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {line.brand} · {line.size} · {line.barcode}
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <Button
                      size="icon"
                      variant="outline"
                      className="h-7 w-7"
                      onClick={() =>
                        setCart((current) =>
                          current.map((item) =>
                            item.variantId === line.variantId
                              ? { ...item, cartQuantity: Math.max(1, item.cartQuantity - 1) }
                              : item
                          )
                        )
                      }
                    >
                      <Minus className="h-3.5 w-3.5" />
                    </Button>
                    <span className="w-8 text-center text-sm font-medium">{line.cartQuantity}</span>
                    <Button size="icon" variant="outline" className="h-7 w-7" onClick={() => addItem(line)}>
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                    <span className="ml-auto text-sm font-semibold">${money(line.price * line.cartQuantity)}</span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => setCart((current) => current.filter((item) => item.variantId !== line.variantId))}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
            {!cart.length && (
              <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                Scan or select an exact size to start a sale.
              </div>
            )}
            <div className="flex items-center justify-between border-t pt-3 text-lg font-semibold">
              <span>Total</span>
              <span>${money(total)}</span>
            </div>
            <Button
              className="w-full"
              size="lg"
              disabled={!cart.length || saleMutation.isPending}
              onClick={() => saleMutation.mutate()}
            >
              {saleMutation.isPending ? "Completing sale…" : "Complete Sale"}
            </Button>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Recent retail sales & returns</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {(salesQuery.data ?? []).map((sale) => (
              <div key={sale.id} className="rounded-lg border p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div>
                    <strong>Sale #{sale.id}</strong>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {new Date(sale.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">${money(sale.totalAmount)}</span>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{sale.status}</span>
                  </div>
                </div>
                <div className="space-y-1.5">
                  {sale.items.map((item) => {
                    const remaining = Math.max(0, item.quantity - item.returnedQuantity);
                    return (
                      <div key={item.id} className="flex items-center gap-2 text-sm">
                        <span className="min-w-0 flex-1 truncate">
                          {item.name} · {item.size} <span className="text-muted-foreground">× {item.quantity}</span>
                        </span>
                        {item.returnedQuantity > 0 && (
                          <span className="text-xs text-muted-foreground">Returned {item.returnedQuantity}</span>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={sale.status !== "completed" || remaining < 1 || returnMutation.isPending}
                          onClick={() =>
                            returnMutation.mutate({
                              saleId: sale.id,
                              saleItemId: item.id,
                              returnedQuantity: item.returnedQuantity,
                            })
                          }
                        >
                          <RotateCcw className="mr-1 h-3.5 w-3.5" />
                          Return 1
                        </Button>
                      </div>
                    );
                  })}
                </div>
                {sale.status === "completed" && (
                  <div className="mt-3 flex justify-end">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={cancelMutation.isPending}
                      onClick={() => cancelMutation.mutate(sale.id)}
                    >
                      Cancel / reverse sale
                    </Button>
                  </div>
                )}
              </div>
            ))}
            {!salesQuery.isLoading && !(salesQuery.data ?? []).length && (
              <div className="text-sm text-muted-foreground">No retail sales at this location yet.</div>
            )}
          </CardContent>
        </Card>

        {!isPosRole && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <ArrowRightLeft className="h-5 w-5" /> Exact-variant transfer
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <Label>Variant</Label>
                <select
                  value={transferVariantId}
                  onChange={(event) => setTransferVariantId(event.target.value ? Number(event.target.value) : "")}
                  className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                >
                  <option value="">Choose exact product + size</option>
                  {(itemsQuery.data ?? []).map((item) => (
                    <option key={item.variantId} value={item.variantId}>
                      {item.name} · {item.brand} · {item.size} · Qty {item.quantity}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label>Destination</Label>
                <select
                  value={transferToLocationId}
                  onChange={(event) => setTransferToLocationId(event.target.value ? Number(event.target.value) : "")}
                  className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                >
                  <option value="">Choose destination</option>
                  {locations
                    .filter((location) => location.id !== selectedLocation?.id)
                    .map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.name}
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <Label htmlFor="retail-transfer-qty">Quantity</Label>
                <Input
                  id="retail-transfer-qty"
                  type="number"
                  min="0.000001"
                  step="1"
                  value={transferQuantity}
                  onChange={(event) => setTransferQuantity(Number(event.target.value))}
                />
              </div>
              <Button
                variant="outline"
                className="w-full"
                disabled={transferMutation.isPending || !transferVariantId || !transferToLocationId}
                onClick={() => transferMutation.mutate()}
              >
                {transferMutation.isPending ? "Transferring…" : "Transfer exact variant"}
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
