import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  FileDown,
  FileSpreadsheet,
  ArrowLeft,
  Trash2,
  ClipboardCheck,
  CheckCircle,
  RefreshCw,
  Container,
  Pencil,
  RotateCcw,
  Hammer,
  ChevronDown,
  GitCompare,
  DollarSign,
  ScanLine,
  Truck,
  ExternalLink,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useFactoryInvoiceDetailModel } from "./factoryinvoicedetail/useFactoryInvoiceDetailModel";
import { FactoryInvoiceDetailDialog1 } from "./factoryinvoicedetail/components/FactoryInvoiceDetailDialog1";
import { FactoryInvoiceDetailDialog2 } from "./factoryinvoicedetail/components/FactoryInvoiceDetailDialog2";
import { FactoryInvoiceDetailDialog3 } from "./factoryinvoicedetail/components/FactoryInvoiceDetailDialog3";
import { FactoryInvoiceDetailDialog4 } from "./factoryinvoicedetail/components/FactoryInvoiceDetailDialog4";
import { FactoryInvoiceDetailDialog5 } from "./factoryinvoicedetail/components/FactoryInvoiceDetailDialog5";
import { FactoryInvoiceDetailFinalizeDialog } from "./factoryinvoicedetail/components/FactoryInvoiceDetailFinalizeDialog";

