import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRightLeft, History, ImageIcon, PackagePlus, Printer, ScanLine, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { normalizeRetailImageUrl } from "@/lib/retailImageUrl";
import { cn } from "@/lib/utils";
import { RetailNav } from "./RetailNav";
import { RetailMovementHistory } from "./RetailMovementHistory";
import { RetailLabelPrintDialog } from "./retailLabels";
import { getJson, money, type Location } from "./retailInventoryTypes";
import { makeRetailIdempotencyKey } from "./retailIdempotency";

type Mode = "receive" | "transfer" | "adjust" | "history";

interface StockVariant {
  variantId: number;
  productId: number;
  name: string;
  brand: string;
  color: string;
  size: string;
  barcode: string;
  sku: string | null;
  cost: number;
  sellingPrice: number;
  imageUrls: string[];
  active: boolean;
  stocks: Array<{ locationId: number; locationName: string; quantity: number }>;
  totalQuantity: number;
}

const ADJUSTMENT_REASONS = ["Damaged", "Lost / stolen", "Stock count correction", "Found during count", "Other"];

const MODES: Array<{ id: Mode; label: string; icon: typeof PackagePlus }> = [
  { id: "receive", label: "Receive", icon: PackagePlus },
  { id: "transfer", label: "Transfer", icon: ArrowRightLeft },
  { id: "adjust", label: "Adjust", icon: SlidersHorizontal },
  { id: "history", label: "History", icon: History },
];

const makeKey = makeRetailIdempotencyKey;

function initialParams() {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get("mode") as Mode | null;
  return {
    mode: mode && MODES.some((entry) => entry.id === mode) ? mode : ("receive" as Mode),
    variantId: Number(params.get("variant")) || 0,
  };
}

