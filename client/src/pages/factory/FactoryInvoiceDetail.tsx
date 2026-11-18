import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  FileSpreadsheet,
  FileText,
  ArrowLeft,
  Trash2,
  ClipboardCheck,
  CheckCircle,
  RefreshCw,
  RotateCcw,
  Hammer,
  ChevronDown,
  GitCompare,
  DollarSign,
  ScanLine,
  Truck,
  ExternalLink,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { FactoryInvoiceDetailDialog1 } from "./factoryinvoicedetail/components/FactoryInvoiceDetailDialog1";
import { FactoryInvoiceDetailDialog2 } from "./factoryinvoicedetail/components/FactoryInvoiceDetailDialog2";
import { FactoryInvoiceDetailDialog3 } from "./factoryinvoicedetail/components/FactoryInvoiceDetailDialog3";
import { FactoryInvoiceDetailDialog4 } from "./factoryinvoicedetail/components/FactoryInvoiceDetailDialog4";
import { FactoryInvoiceDetailDialog5 } from "./factoryinvoicedetail/components/FactoryInvoiceDetailDialog5";
import { FactoryInvoiceDetailFinalizeDialog } from "./factoryinvoicedetail/components/FactoryInvoiceDetailFinalizeDialog";
import { FactoryInvoiceAdminTotals } from "./factoryinvoicedetail/components/FactoryInvoiceAdminTotals";
import { useFactoryInvoiceDetailPageModel, deriveFactoryInvoiceView } from "./FactoryInvoiceDetailPageModel";
import { FactoryInvoiceChargesCard } from "./FactoryInvoiceChargesCard";
import { FactoryInvoiceLinesTable } from "./FactoryInvoiceLinesTable";