export default function FactoryInvoiceDetail() {
  const model = useFactoryInvoiceDetailModel();
  const {
    formatDisplayDate,
    navigate,
    editingArticleCode,
    editingChargeLedger,
    setEditingChargeLedger,
    editingChargeAmount,
    setEditingChargeAmount,
    chargeAmountInput,
    setChargeAmountInput,
    showAddCharge,
    setShowAddCharge,
    newChargeName,
    setNewChargeName,
    newChargeAmount,
    setNewChargeAmount,
    newChargeType,
    setNewChargeType,
    newChargeLedgerId,
    setNewChargeLedgerId,
    editValue,
    setEditValue,
    revertDialogOpen: _revertDialogOpen,
    setRevertDialogOpen,
    deleteDialogOpen: _deleteDialogOpen,
    setDeleteDialogOpen,
    baleRefArticle: _baleRefArticle,
    setBaleRefArticle,
    exchangeBale: _exchangeBale,
    setExchangeBale: _setExchangeBale,
    newRefInput: _newRefInput,
    setNewRefInput: _setNewRefInput,
    removeBaleState: _removeBaleState,
    setRemoveBaleState: _setRemoveBaleState,
    showProformaDialog: _showProformaDialog,
    setShowProformaDialog,
    selectedProformaId: _selectedProformaId,
    setSelectedProformaId,
    inputRef,
    orderId: _orderId,
    order,
    isLoading,
    ledgerAccounts,
    updateChargeLedgerMutation,
    addChargeMutation,
    relinkVouchersMutation,
    updateChargeAmountMutation,
    isDeveloper,
    proformas: _proformas,
    dispatchBatch,
    hideExportSelling,
    isAdmin,
    getStatusBadge,
    deleteMutation: _deleteMutation,
    repriceMutation,
    repriceArticleMutation,
    unfinalizeMutation: _unfinalizeMutation,
    repriceProductionMutation,
    applyProformaMutation,
    exchangeMutation: _exchangeMutation,
    removeBaleMutation: _removeBaleMutation,
    startEdit,
    commitEdit,
    cancelEdit,
    handleExportExcel,
    handleExportExcelNoCharges,
    handleExportPdf,
    handleExportPdfNoCharges,
    handleExportLoadingStatus,
  } = model;

  const viewWithoutCharges =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).get("view") === "no-charges";
  const backTarget = viewWithoutCharges ? "/factory/analytics" : "/factory/invoicing?tab=invoices";

  if (isLoading) {
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
          onClick={() => navigate(backTarget)}
          data-testid="button-back-to-list"
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Invoices
        </Button>
      </div>
    );
  }

  const sortedLines = [...(order.lines || [])].sort((a, b) => (a.baleName || "").localeCompare(b.baleName || ""));

  const freightCharges = (order.charges || []).filter((c) => c.chargeType === "FREIGHT");
  const otherCharges = (order.charges || []).filter((c) => c.chargeType !== "FREIGHT");

  const subtotal = parseFloat(order.subtotalBales || "0");
  const totalCharges = parseFloat(order.freightAmount || "0") + parseFloat(order.otherChargesTotal || "0");
  const grandTotal = parseFloat(order.grandTotal || "0");
  const totalBalesQty = sortedLines.reduce((sum, line) => sum + (line.qty || 0), 0);
  const totalWeightKg = sortedLines.reduce((sum, line) => sum + (Number(line.totalWeight) || 0), 0);

  const isPendingVerification = order.status === "PENDING_VERIFICATION";
  const isVerifiedStatus = order.status === "VERIFIED";
  const isLoadingStatus = order.status === "LOADING";
  const isFinalized = order.status === "FINALIZED";

  return (
    <div className="flex flex-col h-full p-6 overflow-y-auto">
      <div className="flex flex-wrap items-center gap-2 mb-6">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate(backTarget)}
          data-testid="button-back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl sm:text-3xl font-bold" data-testid="text-invoice-number">
              {order.invoiceNumber || `Order #${order.id}`}
            </h1>
            {getStatusBadge(order.status)}
          </div>
          <p className="text-muted-foreground text-sm mt-1" data-testid="text-order-date">
            {order.orderDate ? formatDisplayDate(order.orderDate) : "-"}
          </p>
        </div>
      </div>

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
          {order.status === "DRAFT" && (
            <Button
              variant="outline"
              onClick={() => navigate(`/factory/sales/new?orderId=${order.id}`)}
              data-testid="button-continue-editing"
            >
              Continue Editing
            </Button>
          )}
          {(isPendingVerification || isVerifiedStatus || isLoadingStatus) && (
            <Button
              variant="outline"
              onClick={() => navigate(`/factory/sales/pending-invoices/${order.id}/verify`)}
              data-testid="button-go-to-verify"
            >
              {isPendingVerification ? (
                <>
                  <ClipboardCheck className="mr-2 h-4 w-4" />
                  View Verification
                </>
              ) : isVerifiedStatus ? (
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
          {isFinalized && (
            <Button
              onClick={() => navigate(`/factory/invoices/${order.id}/loading-scan`)}
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
              {isAdmin && (isLoadingStatus || isFinalized) && (
                <>
                  <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">View</DropdownMenuLabel>
                  <DropdownMenuItem
                    onClick={() => navigate(`/factory/sales/pending-invoices/${order.id}/verify`)}
                    data-testid="button-proforma-vs-loaded"
                  >
                    <GitCompare className="h-4 w-4" />
                    Proforma vs Loaded
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}

              {isAdmin && (
                <>
                  <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">Pricing</DropdownMenuLabel>
                  {order.status !== "CANCELLED" && (
                    <DropdownMenuItem
                      onClick={() => repriceProductionMutation.mutate()}
                      disabled={repriceProductionMutation.isPending}
                      data-testid="button-apply-production-prices"
                    >
                      <Hammer className={`h-4 w-4 ${repriceProductionMutation.isPending ? "animate-spin" : ""}`} />
                      Apply Production Prices
                    </DropdownMenuItem>
                  )}
                  {(isVerifiedStatus || isFinalized) && (
                    <DropdownMenuItem
                      onClick={() => repriceMutation.mutate()}
                      disabled={repriceMutation.isPending}
                      data-testid="button-apply-prices"
                    >
                      <RefreshCw className={`h-4 w-4 ${repriceMutation.isPending ? "animate-spin" : ""}`} />
                      Apply Selling Prices
                    </DropdownMenuItem>
                  )}
                  {order.status !== "CANCELLED" && (
                    <DropdownMenuItem
                      onClick={() => {
                        setSelectedProformaId("");
                        setShowProformaDialog(true);
                      }}
                      disabled={applyProformaMutation.isPending}
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
              <DropdownMenuItem onClick={handleExportExcel} data-testid="button-export-excel">
                <FileSpreadsheet className="h-4 w-4" />
                Download Excel
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleExportExcelNoCharges} data-testid="button-export-excel-no-charges">
                <FileSpreadsheet className="h-4 w-4" />
                Download Excel (No Charges)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleExportPdf} data-testid="button-export-pdf">
                <FileDown className="h-4 w-4" />
                Download PDF
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleExportPdfNoCharges} data-testid="button-export-pdf-no-charges">
                <FileDown className="h-4 w-4" />
                Download PDF (No Charges)
              </DropdownMenuItem>
              {isAdmin && (
                <DropdownMenuItem onClick={handleExportLoadingStatus} data-testid="button-export-loading-status">
                  <Container className="h-4 w-4" />
                  Loading Status
                </DropdownMenuItem>
              )}

              {isAdmin && (isFinalized || order.status !== "FINALIZED") && order.status !== "CANCELLED" && (
                <DropdownMenuSeparator />
              )}
              {isAdmin && isFinalized && (
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() => setRevertDialogOpen(true)}
                  data-testid="button-unfinalize"
                >
                  <RotateCcw className="h-4 w-4" />
                  Revert to Draft
                </DropdownMenuItem>
              )}
              {order.status !== "FINALIZED" && order.status !== "CANCELLED" && (
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() => setDeleteDialogOpen(true)}
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
        <FactoryInvoiceDetailDialog1 model={model} />

        <FactoryInvoiceDetailDialog2 model={model} />
      </div>

      {/* ── Dispatch Batch Info Card (Developer only) ───────────────────── */}
      {isDeveloper && order.dispatchBatchId && (
        <Card className="mb-4 border-blue-200 dark:border-blue-800">
          <CardContent className="pt-4 pb-3">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
              <div className="flex items-center gap-2">
                <Truck className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm font-semibold">Dispatch Batch</span>
                {dispatchBatch?.batch && <span className="font-mono font-bold">{dispatchBatch.batch.batchNumber}</span>}
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => navigate(`/factory/dispatch-batches/${order.dispatchBatchId}`)}
                data-testid="button-view-dispatch-batch"
              >
                <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
                View Batch
              </Button>
            </div>
            {dispatchBatch ? (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-2 text-sm">
                {dispatchBatch.proforma && (
                  <div>
                    <p className="text-xs text-muted-foreground">Proforma</p>
                    <p>{dispatchBatch.proforma.name}</p>
                  </div>
                )}
                {dispatchBatch.customerName && (
                  <div>
                    <p className="text-xs text-muted-foreground">Customer</p>
                    <p>{dispatchBatch.customerName}</p>
                  </div>
                )}
                {dispatchBatch.totals && (
                  <>
                    <div>
                      <p className="text-xs text-muted-foreground">Total Bales</p>
                      <p className="font-mono font-medium">{dispatchBatch.totals.totalBales}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Rides</p>
                      <p>
                        {dispatchBatch.rides?.length || 0} truck{dispatchBatch.rides?.length !== 1 ? "s" : ""}
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

      <Card className="mb-6">
        <Table wrapperClassName="max-h-[calc(100vh-260px)] overflow-auto">
          <TableHeader className="sticky top-0 z-30 bg-background">
            <TableRow>
              <TableHead className="w-[50px]">#</TableHead>
              <TableHead>Article Code</TableHead>
              <TableHead>Bale Name</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Weight/Bale</TableHead>
              <TableHead className="text-right">Total Weight</TableHead>
              {isAdmin &&
                (() => {
                  const anyPerKg = sortedLines.some((l) => l.pricingMode === "per_kg");
                  return (
                    <TableHead className={`text-right${hideExportSelling ? " print:hidden" : ""}`}>
                      {anyPerKg ? "Price/KG" : "Price/Bale"}
                      {(isVerifiedStatus || order.status === "FINALIZED") && (
                        <Pencil className="inline ml-1 h-3 w-3 text-muted-foreground" />
                      )}
                    </TableHead>
                  );
                })()}
              {isAdmin && (
                <TableHead className={`text-right${hideExportSelling ? " print:hidden" : ""}`}>Total Price</TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedLines.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={isAdmin ? 8 : 6}
                  className="text-center text-muted-foreground py-6"
                  data-testid="text-no-lines"
                >
                  No order lines
                </TableCell>
              </TableRow>
            ) : (
              sortedLines.map((line, idx) => (
                <TableRow key={`${line.articleCode ?? ""}-${idx}`} data-testid={`row-line-${idx}`}>
                  <TableCell className="text-muted-foreground">{idx + 1}</TableCell>
                  <TableCell className="font-mono text-sm" data-testid={`text-article-code-${idx}`}>
                    {line.articleCode}
                  </TableCell>
                  <TableCell data-testid={`text-bale-name-${idx}`}>
                    <button
                      className="text-left hover-elevate rounded-md px-1 -mx-1 py-0.5 font-medium underline-offset-2 hover:underline"
                      onClick={() => setBaleRefArticle({ code: line.articleCode, name: line.baleName })}
                      data-testid={`button-bale-refs-${idx}`}
                      title="Click to see all reference numbers"
                    >
                      {line.baleName}
                    </button>
                  </TableCell>
                  <TableCell className="text-right font-mono" data-testid={`text-qty-${idx}`}>
                    {line.qty}
                  </TableCell>
                  <TableCell className="text-right font-mono" data-testid={`text-weight-per-bale-${idx}`}>
                    {Number(line.weightPerBale || 0).toLocaleString(undefined, {
                      minimumFractionDigits: 0,
                      maximumFractionDigits: 2,
                    })}
                  </TableCell>
                  <TableCell className="text-right font-mono" data-testid={`text-total-weight-${idx}`}>
                    {Number(line.totalWeight || 0).toLocaleString(undefined, {
                      minimumFractionDigits: 0,
                      maximumFractionDigits: 2,
                    })}
                  </TableCell>
                  {isAdmin &&
                    (() => {
                      const isPerKg = line.pricingMode === "per_kg";
                      const pkgRateInv = line.pricePerKg || 0;
                      const displayRate = isPerKg
                        ? Number(line.totalPrice) > 0 && Number(line.totalWeight) > 0
                          ? Number(line.totalPrice) / Number(line.totalWeight)
                          : pkgRateInv
                        : Number(line.pricePerBale || 0);
                      return (
                        <TableCell
                          className={`text-right font-mono${hideExportSelling ? " print:hidden" : ""}`}
                          data-testid={`text-price-per-bale-${idx}`}
                        >
                          {(isVerifiedStatus || order.status === "FINALIZED") && !isPerKg ? (
                            editingArticleCode === line.articleCode ? (
                              <Input
                                ref={inputRef}
                                type="number"
                                min="0"
                                step="any"
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") commitEdit(line.articleCode);
                                  if (e.key === "Escape") cancelEdit();
                                }}
                                onBlur={() => commitEdit(line.articleCode)}
                                className="h-7 w-28 text-right font-mono p-1 ml-auto"
                                disabled={repriceArticleMutation.isPending}
                                data-testid={`input-price-${idx}`}
                              />
                            ) : (
                              <button
                                onClick={() => startEdit(line.articleCode, line.pricePerBale)}
                                className="group flex items-center justify-end gap-1 w-full hover-elevate rounded-md px-1 py-0.5"
                                data-testid={`button-edit-price-${idx}`}
                                title="Click to edit price"
                              >
                                <span>
                                  {displayRate.toLocaleString(undefined, {
                                    minimumFractionDigits: 0,
                                    maximumFractionDigits: 4,
                                  })}
                                </span>
                                <Pencil className="h-3 w-3 text-muted-foreground invisible group-hover:visible" />
                              </button>
                            )
                          ) : (
                            displayRate.toLocaleString(undefined, {
                              minimumFractionDigits: 0,
                              maximumFractionDigits: 4,
                            })
                          )}
                        </TableCell>
                      );
                    })()}
                  {isAdmin && (
                    <TableCell
                      className={`text-right font-mono font-semibold${hideExportSelling ? " print:hidden" : ""}`}
                      data-testid={`text-total-price-${idx}`}
                    >
                      {Number(line.totalPrice || 0).toLocaleString(undefined, {
                        minimumFractionDigits: 0,
                        maximumFractionDigits: 2,
                      })}
                    </TableCell>
                  )}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      {isAdmin && !viewWithoutCharges && (freightCharges.length > 0 || otherCharges.length > 0 || isFinalized) && (
        <Card className={`p-4 mb-6${hideExportSelling ? " print:hidden" : ""}`}>
          <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
            <h3 className="font-semibold" data-testid="text-charges-header">
              Freight &amp; Charges
            </h3>
            {isFinalized && [...freightCharges, ...otherCharges].some((c) => !c.voucherId) && (
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
          <div className="space-y-3">
            {[...freightCharges, ...otherCharges].map((charge, idx) => {
              const linkedAccount = ledgerAccounts.find((a) => a.id === charge.ledgerAccountId);
              const isEditingLedger = editingChargeLedger === charge.id;
              const isEditingAmount = editingChargeAmount === charge.id;
              const canEditAmount = isFinalized && !!charge.voucherId;
              return (
                <div key={charge.id} className="space-y-1" data-testid={`row-charge-${idx}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm">{charge.name}</span>
                    {isEditingAmount ? (
                      <div className="flex items-center gap-1 print:hidden">
                        <Input
                          type="number"
                          className="h-7 w-28 text-xs text-right font-mono"
                          value={chargeAmountInput}
                          onChange={(e) => setChargeAmountInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              const val = parseFloat(chargeAmountInput);
                              if (!isNaN(val) && val >= 0)
                                updateChargeAmountMutation.mutate({ chargeId: charge.id, amount: val });
                            }
                            if (e.key === "Escape") {
                              setEditingChargeAmount(null);
                              setChargeAmountInput("");
                            }
                          }}
                          autoFocus
                          data-testid={`input-charge-amount-${charge.id}`}
                        />
                        <Button
                          size="sm"
                          variant="default"
                          className="h-7 text-xs px-2"
                          disabled={updateChargeAmountMutation.isPending}
                          onClick={() => {
                            const val = parseFloat(chargeAmountInput);
                            if (!isNaN(val) && val >= 0)
                              updateChargeAmountMutation.mutate({ chargeId: charge.id, amount: val });
                          }}
                          data-testid={`button-save-charge-amount-${charge.id}`}
                        >
                          Save
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs px-2"
                          onClick={() => {
                            setEditingChargeAmount(null);
                            setChargeAmountInput("");
                          }}
                          data-testid={`button-cancel-charge-amount-${charge.id}`}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1">
                        <span className="font-mono text-sm" data-testid={`text-charge-amount-${charge.id}`}>
                          {Number(charge.amount || 0).toLocaleString(undefined, {
                            minimumFractionDigits: 0,
                            maximumFractionDigits: 2,
                          })}
                        </span>
                        {canEditAmount && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6 print:hidden"
                            onClick={() => {
                              setEditingChargeAmount(charge.id);
                              setChargeAmountInput(charge.amount);
                            }}
                            data-testid={`button-edit-charge-amount-${charge.id}`}
                          >
                            <Pencil className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                  {isEditingLedger ? (
                    <div className="flex items-center gap-2 print:hidden">
                      <Select
                        value={String(charge.ledgerAccountId ?? "")}
                        onValueChange={(val) =>
                          updateChargeLedgerMutation.mutate({
                            chargeId: charge.id,
                            ledgerAccountId: val ? parseInt(val) : null,
                          })
                        }
                      >
                        <SelectTrigger className="h-8 text-xs flex-1" data-testid={`select-charge-ledger-${charge.id}`}>
                          <SelectValue placeholder="Select ledger account..." />
                        </SelectTrigger>
                        <SelectContent>
                          {ledgerAccounts.map((acc) => (
                            <SelectItem key={acc.id} value={String(acc.id)}>
                              {acc.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditingChargeLedger(null)}
                        data-testid={`button-cancel-charge-ledger-${charge.id}`}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 print:hidden">
                      {linkedAccount ? (
                        <Badge variant="secondary" className="text-xs">
                          {linkedAccount.name}
                        </Badge>
                      ) : (
                        <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">
                          No ledger account — not posted
                        </span>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-xs px-2"
                        onClick={() => setEditingChargeLedger(charge.id)}
                        data-testid={`button-edit-charge-ledger-${charge.id}`}
                      >
                        <Pencil className="h-3 w-3 mr-1" />
                        Link
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {isFinalized && (
            <div className="mt-3 pt-3 border-t print:hidden">
              {showAddCharge ? (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      placeholder="Charge name"
                      value={newChargeName}
                      onChange={(e) => setNewChargeName(e.target.value)}
                      className="text-sm"
                      data-testid="input-new-charge-name"
                    />
                    <Input
                      type="number"
                      placeholder="Amount"
                      value={newChargeAmount}
                      onChange={(e) => setNewChargeAmount(e.target.value)}
                      className="text-sm font-mono"
                      data-testid="input-new-charge-amount"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Select value={newChargeType} onValueChange={setNewChargeType}>
                      <SelectTrigger className="text-sm" data-testid="select-new-charge-type">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="FREIGHT">Freight</SelectItem>
                        <SelectItem value="CLEARANCE">Clearance</SelectItem>
                        <SelectItem value="OTHER">Other</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select value={newChargeLedgerId} onValueChange={setNewChargeLedgerId}>
                      <SelectTrigger className="text-sm" data-testid="select-new-charge-ledger">
                        <SelectValue placeholder="Ledger account..." />
                      </SelectTrigger>
                      <SelectContent>
                        {ledgerAccounts.map((acc) => (
                          <SelectItem key={acc.id} value={String(acc.id)}>
                            {acc.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <p className="text-xs text-muted-foreground">Saving will immediately post an accounting voucher.</p>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="default"
                      disabled={
                        addChargeMutation.isPending || !newChargeName.trim() || !newChargeAmount || !newChargeLedgerId
                      }
                      onClick={() => {
                        const amt = parseFloat(newChargeAmount);
                        if (isNaN(amt) || amt <= 0) return;
                        addChargeMutation.mutate({
                          name: newChargeName.trim(),
                          amount: amt,
                          chargeType: newChargeType,
                          ledgerAccountId: newChargeLedgerId ? parseInt(newChargeLedgerId) : null,
                        });
                      }}
                      data-testid="button-save-new-charge"
                    >
                      {addChargeMutation.isPending ? "Saving..." : "Save Charge"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setShowAddCharge(false);
                        setNewChargeName("");
                        setNewChargeAmount("");
                        setNewChargeType("FREIGHT");
                        setNewChargeLedgerId("");
                      }}
                      data-testid="button-cancel-new-charge"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-xs"
                  onClick={() => setShowAddCharge(true)}
                  data-testid="button-add-charge"
                >
                  <Pencil className="h-3 w-3 mr-1" />
                  Add Charge
                </Button>
              )}
            </div>
          )}
        </Card>
      )}

      <Card className="p-4">
        <div className="space-y-2">
          {isAdmin &&
            (viewWithoutCharges ? (
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">Invoice Total (No Charges)</span>
                <span className="font-mono font-bold text-lg" data-testid="text-no-charges-total">
                  {subtotal.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
                </span>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span>Subtotal (Bales)</span>
                  <span className="font-mono" data-testid="text-subtotal">
                    {subtotal.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span>Total Charges</span>
                  <span className="font-mono" data-testid="text-total-charges">
                    {totalCharges.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
                  </span>
                </div>
                <div className="border-t pt-2 flex items-center justify-between gap-2">
                  <span className="font-semibold">Grand Total</span>
                  <span className="font-mono font-bold text-lg" data-testid="text-grand-total">
                    {grandTotal.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
                  </span>
                </div>
              </>
            ))}
          <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
            <span>Total Bales Qty</span>
            <span data-testid="text-total-bales-qty">{totalBalesQty}</span>
          </div>
          <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
            <span>Total Weight</span>
            <span className="font-mono" data-testid="text-total-weight-kg">
              {totalWeightKg.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })} kg
            </span>
          </div>
        </div>
      </Card>

      <FactoryInvoiceDetailDialog3 model={model} />

      {/* Bale References Dialog */}
      <FactoryInvoiceDetailFinalizeDialog model={model} isFinalized={isFinalized} />

      {/* Remove Bale Confirm Dialog */}
      <FactoryInvoiceDetailDialog4 model={model} />

      {/* Exchange Bale Dialog */}
      <FactoryInvoiceDetailDialog5 model={model} />
    </div>
  );
}
