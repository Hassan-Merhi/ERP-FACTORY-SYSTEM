// Extracted from ./FactoryInvoiceCreate.tsx to keep that module under the source-size cap.
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { invalidateCustomerBalances, keyStartsWith, queryClient } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import type { Customer, Location, OrderBale, OrderDetail, Proforma } from "./FactoryInvoiceCreateTypes";

export function useFactoryInvoiceCreateState() {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const [, navigate] = useLocation();
  const search = useSearch();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);

  // Read ?orderId= from URL so "Continue Editing" on a reverted draft resumes correctly
  // In wouter v3, useLocation() returns pathname only — query string comes from useSearch()
  const urlOrderId = (() => {
    const v = new URLSearchParams(search).get("orderId");
    return v ? parseInt(v) : null;
  })();

  const [selectedCustomerId, setSelectedCustomerId] = useState<string>("");
  const [orderDate, setOrderDate] = useState(() => new Date().toLocaleDateString("en-CA"));
  const [chargeLedgerAccountId, setChargeLedgerAccountId] = useState<string>("");
  const [selectedLocationId, setSelectedLocationId] = useState<string>("");
  const [orderId, setOrderId] = useState<number | null>(urlOrderId);
  const [scanCode, setScanCode] = useState("");
  const [scanFlash, setScanFlash] = useState<"success" | "error" | null>(null);
  const [showFinalizeDialog, setShowFinalizeDialog] = useState(false);
  const [chargeName, setChargeName] = useState("");
  const [chargeAmount, setChargeAmount] = useState("");
  const [chargeType, setChargeType] = useState("FREIGHT");
  const scannerRef = useRef<HTMLInputElement>(null);
  const lastCompanyRef = useRef(selectedCompany?.id);
  useEffect(() => {
    if (lastCompanyRef.current === selectedCompany?.id) return;
    const hadPreviousCompany = Boolean(lastCompanyRef.current);
    lastCompanyRef.current = selectedCompany?.id;
    // Initial company hydration must not discard ?orderId= deep links.
    if (!hadPreviousCompany) return;
    setSelectedCustomerId("");
    setChargeLedgerAccountId("");
    setSelectedLocationId("");
    setOrderId(null);
    setScanCode("");
    setShowFinalizeDialog(false);
    setChargeName("");
    setChargeAmount("");
    setScanFlash(null);
  }, [selectedCompany?.id]);

  const customerId = selectedCustomerId ? parseInt(selectedCustomerId) : null;

  const { data: orderDetail } = useQuery<OrderDetail>({
    queryKey: companyQueryKey("/api/factory/customer-orders", selectedCompany?.id, orderId),
    enabled: Boolean(selectedCompany?.id) && !!orderId,
  });

  // ── Sync state from loaded existing order (URL ?orderId=) ──────────────────
  useEffect(() => {
    if (!orderDetail) return;
    // Populate customer selector
    if (orderDetail.customerId && !selectedCustomerId) {
      setSelectedCustomerId(String(orderDetail.customerId));
    }
    // Populate date from the stored order date (NOT today)
    if (orderDetail.orderDate) {
      setOrderDate(orderDetail.orderDate.substring(0, 10));
    }
  }, [orderDetail, selectedCustomerId]);

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: companyQueryKey("/api/factory/customers", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });

  const { data: locations = [] } = useQuery<Location[]>({
    queryKey: companyQueryKey("/api/locations", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });

  const { data: ledgerAccounts = [] } = useQuery<{ id: number; name: string; code: string }[]>({
    queryKey: companyQueryKey("/api/ledger-accounts?includeHidden=true&profile=picker", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const { data: proformaSummaries = [] } = useQuery<Array<Omit<Proforma, "lines"> & { lineCount: number }>>({
    queryKey: companyQueryKey(
      `/api/factory/customer-proformas?customerId=${customerId}&profile=summary`,
      selectedCompany?.id
    ),
    enabled: Boolean(selectedCompany?.id) && !!customerId,
  });

  const activeProformaSummary = proformaSummaries.find((proforma) => proforma.isActive) || null;
  const { data: activeProforma = null } = useQuery<Proforma>({
    queryKey: companyQueryKey("/api/factory/customer-proformas/detail", selectedCompany?.id, activeProformaSummary?.id),
    queryFn: async () => {
      const response = await fetch(`/api/factory/customer-proformas/${activeProformaSummary?.id}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to load proforma details");
      return response.json();
    },
    enabled: Boolean(selectedCompany?.id) && !!activeProformaSummary?.id,
  });

  const createOrderMutation = useMutation({
    mutationFn: async (data: { companyId: number; customerId: number; orderDate: string; proformaIdUsed: number }) => {
      const res = await modeApiRequest("POST", "/api/factory/customer-orders", data);
      return await res.json();
    },
    onSuccess: (data) => {
      setOrderId(data.id);
      toast({ title: "Draft order created", description: "You can now start scanning bales" });
      setTimeout(() => scannerRef.current?.focus(), 100);
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Save failed", description: error.message, variant: "destructive" });
    },
  });

  const addBaleMutation = useMutation({
    mutationFn: async (data: { scanCode: string; locationId: number }) => {
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/bales`, data);
      return await res.json();
    },
    onSuccess: () => {
      setScanFlash("success");
      setTimeout(() => setScanFlash(null), 500);
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders", orderId] });
      setScanCode("");
      scannerRef.current?.focus();
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      setScanFlash("error");
      setTimeout(() => setScanFlash(null), 500);
      setScanCode("");
      scannerRef.current?.focus();
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Scan Error", description: error.message, variant: "destructive" });
    },
  });

  const removeBaleMutation = useMutation({
    mutationFn: async (baleId: number) => {
      await modeApiRequest("DELETE", `/api/factory/customer-orders/${orderId}/bales/${baleId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders", orderId] });
      toast({ title: "Bale removed" });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Remove failed", description: error.message, variant: "destructive" });
    },
  });

  const addChargeMutation = useMutation({
    mutationFn: async (data: { name: string; amount: number; chargeType: string; ledgerAccountId?: number }) => {
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/charges`, data);
      return await res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders", orderId] });
      setChargeName("");
      setChargeAmount("");
      setChargeLedgerAccountId("");
      if (data?.warning) {
        toast({ title: "Charge added — ledger entry skipped", description: data.warning, variant: "destructive" });
      } else {
        toast({ title: "Charge added" });
      }
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Save failed", description: error.message, variant: "destructive" });
    },
  });

  const removeChargeMutation = useMutation({
    mutationFn: async (chargeId: number) => {
      await modeApiRequest("DELETE", `/api/factory/customer-orders/${orderId}/charges/${chargeId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders", orderId] });
      toast({ title: "Charge removed" });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Delete failed", description: error.message, variant: "destructive" });
    },
  });

  const relinkVouchersMutation = useMutation({
    mutationFn: async () => {
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/charges/relink-vouchers`, {});
      return await res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders", orderId] });
      toast({ title: data.linked > 0 ? "Ledger entries created" : "Nothing to relink", description: data.message });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Linking failed", description: error.message, variant: "destructive" });
    },
  });

  const finalizeMutation = useMutation({
    mutationFn: async () => {
      await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/finalize`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
      invalidateCustomerBalances(customerId ?? undefined);
      toast({ title: "Invoice finalized", description: "Invoice has been created successfully" });
      setShowFinalizeDialog(false);
      navigate(`/factory/sales/invoices/${orderId}`);
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      setShowFinalizeDialog(false);
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Finalize failed", description: error.message, variant: "destructive" });
    },
  });

  // PATCH the orderDate on the server when the user edits it for an existing order
  const updateDateMutation = useMutation({
    mutationFn: async (newDate: string) => {
      const res = await modeApiRequest("PATCH", `/api/factory/customer-orders/${orderId}/date`, { orderDate: newDate });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || "Failed to update date");
      }
      return res.json();
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error updating date", description: error.message, variant: "destructive" });
    },
  });

  const handleDateChange = useCallback(
    (newDate: string) => {
      setOrderDate(newDate);
      if (orderId && newDate) {
        updateDateMutation.mutate(newDate);
      }
    },
    [orderId, updateDateMutation]
  );

  const repriceMutation = useMutation({
    mutationFn: async () => {
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/reprice`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to apply prices");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders", orderId] });
      toast({ title: "Prices updated", description: `Applied current prices to ${data.repriced} bale(s)` });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Update failed", description: error.message, variant: "destructive" });
    },
  });

  const handleCustomerChange = useCallback((value: string) => {
    setSelectedCustomerId(value);
    setOrderId(null);
  }, []);

  useEffect(() => {
    if (customerId && selectedCompany?.id && activeProforma && orderDate && !orderId) {
      createOrderMutation.mutate({
        companyId: selectedCompany.id,
        customerId,
        orderDate,
        proformaIdUsed: activeProforma.id,
      });
    }
  }, [activeProforma, createOrderMutation, customerId, orderDate, orderId, selectedCompany]);

  const handleScan = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter" || !scanCode.trim() || !orderId || !selectedLocationId) return;
      e.preventDefault();
      addBaleMutation.mutate({ scanCode: scanCode.trim(), locationId: parseInt(selectedLocationId) });
    },
    [scanCode, orderId, selectedLocationId, addBaleMutation]
  );

  const handleAddCharge = useCallback(() => {
    if (!chargeAmount || !orderId) return;
    const name = chargeType === "FREIGHT" ? "Freight" : chargeName.trim();
    if (!name) return;
    addChargeMutation.mutate({
      name,
      amount: parseFloat(chargeAmount),
      chargeType,
      ...(chargeLedgerAccountId ? { ledgerAccountId: parseInt(chargeLedgerAccountId) } : {}),
    });
  }, [chargeAmount, chargeName, chargeType, chargeLedgerAccountId, orderId, addChargeMutation]);

  const bales = orderDetail?.bales || [];
  const charges = orderDetail?.charges || [];

  const groupedBales = bales.reduce<
    Record<
      string,
      {
        articleCode: string;
        productName: string;
        bales: OrderBale[];
        totalWeight: number;
        totalPrice: number;
        pricePerBale: number;
      }
    >
  >((acc, bale) => {
    const key = bale.articleCode;
    if (!acc[key]) {
      acc[key] = {
        articleCode: bale.articleCode,
        productName: bale.productName,
        bales: [],
        totalWeight: 0,
        totalPrice: 0,
        pricePerBale: parseFloat(bale.pricePerBale || "0"),
      };
    }
    acc[key].bales.push(bale);
    acc[key].totalWeight += parseFloat(bale.weight || "0");
    acc[key].totalPrice += parseFloat(bale.totalPrice || "0");
    return acc;
  }, {});

  const subtotal = bales.reduce((sum, b) => sum + parseFloat(b.totalPrice || "0"), 0);
  const freightCharges = charges
    .filter((c) => c.chargeType === "FREIGHT")
    .reduce((sum, c) => sum + parseFloat(c.amount || "0"), 0);
  const otherCharges = charges
    .filter((c) => c.chargeType !== "FREIGHT")
    .reduce((sum, c) => sum + parseFloat(c.amount || "0"), 0);
  const grandTotal = subtotal + freightCharges + otherCharges;

  const scanInputClass =
    scanFlash === "success"
      ? "ring-2 ring-green-500 bg-green-50 dark:bg-green-950 transition-all"
      : scanFlash === "error"
        ? "ring-2 ring-red-500 bg-red-50 dark:bg-red-950 transition-all"
        : "";
  return {
    activeProforma,
    addBaleMutation,
    addChargeMutation,
    bales,
    chargeAmount,
    chargeLedgerAccountId,
    chargeName,
    chargeType,
    charges,
    customerId,
    customers,
    finalizeMutation,
    freightCharges,
    grandTotal,
    groupedBales,
    handleAddCharge,
    handleCustomerChange,
    handleDateChange,
    handleScan,
    ledgerAccounts,
    locations,
    orderDate,
    orderDetail,
    orderId,
    otherCharges,
    proformaSummaries,
    relinkVouchersMutation,
    removeBaleMutation,
    removeChargeMutation,
    repriceMutation,
    scanCode,
    scanInputClass,
    scannerRef,
    selectedCustomerId,
    selectedLocationId,
    setChargeAmount,
    setChargeLedgerAccountId,
    setChargeName,
    setChargeType,
    setScanCode,
    setSelectedLocationId,
    setShowFinalizeDialog,
    showFinalizeDialog,
    subtotal,
  };
}