export default function FactoryInvoiceDetail() {
  const m = useFactoryInvoiceDetailPageModel();
  const { order } = m;

  if (m.isLoading) {
    return (
      <div className="flex flex-col h-full p-6 space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!order) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6">
        <p className="text-muted-foreground" data-testid="text-not-found">
          Invoice not found
        </p>
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => m.navigate(m.backTarget)}
          data-testid="button-back-to-list"
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Invoices
        </Button>
      </div>
    );
  }
  const v = deriveFactoryInvoiceView(order);

  return (
    <div className="flex flex-col h-full p-6 overflow-y-auto">
      <PageHeader
        title={<span data-testid="text-invoice-number">{order.invoiceNumber || `Order #${order.id}`}</span>}
        backTarget={m.backTarget}
        meta={
          <>
            {m.getStatusBadge(order.status)}
            <span data-testid="text-order-date">{order.orderDate ? m.formatDisplayDate(order.orderDate) : "-"}</span>
          </>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div className="flex flex-wrap gap-6">
          <div>
            <p className="text-sm text-muted-foreground">Customer</p>
            <p className="font-semibold text-lg" data-testid="text-customer-name">
              {order.customerName || "-"}
            </p>
          </div>
          {order.containerNumber && (
            <div>
              <p className="text-sm text-muted-foreground">Container No.</p>
              <p className="font-semibold font-mono" data-testid="text-container-number">
                {order.containerNumber}
              </p>
            </div>
          )}
          {order.shippingCompany && (
            <div>
              <p className="text-sm text-muted-foreground">Shipping</p>
              <p className="font-semibold" data-testid="text-shipping-company">
                {order.shippingCompany}
              </p>
            </div>
          )}
          {order.destination && (
            <div>
              <p className="text-sm text-muted-foreground">Destination</p>
              <p className="font-semibold" data-testid="text-destination">
                {order.destination}
              </p>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Primary context action */}
          {order.status === "DRAFT" && m.canChange && (
            <Button
              variant="outline"
              onClick={() => m.navigate(`/factory/sales/new?orderId=${order.id}`)}
              data-testid="button-continue-editing"
            >
              Continue Editing
            </Button>
          )}
          {(v.isPendingVerification || v.isVerifiedStatus || v.isLoadingStatus) && (
            <Button
              variant="outline"
              onClick={() => m.navigate(`/factory/sales/pending-invoices/${order.id}/verify`)}
              data-testid="button-go-to-verify"
            >
              {v.isPendingVerification ? (
                <>
                  <ClipboardCheck className="mr-2 h-4 w-4" />
                  View Verification
                </>
              ) : v.isVerifiedStatus ? (
                <>
                  <CheckCircle className="mr-2 h-4 w-4" />
                  Charges &amp; Finalize
                </>
              ) : (
                <>
                  <ClipboardCheck className="mr-2 h-4 w-4" />
                  View Loading
                </>
              )}
            </Button>
          )}
          {v.isFinalized && m.canChange && (
            <Button
              onClick={() => m.navigate(`/factory/invoices/${order.id}/loading-scan`)}
              data-testid="button-scan-loading"
            >
              <ScanLine className="mr-2 h-4 w-4" />
              Scan Loading
            </Button>
          )}

          {/* Actions dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" data-testid="button-actions-menu">
                Actions
                <ChevronDown className="ml-2 h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {m.isAdmin && (v.isLoadingStatus || v.isFinalized) && (
                <>
                  <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">View</DropdownMenuLabel>
                  <DropdownMenuItem
                    onClick={() => m.navigate(`/factory/sales/pending-invoices/${order.id}/verify`)}
                    data-testid="button-proforma-vs-loaded"
                  >
                    <GitCompare className="h-4 w-4" />
                    Proforma vs Loaded
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}

              {m.isAdmin && m.canChange && (
                <>
                  <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">Pricing</DropdownMenuLabel>
                  {order.status !== "CANCELLED" && (
                    <DropdownMenuItem
                      onClick={() => m.repriceProductionMutation.mutate()}
                      disabled={m.repriceProductionMutation.isPending}
                      data-testid="button-apply-production-prices"
                    >
                      <Hammer className={`h-4 w-4 ${m.repriceProductionMutation.isPending ? "animate-spin" : ""}`} />
                      Apply Production Prices
                    </DropdownMenuItem>
                  )}
                  {(v.isVerifiedStatus || v.isFinalized) && (
                    <DropdownMenuItem
                      onClick={() => m.repriceMutation.mutate()}
                      disabled={m.repriceMutation.isPending}
                      data-testid="button-apply-prices"
                    >
                      <RefreshCw className={`h-4 w-4 ${m.repriceMutation.isPending ? "animate-spin" : ""}`} />
                      Apply Selling Prices
                    </DropdownMenuItem>
                  )}
                  {order.status !== "CANCELLED" && (
                    <DropdownMenuItem
                      onClick={() => {
                        m.setSelectedProformaId("");
                        m.setShowProformaDialog(true);
                      }}
                      disabled={m.applyProformaMutation.isPending}
                      data-testid="button-apply-proforma-prices"
                    >
                      <DollarSign className="h-4 w-4" />
                      Apply Proforma Prices
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                </>
              )}

              <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">Export</DropdownMenuLabel>
              <DropdownMenuItem onClick={m.handleExportExcel} data-testid="button-export-excel">
                <FileSpreadsheet className="h-4 w-4" />
                Export Excel
              </DropdownMenuItem>
              <DropdownMenuItem onClick={m.handleExportExcelNoCharges} data-testid="button-export-excel-no-charges">
                <FileSpreadsheet className="h-4 w-4" />
                Export Excel (No Charges)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={m.handleExportPdf} data-testid="button-export-pdf">
                <FileText className="h-4 w-4" />
                Export PDF
              </DropdownMenuItem>
              <DropdownMenuItem onClick={m.handleExportPdfNoCharges} data-testid="button-export-pdf-no-charges">
                <FileText className="h-4 w-4" />
                Export PDF (No Charges)
              </DropdownMenuItem>
              {m.isAdmin && (
                <DropdownMenuItem onClick={m.handleExportLoadingStatus} data-testid="button-export-loading-status">
                  <FileSpreadsheet className="h-4 w-4" />
                  Export Excel (Loading Status)
                </DropdownMenuItem>
              )}

              {m.isAdmin &&
                m.canChange &&
                (v.isFinalized || order.status !== "FINALIZED") &&
                order.status !== "CANCELLED" && <DropdownMenuSeparator />}
              {m.isAdmin && m.canChange && v.isFinalized && (
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() => m.setRevertDialogOpen(true)}
                  data-testid="button-unfinalize"
                >
                  <RotateCcw className="h-4 w-4" />
                  Revert to Draft
                </DropdownMenuItem>
              )}
              {m.canChange && order.status !== "FINALIZED" && order.status !== "CANCELLED" && (
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() => m.setDeleteDialogOpen(true)}
                  data-testid="button-delete-invoice"
                >
                  <Trash2 className="h-4 w-4" />
                  Delete Invoice
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Controlled dialogs outside dropdown */}
        <FactoryInvoiceDetailDialog1 model={m.model} />

        <FactoryInvoiceDetailDialog2 model={m.model} />
      </div>

      {/* ── Dispatch Batch Info Card (Developer only) ───────────────────── */}
      {m.isDeveloper && order.dispatchBatchId && (
        <Card className="mb-4 border-blue-200 dark:border-blue-800">
          <CardContent className="pt-4 pb-3">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
              <div className="flex items-center gap-2">
                <Truck className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm font-semibold">Dispatch Batch</span>
                {m.dispatchBatch?.batch && (
                  <span className="font-mono font-bold">{m.dispatchBatch.batch.batchNumber}</span>
                )}
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => m.navigate(`/factory/dispatch-batches/${order.dispatchBatchId}`)}
                data-testid="button-view-dispatch-batch"
              >
                <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
                View Batch
              </Button>
            </div>
            {m.dispatchBatch ? (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-2 text-sm">
                {m.dispatchBatch.proforma && (
                  <div>
                    <p className="text-xs text-muted-foreground">Proforma</p>
                    <p>{m.dispatchBatch.proforma.name}</p>
                  </div>
                )}
                {m.dispatchBatch.customerName && (
                  <div>
                    <p className="text-xs text-muted-foreground">Customer</p>
                    <p>{m.dispatchBatch.customerName}</p>
                  </div>
                )}
                {m.dispatchBatch.totals && (
                  <>
                    <div>
                      <p className="text-xs text-muted-foreground">Total Bales</p>
                      <p className="font-mono font-medium">{m.dispatchBatch.totals.totalBales}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Rides</p>
                      <p>
                        {m.dispatchBatch.rides?.length || 0} truck{m.dispatchBatch.rides?.length !== 1 ? "s" : ""}
                      </p>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Loading batch info…</p>
            )}
          </CardContent>
        </Card>
      )}

      <FactoryInvoiceLinesTable m={m} v={v} order={order} />

      <FactoryInvoiceChargesCard m={m} v={v} />

      <Card className="p-4">
        <div className="space-y-2">
          {m.isAdmin && (
            <FactoryInvoiceAdminTotals
              viewWithoutCharges={m.viewWithoutCharges}
              subtotal={v.subtotal}
              totalCharges={v.totalCharges}
              grandTotal={v.grandTotal}
            />
          )}
          <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
            <span>Total Bales Qty</span>
            <span data-testid="text-total-bales-qty">{v.totalBalesQty}</span>
          </div>
          <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
            <span>Total Weight</span>
            <span className="font-mono" data-testid="text-total-weight-kg">
              {v.totalWeightKg.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })} kg
            </span>
          </div>
        </div>
      </Card>

      <FactoryInvoiceDetailDialog3 model={m.model} />

      {/* Bale References Dialog */}
      <FactoryInvoiceDetailFinalizeDialog model={m.model} isFinalized={v.isFinalized} />

      {/* Remove Bale Confirm Dialog */}
      <FactoryInvoiceDetailDialog4 model={m.model} />

      {/* Exchange Bale Dialog */}
      <FactoryInvoiceDetailDialog5 model={m.model} />
    </div>
  );
}
