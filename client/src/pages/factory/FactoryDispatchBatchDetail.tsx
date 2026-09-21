import { visibleTabInterval } from "@/lib/queryPolicies";
import type { ClientErrorLike } from "@/lib/clientError";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useLocation, useRoute } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { PageHeader } from "@/components/PageHeader";
import {
  Plus,
  Truck,
  Package,
  Scale,
  DollarSign,
  Eye,
  FileText,
  ScanLine,
  AlertTriangle,
  RotateCcw,
  ArrowLeft,
  ExternalLink,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { useDateFormat } from "@/contexts/DateFormatContext";

import type { AuditScan, BatchDetail, InvoicePreview } from "./factorydispatchbatchdetail/types";
import { BATCH_STATUS_CONFIG, fmt } from "./factorydispatchbatchdetail/utils";
import { RideStatusBadge } from "./factorydispatchbatchdetail/components/RideStatusBadge";
export default function FactoryDispatchBatchDetail() {
  const [, navigate] = useLocation();
  const [, params] = useRoute("/factory/dispatch-batches/:id");
  const batchId = params?.id ? parseInt(params.id) : null;
  const { toast } = useToast();
  const { formatDisplayDate } = useDateFormat();

  const [addRideOpen, setAddRideOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [reopenRideId, setReopenRideId] = useState<number | null>(null);
  const [reopenReason, setReopenReason] = useState("");
  const { data: me } = useQuery<{ role: string }>({ queryKey: ["/api/auth/me"] });
  const isDeveloper = me?.role === "Developer";

  const [showBales, setShowBales] = useState(false);
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().split("T")[0]);

  const [rideForm, setRideForm] = useState({
    truckPlate: "",
    driverName: "",
    destination: "",
    notes: "",
  });

  const { data, isLoading, isError, error, refetch } = useQuery<BatchDetail>({
    queryKey: [`/api/factory/dispatch-batches/${batchId}`],
    queryFn: async () => {
      const res = await fetch(`/api/factory/dispatch-batches/${batchId}`, { credentials: "include" });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    enabled: !!batchId,
    refetchInterval: visibleTabInterval(15_000),
  });

  const { data: preview, isLoading: previewLoading } = useQuery<InvoicePreview>({
    queryKey: [`/api/factory/dispatch-batches/${batchId}/invoice-preview`],
    queryFn: async () => {
      const res = await fetch(`/api/factory/dispatch-batches/${batchId}/invoice-preview`, { credentials: "include" });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    enabled: !!batchId && previewOpen,
    staleTime: 15000,
  });

  const { data: auditScans = [] } = useQuery<AuditScan[]>({
    queryKey: [`/api/factory/dispatch-batches/${batchId}/audit`],
    queryFn: async () => {
      const res = await fetch(`/api/factory/dispatch-batches/${batchId}/audit`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!batchId && showBales,
  });

  const addRideMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/factory/dispatch-batches/${batchId}/truck-rides`, {
        truckPlate: rideForm.truckPlate || undefined,
        driverName: rideForm.driverName || undefined,
        destination: rideForm.destination || undefined,
        notes: rideForm.notes || undefined,
      });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    onSuccess: (d) => {
      queryClient.invalidateQueries({ queryKey: [`/api/factory/dispatch-batches/${batchId}`] });
      toast({ title: "Truck ride added", description: `Ride #${d.rideNumber} added.` });
      setAddRideOpen(false);
      setRideForm({ truckPlate: "", driverName: "", destination: "", notes: "" });
      if (d.id) navigate(`/factory/dispatch-batches/${batchId}/rides/${d.id}/scan`);
    },
    onError: (err: ClientErrorLike) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const cancelMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", `/api/factory/dispatch-batches/${batchId}`, {});
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/dispatch-batches"] });
      queryClient.invalidateQueries({ queryKey: [`/api/factory/dispatch-batches/${batchId}`] });
      toast({ title: "Batch cancelled", description: "All bales have been returned to stock." });
      setCancelOpen(false);
    },
    onError: (err: ClientErrorLike) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const generateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/factory/dispatch-batches/${batchId}/generate-invoice`, {
        invoiceDate,
      });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    onSuccess: (d) => {
      queryClient.invalidateQueries({ queryKey: [`/api/factory/dispatch-batches/${batchId}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/dispatch-batches"] });
      toast({
        title: "Invoice generated!",
        description: `Invoice ${d.invoiceNumber} — ${d.totalBales} bales — ${data?.batch.currency} ${fmt(d.grandTotal)}`,
      });
      setGenerateOpen(false);
      setPreviewOpen(false);
      refetch();
    },
    onError: (err: ClientErrorLike) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const reopenRideMutation = useMutation({
    mutationFn: async ({ rideId, reason }: { rideId: number; reason: string }) => {
      const res = await apiRequest("POST", `/api/factory/dispatch-truck-rides/${rideId}/reopen`, { reason });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/factory/dispatch-batches/${batchId}`] });
      toast({ title: "Ride reopened", description: "The truck ride is now back to LOADING status." });
      setReopenRideId(null);
      setReopenReason("");
    },
    onError: (err: ClientErrorLike) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  if (!batchId) return null;

  if (me && !isDeveloper) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <p className="text-sm">Dispatch Batches is only available in Developer mode.</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-16 w-full" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="p-6">
        <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
          <AlertTriangle className="w-8 h-8" />
          <p>{error?.message || "Failed to load dispatch batch"}</p>
          <Button variant="outline" onClick={() => navigate("/factory/dispatch-batches")}>
            <ArrowLeft className="w-4 h-4 mr-1" /> Back to list
          </Button>
        </div>
      </div>
    );
  }

  const { batch, customerName, proforma, proformaLines, rides, articleTotals, finalInvoice } = data;
  const isReadOnly = batch.status === "INVOICED" || batch.status === "CANCELLED";

  const totalBales = rides.reduce((s, r) => s + parseInt(String(r.baleCount || 0)), 0);
  const totalWeight = rides.reduce((s, r) => s + parseFloat(r.totalWeightKg || "0"), 0);
  const totalValue = rides.reduce((s, r) => s + parseFloat(r.totalAmount || "0"), 0);

  const batchCfg = BATCH_STATUS_CONFIG[batch.status] || { label: batch.status, className: "" };

  const buildProformaProgress = () => {
    if (!proformaLines.length) return [];
    return proformaLines.map((pl) => {
      const at = articleTotals.find((a) => a.articleCode === pl.articleCode);
      const scanned = parseInt(String(at?.scannedQty || 0));
      return {
        articleCode: pl.articleCode,
        productName: pl.productName,
        proformaQty: pl.quantity,
        proformaPrice: pl.pricePerBale,
        scannedQty: scanned,
        remaining: pl.quantity - scanned,
        totalAmount: at?.scannedAmount || "0",
      };
    });
  };

  const progress = buildProformaProgress();

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono">{batch.batchNumber}</span>
            <Badge className={batchCfg.className}>{batchCfg.label}</Badge>
          </span>
        }
        subtitle={`${customerName || "—"} · ${formatDisplayDate(batch.batchDate)}${batch.destination ? ` · ${batch.destination}` : ""}`}
      >
        <div className="flex flex-wrap gap-2">
          {!isReadOnly && (
            <>
              <Button variant="outline" onClick={() => setAddRideOpen(true)} data-testid="button-add-truck-ride">
                <Plus className="w-4 h-4 mr-1" /> Add Truck Ride
              </Button>
              <Button variant="outline" onClick={() => setPreviewOpen(true)} data-testid="button-preview-invoice">
                <Eye className="w-4 h-4 mr-1" /> Preview Invoice
              </Button>
              <Button
                variant="outline"
                className="text-destructive"
                onClick={() => setCancelOpen(true)}
                data-testid="button-cancel-batch"
              >
                Cancel Batch
              </Button>
            </>
          )}
          {batch.status === "INVOICED" && finalInvoice && (
            <Button
              variant="outline"
              onClick={() => navigate(`/factory/sales/invoices/${finalInvoice.id}`)}
              data-testid="button-view-invoice"
            >
              <ExternalLink className="w-4 h-4 mr-1" /> View Invoice {finalInvoice.invoiceNumber}
            </Button>
          )}
        </div>
      </PageHeader>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <Truck className="w-4 h-4" />
                <span className="text-xs">Rides</span>
              </div>
              <p className="text-2xl font-bold" data-testid="text-total-rides">
                {rides.length}
              </p>
              <p className="text-xs text-muted-foreground">
                {rides.filter((r) => r.status === "DISPATCHED").length} dispatched
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <Package className="w-4 h-4" />
                <span className="text-xs">Bales</span>
              </div>
              <p className="text-2xl font-bold" data-testid="text-total-bales">
                {fmt(totalBales, 0)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <Scale className="w-4 h-4" />
                <span className="text-xs">Weight (kg)</span>
              </div>
              <p className="text-2xl font-bold" data-testid="text-total-weight">
                {fmt(totalWeight)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <DollarSign className="w-4 h-4" />
                <span className="text-xs">Total Value</span>
              </div>
              <p className="text-2xl font-bold" data-testid="text-total-value">
                {batch.currency} {fmt(totalValue)}
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-1 space-y-3">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Batch Info</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Customer</span>
                  <span className="font-medium">{customerName || "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Proforma</span>
                  <span>{proforma?.name || "None"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Currency</span>
                  <span>{batch.currency}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Price Mode</span>
                  <span>{batch.priceMode === "PER_KG" ? "Per Kg" : "Per Bale"}</span>
                </div>
                {batch.destination && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Destination</span>
                    <span>{batch.destination}</span>
                  </div>
                )}
                {batch.notes && (
                  <div>
                    <span className="text-muted-foreground text-xs">Notes</span>
                    <p className="text-sm mt-0.5">{batch.notes}</p>
                  </div>
                )}
                {finalInvoice && (
                  <div className="flex justify-between pt-1 border-t">
                    <span className="text-muted-foreground">Invoice</span>
                    <span className="font-mono font-medium text-green-700 dark:text-green-400">
                      {finalInvoice.invoiceNumber}
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>

            {progress.length > 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-1.5">
                    <Package className="w-4 h-4" /> Proforma Progress
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b">
                          <th className="text-left px-3 py-2 font-medium text-muted-foreground">Article</th>
                          <th className="text-right px-3 py-2 font-medium text-muted-foreground">Target</th>
                          <th className="text-right px-3 py-2 font-medium text-muted-foreground">Scanned</th>
                          <th className="text-right px-3 py-2 font-medium text-muted-foreground">Rem.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {progress.map((p) => (
                          <tr
                            key={p.articleCode}
                            className="border-b last:border-0"
                            data-testid={`row-progress-${p.articleCode}`}
                          >
                            <td className="px-3 py-2 font-mono">{p.articleCode}</td>
                            <td className="px-3 py-2 text-right">{p.proformaQty}</td>
                            <td className="px-3 py-2 text-right">
                              <span className={p.scannedQty > p.proformaQty ? "text-amber-600 font-medium" : ""}>
                                {p.scannedQty}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-right">
                              <span
                                className={
                                  p.remaining < 0 ? "text-amber-600" : p.remaining === 0 ? "text-green-600" : ""
                                }
                              >
                                {p.remaining}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          <div className="md:col-span-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-1.5">
                  <Truck className="w-4 h-4" /> Truck Rides
                  {!isReadOnly && (
                    <Button size="sm" variant="outline" className="ml-auto" onClick={() => setAddRideOpen(true)}>
                      <Plus className="w-3.5 h-3.5 mr-1" /> Add
                    </Button>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {rides.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
                    <Truck className="w-8 h-8 opacity-40" />
                    <p className="text-sm">No truck rides yet</p>
                    {!isReadOnly && (
                      <Button size="sm" variant="outline" onClick={() => setAddRideOpen(true)}>
                        <Plus className="w-4 h-4 mr-1" /> Add first ride
                      </Button>
                    )}
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-12">#</TableHead>
                        <TableHead>Truck</TableHead>
                        <TableHead>Driver</TableHead>
                        <TableHead className="text-right">Bales</TableHead>
                        <TableHead className="text-right">Weight</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rides.map((ride) => (
                        <TableRow key={ride.id} data-testid={`row-ride-${ride.id}`}>
                          <TableCell className="font-mono text-muted-foreground">{ride.rideNumber}</TableCell>
                          <TableCell>{ride.truckPlate || <span className="text-muted-foreground">—</span>}</TableCell>
                          <TableCell>{ride.driverName || <span className="text-muted-foreground">—</span>}</TableCell>
                          <TableCell className="text-right">{fmt(ride.baleCount, 0)}</TableCell>
                          <TableCell className="text-right">{fmt(ride.totalWeightKg)}</TableCell>
                          <TableCell className="text-right">{fmt(ride.totalAmount)}</TableCell>
                          <TableCell>
                            <RideStatusBadge status={ride.status} />
                          </TableCell>
                          <TableCell>
                            <div className="flex gap-1.5 justify-end">
                              {(ride.status === "LOADING" || ride.status === "DRAFT") && !isReadOnly && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => navigate(`/factory/dispatch-batches/${batchId}/rides/${ride.id}/scan`)}
                                  data-testid={`button-open-scanner-${ride.id}`}
                                >
                                  <ScanLine className="w-3.5 h-3.5 mr-1" /> Scan
                                </Button>
                              )}
                              {ride.status === "DISPATCHED" && !isReadOnly && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => {
                                    setReopenRideId(ride.id);
                                    setReopenReason("");
                                  }}
                                  data-testid={`button-reopen-ride-${ride.id}`}
                                >
                                  <RotateCcw className="w-3.5 h-3.5 mr-1" /> Reopen
                                </Button>
                              )}
                              {ride.status === "DISPATCHED" && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => navigate(`/factory/dispatch-batches/${batchId}/rides/${ride.id}/scan`)}
                                  data-testid={`button-view-scan-${ride.id}`}
                                >
                                  <Eye className="w-3.5 h-3.5 mr-1" /> View
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      {/* ── Scanned Bales Section (Developer only) ───────────────────────── */}
      {isDeveloper && (
        <Card className="mx-4 mb-4">
          <CardContent className="pt-3 pb-3">
            <button
              className="flex items-center gap-2 w-full text-sm font-medium text-left"
              onClick={() => setShowBales((v) => !v)}
              data-testid="button-toggle-bales"
            >
              <Package className="w-4 h-4 text-muted-foreground" />
              Scanned Bales
              {data &&
                (() => {
                  const tb = (data.articleTotals || []).reduce((s, a) => s + parseInt(String(a.scannedQty || 0)), 0);
                  const tw = (data.articleTotals || []).reduce((s, a) => s + parseFloat(a.scannedWeightKg || "0"), 0);
                  return (
                    <span className="text-xs text-muted-foreground font-normal ml-1">
                      ({tb} bales · {fmt(tw)} kg)
                    </span>
                  );
                })()}
              <span className="ml-auto text-muted-foreground">
                {showBales ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </span>
            </button>

            {showBales && (
              <div className="mt-3 border-t pt-3">
                {auditScans.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">No active bale scans found.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="text-xs">Ride #</TableHead>
                          <TableHead className="text-xs">Reference</TableHead>
                          <TableHead className="text-xs">Article</TableHead>
                          <TableHead className="text-xs">Product</TableHead>
                          <TableHead className="text-xs text-right">Weight (kg)</TableHead>
                          <TableHead className="text-xs text-right">Amount</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {auditScans
                          .filter((s) => !s.removedAt)
                          .map((s) => (
                            <TableRow key={s.id} data-testid={`row-scan-${s.id}`}>
                              <TableCell className="text-xs font-mono">#{s.rideNumber}</TableCell>
                              <TableCell className="text-xs font-mono font-medium">{s.baleReference}</TableCell>
                              <TableCell className="text-xs">{s.articleCode || "—"}</TableCell>
                              <TableCell className="text-xs text-muted-foreground">{s.productName || "—"}</TableCell>
                              <TableCell className="text-xs text-right font-mono">{fmt(s.weightKg, 3)}</TableCell>
                              <TableCell className="text-xs text-right font-mono">{fmt(s.amount)}</TableCell>
                            </TableRow>
                          ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Dialog open={addRideOpen} onOpenChange={setAddRideOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Truck Ride</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Truck Plate</Label>
              <Input
                placeholder="e.g. LEB-1234"
                value={rideForm.truckPlate}
                onChange={(e) => setRideForm((f) => ({ ...f, truckPlate: e.target.value }))}
                data-testid="input-truck-plate"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Driver Name</Label>
              <Input
                placeholder="Driver name"
                value={rideForm.driverName}
                onChange={(e) => setRideForm((f) => ({ ...f, driverName: e.target.value }))}
                data-testid="input-driver-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Destination</Label>
              <Input
                placeholder="Destination"
                value={rideForm.destination}
                onChange={(e) => setRideForm((f) => ({ ...f, destination: e.target.value }))}
                data-testid="input-ride-destination"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Notes</Label>
              <Textarea
                rows={2}
                value={rideForm.notes}
                onChange={(e) => setRideForm((f) => ({ ...f, notes: e.target.value }))}
                data-testid="textarea-ride-notes"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddRideOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => addRideMutation.mutate()}
              disabled={addRideMutation.isPending}
              data-testid="button-add-ride-submit"
            >
              {addRideMutation.isPending ? "Adding..." : "Add & Open Scanner"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Invoice Preview — {batch.batchNumber}</DialogTitle>
            <DialogDescription>Review all dispatched bales before generating the final invoice.</DialogDescription>
          </DialogHeader>

          {previewLoading ? (
            <div className="space-y-2 py-4">
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : preview ? (
            <div className="space-y-4">
              {preview.blockers.length > 0 && (
                <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950 dark:border-amber-800 p-3 space-y-1">
                  <p className="text-sm font-medium flex items-center gap-1.5 text-amber-800 dark:text-amber-200">
                    <AlertTriangle className="w-4 h-4" /> Cannot generate invoice yet
                  </p>
                  {preview.blockers.map((b, i) => (
                    <p key={i} className="text-sm text-amber-700 dark:text-amber-300">
                      {b}
                    </p>
                  ))}
                </div>
              )}

              {preview.proformaProgress.length > 0 && (
                <div>
                  <p className="text-sm font-medium mb-2">Proforma Progress</p>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Article</TableHead>
                        <TableHead>Product</TableHead>
                        <TableHead className="text-right">Target</TableHead>
                        <TableHead className="text-right">Scanned</TableHead>
                        <TableHead className="text-right">Remaining</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {preview.proformaProgress.map((p) => (
                        <TableRow key={p.articleCode}>
                          <TableCell className="font-mono text-sm">{p.articleCode}</TableCell>
                          <TableCell className="text-muted-foreground text-sm">{p.productName}</TableCell>
                          <TableCell className="text-right">{p.proformaQty}</TableCell>
                          <TableCell className="text-right">
                            <span className={p.scannedQty > p.proformaQty ? "text-amber-600 font-medium" : ""}>
                              {p.scannedQty}
                            </span>
                          </TableCell>
                          <TableCell className="text-right">
                            <span
                              className={p.remaining < 0 ? "text-amber-600" : p.remaining === 0 ? "text-green-600" : ""}
                            >
                              {p.remaining}
                            </span>
                          </TableCell>
                          <TableCell className="text-right">{fmt(p.totalAmount)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              <div>
                <p className="text-sm font-medium mb-2">Article Breakdown</p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Article</TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-right">Bales</TableHead>
                      <TableHead className="text-right">Weight (kg)</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.articleLines.map((a) => (
                      <TableRow key={a.articleCode}>
                        <TableCell className="font-mono text-sm">{a.articleCode}</TableCell>
                        <TableCell className="text-muted-foreground text-sm">{a.productName}</TableCell>
                        <TableCell className="text-right">{a.qty}</TableCell>
                        <TableCell className="text-right">{fmt(a.totalWeightKg)}</TableCell>
                        <TableCell className="text-right font-medium">{fmt(a.totalAmount)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="flex justify-between items-center bg-muted/40 rounded-md px-4 py-3 text-sm">
                <span className="text-muted-foreground">
                  {preview.totals?.totalBales || 0} bales · {fmt(preview.totals?.totalWeightKg || 0)} kg
                </span>
                <span className="font-bold text-base">
                  {batch.currency} {fmt(preview.totals?.grandTotal || 0)}
                </span>
              </div>

              {preview.canGenerate && (
                <div className="space-y-2">
                  <Label>Invoice Date</Label>
                  <Input
                    type="date"
                    value={invoiceDate}
                    onChange={(e) => setInvoiceDate(e.target.value)}
                    data-testid="input-invoice-date"
                  />
                </div>
              )}
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewOpen(false)}>
              Close
            </Button>
            {preview?.canGenerate && (
              <Button
                onClick={() => setGenerateOpen(true)}
                disabled={!preview.canGenerate}
                data-testid="button-generate-invoice-from-preview"
              >
                <FileText className="w-4 h-4 mr-1.5" /> Generate Invoice
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={generateOpen} onOpenChange={setGenerateOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Generate Final Invoice?</AlertDialogTitle>
            <AlertDialogDescription>
              This will create an invoice for <strong>{preview?.totals?.totalBales || 0} bales</strong> totalling{" "}
              <strong>
                {batch.currency} {fmt(preview?.totals?.grandTotal || 0)}
              </strong>
              . All scanned bales will be marked as SOLD. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => generateMutation.mutate()}
              disabled={generateMutation.isPending}
              data-testid="button-confirm-generate-invoice"
            >
              {generateMutation.isPending ? "Generating..." : "Yes, Generate Invoice"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel Dispatch Batch?</AlertDialogTitle>
            <AlertDialogDescription>
              All scanned bales will be returned to IN_STOCK. All truck rides will be cancelled. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Batch</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => cancelMutation.mutate()}
              disabled={cancelMutation.isPending}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-confirm-cancel-batch"
            >
              {cancelMutation.isPending ? "Cancelling..." : "Cancel Batch"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={!!reopenRideId}
        onOpenChange={(o) => {
          if (!o) {
            setReopenRideId(null);
            setReopenReason("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reopen Truck Ride</DialogTitle>
            <DialogDescription>Admin action. Provide a reason to reopen this dispatched ride.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>
              Reason <span className="text-destructive">*</span>
            </Label>
            <Textarea
              rows={3}
              placeholder="Reason for reopening..."
              value={reopenReason}
              onChange={(e) => setReopenReason(e.target.value)}
              data-testid="textarea-reopen-reason"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setReopenRideId(null);
                setReopenReason("");
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => reopenRideId && reopenRideMutation.mutate({ rideId: reopenRideId, reason: reopenReason })}
              disabled={!reopenReason.trim() || reopenRideMutation.isPending}
              data-testid="button-confirm-reopen-ride"
            >
              {reopenRideMutation.isPending ? "Reopening..." : "Reopen Ride"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
