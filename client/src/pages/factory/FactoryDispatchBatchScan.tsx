import { useQuery, useMutation } from "@tanstack/react-query";
import { useState, useRef, useEffect, useCallback } from "react";
import { useLocation, useRoute } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import {
  ScanLine,
  Trash2,
  CheckCircle,
  AlertTriangle,
  Package,
  Truck,
  ArrowLeft,
  Scale,
  DollarSign,
} from "lucide-react";

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

function fmt(n: number | string, decimals = 2) {
  const v = typeof n === "string" ? parseFloat(n) : n;
  if (isNaN(v)) return "0";
  return v.toLocaleString(undefined, { maximumFractionDigits: decimals });
}

export default function FactoryDispatchBatchScan() {
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
    refetchInterval: 15_000,
  });

  const { data: auditScans = [] } = useQuery<AuditScan[]>({
    queryKey: [`/api/factory/dispatch-batches/${batchId}/audit`],
    queryFn: async () => {
      const res = await fetch(`/api/factory/dispatch-batches/${batchId}/audit`, { credentials: "include" });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    enabled: !!batchId,
    refetchInterval: 10_000,
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
      toast({ title: "Error", description: err.message, variant: "destructive" });
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
      toast({ title: "Error", description: err.message, variant: "destructive" });
      setDispatchOpen(false);
    },
  });

  function handleScanKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && scanInput.trim() && canScan && !scanMutation.isPending) {
      scanMutation.mutate(scanInput.trim());
    }
  }

  if (batchLoading) {
    return (
      <div className="space-y-4 p-3 sm:p-6">
        <Skeleton className="h-12 w-full" />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!batch || !thisRide) {
    return (
      <div className="flex flex-col items-center gap-3 p-3 py-16 text-muted-foreground sm:p-6">
        <AlertTriangle className="w-8 h-8" />
        <p>Ride or batch not found</p>
        <Button
          variant="outline"
          onClick={() => navigate(batchId ? `/factory/dispatch-batches/${batchId}` : "/factory/dispatch-batches")}
        >
          <ArrowLeft className="w-4 h-4 mr-1" /> Back
        </Button>
      </div>
    );
  }

  const totalWeight = rideScans.reduce((s, sc) => s + parseFloat(sc.weightKg || "0"), 0);
  const totalAmount = rideScans.reduce((s, sc) => s + parseFloat(sc.amount || "0"), 0);

  const proformaProgress = (batchData?.proformaLines || []).map((pl) => {
    const at = batchData?.articleTotals.find((a) => a.articleCode === pl.articleCode);
    const scanned = parseInt(String(at?.scannedQty || 0));
    return {
      articleCode: pl.articleCode,
      productName: pl.productName,
      proformaQty: pl.quantity,
      scannedQty: scanned,
      remaining: pl.quantity - scanned,
      isOver: scanned > pl.quantity,
    };
  });

  const flashColors = {
    success: "bg-green-100 border-green-400 text-green-800 dark:bg-green-900 dark:border-green-700 dark:text-green-200",
    error: "bg-red-100 border-red-400 text-red-800 dark:bg-red-900 dark:border-red-700 dark:text-red-200",
    warn: "bg-amber-100 border-amber-400 text-amber-800 dark:bg-amber-900 dark:border-amber-700 dark:text-amber-200",
  };

  return (
    <div className="flex h-full min-w-0 flex-col" data-testid="factory-dispatch-batch-scan-page">
      <div className="flex flex-wrap items-start gap-2 border-b px-3 py-3 sm:items-center sm:gap-3 sm:px-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate(`/factory/dispatch-batches/${batchId}`)}
          data-testid="button-back"
        >
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="break-all font-mono font-semibold">{batch.batchNumber}</span>
            <span className="text-muted-foreground">·</span>
            <span className="break-words text-sm text-muted-foreground">{batchData.customerName}</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-sm">Ride #{thisRide.rideNumber}</span>
            {thisRide.truckPlate && <span className="text-muted-foreground text-sm">({thisRide.truckPlate})</span>}
            <Badge
              className={
                thisRide.status === "LOADING"
                  ? "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"
                  : thisRide.status === "DISPATCHED"
                    ? "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"
                    : "bg-muted text-muted-foreground"
              }
            >
              {thisRide.status}
            </Badge>
          </div>
          {batchData.proforma && (
            <p className="mt-0.5 break-words text-xs text-muted-foreground">{batchData.proforma.name}</p>
          )}
        </div>
        {!isDispatched && !isCancelled && batch.status !== "INVOICED" && (
          <Button
            onClick={() => setDispatchOpen(true)}
            disabled={rideScans.length === 0}
            className="w-full sm:w-auto"
            data-testid="button-dispatch-ride"
          >
            <Truck className="w-4 h-4 mr-1.5" /> Mark Dispatched
          </Button>
        )}
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden lg:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="space-y-3 p-3 sm:p-4">
            <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-3">
              <Card>
                <CardContent className="pt-3 pb-3">
                  <div className="flex items-center gap-1.5 text-muted-foreground text-xs mb-1">
                    <Package className="w-3.5 h-3.5" /> Bales Scanned
                  </div>
                  <p className="text-2xl font-bold" data-testid="text-scan-bale-count">
                    {rideScans.length}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-3 pb-3">
                  <div className="flex items-center gap-1.5 text-muted-foreground text-xs mb-1">
                    <Scale className="w-3.5 h-3.5" /> Total Weight (kg)
                  </div>
                  <p className="text-2xl font-bold" data-testid="text-scan-weight">
                    {fmt(totalWeight)}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-3 pb-3">
                  <div className="flex items-center gap-1.5 text-muted-foreground text-xs mb-1">
                    <DollarSign className="w-3.5 h-3.5" /> Est. Value
                  </div>
                  <p className="break-words text-2xl font-bold" data-testid="text-scan-value">
                    {batch.currency} {fmt(totalAmount)}
                  </p>
                </CardContent>
              </Card>
            </div>

            {canScan && (
              <div className="relative min-w-0">
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
            )}

            {flash && (
              <div
                className={`flex items-start gap-2 border rounded-md px-3 py-2.5 text-sm font-medium transition-all ${flashColors[flash]}`}
                data-testid={`scan-feedback-${flash}`}
              >
                {flash === "success" ? (
                  <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" />
                ) : (
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                )}
                <span className="min-w-0 break-words">{flashMsg}</span>
              </div>
            )}

            {isDispatched && (
              <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200 sm:items-center">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                This ride is DISPATCHED. Scanning is locked. An admin can reopen it from the batch detail page.
              </div>
            )}

            {isCancelled && (
              <div className="flex items-center gap-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                This ride is CANCELLED.
              </div>
            )}
          </div>

          <div className="flex-1 min-w-0 overflow-auto px-3 pb-3 sm:px-4 sm:pb-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Scanned Bales ({rideScans.length})</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {rideScans.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
                    <ScanLine className="w-8 h-8 opacity-40" />
                    <p className="text-sm">No bales scanned yet</p>
                    {canScan && <p className="text-xs">Scan a barcode above to get started</p>}
                  </div>
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
        </div>

        {proformaProgress.length > 0 && (
          <div
            className="flex max-h-[min(40dvh,22rem)] w-full shrink-0 flex-col overflow-hidden border-t lg:max-h-none lg:w-56 lg:border-l lg:border-t-0"
            data-testid="dispatch-scan-proforma-progress"
          >
            <div className="px-3 py-2 border-b">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Proforma</p>
              <p className="mt-0.5 break-words text-xs text-muted-foreground">{batchData.proforma?.name}</p>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
              {proformaProgress.map((p) => (
                <div
                  key={p.articleCode}
                  className={`rounded-md p-2 text-xs border ${
                    p.isOver
                      ? "border-amber-300 bg-amber-50 dark:bg-amber-950 dark:border-amber-800"
                      : p.remaining === 0
                        ? "border-green-300 bg-green-50 dark:bg-green-950 dark:border-green-800"
                        : "border-border bg-muted/30"
                  }`}
                  data-testid={`sidebar-progress-${p.articleCode}`}
                >
                  <p className="break-all font-mono font-semibold">{p.articleCode}</p>
                  <p className="truncate text-xs text-muted-foreground">{p.productName}</p>
                  <div className="flex justify-between mt-1">
                    <span className="text-muted-foreground">Target</span>
                    <span>{p.proformaQty}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Scanned</span>
                    <span
                      className={
                        p.isOver
                          ? "text-amber-600 font-semibold"
                          : p.remaining === 0
                            ? "text-green-600 font-semibold"
                            : "font-semibold"
                      }
                    >
                      {p.scannedQty}
                    </span>
                  </div>
                  {p.isOver && (
                    <p className="text-amber-600 mt-0.5 flex items-center gap-0.5">
                      <AlertTriangle className="w-3 h-3" /> +{p.scannedQty - p.proformaQty} over
                    </p>
                  )}
                  {p.remaining > 0 && <p className="text-muted-foreground mt-0.5">{p.remaining} remaining</p>}
                  {p.remaining === 0 && !p.isOver && (
                    <p className="text-green-600 mt-0.5 flex items-center gap-0.5">
                      <CheckCircle className="w-3 h-3" /> Done
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <AlertDialog open={dispatchOpen} onOpenChange={setDispatchOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark Truck as Dispatched?</AlertDialogTitle>
            <AlertDialogDescription>
              Ride #{thisRide.rideNumber} has <strong>{rideScans.length}</strong> bales ({fmt(totalWeight)} kg). After
              dispatching, scanning will be locked for this ride.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => dispatchMutation.mutate()}
              disabled={dispatchMutation.isPending}
              data-testid="button-confirm-dispatch-ride"
            >
              {dispatchMutation.isPending ? "Dispatching..." : "Mark Dispatched"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!removeScanId}
        onOpenChange={(o) => {
          if (!o) setRemoveScanId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Bale?</AlertDialogTitle>
            <AlertDialogDescription>
              This bale will be removed from the scan list and returned to IN_STOCK.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => removeScanId && removeMutation.mutate(removeScanId)}
              disabled={removeMutation.isPending}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-confirm-remove-scan"
            >
              {removeMutation.isPending ? "Removing..." : "Remove Bale"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
