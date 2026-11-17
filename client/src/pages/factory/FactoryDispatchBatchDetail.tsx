import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { BATCH_STATUS_CONFIG, fmt } from "./factorydispatchbatchdetail/utils";
import { RideStatusBadge } from "./factorydispatchbatchdetail/components/RideStatusBadge";
import { BatchInfoCard } from "./factorydispatchbatchdetail/components/BatchInfoCard";
import {
  FactoryDispatchBatchDetailDialogSection,
  FactoryDispatchBatchDetailDialogSection2,
  FactoryDispatchBatchDetailSection,
  useFactoryDispatchBatchDetailState,
} from "./useFactoryDispatchBatchDetailState";
import { EmptyState } from "@/components/ui/page-state";

export default function FactoryDispatchBatchDetail() {
  const {
    addRideMutation,
    addRideOpen,
    auditScans,
    batchId,
    cancelMutation,
    cancelOpen,
    data,
    error,
    formatDisplayDate,
    generateMutation,
    generateOpen,
    invoiceDate,
    isDeveloper,
    isError,
    isLoading,
    me,
    navigate,
    preview,
    previewLoading,
    previewOpen,
    recordChanges,
    reopenReason,
    reopenRideId,
    reopenRideMutation,
    rideForm,
    setAddRideOpen,
    setCancelOpen,
    setGenerateOpen,
    setInvoiceDate,
    setPreviewOpen,
    setReopenReason,
    setReopenRideId,
    setRideForm,
    setShowBales,
    showBales,
  } = useFactoryDispatchBatchDetailState();

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
  // Rides, cancel, reopen, scan and invoice generation all change this existing batch.
  const canChangeBatch = !isReadOnly && recordChanges.allowed;

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
              {canChangeBatch && (
                <Button variant="outline" onClick={() => setAddRideOpen(true)} data-testid="button-add-truck-ride">
                  <Plus className="w-4 h-4 mr-1" /> Add Truck Ride
                </Button>
              )}
              <Button variant="outline" onClick={() => setPreviewOpen(true)} data-testid="button-preview-invoice">
                <Eye className="w-4 h-4 mr-1" /> Preview Invoice
              </Button>
              {canChangeBatch && (
                <Button
                  variant="outline"
                  className="text-destructive"
                  onClick={() => setCancelOpen(true)}
                  data-testid="button-cancel-batch"
                >
                  Cancel Batch
                </Button>
              )}
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
            <BatchInfoCard batch={batch} customerName={customerName} proforma={proforma} finalInvoice={finalInvoice} />

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
                  {canChangeBatch && (
                    <Button size="sm" variant="outline" className="ml-auto" onClick={() => setAddRideOpen(true)}>
                      <Plus className="w-3.5 h-3.5 mr-1" /> Add
                    </Button>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {rides.length === 0 ? (
                  <EmptyState
                    icon={Truck}
                    title="No truck rides yet"
                    className="border-0"
                    action={
                      canChangeBatch ? (
                        <Button size="sm" variant="outline" onClick={() => setAddRideOpen(true)}>
                          <Plus className="w-4 h-4 mr-1" /> Add first ride
                        </Button>
                      ) : undefined
                    }
                  />
                ) : (
                  <Table mobileLayout="cards">
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
                              {(ride.status === "LOADING" || ride.status === "DRAFT") && canChangeBatch && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => navigate(`/factory/dispatch-batches/${batchId}/rides/${ride.id}/scan`)}
                                  data-testid={`button-open-scanner-${ride.id}`}
                                >
                                  <ScanLine className="w-3.5 h-3.5 mr-1" /> Scan
                                </Button>
                              )}
                              {ride.status === "DISPATCHED" && canChangeBatch && (
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

            {showBales && <FactoryDispatchBatchDetailSection auditScans={auditScans} />}
          </CardContent>
        </Card>
      )}

      <FactoryDispatchBatchDetailDialogSection
        addRideMutation={addRideMutation}
        addRideOpen={addRideOpen}
        rideForm={rideForm}
        setAddRideOpen={setAddRideOpen}
        setRideForm={setRideForm}
      />

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
                  <Table mobileLayout="cards">
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
                <Table mobileLayout="cards">
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
            {recordChanges.allowed && preview?.canGenerate && (
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

      <FactoryDispatchBatchDetailDialogSection2
        reopenReason={reopenReason}
        reopenRideId={reopenRideId}
        reopenRideMutation={reopenRideMutation}
        setReopenReason={setReopenReason}
        setReopenRideId={setReopenRideId}
      />
    </div>
  );
}
