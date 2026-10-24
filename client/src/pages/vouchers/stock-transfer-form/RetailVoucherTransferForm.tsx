/**
 * Retail-company stock transfer inside Vouchers.
 *
 * Retail variants live in retailVariantInventory, not the ordinary ERP
 * stockItems/inventory tables. Never submit a retail variant to the legacy
 * voucher stock-transfer endpoint: the IDs are unrelated.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRightLeft, Barcode, Loader2, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { RetailPhotoGallery } from "@/pages/retail/RetailProductImage";
import {
  lookupRetailBarcode,
  makeKey,
  readJson,
  scanBeep,
  type RetailPosItem,
} from "@/pages/pos/retailPosTypes";
import { useRetailBarcodeScanner } from "@/pages/pos/useRetailBarcodeScanner";

type Location = { id: number; name: string };
type TransferLine = { item: RetailPosItem; quantity: number; requestKey: string };

const availableQty = (item: RetailPosItem): number => Math.max(0, Number(item.quantity) || 0);

export function RetailVoucherTransferForm({ isPOS = false }: { isPOS?: boolean }) {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [destinationId, setDestinationId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [lines, setLines] = useState<TransferLine[]>([]);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const scanInput = useRef<HTMLInputElement>(null);
  const scanInFlight = useRef(false);
  const pendingBarcodes = useRef<string[]>([]);

  const { data: locations = [], isLoading: locationsLoading } = useQuery<Location[]>({
    queryKey: ["/api/locations", selectedCompany?.id],
    queryFn: () => readJson<Location[]>("/api/locations"),
  });

  useEffect(() => {
    if (sourceId || !locations.length) return;
    const preferred = locations.find((loc) => loc.id === selectedCompany?.assignedLocationId);
    setSourceId((preferred ?? locations[0]).id);
  }, [sourceId, locations, selectedCompany?.assignedLocationId]);

  const { data: items = [], isFetching: itemsLoading, isError: itemsError } = useQuery<RetailPosItem[]>({
    queryKey: ["retail-voucher-transfer-items", selectedCompany?.id, sourceId, search.trim()],
    queryFn: () =>
      readJson<RetailPosItem[]>(
        `/api/pos/retail/items?locationId=${sourceId}&search=${encodeURIComponent(search.trim())}&limit=100`
      ),
    enabled: Boolean(sourceId) && !isPOS,
    staleTime: 10_000,
  });

  const addedQty = useMemo(
    () => lines.reduce((sum, line) => sum + line.quantity, 0),
    [lines]
  );

  const addItem = useCallback(
    (item: RetailPosItem) => {
      if (!sourceId) {
        toast({ title: "Choose a source location first", variant: "destructive" });
        return;
      }
      const stock = availableQty(item);
      if (stock < 1) {
        toast({ title: "Out of stock at the selected source", description: item.name, variant: "destructive" });
        return;
      }
      setLines((current) => {
        const existing = current.find((line) => line.item.variantId === item.variantId);
        if (existing && existing.quantity + 1 > stock) return current;
        if (!existing) {
          return [...current, { item, quantity: 1, requestKey: makeKey("retail-voucher-transfer") }];
        }
        return current.map((line) =>
          line.item.variantId === item.variantId
            ? { ...line, item, quantity: line.quantity + 1, requestKey: makeKey("retail-voucher-transfer") }
            : line
        );
      });
    },
    [sourceId, toast]
  );

  const handleScan = useCallback(
    async (raw: string) => {
      const barcode = raw.trim();
      if (!barcode || !sourceId || saving) return;
      // Queue quick back-to-back scans instead of silently dropping a second
      // barcode while the first request is still in flight.
      pendingBarcodes.current.push(barcode);
      if (scanInFlight.current) return;
      scanInFlight.current = true;
      setScanning(true);
      try {
        while (pendingBarcodes.current.length) {
          const nextBarcode = pendingBarcodes.current.shift()!;
          try {
            const result = await lookupRetailBarcode(nextBarcode, sourceId);
            if (result.kind === "unknown") {
              scanBeep(false);
              toast({ title: "Barcode not found", description: nextBarcode, variant: "destructive" });
            } else if (result.kind === "inactive") {
              scanBeep(false);
              toast({ title: "This variant is archived", description: nextBarcode, variant: "destructive" });
            } else {
              addItem(result.item);
              scanBeep(availableQty(result.item) >= 1);
              setSearch("");
            }
          } catch (error) {
            scanBeep(false);
            toast({
              title: "Couldn't scan the item",
              description: error instanceof Error ? error.message : "Try again.",
              variant: "destructive",
            });
          }
        }
      } finally {
        scanInFlight.current = false;
        setScanning(false);
        scanInput.current?.focus();
      }
    },
    [sourceId, saving, addItem, toast]
  );
  // Hardware scanners enter a code followed by Enter. Captures scans even
  // when focus is outside the search input; the search input handles its own Enter.
  useRetailBarcodeScanner((barcode) => void handleScan(barcode));

  const changeQuantity = (variantId: number, value: number) => {
    setLines((current) =>
      current.map((line) =>
        line.item.variantId === variantId
          ? {
              ...line,
              quantity: Number.isFinite(value) ? value : 0,
              requestKey: makeKey("retail-voucher-transfer"),
            }
          : line
      )
    );
  };

  const save = async () => {
    if (saving || isPOS) return;
    if (!sourceId || !destinationId || sourceId === destinationId) {
      toast({ title: "Select two different locations", variant: "destructive" });
      return;
    }
    if (!lines.length) {
      toast({ title: "Add at least one item to transfer", variant: "destructive" });
      return;
    }
    const invalid = lines.find((line) =>
      !Number.isInteger(line.quantity) ||
      line.quantity <= 0 ||
      line.quantity > availableQty(line.item)
    );
    if (invalid) {
      toast({
        title: "Check the transfer quantities",
        description: `${invalid.item.name} has ${availableQty(invalid.item)} available at source.`,
        variant: "destructive",
      });
      return;
    }
    setSaving(true);
    let transferred = 0;
    try {
      // The established retail endpoint commits and journals one variant per
      // operation. Process sequentially with stable per-line idempotency keys.
      // On partial failure, keep only outstanding lines so Retry NEVER reposts
      // successfully transferred items.
      for (const line of lines) {
        await apiRequest("POST", "/api/pos/retail/transfers", {
          idempotencyKey: line.requestKey,
          variantId: line.item.variantId,
          fromLocationId: sourceId,
          toLocationId: destinationId,
          quantity: line.quantity,
          notes: notes.trim() || undefined,
        });
        transferred += 1;
        setLines((current) => current.filter((entry) => entry.item.variantId !== line.item.variantId));
      }
      setNotes("");
      toast({ title: "Transfer saved", description: `${transferred} variant(s) transferred.` });
    } catch (error) {
      toast({
        title: transferred ? "Partially saved — remaining items kept" : "Transfer not saved",
        description: error instanceof Error ? error.message : "Please review the remaining lines and retry.",
        variant: "destructive",
      });
    } finally {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["retail-voucher-transfer-items"] }),
        queryClient.invalidateQueries({ queryKey: ["retail-pos-items"] }),
        queryClient.invalidateQueries({ queryKey: ["retail-products"] }),
        queryClient.invalidateQueries({ queryKey: ["retail-transfer-options"] }),
        queryClient.invalidateQueries({ queryKey: ["retail-variant-movements"] }),
      ]);
      setSaving(false);
      scanInput.current?.focus();
    }
  };

  return (
    <div className="space-y-4" data-testid="retail-voucher-transfer">
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-2 text-sm font-semibold">
          <ArrowRightLeft className="h-4 w-4" /> Retail Stock Transfer
        </span>
        <label className="flex min-w-0 items-center gap-2 text-sm">
          <span className="text-muted-foreground">From:</span>
          <Select
            value={sourceId ? String(sourceId) : ""}
            onValueChange={(value) => {
              setSourceId(Number(value));
              setLines([]);
              setSearch("");
            }}
            disabled={saving || scanning}
          >
            <SelectTrigger className="w-40" data-testid="retail-transfer-source">
              <SelectValue placeholder="Source location" />
            </SelectTrigger>
            <SelectContent>
              {locations.map((loc) => (
                <SelectItem key={loc.id} value={String(loc.id)}>{loc.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="flex min-w-0 items-center gap-2 text-sm">
          <span className="text-muted-foreground">To:</span>
          <Select
            value={destinationId ? String(destinationId) : ""}
            onValueChange={(value) => setDestinationId(Number(value))}
            disabled={saving}
          >
            <SelectTrigger className="w-40" data-testid="retail-transfer-destination">
              <SelectValue placeholder="Destination location" />
            </SelectTrigger>
            <SelectContent>
              {locations.filter((loc) => loc.id !== sourceId).map((loc) => (
                <SelectItem key={loc.id} value={String(loc.id)}>{loc.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>
      {isPOS ? (
        <Card className="p-5 text-sm text-muted-foreground">
          Retail stock transfers require an authorized non-POS user.
        </Card>
      ) : (
        <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <Card className="min-w-0 overflow-hidden">
            <div className="grid grid-cols-[2rem_minmax(0,1fr)_5.5rem_3rem] gap-2 border-b bg-muted/50 px-3 py-3 text-xs font-semibold sm:grid-cols-[3rem_minmax(0,1fr)_8rem_3rem]">
              <span>#</span><span>Item</span><span className="text-right">Qty</span><span />
            </div>
            <div className="max-h-[56vh] overflow-auto">
              {lines.map((line, index) => (
                <div
                  key={line.item.variantId}
                  className="grid grid-cols-[2rem_minmax(0,1fr)_5.5rem_3rem] items-center gap-2 border-b px-3 py-2 sm:grid-cols-[3rem_minmax(0,1fr)_8rem_3rem]"
                  data-testid={`retail-transfer-line-${line.item.variantId}`}
                >
                  <span className="text-xs text-muted-foreground">{index + 1}</span>
                  <div className="flex min-w-0 items-center gap-2">
                    <RetailPhotoGallery
                      images={line.item.imageUrls ?? []}
                      title={`${line.item.brand} · ${line.item.name} · ${line.item.color} / ${line.item.size}`}
                      imageClassName="h-11 w-11 rounded border"
                    />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{line.item.name}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {line.item.brand} · {line.item.color} / {line.item.size}
                      </div>
                      <div className="truncate font-mono text-xs text-muted-foreground">
                        {line.item.barcode} · Stock {availableQty(line.item)}
                      </div>
                    </div>
                  </div>
                  <Input
                    type="number"
                    min={1}
                    max={availableQty(line.item)}
                    step={1}
                    value={line.quantity || ""}
                    onChange={(e) => changeQuantity(line.item.variantId, Number(e.target.value))}
                    disabled={saving}
                    aria-label={`Transfer quantity for ${line.item.name} ${line.item.color} ${line.item.size}`}
                    data-testid={`retail-transfer-qty-${line.item.variantId}`}
                    className="h-9 text-right"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={saving}
                    onClick={() => setLines((current) => current.filter((entry) => entry.item.variantId !== line.item.variantId))}
                    aria-label={`Remove ${line.item.name}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              {!lines.length && (
                <div className="p-8 text-center text-sm text-muted-foreground">
                  Scan a barcode or choose an item from the right sidebar.
                </div>
              )}
            </div>
            <div className="flex justify-end gap-6 border-t bg-muted/30 px-4 py-3 text-sm">
              <span>Items: <strong>{lines.length}</strong></span>
              <span>Qty: <strong>{addedQty}</strong></span>
            </div>
            <div className="space-y-3 p-3">
              <textarea
                className="w-full min-h-16 resize-y rounded-md border bg-background px-3 py-2 text-sm"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Transfer notes (optional)"
                maxLength={2000}
                disabled={saving}
                data-testid="retail-transfer-notes"
              />
              <div className="flex justify-end">
                <Button
                  type="button"
                  onClick={() => void save()}
                  disabled={saving || !sourceId || !destinationId || sourceId === destinationId || lines.length === 0}
                  data-testid="retail-transfer-save"
                >
                  {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Save Transfer
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Transfers move exact retail variants between locations immediately and are recorded in the retail stock ledger.
              </p>
            </div>
          </Card>
          <Card className="flex min-h-72 min-w-0 flex-col overflow-hidden xl:sticky xl:top-4 xl:max-h-[min(70vh,740px)]">
            <div className="space-y-2 border-b p-3">
              <div className="flex items-center justify-between gap-2 text-sm font-semibold">
                <span>Search Items</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {locations.find((loc) => loc.id === sourceId)?.name || "Choose source"}
                </span>
              </div>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleScan(search);
                }}
              >
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    ref={scanInput}
                    autoComplete="off"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Scan barcode or search name / SKU…"
                    className="pl-9 pr-9"
                    disabled={!sourceId || saving}
                    data-testid="retail-transfer-search-scan"
                    aria-label="Search retail variants or scan barcode"
                  />
                  <Barcode className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                </div>
              </form>
              <div className="text-xs text-muted-foreground">
                Click an item to add it; click its picture to view all photos. Scanning again adds one more.
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {!sourceId ? (
                <div className="p-5 text-sm text-muted-foreground">
                  {locationsLoading ? "Loading locations…" : "Choose a source location to see its items."}
                </div>
              ) : itemsLoading && !items.length ? (
                <div className="p-5 text-sm text-muted-foreground">Loading items…</div>
              ) : itemsError ? (
                <div className="p-5 text-sm text-destructive">Unable to load inventory for this location.</div>
              ) : !items.length ? (
                <div className="p-5 text-sm text-muted-foreground">No matching items found at this location.</div>
              ) : items.map((item) => (
                <div key={item.variantId} className="flex items-center gap-2 border-b p-2 hover:bg-muted/30">
                  <RetailPhotoGallery
                    images={item.imageUrls ?? []}
                    title={`${item.brand} · ${item.name} · ${item.color} / ${item.size}`}
                    imageClassName="h-14 w-14 rounded border"
                  />
                  <button
                    type="button"
                    onClick={() => addItem(item)}
                    disabled={saving || scanning || availableQty(item) < 1}
                    className="min-w-0 flex-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                    data-testid={`retail-transfer-pick-${item.variantId}`}
                    aria-label={`Add ${item.name} ${item.color} ${item.size} to transfer`}
                  >
                    <div className="truncate text-sm font-semibold">{item.name}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {item.brand} · {item.color} / {item.size}
                    </div>
                    <div className="truncate font-mono text-xs text-muted-foreground">{item.barcode}</div>
                    <div className="text-xs font-medium">
                      {availableQty(item) > 0 ? `Available: ${availableQty(item)}` : "Out of stock"}
                    </div>
                  </button>
                </div>
              ))}
            </div>
            <div className="border-t p-2 text-xs text-muted-foreground">
              {scanning ? "Checking barcode…" : "Scan with a hardware reader or press Enter in the search field."}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