/** Barcode-first stock operations: receive, transfer, adjust and audit one exact variant. */
export default function RetailStockOperations() {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const retailEnabled = selectedCompany?.companyType === "retail";
  const companyKey = selectedCompany?.id ?? 0;
  const [mode, setMode] = useState<Mode>(() => initialParams().mode);
  const [scanText, setScanText] = useState("");
  const [variant, setVariant] = useState<StockVariant | null>(null);
  const [notFound, setNotFound] = useState<string | null>(null);
  const [locationId, setLocationId] = useState<number | "">("");
  const [toLocationId, setToLocationId] = useState<number | "">("");
  const [quantity, setQuantity] = useState(1);
  const [direction, setDirection] = useState<1 | -1>(-1);
  const [reason, setReason] = useState(ADJUSTMENT_REASONS[0]);
  const [reasonNote, setReasonNote] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [reference, setReference] = useState("");
  const [quickReceive, setQuickReceive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [labelOpen, setLabelOpen] = useState(false);
  const scanRef = useRef<HTMLInputElement | null>(null);
  const attemptRef = useRef<{ fingerprint: string; key: string } | null>(null);

  const { data: locations = [] } = useQuery<Location[]>({
    queryKey: ["retail-locations", companyKey],
    queryFn: () => getJson("/api/locations"),
    enabled: retailEnabled,
  });
  const activeLocations = locations.filter((location) => location.id > 0 && location.active !== false);
  useEffect(() => {
    if (locationId === "" && activeLocations.length) setLocationId(activeLocations[0].id);
  }, [activeLocations, locationId]);

  const focusScan = useCallback(() => window.setTimeout(() => scanRef.current?.focus(), 30), []);

  const loadVariant = useCallback(async (query: string) => {
    try {
      const next = await getJson<StockVariant>(`/api/retail/stock/lookup?${query}`);
      setVariant(next);
      setNotFound(null);
      setUnitCost(String(next.cost ?? ""));
      attemptRef.current = null;
      return next;
    } catch {
      setVariant(null);
      setNotFound(decodeURIComponent(query.replace(/^barcode=/, "")));
      return null;
    }
  }, []);

  useEffect(() => {
    const { variantId } = initialParams();
    if (retailEnabled && variantId) void loadVariant(`variantId=${variantId}`);
  }, [retailEnabled, loadVariant]);

  const post = async (url: string, body: Record<string, unknown>, success: string) => {
    const fingerprint = JSON.stringify({ url, body });
    if (!attemptRef.current || attemptRef.current.fingerprint !== fingerprint) {
      attemptRef.current = { fingerprint, key: makeKey("retail-stock-op") };
    }
    setBusy(true);
    try {
      const response = await apiRequest("POST", url, { ...body, idempotencyKey: attemptRef.current.key });
      const result = await response.json();
      attemptRef.current = null;
      toast({ title: result.replayed ? "Already recorded" : success });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["retail-products"] }),
        queryClient.invalidateQueries({ queryKey: ["retail-product"] }),
        queryClient.invalidateQueries({ queryKey: ["retail-pos-items"] }),
        queryClient.invalidateQueries({ queryKey: ["retail-variant-movements"] }),
      ]);
      if (variant) await loadVariant(`variantId=${variant.variantId}`);
      return true;
    } catch (error) {
      toast({
        title: "Stock operation failed",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
      return false;
    } finally {
      setBusy(false);
      focusScan();
    }
  };

  const receive = (target: StockVariant, qty: number) =>
    post(
      "/api/pos/retail/receipts",
      {
        variantId: target.variantId,
        locationId: Number(locationId),
        quantity: qty,
        unitCost: unitCost === "" ? undefined : Number(unitCost),
        reference: reference.trim() || undefined,
      },
      `Received ${qty} × ${target.color} / ${target.size}`
    );

  const onScan = async (raw: string) => {
    const barcode = raw.trim();
    if (!barcode) return;
    setScanText("");
    const found = await loadVariant(`barcode=${encodeURIComponent(barcode)}`);
    if (found && mode === "receive" && quickReceive && locationId) {
      // Quick receive: every scan is one unit into the selected location.
      attemptRef.current = null;
      await receive(found, 1);
    }
    focusScan();
  };

  const submit = async () => {
    if (!variant) return;
    if (mode === "receive") {
      if (!locationId || quantity <= 0) return;
      if (await receive(variant, quantity)) setQuantity(1);
    } else if (mode === "transfer") {
      if (!locationId || !toLocationId || locationId === toLocationId || quantity <= 0) {
        toast({ title: "Choose two different locations and a quantity", variant: "destructive" });
        return;
      }
      const ok = await post(
        "/api/pos/retail/transfers",
        {
          variantId: variant.variantId,
          fromLocationId: Number(locationId),
          toLocationId: Number(toLocationId),
          quantity,
        },
        `Transferred ${quantity} × ${variant.color} / ${variant.size}`
      );
      if (ok) setQuantity(1);
    } else if (mode === "adjust") {
      const fullReason =
        reason === "Other" ? reasonNote.trim() : `${reason}${reasonNote.trim() ? ` · ${reasonNote.trim()}` : ""}`;
      if (!locationId || quantity <= 0 || !fullReason) {
        toast({ title: "An adjustment needs a location, quantity and reason", variant: "destructive" });
        return;
      }
      const ok = await post(
        "/api/pos/retail/adjustments",
        {
          variantId: variant.variantId,
          locationId: Number(locationId),
          quantityDelta: direction * quantity,
          reason: fullReason,
        },
        `Adjusted ${direction > 0 ? "+" : "-"}${quantity} × ${variant.color} / ${variant.size}`
      );
      if (ok) {
        setQuantity(1);
        setReasonNote("");
      }
    }
  };

  if (!retailEnabled) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="p-6">
            Retail inventory is only available when a Retail / Variant Inventory company is selected.
          </CardContent>
        </Card>
      </div>
    );
  }

  const stockAt = (id: number | "") => variant?.stocks.find((stock) => stock.locationId === id)?.quantity ?? 0;
  const locationSelect = (value: number | "", onChange: (value: number | "") => void, id: string) => (
    <select
      id={id}
      className="h-11 w-full rounded-md border bg-background px-3 text-base"
      value={value}
      onChange={(event) => onChange(event.target.value ? Number(event.target.value) : "")}
    >
      <option value="">Select location</option>
      {activeLocations.map((location) => (
        <option key={location.id} value={location.id}>
          {location.name}
          {variant ? ` (${stockAt(location.id)})` : ""}
        </option>
      ))}
    </select>
  );

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-3 md:p-6">
      <RetailNav />
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <ScanLine className="h-6 w-6" /> Stock operations
        </h1>
        <p className="text-sm text-muted-foreground">
          Scan an item label to receive, transfer or adjust that exact color and size.
        </p>
      </div>

      <div className="grid grid-cols-4 gap-1 rounded-lg bg-muted p-1">
        {MODES.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              setMode(id);
              focusScan();
            }}
            className={cn(
              "flex flex-col items-center gap-0.5 rounded-md px-2 py-2 text-xs font-medium sm:flex-row sm:justify-center sm:gap-2 sm:text-sm",
              mode === id ? "bg-background shadow-sm" : "text-muted-foreground"
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      <form
        className="relative"
        onSubmit={(event) => {
          event.preventDefault();
          void onScan(scanText);
        }}
      >
        <ScanLine className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={scanRef}
          autoFocus
          autoComplete="off"
          enterKeyHint="go"
          className="h-12 pl-10 text-base"
          placeholder="Scan or type barcode"
          value={scanText}
          onChange={(event) => setScanText(event.target.value)}
          data-testid="stock-scan"
        />
      </form>
      {mode === "receive" && (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={quickReceive} onCheckedChange={(value) => setQuickReceive(value === true)} />
          <span>Quick receive: every scan adds 1 unit to the selected location</span>
        </label>
      )}

      {notFound && (
        <div
          className="rounded-lg border-2 border-destructive/60 bg-red-50 p-3 text-sm dark:bg-red-950/30"
          role="alert"
        >
          <strong data-i18n-ui>Unknown barcode</strong> <span className="font-mono">{notFound}</span>
        </div>
      )}

      {variant && (
        <Card data-testid="stock-variant">
          <CardContent className="flex gap-3 p-3">
            {variant.imageUrls[0] ? (
              <img
                src={normalizeRetailImageUrl(variant.imageUrls[0])}
                alt=""
                className="h-24 w-24 shrink-0 rounded-md border object-cover"
              />
            ) : (
              <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-md bg-muted">
                <ImageIcon className="h-6 w-6 text-muted-foreground" />
              </div>
            )}
            <div className="min-w-0 flex-1 space-y-1" data-no-translate>
              <div className="truncate font-semibold">
                {variant.brand} · {variant.name}
              </div>
              <div className="text-lg font-bold">
                {variant.color} · {variant.size}
              </div>
              <div className="font-mono text-xs text-muted-foreground">
                {variant.barcode} · {money(variant.sellingPrice)}
                {!variant.active && <span className="ml-2 text-destructive">(archived)</span>}
              </div>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {variant.stocks.length ? (
                  variant.stocks.map((stock) => (
                    <span key={stock.locationId} className="rounded-full bg-muted px-2 py-0.5 text-xs">
                      {stock.locationName}: <strong>{stock.quantity}</strong>
                    </span>
                  ))
                ) : (
                  <span className="text-xs text-muted-foreground">No stock yet</span>
                )}
              </div>
            </div>
            <Button variant="ghost" size="icon" aria-label="Print label" onClick={() => setLabelOpen(true)}>
              <Printer className="h-4 w-4" />
            </Button>
          </CardContent>
        </Card>
      )}

      {variant && mode !== "history" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{MODES.find((entry) => entry.id === mode)?.label}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="stock-location">{mode === "transfer" ? "From location" : "Location"}</Label>
                {locationSelect(locationId, setLocationId, "stock-location")}
              </div>
              {mode === "transfer" && (
                <div className="space-y-1">
                  <Label htmlFor="stock-to-location">To location</Label>
                  {locationSelect(toLocationId, setToLocationId, "stock-to-location")}
                </div>
              )}
            </div>
            {mode === "adjust" && (
              <div className="grid grid-cols-2 gap-2">
                <Button type="button" variant={direction < 0 ? "default" : "outline"} onClick={() => setDirection(-1)}>
                  − Decrease
                </Button>
                <Button type="button" variant={direction > 0 ? "default" : "outline"} onClick={() => setDirection(1)}>
                  + Increase
                </Button>
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="stock-qty">Quantity</Label>
                <Input
                  id="stock-qty"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  className="h-11 text-base"
                  value={quantity}
                  onChange={(event) => setQuantity(Math.max(0, Number(event.target.value) || 0))}
                />
              </div>
              {mode === "receive" && (
                <div className="space-y-1">
                  <Label htmlFor="stock-cost">Unit cost</Label>
                  <Input
                    id="stock-cost"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    className="h-11 text-base"
                    value={unitCost}
                    onChange={(event) => setUnitCost(event.target.value)}
                  />
                </div>
              )}
              {mode === "adjust" && (
                <div className="space-y-1">
                  <Label htmlFor="stock-reason">Reason *</Label>
                  <select
                    id="stock-reason"
                    className="h-11 w-full rounded-md border bg-background px-3 text-base"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  >
                    {ADJUSTMENT_REASONS.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            {mode === "receive" && (
              <div className="space-y-1">
                <Label htmlFor="stock-ref">Supplier reference</Label>
                <Input
                  id="stock-ref"
                  className="h-11 text-base"
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
                />
              </div>
            )}
            {mode === "adjust" && (
              <div className="space-y-1">
                <Label htmlFor="stock-note">{reason === "Other" ? "Reason details *" : "Note"}</Label>
                <Input
                  id="stock-note"
                  className="h-11 text-base"
                  value={reasonNote}
                  onChange={(event) => setReasonNote(event.target.value)}
                />
              </div>
            )}
            {locationId !== "" && (
              <p className="text-sm text-muted-foreground" data-testid="stock-preview">
                <span data-i18n-ui>Stock at this location</span>: {stockAt(locationId)} →{" "}
                <strong>
                  {mode === "receive"
                    ? stockAt(locationId) + quantity
                    : mode === "transfer"
                      ? stockAt(locationId) - quantity
                      : stockAt(locationId) + direction * quantity}
                </strong>
              </p>
            )}
            <Button className="h-12 w-full text-base" disabled={busy} onClick={() => void submit()}>
              {busy ? "Saving…" : `Confirm ${MODES.find((entry) => entry.id === mode)?.label.toLowerCase()}`}
            </Button>
          </CardContent>
        </Card>
      )}

      {variant && (mode === "history" || mode === "adjust") && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Movement history</CardTitle>
          </CardHeader>
          <CardContent>
            <RetailMovementHistory variantId={variant.variantId} companyKey={companyKey} />
          </CardContent>
        </Card>
      )}

      {variant && (
        <RetailLabelPrintDialog
          open={labelOpen}
          onOpenChange={setLabelOpen}
          items={[
            {
              variantId: variant.variantId,
              title: `${variant.brand} · ${variant.name} · ${variant.color} · ${variant.size}`,
              barcode: variant.barcode,
              stockQuantity: variant.totalQuantity,
            },
          ]}
        />
      )}
    </div>
  );
}
