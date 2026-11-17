// Extracted from ./FactoryDispatchBatchScan.tsx to keep that module under the source-size cap.
import { visibleTabInterval } from "@/lib/queryPolicies";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { Button } from "@/components/ui/button";
import { MobileBarcodeScanner } from "@/components/MobileBarcodeScanner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { ScanLine, Trash2 } from "lucide-react";
import { EmptyState } from "@/components/ui/page-state";

interface BatchDetail {
  batch: {
    id: number;
    batchNumber: string;
    batchDate: string;
    status: string;
    currency: string;
    priceMode: string;
    destination: string | null;
    proformaId: number | null;
  };
  customerName: string | null;
  proforma: { id: number; name: string } | null;
  proformaLines: {
    id: number;
    articleCode: string;
    productName: string;
    quantity: number;
    pricePerBale: string;
  }[];
  rides: {
    id: number;
    rideNumber: number;
    truckPlate: string | null;
    driverName: string | null;
    status: string;
    baleCount: number | string;
    totalWeightKg: string;
    totalAmount: string;
  }[];
  articleTotals: {
    articleCode: string;
    productName: string;
    scannedQty: number | string;
    scannedWeightKg: string;
    scannedAmount: string;
  }[];
}

interface AuditScan {
  id: number;
  truckRideId: number;
  rideNumber: number;
  baleId: number;
  baleReference: string;
  articleCode: string | null;
  productName: string | null;
  weightKg: string;
  priceUsed: string;
  amount: string;
  scannedBy: string | null;
  scannedAt: string;
  removedAt: string | null;
}

export function fmt(n: number | string, decimals = 2) {
  const v = typeof n === "string" ? parseFloat(n) : n;
  if (isNaN(v)) return "0";
  return v.toLocaleString(undefined, { maximumFractionDigits: decimals });
}

