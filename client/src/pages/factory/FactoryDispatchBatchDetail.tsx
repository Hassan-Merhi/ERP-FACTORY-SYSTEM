import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
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
  Package,
  Eye,
  FileText,
  AlertTriangle,
  ArrowLeft,
  ExternalLink,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { fmt } from "./factorydispatchbatchdetail/utils";
import {
  FactoryDispatchBatchDetailDialogSection,
  FactoryDispatchBatchDetailDialogSection2,
  FactoryDispatchBatchDetailSection,
} from "./useFactoryDispatchBatchDetailState";
import {
  useFactoryDispatchBatchDetailModel,
  deriveFactoryDispatchBatchDetailView,
} from "./FactoryDispatchBatchDetailModel";
import { FactoryDispatchBatchDetailBody } from "./FactoryDispatchBatchDetailBody";

export default function FactoryDispatchBatchDetail() {
  const bd = useFactoryDispatchBatchDetailModel();

  if (!bd.batchId) return null;

  if (bd.me && !bd.isDeveloper) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <p className="text-sm">Dispatch Batches is only available in Developer mode.</p>
      </div>
    );
  }

  if (bd.isLoading) {
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

  if (bd.isError || !bd.data) {
    return (
      <div className="p-6">
        <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
          <AlertTriangle className="w-8 h-8" />
          <p>{bd.error?.message || "Failed to load dispatch batch"}</p>
          <Button variant="outline" onClick={() => bd.navigate("/factory/dispatch-batches")}>
            <ArrowLeft className="w-4 h-4 mr-1" /> Back to list
          </Button>
        </div>
      </div>
    );
  }
  const view = deriveFactoryDispatchBatchDetailView({ bd: { ...bd, batchId: bd.batchId, data: bd.data } });
  const { finalInvoice } = view;

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono">{view.batch.batchNumber}</span>
            <Badge className={view.batchCfg.className}>{view.batchCfg.label}</Badge>
          </span>
        }
        subtitle={`${view.customerName || "—"} · ${bd.formatDisplayDate(view.batch.batchDate)}${view.batch.destination ? ` · ${view.batch.destination}` : ""}`}
      >
        <div className="flex flex-wrap gap-2">
          {!view.isReadOnly && (
            <>
              {view.canChangeBatch && (
                <Button variant="outline" onClick={() => bd.setAddRideOpen(true)} data-testid="button-add-truck-ride">
                  <Plus className="w-4 h-4 mr-1" /> Add Truck Ride
                </Button>
              )}
              <Button variant="outline" onClick={() => bd.setPreviewOpen(true)} data-testid="button-preview-invoice">
                <Eye className="w-4 h-4 mr-1" /> Preview Invoice
              </Button>
              {view.canChangeBatch && (
                <Button
                  variant="outline"
                  className="text-destructive"
                  onClick={() => bd.setCancelOpen(true)}
                  data-testid="button-cancel-batch"
                >
                  Cancel Batch
                </Button>
              )}
            </>
          )}
          {view.batch.status === "INVOICED" && finalInvoice && (
            <Button
              variant="outline"
              onClick={() => bd.navigate(`/factory/sales/invoices/${finalInvoice.id}`)}
              data-testid="button-view-invoice"
            >
              <ExternalLink className="w-4 h-4 mr-1" /> View Invoice {finalInvoice.invoiceNumber}
            </Button>
          )}
        </div>
      </PageHeader>

      <FactoryDispatchBatchDetailBody bd={bd} view={view} batchId={bd.batchId} />

      {/* ── Scanned Bales Section (Developer only) ───────────────────────── */}
      {bd.isDeveloper && (
        <Card className="mx-4 mb-4">
          <CardContent className="pt-3 pb-3">
            <button
              className="flex items-center gap-2 w-full text-sm font-medium text-left"
              onClick={() => bd.setShowBales((v) => !v)}
              data-testid="button-toggle-bales"
            >
              <Package className="w-4 h-4 text-muted-foreground" />
              Scanned Bales
              {bd.data &&
                (() => {
                  const tb = (bd.data.articleTotals || []).reduce((s, a) => s + parseInt(String(a.scannedQty || 0)), 0);
                  const tw = (bd.data.articleTotals || []).reduce(
                    (s, a) => s + parseFloat(a.scannedWeightKg || "0"),
                    0
                  );
                  return (
                    <span className="text-xs text-muted-foreground font-normal ml-1">
                      ({tb} bales · {fmt(tw)} kg)
                    </span>
                  );
                })()}
              <span className="ml-auto text-muted-foreground">
                {bd.showBales ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </span>
            </button>

            {bd.showBales && <FactoryDispatchBatchDetailSection auditScans={bd.auditScans} />}
          </CardContent>
        </Card>
      )}

      <FactoryDispatchBatchDetailDialogSection
        addRideMutation={bd.addRideMutation}
        addRideOpen={bd.addRideOpen}
        rideForm={bd.rideForm}
        setAddRideOpen={bd.setAddRideOpen}
        setRideForm={bd.setRideForm}
      />

      <Dialog open={bd.previewOpen} onOpenChange={bd.setPreviewOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Invoice Preview — {view.batch.batchNumber}</DialogTitle>
            <DialogDescription>Review all dispatched bales before generating the final invoice.</DialogDescription>
          </DialogHeader>

          {bd.previewLoading ? (
            <div className="space-y-2 py-4">
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : bd.preview ? (
            <div className="space-y-4">
              {bd.preview.blockers.length > 0 && (
                <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950 dark:border-amber-800 p-3 space-y-1">
                  <p className="text-sm font-medium flex items-center gap-1.5 text-amber-800 dark:text-amber-200">
                    <AlertTriangle className="w-4 h-4" /> Cannot generate invoice yet
                  </p>
                  {bd.preview.blockers.map((b, i) => (
                    <p key={i} className="text-sm text-amber-700 dark:text-amber-300">
                      {b}
                    </p>
                  ))}
                </div>
              )}

              {bd.preview.proformaProgress.length > 0 && (
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
                      {bd.preview.proformaProgress.map((p) => (
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
                    {bd.preview.articleLines.map((a) => (
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
                  {bd.preview.totals?.totalBales || 0} bales · {fmt(bd.preview.totals?.totalWeightKg || 0)} kg
                </span>
                <span className="font-bold text-base">
                  {view.batch.currency} {fmt(bd.preview.totals?.grandTotal || 0)}
                </span>
              </div>

              {bd.preview.canGenerate && (
                <div className="space-y-2">
                  <Label>Invoice Date</Label>
                  <Input
                    type="date"
                    value={bd.invoiceDate}
                    onChange={(e) => bd.setInvoiceDate(e.target.value)}
                    data-testid="input-invoice-date"
                  />
                </div>
              )}
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => bd.setPreviewOpen(false)}>
              Close
            </Button>
            {bd.recordChanges.allowed && bd.preview?.canGenerate && (
              <Button
                onClick={() => bd.setGenerateOpen(true)}
                disabled={!bd.preview.canGenerate}
                data-testid="button-generate-invoice-from-preview"
              >
                <FileText className="w-4 h-4 mr-1.5" /> Generate Invoice
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={bd.generateOpen} onOpenChange={bd.setGenerateOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Generate Final Invoice?</AlertDialogTitle>
            <AlertDialogDescription>
              This will create an invoice for <strong>{bd.preview?.totals?.totalBales || 0} bales</strong> totalling{" "}
              <strong>
                {view.batch.currency} {fmt(bd.preview?.totals?.grandTotal || 0)}
              </strong>
              . All scanned bales will be marked as SOLD. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => bd.generateMutation.mutate()}
              disabled={bd.generateMutation.isPending}
              data-testid="button-confirm-generate-invoice"
            >
              {bd.generateMutation.isPending ? "Generating..." : "Yes, Generate Invoice"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={bd.cancelOpen} onOpenChange={bd.setCancelOpen}>
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
              onClick={() => bd.cancelMutation.mutate()}
              disabled={bd.cancelMutation.isPending}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-confirm-cancel-batch"
            >
              {bd.cancelMutation.isPending ? "Cancelling..." : "Cancel Batch"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <FactoryDispatchBatchDetailDialogSection2
        reopenReason={bd.reopenReason}
        reopenRideId={bd.reopenRideId}
        reopenRideMutation={bd.reopenRideMutation}
        setReopenReason={bd.setReopenReason}
        setReopenRideId={bd.setReopenRideId}
      />
    </div>
  );
}
