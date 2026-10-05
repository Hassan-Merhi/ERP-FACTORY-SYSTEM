import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowRightLeft,
  Minus,
  Plus,
  Printer,
  Repeat,
  RotateCcw,
  ScanLine,
  ShoppingCart,
  Trash2,
  CircleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCompany } from "@/contexts/CompanyContext";
import { calculateRetailSaleAmounts } from "@shared/retailFinancialMath";
import { useLocation as useLocationContext } from "@/contexts/LocationContext";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { RetailNav } from "@/pages/retail/RetailNav";
import { RetailCameraScanner } from "./RetailCameraScanner";
import { RetailExchangeDialog } from "./RetailExchangeDialog";
import { RetailItemImage, RetailScanFeedback } from "./RetailScanFeedback";
import { useRetailReceiptPrinter } from "./retailReceipt";
import {
  canSellIntoNegative,
  lookupRetailBarcode,
  makeKey,
  money,
  readJson,
  scanBeep,
  type CartLine,
  type Location,
  type RetailPosItem,
  type RetailSale,
  type RetailPaymentMethod,
  type RetailCashierShift,
  type RetailShiftReport,
  type ScanOutcome,
} from "./retailPosTypes";

/**
 * Hardware scanners type the code followed by Enter. When focus is outside an
 * input (e.g. after clicking a button) the keystrokes are captured globally so a
 * scan is never lost.
 */