export function useFactoryDispatchBatchScanState() {
  const [, navigate] = useLocation();
  const [, params] = useRoute("/factory/dispatch-batches/:batchId/rides/:rideId/scan");
  const batchId = params?.batchId ? parseInt(params.batchId) : null;
  const rideId = params?.rideId ? parseInt(params.rideId) : null;
  const { toast } = useToast();

  const scanRef = useRef<HTMLInputElement>(null);
  const [scanInput, setScanInput] = useState("");
  const [flash, setFlash] = useState<"success" | "error" | "warn" | null>(null);
  const [flashMsg, setFlashMsg] = useState("");
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [removeScanId, setRemoveScanId] = useState<number | null>(null);

  const { data: batchData, isLoading: batchLoading } = useQuery<BatchDetail>({
    queryKey: [`/api/factory/dispatch-batches/${batchId}`],
    queryFn: async () => {
      const res = await fetch(`/api/factory/dispatch-batches/${batchId}`, { credentials: "include" });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    enabled: !!batchId,
    refetchInterval: visibleTabInterval(15_000),
  });

  const { data: auditScans = [] } = useQuery<AuditScan[]>({
    queryKey: [`/api/factory/dispatch-batches/${batchId}/audit`],
    queryFn: async () => {
      const res = await fetch(`/api/factory/dispatch-batches/${batchId}/audit`, { credentials: "include" });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    enabled: !!batchId,
    refetchInterval: visibleTabInterval(10_000),
  });

  const rideScans = auditScans.filter((s) => s.truckRideId === rideId && !s.removedAt);
  const thisRide = batchData?.rides.find((r) => r.id === rideId);
  const batch = batchData?.batch;
  const isDispatched = thisRide?.status === "DISPATCHED";
  const isCancelled = thisRide?.status === "CANCELLED";
  const canScan = !isDispatched && !isCancelled && batch?.status !== "INVOICED" && batch?.status !== "CANCELLED";

  const flashFeedback = useCallback((type: "success" | "error" | "warn", msg: string) => {
    setFlash(type);
    setFlashMsg(msg);
    setTimeout(() => setFlash(null), 2200);
  }, []);

  useEffect(() => {
    if (canScan && scanRef.current) scanRef.current.focus();
  }, [canScan, rideScans.length]);

  const scanMutation = useMutation({
    mutationFn: async (barcode: string) => {
      const res = await apiRequest("POST", `/api/factory/dispatch-truck-rides/${rideId}/scan-bale`, { barcode });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message);
      return data;
    },
    onSuccess: (data) => {
      setScanInput("");
      queryClient.invalidateQueries({ queryKey: [`/api/factory/dispatch-batches/${batchId}/audit`] });
      queryClient.invalidateQueries({ queryKey: [`/api/factory/dispatch-batches/${batchId}`] });
      if (data.overageWarning) {
        flashFeedback("warn", `⚠ ${data.message}`);
      } else {
        flashFeedback(
          "success",
          `✓ ${data.bale?.referenceNumber} — ${data.bale?.articleCode} — ${fmt(data.bale?.weightKg)} kg`
        );
      }
      setTimeout(() => scanRef.current?.focus(), 40);
    },
    onError: (err) => {
      setScanInput("");
      flashFeedback("error", err.message);
      setTimeout(() => scanRef.current?.focus(), 40);
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (scanId: number) => {
      const res = await apiRequest("DELETE", `/api/factory/dispatch-bale-scans/${scanId}`, {});
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/factory/dispatch-batches/${batchId}/audit`] });
      queryClient.invalidateQueries({ queryKey: [`/api/factory/dispatch-batches/${batchId}`] });
      toast({ title: "Bale removed", description: "Bale returned to IN_STOCK." });
      setRemoveScanId(null);
      setTimeout(() => scanRef.current?.focus(), 40);
    },
    onError: (err) => {
      toast({ title: "Remove failed", description: err.message, variant: "destructive" });
      setRemoveScanId(null);
    },
  });

  const dispatchMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/factory/dispatch-truck-rides/${rideId}/dispatch`, {});
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/factory/dispatch-batches/${batchId}`] });
      queryClient.invalidateQueries({ queryKey: [`/api/factory/dispatch-batches/${batchId}/audit`] });
      toast({ title: "Truck dispatched", description: "Ride is now marked as DISPATCHED." });
      setDispatchOpen(false);
      navigate(`/factory/dispatch-batches/${batchId}`);
    },
    onError: (err) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
      setDispatchOpen(false);
    },
  });

  function handleScanKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && scanInput.trim() && canScan && !scanMutation.isPending) {
      scanMutation.mutate(scanInput.trim());
    }
  }
  return {
    batch,
    batchData,
    batchId,
    batchLoading,
    canScan,
    dispatchMutation,
    dispatchOpen,
    flash,
    flashMsg,
    handleScanKey,
    isCancelled,
    isDispatched,
    navigate,
    removeMutation,
    removeScanId,
    rideScans,
    scanInput,
    scanMutation,
    scanRef,
    setDispatchOpen,
    setRemoveScanId,
    setScanInput,
    thisRide,
  };
}

export function FactoryDispatchBatchScanSection({
  handleScanKey,
  scanInput,
  scanMutation,
  scanRef,
  setScanInput,
}: Pick<
  ReturnType<typeof useFactoryDispatchBatchScanState>,
  "handleScanKey" | "scanInput" | "scanMutation" | "scanRef" | "setScanInput"
>) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="relative min-w-0 flex-1">
        <ScanLine className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
        <Input
          ref={scanRef}
          value={scanInput}
          onChange={(e) => setScanInput(e.target.value)}
          onKeyDown={handleScanKey}
          placeholder="Scan barcode or type reference number and press Enter..."
          className="h-12 min-w-0 pl-10 font-mono text-base"
          disabled={scanMutation.isPending}
          autoFocus
          data-testid="input-scan-barcode"
        />
        {scanMutation.isPending && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground animate-pulse">
            Scanning...
          </span>
        )}
      </div>
      <MobileBarcodeScanner
        onScan={(code) => scanMutation.mutate(code)}
        disabled={scanMutation.isPending}
        className="h-12 w-12 shrink-0"
      />
    </div>
  );
}

export function FactoryDispatchBatchScanSection2({
  canScan,
  rideScans,
  setRemoveScanId,
}: Pick<ReturnType<typeof useFactoryDispatchBatchScanState>, "canScan" | "rideScans" | "setRemoveScanId">) {
  return (
    <div className="flex-1 min-w-0 overflow-auto px-3 pb-3 sm:px-4 sm:pb-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Scanned Bales ({rideScans.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {rideScans.length === 0 ? (
            <EmptyState
              icon={ScanLine}
              title="No bales scanned yet"
              description={canScan ? "Scan a barcode above to get started" : undefined}
              className="border-0"
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Article</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Weight (kg)</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  {canScan && <TableHead />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rideScans.map((sc) => (
                  <TableRow key={sc.id} data-testid={`row-scan-${sc.id}`}>
                    <TableCell className="font-mono text-sm">{sc.baleReference}</TableCell>
                    <TableCell className="font-mono text-sm">{sc.articleCode || "—"}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">{sc.productName || "—"}</TableCell>
                    <TableCell className="text-right">{fmt(sc.weightKg)}</TableCell>
                    <TableCell className="text-right">{fmt(sc.priceUsed)}</TableCell>
                    <TableCell className="text-right font-medium">{fmt(sc.amount)}</TableCell>
                    {canScan && (
                      <TableCell>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="text-muted-foreground"
                          onClick={() => setRemoveScanId(sc.id)}
                          data-testid={`button-remove-scan-${sc.id}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
