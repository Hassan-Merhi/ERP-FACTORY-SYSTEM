import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { queryClient, keyStartsWith, invalidateCustomerBalances } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useCompany } from "@/contexts/CompanyContext";
import { Badge } from "@/components/ui/badge";
import { useState, useRef, useEffect, useCallback } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { useLocation, useSearch } from "wouter";
import { Trash2, ScanLine, Plus, PackageCheck, MapPin, RefreshCw } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageHeader } from "@/components/PageHeader";

interface Customer {
  id: number;
  legalName: string;
  balance: number;
  balanceSide: string;
}

interface Location {
  id: number;
  name: string;
  code?: string;
}

interface ProformaLine {
  id: number;
  articleCode: string;
  productName: string;
  pricePerBale: string;
  pricingMode?: string;
  pricePerKg?: string | null;
}

interface Proforma {
  id: number;
  customerId: number;
  name: string;
  isActive: boolean;
  lines: ProformaLine[];
}

interface OrderBale {
  id: number;
  baleId: number;
  referenceNumber: string;
  articleCode: string;
  productName: string;
  weight: string;
  pricePerBale: string;
  totalPrice: string;
}

interface OrderCharge {
  id: number;
  name: string;
  amount: string;
  chargeType: string;
  voucherId?: number | null;
  ledgerAccountId?: number | null;
}

interface OrderDetail {
  id: number;
  customerId: number;
  companyId: number;
  orderDate: string;
  status: string;
  invoiceNumber?: string;
  subtotalBales: string;
  freightAmount: string;
  otherChargesTotal: string;
  grandTotal: string;
  totalQtyBales: number;
  bales: OrderBale[];
  charges: OrderCharge[];
}