function useBarcodeScanner(onScan: (barcode: string) => void) {
  const bufferRef = useRef("");
  const lastKeyAtRef = useRef(0);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], [role='dialog']")) return;
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
  const [scanText, setScanText] = useState("");
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [lastScan, setLastScan] = useState<ScanOutcome | null>(null);
  const [lastSale, setLastSale] = useState<RetailSale | null>(null);
  const [exchangeSale, setExchangeSale] = useState<RetailSale | null>(null);
  const [transferVariantId, setTransferVariantId] = useState<number | "">("");
  const [transferToLocationId, setTransferToLocationId] = useState<number | "">("");
  const [transferQuantity, setTransferQuantity] = useState(1);
  const [discountAmount, setDiscountAmount] = useState("0.00");
  const [taxAmount, setTaxAmount] = useState("0.00");
  const [tenders, setTenders] = useState<
    Array<{ method: RetailPaymentMethod; amount: string; amountTendered: string; reference: string }>
  >([{ method: "cash", amount: "0.00", amountTendered: "0.00", reference: "" }]);
  const [tendersTouched, setTendersTouched] = useState(false);
  const [openingCash, setOpeningCash] = useState("0.00");
  const [countedCash, setCountedCash] = useState("");
  const [cashMovementDirection, setCashMovementDirection] = useState<"cash_in" | "cash_out">("cash_in");
  const [cashMovementAmount, setCashMovementAmount] = useState("");
  const [cashMovementReason, setCashMovementReason] = useState("");
  const [shiftActionPending, setShiftActionPending] = useState(false);
  const [historyShiftId, setHistoryShiftId] = useState<number | null>(null);
  const scanInputRef = useRef<HTMLInputElement | null>(null);
  const saleAttemptRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const transferAttemptRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const shiftOpenAttemptRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const cashMovementAttemptRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const allowNegative = canSellIntoNegative(selectedCompany);

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
  const { printReceipt, portal: receiptPortal } = useRetailReceiptPrinter(
    selectedCompany?.name,
    selectedLocation?.name
  );

  const focusScan = useCallback(() => {
    window.setTimeout(() => scanInputRef.current?.focus({ preventScroll: true }), 30);
  }, []);

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
    setScanText("");
    setSearch("");
    setLastScan(null);
    setLastSale(null);
    setTransferVariantId("");
    setTransferToLocationId("");
    setDiscountAmount("0.00");
    setTaxAmount("0.00");
    setTenders([{ method: "cash", amount: "0.00", amountTendered: "0.00", reference: "" }]);
    setTendersTouched(false);
    setOpeningCash("0.00");
    setCountedCash("");
    setCashMovementAmount("");
    setCashMovementReason("");
  }, [selectedCompany?.id, selectedLocation?.id]);

  // Typing filters the item grid; debounce so a hardware scan does not fire a query per character.
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(scanText.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [scanText]);

  // Keep the scan field ready whenever the cashier comes back to the window.
  useEffect(() => {
    window.addEventListener("focus", focusScan);
    return () => window.removeEventListener("focus", focusScan);
  }, [focusScan]);

  const itemsQuery = useQuery({
    queryKey: ["retail-pos-items", selectedCompany?.id, selectedLocation?.id, search],
    queryFn: () =>
      readJson<RetailPosItem[]>(
        `/api/pos/retail/items?locationId=${selectedLocation!.id}&search=${encodeURIComponent(search)}&limit=60`
      ),
    enabled: selectedCompany?.companyType === "retail" && Boolean(selectedLocation?.id),
  });

  const salesQuery = useQuery({
    queryKey: ["retail-pos-sales", selectedCompany?.id, selectedLocation?.id],
    queryFn: () => readJson<RetailSale[]>(`/api/pos/retail/sales?locationId=${selectedLocation!.id}&limit=12`),
    enabled: selectedCompany?.companyType === "retail" && Boolean(selectedLocation?.id),
  });

  const shiftsQuery = useQuery({
    queryKey: ["retail-pos-shifts", selectedCompany?.id, selectedLocation?.id],
    queryFn: () =>
      readJson<RetailCashierShift[]>(`/api/pos/retail/shifts?locationId=${selectedLocation!.id}&mine=true&limit=100`),
    enabled: selectedCompany?.companyType === "retail" && Boolean(selectedLocation?.id),
  });
  const activeShift = shiftsQuery.data?.find((shift) => shift.status === "open") ?? null;
  const shiftReportQuery = useQuery({
    queryKey: ["retail-pos-shift-report", selectedCompany?.id, activeShift?.id],
    queryFn: () => readJson<RetailShiftReport>(`/api/pos/retail/shifts/${activeShift!.id}/report`),
    enabled: Boolean(activeShift?.id),
  });
  const historyReportQuery = useQuery({
    queryKey: ["retail-pos-shift-report", selectedCompany?.id, historyShiftId],
    queryFn: () => readJson<RetailShiftReport>(`/api/pos/retail/shifts/${historyShiftId!}/report`),
    enabled: Boolean(historyShiftId),
  });

  const refreshRetailPos = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["retail-pos-items"] }),
      queryClient.invalidateQueries({ queryKey: ["retail-pos-sales"] }),
      queryClient.invalidateQueries({ queryKey: ["retail-pos-shifts"] }),
      queryClient.invalidateQueries({ queryKey: ["retail-pos-shift-report"] }),
      queryClient.invalidateQueries({ queryKey: ["retail-products"] }),
      queryClient.invalidateQueries({ queryKey: ["retail-product"] }),
    ]);
  };

  const cartQuantityOf = (variantId: number, lines: CartLine[] = cart) =>
    lines.find((line) => line.variantId === variantId)?.cartQuantity ?? 0;

  /** Adds one unit, enforcing the same stock rule the server applies at checkout. */
  const addItem = (item: RetailPosItem, quantity = 1): ScanOutcome => {
    const nextQuantity = cartQuantityOf(item.variantId) + quantity;
    if (nextQuantity > item.quantity && !allowNegative) {
      return { status: "out", item, cartQuantity: nextQuantity - quantity };
    }
    setCart((current) => {
      const existing = current.find((line) => line.variantId === item.variantId);
      if (existing) {
        return current.map((line) =>
          line.variantId === item.variantId ? { ...line, ...item, cartQuantity: line.cartQuantity + quantity } : line
        );
      }
      return [...current, { ...item, cartQuantity: quantity }];
    });
    return {
      status: "added",
      item,
      cartQuantity: nextQuantity,
      warning: nextQuantity > item.quantity ? `Only ${item.quantity} in stock here` : undefined,
    };
  };

  const scanBarcode = useCallback(
    async (rawBarcode: string) => {
      const barcode = rawBarcode.trim();
      if (!barcode) return;
      if (!selectedLocation?.id) {
        toast({ title: "Select a location first", variant: "destructive" });
        return;
      }
      let outcome: ScanOutcome;
      try {
        const result = await lookupRetailBarcode(barcode, selectedLocation.id);
        if (result.kind === "unknown") outcome = { status: "unknown", barcode };
        else if (result.kind === "inactive") outcome = { status: "inactive", item: result.item };
        else outcome = addItem(result.item);
      } catch (error) {
        outcome = { status: "error", barcode, message: error instanceof Error ? error.message : String(error) };
      }
      setLastScan(outcome);
      scanBeep(outcome.status === "added");
      // Clear after every scanner read so the next scan never appends to a stale code. Keep free
      // text that is clearly a product search (letters only / words) so the grid stays filtered.
      if (outcome.status !== "unknown" || /^\S*\d\S*$/.test(barcode)) setScanText("");
      focusScan();
    },
    // addItem reads the latest cart through state; recreate when the cart or location changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedLocation?.id, cart, allowNegative, focusScan, toast]
  );

  useBarcodeScanner(scanBarcode);

  const pricingLines = useMemo(
    () =>
      cart.map((line) => ({
        variantId: line.variantId,
        quantity: line.cartQuantity,
        unitPrice: line.price,
        // Cost is server-owned; zero is sufficient because preview totals use
        // only variant price, discount and tax.
        unitCost: 0,
      })),
    [cart]
  );
  const baseAmounts = useMemo(() => {
    if (!pricingLines.length) return null;
    try {
      return calculateRetailSaleAmounts(pricingLines);
    } catch {
      return null;
    }
  }, [pricingLines]);
  const checkoutAmounts = useMemo(() => {
    if (!pricingLines.length) return null;
    try {
      return calculateRetailSaleAmounts(pricingLines, discountAmount, taxAmount);
    } catch {
      return null;
    }
  }, [pricingLines, discountAmount, taxAmount]);
  const subtotal = Number(baseAmounts?.subtotalAmount ?? 0);
  const total = Number(checkoutAmounts?.totalAmount ?? 0);
  const grossAmountByVariant = useMemo(
    () => new Map((baseAmounts?.lines ?? []).map((line) => [line.variantId, Number(line.grossAmount)])),
    [baseAmounts]
  );
  const units = cart.reduce((sum, line) => sum + line.cartQuantity, 0);
  const tenderedAmount = tenders.reduce((sum, tender) => sum + (Number(tender.amount) || 0), 0);
  const tenderDifference = Math.round((tenderedAmount - total + Number.EPSILON) * 100) / 100;
  useEffect(() => {
    if (tendersTouched) return;
    const defaultAmount = total.toFixed(2);
    setTenders([{ method: "cash", amount: defaultAmount, amountTendered: defaultAmount, reference: "" }]);
  }, [tendersTouched, total]);

  const saleMutation = useMutation({
    mutationFn: async () => {
      if (!selectedLocation?.id || !cart.length) throw new Error("Select a location and add at least one item");
      const items = cart.map((line) => ({ variantId: line.variantId, quantity: line.cartQuantity }));
      if (!activeShift) throw new Error("Open a cashier shift before completing a Retail sale");
      const paymentLines = tenders
        .filter((tender) => Number(tender.amount) > 0)
        .map((tender) => ({
          method: tender.method,
          amount: Number(tender.amount),
          ...(tender.method === "cash" ? { amountTendered: Number(tender.amountTendered || tender.amount) } : {}),
          ...(tender.reference.trim() ? { reference: tender.reference.trim() } : {}),
        }));
      const fingerprint = JSON.stringify({
        locationId: selectedLocation.id,
        items: items.slice().sort((a, b) => a.variantId - b.variantId),
        discountAmount: Number(discountAmount || 0),
        taxAmount: Number(taxAmount || 0),
        payments: paymentLines,
      });
      if (!saleAttemptRef.current || saleAttemptRef.current.fingerprint !== fingerprint) {
        saleAttemptRef.current = { fingerprint, key: makeKey("retail-sale") };
      }
      const response = await apiRequest("POST", "/api/pos/retail/sales", {
        locationId: selectedLocation.id,
        idempotencyKey: saleAttemptRef.current.key,
        items,
        discountAmount: Number(discountAmount || 0),
        taxAmount: Number(taxAmount || 0),
        payments: paymentLines,
      });
      return (await response.json()) as { replayed: boolean; checkout?: RetailSale; sale: RetailSale };
    },
    onSuccess: async (data) => {
      const checkout = data.checkout ?? data.sale;
      saleAttemptRef.current = null;
      setCart([]);
      setDiscountAmount("0.00");
      setTaxAmount("0.00");
      setTendersTouched(false);
      setLastScan(null);
      setLastSale(checkout);
      focusScan();
      await refreshRetailPos();
      toast(
        data.replayed
          ? {
              title: "Sale already recorded",
              description: "This checkout was already saved. Stock was not deducted twice.",
            }
          : { title: "Sale completed", description: "Exact variant stock was deducted." }
      );
      focusScan();
    },
    onError: (error) => {
      toast({ title: "Sale failed", description: error.message, variant: "destructive" });
      focusScan();
    },
  });

  const openShift = async () => {
    if (!selectedLocation?.id || shiftActionPending) return;
    const fingerprint = `${selectedLocation.id}|${Number(openingCash || 0).toFixed(2)}`;
    if (!shiftOpenAttemptRef.current || shiftOpenAttemptRef.current.fingerprint !== fingerprint) {
      shiftOpenAttemptRef.current = { fingerprint, key: makeKey("retail-shift-open") };
    }
    setShiftActionPending(true);
    try {
      const response = await apiRequest("POST", "/api/pos/retail/shifts/open", {
        locationId: selectedLocation.id,
        openingCash: Number(openingCash || 0),
        idempotencyKey: shiftOpenAttemptRef.current.key,
      });
      const result = (await response.json()) as { replayed: boolean };
      shiftOpenAttemptRef.current = null;
      await refreshRetailPos();
      toast({ title: result.replayed ? "Cashier shift already open" : "Cashier shift opened" });
    } catch (error) {
      toast({
        title: "Could not open shift",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    } finally {
      setShiftActionPending(false);
    }
  };

  const recordCashMovement = async () => {
    if (!activeShift || !cashMovementAmount || !cashMovementReason.trim() || shiftActionPending) return;
    const fingerprint = `${activeShift.id}|${cashMovementDirection}|${cashMovementAmount}|${cashMovementReason.trim()}`;
    if (!cashMovementAttemptRef.current || cashMovementAttemptRef.current.fingerprint !== fingerprint) {
      cashMovementAttemptRef.current = { fingerprint, key: makeKey("retail-cash-movement") };
    }
    setShiftActionPending(true);
    try {
      const response = await apiRequest("POST", `/api/pos/retail/shifts/${activeShift.id}/cash-movements`, {
        direction: cashMovementDirection,
        amount: Number(cashMovementAmount),
        reason: cashMovementReason.trim(),
        idempotencyKey: cashMovementAttemptRef.current.key,
      });
      const result = (await response.json()) as { replayed: boolean };
      cashMovementAttemptRef.current = null;
      setCashMovementAmount("");
      setCashMovementReason("");
      await refreshRetailPos();
      toast({ title: result.replayed ? "Cash movement already recorded" : "Cash movement recorded" });
    } catch (error) {
      toast({
        title: "Cash movement failed",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    } finally {
      setShiftActionPending(false);
    }
  };

  const closeShift = async () => {
    if (!activeShift || countedCash === "" || shiftActionPending) return;
    setShiftActionPending(true);
    try {
      const response = await apiRequest("POST", `/api/pos/retail/shifts/${activeShift.id}/close`, {
        actualCountedCash: Number(countedCash),
      });
      const result = (await response.json()) as { variance: string };
      await refreshRetailPos();
      setCountedCash("");
      toast({
        title: "Cashier shift closed",
        description: `Closing variance: ${money(Number(result.variance))}`,
      });
    } catch (error) {
      toast({
        title: "Could not close shift",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    } finally {
      setShiftActionPending(false);
    }
  };

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
      toast({ title: "Return completed", description: "The exact color and size were restored to this location." });
      focusScan();
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

  if (selectedCompany?.companyType !== "retail") return null;

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 p-3 pb-24 md:p-5 xl:pb-5">
      {receiptPortal}
      {!isPosRole && <RetailNav />}
      <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Retail POS</h1>
          <p className="text-sm text-muted-foreground">
            Scan a barcode or search by name, SKU, barcode, brand, color, or size.
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

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between gap-3 text-lg">
            <span>Cashier shift</span>
            {activeShift && (
              <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-900">
                OPEN · #{activeShift.id}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!selectedLocation ? (
            <p className="text-sm text-muted-foreground">Select a Retail location to open or view a cashier shift.</p>
          ) : !activeShift ? (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="w-full sm:max-w-xs">
                <Label htmlFor="retail-opening-cash">Opening cash</Label>
                <Input
                  id="retail-opening-cash"
                  type="number"
                  min="0"
                  step="0.01"
                  value={openingCash}
                  onChange={(event) => setOpeningCash(event.target.value)}
                />
              </div>
              <Button onClick={() => void openShift()} disabled={shiftActionPending || shiftsQuery.isLoading}>
                {shiftActionPending ? "Opening…" : "Open cashier shift"}
              </Button>
              <span className="text-xs text-muted-foreground">
                A shift is required for sales, returns and cancellations.
              </span>
            </div>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-md bg-muted/40 p-3">
                  <div className="text-xs text-muted-foreground">Opening cash</div>
                  <div className="font-semibold">{money(Number(activeShift.openingCash))}</div>
                </div>
                <div className="rounded-md bg-muted/40 p-3">
                  <div className="text-xs text-muted-foreground">Cash sales</div>
                  <div className="font-semibold">{money(shiftReportQuery.data?.cashSalesTotal ?? 0)}</div>
                </div>
                <div className="rounded-md bg-muted/40 p-3">
                  <div className="text-xs text-muted-foreground">Expected closing cash</div>
                  <div className="font-semibold">
                    {money(shiftReportQuery.data?.expectedClosingCash ?? Number(activeShift.openingCash))}
                  </div>
                </div>
                <div className="rounded-md bg-muted/40 p-3">
                  <div className="text-xs text-muted-foreground">Cash refunds · in · out</div>
                  <div className="font-semibold">
                    {money(shiftReportQuery.data?.refundTotal ?? 0)} · {money(shiftReportQuery.data?.cashInTotal ?? 0)}{" "}
                    · {money(shiftReportQuery.data?.cashOutTotal ?? 0)}
                  </div>
                </div>
              </div>
              <div>
                <div className="mb-2 text-sm font-semibold">Payment-method totals</div>
                <div className="flex flex-wrap gap-2">
                  {(shiftReportQuery.data?.paymentMethodTotals ?? []).length ? (
                    shiftReportQuery.data!.paymentMethodTotals.map((total) => (
                      <span key={total.method} className="rounded-full border px-3 py-1 text-xs">
                        {total.method.replaceAll("_", " ")} · sales {money(total.sales)} · refunds{" "}
                        {money(total.refunds)} · net {money(total.net)}
                      </span>
                    ))
                  ) : (
                    <span className="text-xs text-muted-foreground">No payments recorded in this shift yet.</span>
                  )}
                </div>
              </div>
              <div className="grid gap-4 border-t pt-4 lg:grid-cols-2">
                <div className="space-y-2 rounded-lg border p-3">
                  <div className="font-medium">Reasoned Cash In / Out</div>
                  <div className="grid gap-2 sm:grid-cols-[130px_1fr]">
                    <select
                      value={cashMovementDirection}
                      onChange={(event) => setCashMovementDirection(event.target.value as "cash_in" | "cash_out")}
                      className="h-10 rounded-md border bg-background px-3 text-sm"
                    >
                      <option value="cash_in">Cash In</option>
                      <option value="cash_out">Cash Out</option>
                    </select>
                    <Input
                      type="number"
                      min="0.01"
                      step="0.01"
                      placeholder="Amount"
                      value={cashMovementAmount}
                      onChange={(event) => setCashMovementAmount(event.target.value)}
                    />
                  </div>
                  <Input
                    placeholder="Reason (required)"
                    value={cashMovementReason}
                    onChange={(event) => setCashMovementReason(event.target.value)}
                  />
                  <Button
                    variant="outline"
                    className="w-full"
                    disabled={shiftActionPending || !cashMovementAmount || !cashMovementReason.trim()}
                    onClick={() => void recordCashMovement()}
                  >
                    Record {cashMovementDirection === "cash_in" ? "Cash In" : "Cash Out"}
                  </Button>
                </div>
                <div className="space-y-2 rounded-lg border p-3">
                  <div className="font-medium">Count and close shift</div>
                  <div className="text-sm text-muted-foreground">
                    Expected cash: {money(shiftReportQuery.data?.expectedClosingCash ?? 0)}
                  </div>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Counted cash"
                    value={countedCash}
                    onChange={(event) => setCountedCash(event.target.value)}
                  />
                  <Button
                    variant="destructive"
                    className="w-full"
                    disabled={shiftActionPending || countedCash === ""}
                    onClick={() => void closeShift()}
                  >
                    {shiftActionPending ? "Saving…" : "Close shift and record variance"}
                  </Button>
                </div>
              </div>
            </>
          )}
          {(shiftsQuery.data ?? []).some((shift) => shift.status === "closed") && (
            <details className="border-t pt-3">
              <summary className="cursor-pointer text-sm font-semibold">
                Shift history ({(shiftsQuery.data ?? []).filter((shift) => shift.status === "closed").length})
              </summary>
              <div className="mt-3 space-y-2">
                {(shiftsQuery.data ?? [])
                  .filter((shift) => shift.status === "closed")
                  .slice(0, 15)
                  .map((shift) => (
                    <div
                      key={shift.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm"
                    >
                      <span>
                        Shift #{shift.id} · {new Date(shift.openedAt).toLocaleDateString()} · counted{" "}
                        {money(Number(shift.actualCountedCash ?? 0))}
                      </span>
                      <div className="flex items-center gap-2">
                        {shift.variance != null && (
                          <span
                            className={
                              Number(shift.variance) === 0 ? "text-muted-foreground" : "font-semibold text-destructive"
                            }
                          >
                            variance {money(Number(shift.variance))}
                          </span>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setHistoryShiftId(historyShiftId === shift.id ? null : shift.id)}
                        >
                          {historyShiftId === shift.id ? "Hide totals" : "Payment totals"}
                        </Button>
                      </div>
                    </div>
                  ))}
                {historyReportQuery.data && historyReportQuery.data.shift.id === historyShiftId && (
                  <div className="flex flex-wrap gap-2 rounded-md bg-muted/40 p-3">
                    {historyReportQuery.data.paymentMethodTotals.map((total) => (
                      <span key={total.method} className="text-xs">
                        {total.method.replaceAll("_", " ")}: sales {money(total.sales)}, refunds {money(total.refunds)},
                        net {money(total.net)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </details>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(360px,0.7fr)]">
        <Card>
          <CardHeader className="space-y-3 pb-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <ScanLine className="h-5 w-5" /> Scan or find item
            </CardTitle>
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void scanBarcode(scanText);
              }}
            >
              <div className="relative flex-1">
                <ScanLine className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  ref={scanInputRef}
                  autoFocus
                  autoComplete="off"
                  inputMode="search"
                  enterKeyHint="go"
                  value={scanText}
                  onChange={(event) => setScanText(event.target.value)}
                  placeholder="Scan barcode or search product / SKU / brand / color / size"
                  className="h-12 pl-10 text-base"
                  data-testid="retail-pos-scan"
                />
              </div>
              <RetailCameraScanner onScan={(value) => void scanBarcode(value)} />
            </form>
            <RetailScanFeedback outcome={lastScan} />
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
                    onClick={() => {
                      const outcome = addItem(item);
                      setLastScan(outcome);
                      if (outcome.status !== "added") scanBeep(false);
                      focusScan();
                    }}
                    className="flex min-h-24 items-center gap-3 rounded-lg border p-3 text-left transition hover:border-primary hover:bg-muted/40"
                  >
                    <RetailItemImage item={item} />
                    <span className="min-w-0 flex-1" data-no-translate>
                      <span className="block truncate font-medium">{item.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {item.brand} · {item.color} · Size {item.size}
                      </span>
                      <span className="mt-1 flex items-center justify-between text-sm">
                        <strong>{money(item.price)}</strong>
                        <span className={item.quantity <= 0 ? "font-medium text-destructive" : "text-muted-foreground"}>
                          {item.quantity <= 0 ? "Sold out" : `Qty ${item.quantity}`}
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

        <Card className="h-fit xl:sticky xl:top-3" id="retail-pos-cart">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <ShoppingCart className="h-5 w-5" /> Cart
              {units > 0 && <span className="text-sm font-normal text-muted-foreground">· {units}</span>}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {cart.map((line) => (
              <div
                key={line.variantId}
                className="flex items-center gap-3 rounded-lg border p-3"
                data-testid="cart-line"
              >
                <RetailItemImage item={line} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium" data-no-translate>
                    {line.brand} · {line.name}
                  </div>
                  <div className="text-xs text-muted-foreground" data-no-translate>
                    <strong className="text-foreground">{line.color}</strong> ·{" "}
                    <strong className="text-foreground">{line.size}</strong> · {line.barcode}
                  </div>
                  <div
                    className={`text-xs ${line.cartQuantity > line.quantity ? "text-destructive" : "text-muted-foreground"}`}
                  >
                    <span data-i18n-ui>Available here</span>: {line.quantity}
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <Button
                      size="icon"
                      variant="outline"
                      className="h-8 w-8"
                      aria-label="Decrease quantity"
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
                    <Button
                      size="icon"
                      variant="outline"
                      className="h-8 w-8"
                      aria-label="Increase quantity"
                      onClick={() => setLastScan(addItem(line))}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                    <span className="ml-auto text-sm font-semibold">
                      {money(grossAmountByVariant.get(line.variantId) ?? 0)}
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      aria-label="Remove from cart"
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
                Scan or select an exact color and size to start a sale.
              </div>
            )}
            <div className="space-y-1 border-t pt-3 text-sm">
              <div className="flex justify-between">
                <span>Subtotal</span>
                <span>{money(subtotal)}</span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label htmlFor="retail-discount">Discount</Label>
                  <Input
                    id="retail-discount"
                    type="number"
                    min="0"
                    step="0.01"
                    value={discountAmount}
                    onChange={(event) => setDiscountAmount(event.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="retail-tax">Tax</Label>
                  <Input
                    id="retail-tax"
                    type="number"
                    min="0"
                    step="0.01"
                    value={taxAmount}
                    onChange={(event) => setTaxAmount(event.target.value)}
                  />
                </div>
              </div>
              <div className="flex justify-between pt-1 text-lg font-semibold">
                <span>Total due</span>
                <span data-testid="cart-total">{money(total)}</span>
              </div>
              {cart.length > 0 && !checkoutAmounts && (
                <p role="alert" className="text-xs text-destructive">
                  Check the item price, discount and tax; the checkout total must be positive and the discount cannot
                  exceed the subtotal.
                </p>
              )}
            </div>
            <div className="space-y-2 rounded-lg border p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="font-medium">Payments</div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setTendersTouched(true);
                    setTenders((current) => [
                      ...current,
                      { method: "card", amount: "0.00", amountTendered: "0.00", reference: "" },
                    ]);
                  }}
                >
                  Add split tender
                </Button>
              </div>
              {tenders.map((tender, index) => (
                <div key={index} className="space-y-2 rounded-md bg-muted/30 p-2">
                  <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_auto] gap-2">
                    <select
                      aria-label={`Payment method ${index + 1}`}
                      value={tender.method}
                      onChange={(event) => {
                        const method = event.target.value as RetailPaymentMethod;
                        setTendersTouched(true);
                        setTenders((current) =>
                          current.map((line, rowIndex) =>
                            rowIndex === index
                              ? { ...line, method, amountTendered: method === "cash" ? line.amount : "" }
                              : line
                          )
                        );
                      }}
                      className="h-10 min-w-0 rounded-md border bg-background px-2 text-xs"
                    >
                      <option value="cash">Cash</option>
                      <option value="card">Card</option>
                      <option value="bank_transfer">Bank / Transfer</option>
                      <option value="mobile_other">Mobile / Other</option>
                      <option value="store_credit">Store Credit</option>
                    </select>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      aria-label={`Payment amount ${index + 1}`}
                      value={tender.amount}
                      onChange={(event) => {
                        setTendersTouched(true);
                        setTenders((current) =>
                          current.map((line, rowIndex) =>
                            rowIndex === index
                              ? {
                                  ...line,
                                  amount: event.target.value,
                                  ...(line.method === "cash" && Number(line.amountTendered) === Number(line.amount)
                                    ? { amountTendered: event.target.value }
                                    : {}),
                                }
                              : line
                          )
                        );
                      }}
                    />
                    {tenders.length > 1 && (
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Remove payment line"
                        onClick={() => {
                          setTendersTouched(true);
                          setTenders((current) => current.filter((_, rowIndex) => rowIndex !== index));
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                  {tender.method === "cash" ? (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Input
                        type="number"
                        min={tender.amount || "0"}
                        step="0.01"
                        aria-label="Cash tendered"
                        placeholder="Cash tendered"
                        value={tender.amountTendered}
                        onChange={(event) => {
                          setTendersTouched(true);
                          setTenders((current) =>
                            current.map((line, rowIndex) =>
                              rowIndex === index ? { ...line, amountTendered: event.target.value } : line
                            )
                          );
                        }}
                      />
                      <div className="flex items-center justify-end text-xs text-muted-foreground">
                        Change due:{" "}
                        {money(Math.max(0, Number(tender.amountTendered || 0) - Number(tender.amount || 0)))}
                      </div>
                    </div>
                  ) : null}
                  <Input
                    aria-label={`Reference ${index + 1}`}
                    placeholder="Reference (optional)"
                    value={tender.reference}
                    onChange={(event) => {
                      setTendersTouched(true);
                      setTenders((current) =>
                        current.map((line, rowIndex) =>
                          rowIndex === index ? { ...line, reference: event.target.value } : line
                        )
                      );
                    }}
                  />
                </div>
              ))}
              <div
                className={`flex items-center justify-between text-xs ${Math.abs(tenderDifference) >= 0.01 ? "text-destructive" : "text-emerald-700"}`}
              >
                <span>
                  {tenderDifference < 0
                    ? "Amount still due"
                    : tenderDifference > 0
                      ? "Over tendered"
                      : "Tender reconciles"}
                </span>
                <strong>{money(Math.abs(tenderDifference))}</strong>
              </div>
            </div>
            {!activeShift && selectedLocation && (
              <div className="flex items-center gap-2 rounded-md bg-amber-50 p-2 text-xs text-amber-900">
                <CircleAlert className="h-4 w-4 shrink-0" />
                Open a cashier shift before taking payment.
              </div>
            )}
            <Button
              className="h-12 w-full text-base"
              size="lg"
              disabled={
                !cart.length ||
                !activeShift ||
                saleMutation.isPending ||
                total <= 0 ||
                Math.abs(tenderDifference) >= 0.01
              }
              onClick={() => saleMutation.mutate()}
            >
              {saleMutation.isPending ? "Completing sale…" : "Complete Sale"}
            </Button>
            {lastSale && (
              <div className="rounded-lg border bg-muted/30 p-3 text-sm" data-testid="last-sale">
                <div className="flex items-center justify-between gap-2">
                  <strong>Sale #{lastSale.id}</strong>
                  <span>{money(lastSale.totalAmount)}</span>
                </div>
                <div className="mt-1 space-y-0.5 text-xs text-muted-foreground" data-no-translate>
                  {lastSale.items.map((item) => (
                    <div key={item.id}>
                      {item.quantity} × {item.name} · {item.color} · {item.size}
                    </div>
                  ))}
                </div>
                <Button size="sm" variant="outline" className="mt-2 w-full" onClick={() => printReceipt(lastSale)}>
                  <Printer className="mr-2 h-4 w-4" /> Print receipt
                </Button>
              </div>
            )}
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
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <strong>Sale #{sale.id}</strong>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {new Date(sale.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{money(sale.totalAmount)}</span>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{sale.status}</span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label="Print receipt"
                      onClick={() => printReceipt(sale)}
                    >
                      <Printer className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                {(sale.paymentMethodTotals ?? []).length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {sale.paymentMethodTotals!.map((payment) => (
                      <span key={payment.method} className="rounded-full bg-muted px-2 py-0.5 text-[11px]">
                        {payment.method.replaceAll("_", " ")} · {money(payment.sales)}
                      </span>
                    ))}
                    {(sale.changeDue ?? 0) > 0 && (
                      <span className="text-[11px] text-muted-foreground">Change {money(sale.changeDue ?? 0)}</span>
                    )}
                  </div>
                )}
                <div className="space-y-1.5">
                  {sale.items.map((item) => {
                    const remaining = Math.max(0, item.quantity - item.returnedQuantity);
                    return (
                      <div key={item.id} className="flex items-center gap-2 text-sm">
                        <RetailItemImage item={item} className="h-9 w-9" />
                        <span className="min-w-0 flex-1 truncate" data-no-translate>
                          {item.name} · {item.color} · {item.size}{" "}
                          <span className="text-muted-foreground">× {item.quantity}</span>
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
                  <div className="mt-3 flex flex-wrap justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => setExchangeSale(sale)}>
                      <Repeat className="mr-1 h-3.5 w-3.5" /> Exchange
                    </Button>
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
                <Label>Variant (Color · Size)</Label>
                <select
                  value={transferVariantId}
                  onChange={(event) => setTransferVariantId(event.target.value ? Number(event.target.value) : "")}
                  className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                >
                  <option value="">Choose exact product + color + size</option>
                  {(itemsQuery.data ?? []).map((item) => (
                    <option key={item.variantId} value={item.variantId}>
                      {item.name} · {item.brand} · {item.color} · {item.size} · Qty {item.quantity}
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

      {cart.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 p-3 backdrop-blur xl:hidden">
          <div className="mx-auto flex max-w-3xl items-center gap-3">
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              onClick={() => document.getElementById("retail-pos-cart")?.scrollIntoView({ behavior: "smooth" })}
            >
              <div className="text-xs text-muted-foreground">
                <ShoppingCart className="mr-1 inline h-3.5 w-3.5" />
                {units} · <span data-i18n-ui>View cart</span>
              </div>
              <div className="text-lg font-semibold">{money(total)}</div>
            </button>
            <Button
              className="h-12 px-6 text-base"
              disabled={!activeShift || saleMutation.isPending || Math.abs(tenderDifference) >= 0.01 || total <= 0}
              onClick={() => saleMutation.mutate()}
            >
              {saleMutation.isPending ? "Completing sale…" : "Complete Sale"}
            </Button>
          </div>
        </div>
      )}

      <RetailExchangeDialog
        sale={exchangeSale}
        locationId={selectedLocation?.id ?? null}
        onOpenChange={(open) => {
          if (!open) {
            setExchangeSale(null);
            focusScan();
          }
        }}
        onCompleted={async (sale) => {
          setExchangeSale(null);
          setLastSale(sale);
          await refreshRetailPos();
          focusScan();
        }}
      />
    </div>
  );
}
