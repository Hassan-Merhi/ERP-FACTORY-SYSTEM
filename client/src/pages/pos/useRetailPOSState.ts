// Extracted from ./RetailPOS.tsx to keep that module under the source-size cap.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { useLocation as useLocationContext } from "@/contexts/LocationContext";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { RetailPaymentAccounts } from "./RetailPaymentAccountSelect";
import type { RetailShift } from "./RetailShiftPanel";
import { useRetailReceiptPrinter } from "./retailReceipt";
import { useRetailBarcodeScanner } from "./useRetailBarcodeScanner";
import { type CartRequestLine, fetchRetailCartPreview, requestRetailDiscountApproval } from "./retailPosApi";
import type { RetailCartPreview, RetailCustomerSummary } from "./retailTypes";
import {
  canSellIntoNegative,
  type CartLine,
  type Location,
  lookupRetailBarcode,
  makeKey,
  readJson,
  type RetailPaymentDraft,
  type RetailPosItem,
  type RetailSale,
  scanBeep,
  type ScanOutcome,
} from "./retailPosTypes";

export function useRetailPOSState() {
  const { selectedCompany } = useCompany();
  const { selectedLocation, setSelectedLocation } = useLocationContext();
  const { toast } = useToast();
  const [scanText, setScanText] = useState("");
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [notes, setNotes] = useState("");
  const [lastScan, setLastScan] = useState<ScanOutcome | null>(null);
  const [lastSale, setLastSale] = useState<RetailSale | null>(null);
  const [exchangeSale, setExchangeSale] = useState<RetailSale | null>(null);
  const [returnDialogOpen, setReturnDialogOpen] = useState(false);
  const [currentShift, setCurrentShift] = useState<RetailShift | null>(null);
  const [payments, setPayments] = useState<RetailPaymentDraft[]>([{ method: "cash", amount: 0, tenderedAmount: null }]);
  const [customer, setCustomer] = useState<RetailCustomerSummary | null>(null);
  const [orderDiscount, setOrderDiscount] = useState<{
    type: "none" | "percent" | "fixed";
    value: number;
    reason: string;
  }>({ type: "none", value: 0, reason: "" });
  const [orderDiscountOpen, setOrderDiscountOpen] = useState(false);
  const [adjustLine, setAdjustLine] = useState<CartLine | null>(null);
  const [approvalToken, setApprovalToken] = useState<string | null>(null);
  const [approvalRequest, setApprovalRequest] = useState<{
    open: boolean;
    reasons: string[];
    pending: boolean;
    error: string | null;
  }>({ open: false, reasons: [], pending: false, error: null });
  const scanInputRef = useRef<HTMLInputElement | null>(null);
  const saleAttemptRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const allowNegative = canSellIntoNegative(selectedCompany);

  const locationsQuery = useQuery({
    queryKey: ["retail-pos-locations", selectedCompany?.id],
    queryFn: () => readJson<Location[]>("/api/locations"),
    enabled: selectedCompany?.companyType === "retail",
  });
  const paymentAccountsQuery = useQuery<RetailPaymentAccounts>({
    queryKey: ["retail-payment-accounts", selectedCompany?.id],
    queryFn: () => readJson<RetailPaymentAccounts>("/api/pos/retail/payment-accounts"),
    enabled: selectedCompany?.companyType === "retail",
  });
  const paymentAccounts = paymentAccountsQuery.data;
  const isPosRole = selectedCompany?.role === "POS";
  const assignedLocationId = selectedCompany?.assignedLocationId ?? null;
  const locations = (locationsQuery.data ?? [])
    .filter((location) => location.id > 0)
    .filter((location) => !isPosRole || location.id === assignedLocationId);
  const {
    printReceipt,
    portal: receiptPortal,
    paperWidth: receiptPaperWidth,
    setPaperWidth: setReceiptPaperWidth,
  } = useRetailReceiptPrinter(selectedCompany?.name, selectedLocation?.name);

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
    setPayments([{ method: "cash", amount: 0, tenderedAmount: null }]);
    setNotes("");
    setScanText("");
    setSearch("");
    setLastScan(null);
    setLastSale(null);
    setReturnDialogOpen(false);
    setCustomer(null);
    setOrderDiscount({ type: "none", value: 0, reason: "" });
    setOrderDiscountOpen(false);
    setAdjustLine(null);
    setApprovalToken(null);
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

  const checkoutItems: CartRequestLine[] = useMemo(
    () =>
      cart.map((line) => ({
        variantId: line.variantId,
        quantity: line.cartQuantity,
        priceOverride: line.priceOverride ?? null,
        discountType: line.discountType ?? "none",
        discountValue: line.discountValue ?? 0,
        discountReason: line.discountReason ?? null,
      })),
    [cart]
  );

  const orderDiscountPayload = useMemo(
    () => ({ type: orderDiscount.type, value: orderDiscount.value, reason: orderDiscount.reason.trim() || null }),
    [orderDiscount]
  );

  const previewSignature = JSON.stringify({
    locationId: selectedLocation?.id ?? null,
    items: checkoutItems,
    order: orderDiscountPayload,
  });

  /** Authoritative Subtotal → Discount → Tax → Total ladder and the approval policy. */
  const previewQuery = useQuery({
    queryKey: ["retail-cart-preview", previewSignature],
    queryFn: () => fetchRetailCartPreview(checkoutItems, orderDiscountPayload, selectedLocation?.id),
    enabled: selectedCompany?.companyType === "retail" && Boolean(selectedLocation?.id) && cart.length > 0,
    staleTime: 30_000,
  });
  const preview: RetailCartPreview | null = previewQuery.data ?? null;

  // Any change to the cart or order discount invalidates a manager approval issued for it.
  useEffect(() => {
    setApprovalToken(null);
  }, [previewSignature]);

  const refreshRetailPos = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["retail-pos-items"] }),
      queryClient.invalidateQueries({ queryKey: ["retail-pos-sales"] }),
      queryClient.invalidateQueries({ queryKey: ["retail-products"] }),
      queryClient.invalidateQueries({ queryKey: ["retail-product"] }),
      queryClient.invalidateQueries({ queryKey: ["retail-shift-summary"] }),
      queryClient.invalidateQueries({ queryKey: ["retail-shift-ledger-balance"] }),
      queryClient.invalidateQueries({ queryKey: ["retail-current-shift"] }),
      queryClient.invalidateQueries({ queryKey: ["retail-pos-customer-balance"] }),
      queryClient.invalidateQueries({ queryKey: ["retail-accounting-customer-history", selectedCompany?.id] }),
      queryClient.invalidateQueries({ queryKey: ["/api/customers/stats", selectedCompany?.id] }),
      queryClient.invalidateQueries({ queryKey: ["/api/customers"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] }),
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

  useRetailBarcodeScanner(scanBarcode);

  const saleMutation = useMutation({
    // The approval token can be passed explicitly so the retry right after a manager
    // approves uses the fresh token instead of the state value from this render.
    mutationFn: async (options?: { approvalToken?: string | null }) => {
      if (!selectedLocation?.id || !cart.length) throw new Error("Select a location and add at least one item");
      if (orderDiscount.type !== "none" && !orderDiscount.reason.trim()) {
        throw new Error("A reason is required for the whole-sale discount");
      }
      if (isPosRole && !currentShift) throw new Error("Open a cashier shift before completing a sale");
      if (!preview) throw previewQuery.error ?? new Error();
      const fingerprint = JSON.stringify({
        locationId: selectedLocation.id,
        shiftId: currentShift?.id ?? null,
        previewSignature,
        customerId: customer?.id ?? null,
        notes: notes.trim(),
        payments,
      });
      const paymentTotal = payments.reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
      if (Math.abs(paymentTotal - preview.pricing.totalAmount) > 0.005) {
        throw new Error("Payments must equal the sale total");
      }
      if (
        payments.some(
          (payment) =>
            payment.method === "cash" &&
            payment.tenderedAmount != null &&
            Number(payment.tenderedAmount) + 0.000001 < Number(payment.amount)
        )
      ) {
        throw new Error("Cash tendered cannot be less than the cash payment");
      }
      if (!saleAttemptRef.current || saleAttemptRef.current.fingerprint !== fingerprint) {
        saleAttemptRef.current = { fingerprint, key: makeKey("retail-sale") };
      }
      const response = await apiRequest("POST", "/api/pos/retail/sales", {
        locationId: selectedLocation.id,
        idempotencyKey: saleAttemptRef.current.key,
        notes: notes.trim() || undefined,
        customerId: customer?.id ?? null,
        customerName: customer?.legalName ?? null,
        shiftId: currentShift?.id ?? undefined,
        payments,
        items: checkoutItems,
        orderDiscount: orderDiscount.type === "none" ? undefined : orderDiscountPayload,
        approvalToken: options?.approvalToken ?? approvalToken ?? undefined,
      });
      return (await response.json()) as { replayed: boolean; sale: RetailSale };
    },
    onSuccess: async (data) => {
      saleAttemptRef.current = null;
      setCart([]);
      setNotes("");
      setLastScan(null);
      setLastSale(data.sale);
      setCustomer(null);
      // A credit or split tender belongs to the completed sale only.
      setPayments([{ method: "cash", amount: 0, tenderedAmount: null }]);
      setOrderDiscount({ type: "none", value: 0, reason: "" });
      setOrderDiscountOpen(false);
      setApprovalToken(null);
      setApprovalRequest({ open: false, reasons: [], pending: false, error: null });
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
      const status = (error as Error & { status?: number }).status;
      const code = (error as Error & { code?: string }).code;
      if (status === 428 && code === "DISCOUNT_APPROVAL_REQUIRED") {
        setApprovalRequest({ open: true, reasons: preview?.policy.reasons ?? [], pending: false, error: null });
        toast({ title: "Manager approval required", description: error.message });
        return;
      }
      toast({ title: "Sale failed", description: error.message, variant: "destructive" });
      focusScan();
    },
  });

  const approvalMutation = useMutation({
    mutationFn: (credentials: { username: string; password: string }) =>
      requestRetailDiscountApproval({
        managerUsername: credentials.username,
        managerPassword: credentials.password,
        reason: orderDiscount.reason.trim() || undefined,
        items: checkoutItems,
        orderDiscount: orderDiscount.type === "none" ? null : orderDiscountPayload,
      }),
    onSuccess: (data) => {
      if (!data.approvalToken) {
        setApprovalRequest({ open: false, reasons: [], pending: false, error: null });
        return;
      }
      setApprovalToken(data.approvalToken);
      setApprovalRequest({ open: false, reasons: [], pending: false, error: null });
      toast({
        title: "Discount approved",
        description: `Approved by ${data.managerName ?? "manager"}. Completing sale…`,
      });
      saleMutation.mutate({ approvalToken: data.approvalToken });
    },
    onError: (error) => setApprovalRequest((current) => ({ ...current, pending: false, error: error.message })),
  });

  const total = preview?.pricing.totalAmount ?? cart.reduce((sum, line) => sum + line.price * line.cartQuantity, 0);
  const units = cart.reduce((sum, line) => sum + line.cartQuantity, 0);
  const ladder = preview?.pricing ?? null;
  const settings = preview?.settings ?? null;
  const requiresApproval = Boolean(preview?.policy.requiresApproval) && !approvalToken;

  // Reprice the default single tender without silently reverting a cashier's selected
  // card/bank method to cash. A split tender is kept intact for manual rebalancing.
  useEffect(() => {
    const amount = Number(total.toFixed(2));
    setPayments((current) => {
      if (current.length !== 1) return current;
      const payment = current[0];
      return [
        {
          ...payment,
          amount,
          tenderedAmount: payment.method === "cash" ? Math.max(amount, Number(payment.tenderedAmount ?? 0)) : null,
        },
      ];
    });
  }, [total]);

  const paymentTotal = payments.reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
  const hasCreditTender = payments.some((payment) => payment.method === "credit");
  const creditAmount = payments.reduce(
    (sum, payment) => (payment.method === "credit" ? sum + Number(payment.amount || 0) : sum),
    0
  );
  const paymentsValid =
    (!hasCreditTender || Boolean(customer?.id)) &&
    Boolean(paymentAccounts) &&
    Math.abs(paymentTotal - total) <= 0.005 &&
    payments.every(
      (payment) =>
        Number(payment.amount) > 0 &&
        (payment.method === "credit"
          ? Boolean(customer?.id)
          : Boolean(payment.ledgerAccountId || payment.bankAccountId)) &&
        (payment.method !== "cash" ||
          payment.tenderedAmount == null ||
          Number(payment.tenderedAmount) + 0.000001 >= Number(payment.amount))
    );
  const canCompleteSale = Boolean(
    cart.length &&
    preview &&
    !previewQuery.isFetching &&
    !saleMutation.isPending &&
    paymentsValid &&
    (!isPosRole || currentShift)
  );

  // Credit is owed by the selected customer; clearing the customer must never
  // leave an on-account tender that the server would reject at checkout.
  const selectCustomer = (next: RetailCustomerSummary | null) => {
    if (!next?.id) {
      setPayments((current) =>
        current.map((payment) =>
          payment.method === "credit"
            ? ({ method: "cash", amount: payment.amount, tenderedAmount: null } as RetailPaymentDraft)
            : payment
        )
      );
    }
    setCustomer(next);
  };
  return {
    addItem,
    adjustLine,
    approvalMutation,
    approvalRequest,
    canCompleteSale,
    cart,
    creditAmount,
    currentShift,
    customer,
    exchangeSale,
    focusScan,
    hasCreditTender,
    isPosRole,
    itemsQuery,
    ladder,
    lastSale,
    lastScan,
    locations,
    notes,
    orderDiscount,
    orderDiscountOpen,
    paymentAccounts,
    payments,
    printReceipt,
    receiptPaperWidth,
    receiptPortal,
    refreshRetailPos,
    requiresApproval,
    returnDialogOpen,
    saleMutation,
    scanBarcode,
    scanInputRef,
    scanText,
    selectCustomer,
    selectedCompany,
    selectedLocation,
    setAdjustLine,
    setApprovalRequest,
    setCart,
    setCurrentShift,
    setExchangeSale,
    setLastSale,
    setLastScan,
    setNotes,
    setOrderDiscount,
    setOrderDiscountOpen,
    setPayments,
    setReceiptPaperWidth,
    setReturnDialogOpen,
    setScanText,
    setSelectedLocation,
    settings,
    total,
    units,
  };
}