export default function FactoryInvoiceCreate() {
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

  const customerId = selectedCustomerId ? parseInt(selectedCustomerId) : null;

  const { data: orderDetail } = useQuery<OrderDetail>({
    queryKey: ["/api/factory/customer-orders", orderId],
    enabled: !!orderId,
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
    queryKey: ["/api/factory/customers"],
  });

  const { data: locations = [] } = useQuery<Location[]>({
    queryKey: ["/api/locations"],
  });

  const { data: ledgerAccounts = [] } = useQuery<{ id: number; name: string; code: string }[]>({
    queryKey: ["/api/ledger-accounts?includeHidden=true&profile=picker"],
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const { data: proformaSummaries = [] } = useQuery<Array<Omit<Proforma, "lines"> & { lineCount: number }>>({
    queryKey: [`/api/factory/customer-proformas?customerId=${customerId}&profile=summary`],
    enabled: !!customerId,
  });

  const activeProformaSummary = proformaSummaries.find((proforma) => proforma.isActive) || null;
  const { data: activeProforma = null } = useQuery<Proforma>({
    queryKey: ["/api/factory/customer-proformas/detail", activeProformaSummary?.id],
    queryFn: async () => {
      const response = await fetch(`/api/factory/customer-proformas/${activeProformaSummary?.id}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to load proforma details");
      return response.json();
    },
    enabled: !!activeProformaSummary?.id,
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
      toast({ title: "Error", description: error.message, variant: "destructive" });
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
      toast({ title: "Error", description: error.message, variant: "destructive" });
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
      toast({ title: "Error", description: error.message, variant: "destructive" });
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
      toast({ title: "Error", description: error.message, variant: "destructive" });
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
      toast({ title: "Error", description: error.message, variant: "destructive" });
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
      toast({ title: "Error", description: error.message, variant: "destructive" });
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
      toast({ title: "Error", description: error.message, variant: "destructive" });
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

  return (
    <div className="flex flex-col h-full p-4 lg:p-6">
      <div className="flex items-center justify-between gap-4 mb-4">
        <div>
          <PageHeader title="Create Invoice" subtitle="POS-style bale sales invoice" />
        </div>
        {orderId && (
          <Badge variant="secondary" data-testid="badge-draft-order">
            Draft #{orderId}
          </Badge>
        )}
      </div>

      <div className="flex flex-col lg:flex-row gap-4 flex-1 min-h-0">
        <div className="lg:w-[60%] flex flex-col min-h-0">
          <Card className="flex-1 flex flex-col min-h-0 p-4">
            <div className="flex items-center justify-between gap-2 mb-3">
              <h2 className="font-semibold text-lg" data-testid="text-bales-header">
                Scanned Bales
              </h2>
              <Badge variant="secondary" data-testid="badge-bale-count">
                {bales.length} bales
              </Badge>
            </div>

            <div className="flex-1 overflow-y-auto">
              {Object.keys(groupedBales).length === 0 ? (
                <div
                  className="flex flex-col items-center justify-center py-12 text-muted-foreground"
                  data-testid="text-no-bales"
                >
                  <ScanLine className="h-12 w-12 mb-3 opacity-40" />
                  <p>No bales scanned yet</p>
                  <p className="text-sm mt-1">Select a customer and location, then scan bales</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {Object.values(groupedBales).map((group) => (
                    <div key={group.articleCode} data-testid={`group-article-${group.articleCode}`}>
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-2 px-1">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" data-testid={`badge-article-${group.articleCode}`}>
                            {group.articleCode}
                          </Badge>
                          <span className="text-sm font-medium">{group.productName}</span>
                        </div>
                        <div className="flex items-center gap-3 text-sm text-muted-foreground">
                          <span>Qty: {group.bales.length}</span>
                          <span>
                            Wt:{" "}
                            {group.totalWeight.toLocaleString(undefined, {
                              minimumFractionDigits: 0,
                              maximumFractionDigits: 2,
                            })}
                          </span>
                          {(() => {
                            const pfl = activeProforma?.lines.find((l) => l.articleCode === group.articleCode);
                            const isPerKg = pfl?.pricingMode === "per_kg";
                            return isPerKg ? (
                              <span className="font-mono text-xs text-muted-foreground">
                                @
                                {parseFloat(pfl?.pricePerKg || "0").toLocaleString(undefined, {
                                  minimumFractionDigits: 3,
                                  maximumFractionDigits: 3,
                                })}
                                /kg
                              </span>
                            ) : (
                              <span className="font-mono">
                                @
                                {group.pricePerBale.toLocaleString(undefined, {
                                  minimumFractionDigits: 0,
                                  maximumFractionDigits: 2,
                                })}
                              </span>
                            );
                          })()}
                          <span className="font-mono font-semibold text-foreground">
                            {group.totalPrice.toLocaleString(undefined, {
                              minimumFractionDigits: 0,
                              maximumFractionDigits: 2,
                            })}
                          </span>
                        </div>
                      </div>
                      <Table>
                        <TableBody>
                          {group.bales.map((bale) => (
                            <TableRow key={bale.id} data-testid={`row-bale-${bale.id}`}>
                              <TableCell className="font-mono text-sm" data-testid={`text-bale-ref-${bale.id}`}>
                                {bale.referenceNumber}
                              </TableCell>
                              <TableCell className="text-right text-sm text-muted-foreground">
                                {parseFloat(bale.weight || "0").toLocaleString(undefined, {
                                  minimumFractionDigits: 0,
                                  maximumFractionDigits: 2,
                                })}{" "}
                                kg
                              </TableCell>
                              <TableCell
                                className="text-right font-mono text-sm"
                                data-testid={`text-bale-price-${bale.id}`}
                              >
                                {parseFloat(bale.totalPrice || "0").toLocaleString(undefined, {
                                  minimumFractionDigits: 0,
                                  maximumFractionDigits: 2,
                                })}
                              </TableCell>
                              <TableCell className="w-[40px]">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => removeBaleMutation.mutate(bale.id)}
                                  disabled={removeBaleMutation.isPending}
                                  data-testid={`button-remove-bale-${bale.id}`}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {bales.length > 0 && (
              <div className="border-t pt-3 mt-3 flex items-center justify-between gap-2">
                <span className="font-medium">Subtotal</span>
                <span className="font-mono font-semibold text-lg" data-testid="text-subtotal">
                  {subtotal.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
                </span>
              </div>
            )}
          </Card>
        </div>

        <div className="lg:w-[40%] flex flex-col gap-4">
          <Card className="p-4 space-y-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Customer</label>
              <Select value={selectedCustomerId} onValueChange={handleCustomerChange} disabled={!!orderId}>
                <SelectTrigger data-testid="select-customer">
                  <SelectValue placeholder="Select customer..." />
                </SelectTrigger>
                <SelectContent>
                  {customers.map((c) => (
                    <SelectItem key={c.id} value={c.id.toString()} data-testid={`select-customer-option-${c.id}`}>
                      {c.legalName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block">Date</label>
              <Input
                type="date"
                value={orderDate}
                onChange={(e) => handleDateChange(e.target.value)}
                data-testid="input-order-date"
              />
            </div>

            {activeProforma && (
              <div className="flex items-center gap-2">
                <Badge
                  variant="default"
                  className="bg-green-600 text-white no-default-hover-elevate no-default-active-elevate"
                  data-testid="badge-active-proforma"
                >
                  {activeProforma.name}
                </Badge>
                <span className="text-sm text-muted-foreground">{activeProforma.lines.length} price lines</span>
              </div>
            )}

            {customerId && !activeProforma && proformaSummaries.length === 0 && (
              <p className="text-sm text-destructive" data-testid="text-no-proforma">
                No active proforma found for this customer
              </p>
            )}

            <div>
              <label className="text-sm font-medium mb-1 block">
                <MapPin className="inline h-3 w-3 mr-1" />
                Picking Location
              </label>
              <Select value={selectedLocationId} onValueChange={setSelectedLocationId}>
                <SelectTrigger data-testid="select-location">
                  <SelectValue placeholder="Select location..." />
                </SelectTrigger>
                <SelectContent>
                  {locations.map((loc) => (
                    <SelectItem key={loc.id} value={loc.id.toString()} data-testid={`select-location-option-${loc.id}`}>
                      {loc.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block">
                <ScanLine className="inline h-3 w-3 mr-1" />
                Scan Bale
              </label>
              <Input
                ref={scannerRef}
                value={scanCode}
                onChange={(e) => setScanCode(e.target.value)}
                onKeyDown={handleScan}
                placeholder="Scan or type bale code..."
                disabled={!orderId || !selectedLocationId}
                className={scanInputClass}
                data-testid="input-scan-code"
              />
              {(!orderId || !selectedLocationId) && (
                <p className="text-xs text-muted-foreground mt-1">
                  {!orderId ? "Select a customer with an active proforma first" : "Select a location to start scanning"}
                </p>
              )}
            </div>
          </Card>

          <Card className="p-4 space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <h3 className="font-semibold text-sm">Charges</h3>
              {orderDetail?.status === "FINALIZED" && charges.some((c) => !c.voucherId) && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => relinkVouchersMutation.mutate()}
                  disabled={relinkVouchersMutation.isPending}
                  data-testid="button-relink-charge-vouchers"
                >
                  {relinkVouchersMutation.isPending ? "Linking..." : "Fix Ledger Entries"}
                </Button>
              )}
            </div>

            {charges.length > 0 && (
              <div className="space-y-1">
                {charges.map((charge) => (
                  <div
                    key={charge.id}
                    className="flex items-center justify-between gap-2"
                    data-testid={`row-charge-${charge.id}`}
                  >
                    <span className="text-sm">{charge.name}</span>
                    <div className="flex items-center gap-1">
                      <span className="font-mono text-sm" data-testid={`text-charge-amount-${charge.id}`}>
                        {parseFloat(charge.amount).toLocaleString(undefined, {
                          minimumFractionDigits: 0,
                          maximumFractionDigits: 2,
                        })}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => removeChargeMutation.mutate(charge.id)}
                        disabled={removeChargeMutation.isPending}
                        data-testid={`button-remove-charge-${charge.id}`}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-2">
              <Select value={chargeType} onValueChange={setChargeType}>
                <SelectTrigger data-testid="select-charge-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="FREIGHT">Freight</SelectItem>
                  <SelectItem value="OTHER">Other</SelectItem>
                </SelectContent>
              </Select>

              {chargeType === "OTHER" && (
                <Input
                  value={chargeName}
                  onChange={(e) => setChargeName(e.target.value)}
                  placeholder="Charge name..."
                  data-testid="input-charge-name"
                />
              )}

              <Select value={chargeLedgerAccountId} onValueChange={setChargeLedgerAccountId}>
                <SelectTrigger data-testid="select-charge-ledger-account">
                  <SelectValue
                    placeholder={
                      chargeType !== "FREIGHT" ? "Select account (required)..." : "Select account (optional)..."
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {ledgerAccounts.map((acc) => (
                    <SelectItem key={acc.id} value={String(acc.id)}>
                      {acc.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {chargeType !== "FREIGHT" && !chargeLedgerAccountId && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  A ledger account is required so the charge posts to accounting.
                </p>
              )}

              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  step="0.01"
                  value={chargeAmount}
                  onChange={(e) => setChargeAmount(e.target.value)}
                  placeholder="Amount"
                  disabled={!orderId}
                  data-testid="input-charge-amount"
                />
                <Button
                  variant="outline"
                  onClick={handleAddCharge}
                  disabled={
                    !orderId ||
                    !chargeAmount ||
                    (chargeType !== "FREIGHT" && !chargeLedgerAccountId) ||
                    addChargeMutation.isPending
                  }
                  data-testid="button-add-charge"
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </Card>

          <Card className="p-4 space-y-2">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span>Subtotal</span>
              <span className="font-mono" data-testid="text-summary-subtotal">
                {subtotal.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 text-sm">
              <span>Freight</span>
              <span className="font-mono" data-testid="text-summary-freight">
                {freightCharges.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 text-sm">
              <span>Other Charges</span>
              <span className="font-mono" data-testid="text-summary-other">
                {otherCharges.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
              </span>
            </div>
            <div className="border-t pt-2 flex items-center justify-between gap-2">
              <span className="font-semibold">Grand Total</span>
              <span className="font-mono font-bold text-lg" data-testid="text-grand-total">
                {grandTotal.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
              <span>Total Bales</span>
              <span data-testid="text-total-bales">{bales.length}</span>
            </div>
          </Card>

          {orderId && bales.length > 0 && (
            <Button
              variant="outline"
              className="w-full"
              onClick={() => repriceMutation.mutate()}
              disabled={repriceMutation.isPending}
              data-testid="button-apply-prices"
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${repriceMutation.isPending ? "animate-spin" : ""}`} />
              Apply Current Prices
            </Button>
          )}

          <Button
            className="w-full"
            size="lg"
            onClick={() => setShowFinalizeDialog(true)}
            disabled={!orderId || bales.length === 0 || finalizeMutation.isPending}
            data-testid="button-finalize"
          >
            <PackageCheck className="mr-2 h-5 w-5" />
            Finalize Invoice
          </Button>
        </div>
      </div>

      <Dialog open={showFinalizeDialog} onOpenChange={setShowFinalizeDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Finalize Invoice</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <p className="mb-4">
              Are you sure you want to finalize this invoice for{" "}
              <span className="font-semibold">{customers.find((c) => c.id === customerId)?.legalName}</span>?
            </p>
            <div className="bg-muted p-4 rounded-lg space-y-2">
              <div className="flex justify-between">
                <span>Total Bales:</span>
                <span className="font-mono">{bales.length}</span>
              </div>
              <div className="flex justify-between font-bold border-t pt-2">
                <span>Grand Total:</span>
                <span className="font-mono">
                  {grandTotal.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
                </span>
              </div>
            </div>
            <p className="text-sm text-muted-foreground mt-4 italic">
              Finalizing will assign the bales to this invoice and generate a permanent invoice number.
            </p>
          </div>
          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => setShowFinalizeDialog(false)} data-testid="button-cancel-finalize">
              Cancel
            </Button>
            <Button
              onClick={() => finalizeMutation.mutate()}
              disabled={finalizeMutation.isPending}
              data-testid="button-confirm-finalize"
            >
              Confirm & Finalize
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
