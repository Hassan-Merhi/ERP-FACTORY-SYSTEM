import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronsUpDown,
  RotateCcw,
  Ship,
  Truck,
  AlertTriangle,
  CheckCircle,
  Package,
  Trash2,
  Plus,
  Wrench,
  RefreshCw,
  FileText,
  Container,
  DollarSign,
  FileDown,
  FileSpreadsheet,
  GitCompare,
  Hammer,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtNum } from "./factorypendinginvoiceverify/utils";
import { useFactoryPendingInvoiceVerifyModel } from "./factorypendinginvoiceverify/useFactoryPendingInvoiceVerifyModel";
import { FactoryPendingInvoiceVerifyDialog1 } from "./factorypendinginvoiceverify/components/FactoryPendingInvoiceVerifyDialog1";
import { FactoryPendingInvoiceVerifyDialog2 } from "./factorypendinginvoiceverify/components/FactoryPendingInvoiceVerifyDialog2";
import { FactoryPendingInvoiceVerifyDialog3 } from "./factorypendinginvoiceverify/components/FactoryPendingInvoiceVerifyDialog3";
import { FactoryPendingInvoiceVerifyDialog4 } from "./factorypendinginvoiceverify/components/FactoryPendingInvoiceVerifyDialog4";
import { FactoryPendingInvoiceVerifyDialog5 } from "./factorypendinginvoiceverify/components/FactoryPendingInvoiceVerifyDialog5";
import { FactoryPendingInvoiceVerifyDialog6 } from "./factorypendinginvoiceverify/components/FactoryPendingInvoiceVerifyDialog6";
import { FactoryPendingInvoiceVerifyDialog7 } from "./factorypendinginvoiceverify/components/FactoryPendingInvoiceVerifyDialog7";
import { FactoryPendingInvoiceVerifyDetailCard } from "./factorypendinginvoiceverify/components/FactoryPendingInvoiceVerifyDetailCard";

export default function FactoryPendingInvoiceVerify() {
  const model = useFactoryPendingInvoiceVerifyModel();
  const {
    navigate,
    orderId,
    containerNumber,
    setContainerNumber,
    shippingCompany,
    setShippingCompany,
    containerNotes,
    setContainerNotes,
    destination,
    setDestination,
    chargeName,
    setChargeName,
    chargeAmount,
    setChargeAmount,
    chargeType,
    setChargeType,
    chargeLedgerAccountId,
    setChargeLedgerAccountId,
    chargeAccountOpen,
    setChargeAccountOpen,
    showApproveDialog: _showApproveDialog,
    setShowApproveDialog,
    showReturnDialog: _showReturnDialog,
    setShowReturnDialog,
    approveNotes: _approveNotes,
    setApproveNotes: _setApproveNotes,
    showFinalizePreview: _showFinalizePreview,
    setShowFinalizePreview: _setShowFinalizePreview,
    finalizePreview: _finalizePreview,
    setFinalizePreview: _setFinalizePreview,
    previewLoading,
    showPriceWarning: _showPriceWarning,
    setShowPriceWarning: _setShowPriceWarning,
    unpricedItems: _unpricedItems,
    pendingFinalizeData: _pendingFinalizeData,
    showFixBalesDialog: _showFixBalesDialog,
    setShowFixBalesDialog,
    invoiceDate: _invoiceDate,
    setInvoiceDate: _setInvoiceDate,
    showProformaDialog: _showProformaDialog,
    setShowProformaDialog,
    showViewProformaDialog,
    setShowViewProformaDialog,
    selectedProformaId: _selectedProformaId,
    setSelectedProformaId,
    statusFilter: _statusFilter,
    setStatusFilter: _setStatusFilter,
    showRecoverDialog: _showRecoverDialog,
    setShowRecoverDialog,
    recoverInput: _recoverInput,
    setRecoverInput: _setRecoverInput,
    recoverTab: _recoverTab,
    setRecoverTab: _setRecoverTab,
    verification,
    verificationLoading,
    orderDetail,
    currentUser,
    isAdminOrOwner,
    isDeveloper,
    ledgerAccounts,
    proformas,
    verifyMutation,
    returnToLoadingMutation,
    assignContainerMutation,
    addChargeMutation,
    removeChargeMutation,
    finalizeMutation,
    forceSyncMutation,
    recoverBalesMutation: _recoverBalesMutation,
    autoRecoverMutation: _autoRecoverMutation,
    applyProformaMutation,
    applyProductionPricesMutation,
    applySellingPricesMutation,
    fetchFinalizePreview,
    handleAddCharge,
    getStatusBadge: _getStatusBadge,
    isLoading,
    charges,
    isPending,
    isVerified,
    isLoadingStatus,
    totalNotLoadedBales,
    totalNotLoadedWeight,
    handleExportExcel,
    handleExportExcelNoCharges,
    handleExportPdf,
    handleExportPdfNoCharges,
    handleExportLoadingStatus,
  } = model;

  if (isLoading) {
    return (
      <div className="flex flex-col h-full p-6">
        <Skeleton className="h-10 w-64 mb-4" />
        <div className="grid grid-cols-2 gap-4 mb-4">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
        <Skeleton className="h-96" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full p-4 lg:p-6 overflow-y-auto">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate("/factory/invoicing?tab=invoices")}
            data-testid="button-back"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-page-title">
              Verify Order #{orderId}
            </h1>
            <p className="text-muted-foreground text-sm">Review loaded bales against proforma</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5" data-testid="button-verification-actions">
                Actions
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {isVerified ? (
                <>
                  <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">View</DropdownMenuLabel>
                  <DropdownMenuItem
                    onClick={() => navigate(`/factory/sales/pending-invoices/${orderId}/verify`)}
                    data-testid="menu-proforma-vs-loaded"
                  >
                    <GitCompare className="h-4 w-4" />
                    Proforma vs Loaded
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setShowViewProformaDialog(true)} data-testid="menu-view-proforma">
                    <FileText className="h-4 w-4" />
                    View Proforma
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />

                  {isAdminOrOwner && (
                    <>
                      <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">Pricing</DropdownMenuLabel>
                      <DropdownMenuItem
                        onClick={() => applyProductionPricesMutation.mutate()}
                        disabled={applyProductionPricesMutation.isPending}
                        data-testid="menu-apply-production-prices"
                      >
                        <Hammer
                          className={`h-4 w-4 ${applyProductionPricesMutation.isPending ? "animate-spin" : ""}`}
                        />
                        Apply Production Prices
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => applySellingPricesMutation.mutate()}
                        disabled={applySellingPricesMutation.isPending}
                        data-testid="menu-apply-selling-prices"
                      >
                        <RefreshCw
                          className={`h-4 w-4 ${applySellingPricesMutation.isPending ? "animate-spin" : ""}`}
                        />
                        Apply Selling Prices
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => {
                          setSelectedProformaId("");
                          setShowProformaDialog(true);
                        }}
                        disabled={applyProformaMutation.isPending}
                        data-testid="menu-apply-proforma-prices"
                      >
                        <DollarSign className="h-4 w-4" />
                        Apply Proforma Prices
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                    </>
                  )}

                  <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">Export</DropdownMenuLabel>
                  <DropdownMenuItem onClick={handleExportExcel} data-testid="menu-export-excel">
                    <FileSpreadsheet className="h-4 w-4" />
                    Download Excel
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleExportExcelNoCharges} data-testid="menu-export-excel-no-charges">
                    <FileSpreadsheet className="h-4 w-4" />
                    Download Excel (No Charges)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleExportPdf} data-testid="menu-export-pdf">
                    <FileDown className="h-4 w-4" />
                    Download PDF
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleExportPdfNoCharges} data-testid="menu-export-pdf-no-charges">
                    <FileDown className="h-4 w-4" />
                    Download PDF (No Charges)
                  </DropdownMenuItem>
                  {isAdminOrOwner && (
                    <DropdownMenuItem onClick={handleExportLoadingStatus} data-testid="menu-export-loading-status">
                      <Container className="h-4 w-4" />
                      Loading Status
                    </DropdownMenuItem>
                  )}

                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onSelect={() => setShowReturnDialog(true)}
                    disabled={returnToLoadingMutation.isPending}
                    data-testid="menu-return-to-loading"
                  >
                    <RotateCcw className="h-4 w-4" />
                    Return to Loading
                  </DropdownMenuItem>
                </>
              ) : (
                <>
                  <DropdownMenuItem
                    onClick={() => setShowReturnDialog(true)}
                    disabled={returnToLoadingMutation.isPending}
                    data-testid="menu-return-to-loading"
                  >
                    <RotateCcw className="mr-2 h-4 w-4" />
                    Return to Loading
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setShowViewProformaDialog(true)} data-testid="menu-view-proforma">
                    <FileText className="mr-2 h-4 w-4" />
                    View Proforma
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          {isLoadingStatus && (
            <Badge
              variant="outline"
              className="border-blue-300 text-blue-700 dark:border-blue-600 dark:text-blue-400"
              data-testid="badge-order-status"
            >
              Loading
            </Badge>
          )}
          {isVerified && (
            <Badge
              variant="outline"
              className="bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800"
              data-testid="badge-order-status"
            >
              Verified
            </Badge>
          )}
        </div>
      </div>

      {/* Fallback notice — shown only to Developer role when bale records are missing but order lines cover the data */}
      {!verificationLoading && verification?.dataSource === "order_lines" && currentUser?.role === "Developer" && (
        <div
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/40 p-4"
          data-testid="panel-order-lines-fallback"
        >
          <div className="flex items-start gap-3">
            <Package className="h-5 w-5 text-blue-600 dark:text-blue-400 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-blue-800 dark:text-blue-200">
                Bale counts sourced from order summary
              </p>
              <p className="text-xs text-blue-700 dark:text-blue-300 mt-0.5">
                Individual bale scan records are unavailable, but per-article totals are intact. All counts and weights
                shown are accurate. If you need individual bale-level detail, use <strong>Recover Bales</strong>.
              </p>
            </div>
          </div>
          {isAdminOrOwner && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowRecoverDialog(true)}
              className="border-blue-300 dark:border-blue-700 text-blue-800 dark:text-blue-200"
              data-testid="button-recover-bales-from-notice"
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Recover Bales
            </Button>
          )}
        </div>
      )}

      {/* Recovery banner — shown when the order has 0 linked bales, no fallback, and the user is admin */}
      {!verificationLoading &&
        (verification?.totalLoadedBales ?? 0) === 0 &&
        verification?.dataSource !== "order_lines" &&
        isAdminOrOwner && (
          <div
            className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 p-4"
            data-testid="panel-zero-bales-warning"
          >
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                  No bale records found for this order
                </p>
                <p className="text-xs text-amber-700 dark:text-amber-300 mt-0.5">
                  Bale scans may have failed while the database columns were missing. If you have the bale reference
                  numbers, use <strong>Recover Bales</strong> to re-link them. Otherwise use{" "}
                  <strong>Return to Loading</strong> to re-scan.
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              onClick={() => setShowRecoverDialog(true)}
              className="border-amber-400 dark:border-amber-600 text-amber-800 dark:text-amber-200"
              data-testid="button-recover-bales"
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Recover Bales
            </Button>
          </div>
        )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Loaded Bales</CardTitle>
            <Package className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-total-loaded-bales">
              {verification?.totalLoadedBales ?? 0} bales
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Weight</CardTitle>
            <Truck className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-total-weight">
              {fmtNum(verification?.totalLoadedWeight ?? 0)} kg
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Not Loaded</CardTitle>
            <Package className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <div
              className="text-2xl font-bold text-amber-600 dark:text-amber-400"
              data-testid="text-total-not-loaded-bales"
            >
              {totalNotLoadedBales} bales
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Not Loaded Weight</CardTitle>
            <Truck className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <div
              className="text-2xl font-bold text-amber-600 dark:text-amber-400"
              data-testid="text-total-not-loaded-weight"
            >
              {fmtNum(totalNotLoadedWeight)} kg
            </div>
          </CardContent>
        </Card>
      </div>

      <FactoryPendingInvoiceVerifyDetailCard model={model} />

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Ship className="h-5 w-5" />
            Container / Shipping
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Container Number</label>
              <Input
                value={containerNumber}
                onChange={(e) => setContainerNumber(e.target.value)}
                placeholder="e.g. MSCU1234567"
                data-testid="input-container-number"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Shipping Company</label>
              <Input
                value={shippingCompany}
                onChange={(e) => setShippingCompany(e.target.value)}
                placeholder="e.g. MSC, Maersk"
                data-testid="input-shipping-company"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Destination</label>
              <Input
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                placeholder="e.g. Rotterdam, UK"
                data-testid="input-destination"
              />
            </div>
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">Container Notes</label>
            <Textarea
              value={containerNotes}
              onChange={(e) => setContainerNotes(e.target.value)}
              placeholder="Additional notes..."
              data-testid="input-container-notes"
            />
          </div>
          <Button
            variant="outline"
            onClick={() =>
              assignContainerMutation.mutate({ containerNumber, shippingCompany, containerNotes, destination })
            }
            disabled={assignContainerMutation.isPending}
            data-testid="button-save-container"
          >
            <Ship className="mr-2 h-4 w-4" />
            Save Container Info
          </Button>
        </CardContent>
      </Card>

      {(isPending || isVerified || isLoadingStatus) && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-sm">Freight &amp; Charges</CardTitle>
            <p className="text-xs text-muted-foreground">
              These will be billed to the customer and posted to the selected account
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {charges.length > 0 && (
              <div className="space-y-1">
                {charges.map((charge) => {
                  const acct = ledgerAccounts.find((a) => a.id === charge.ledgerAccountId);
                  return (
                    <div
                      key={charge.id}
                      className="flex items-center justify-between gap-2"
                      data-testid={`row-charge-${charge.id}`}
                    >
                      <div className="flex flex-col min-w-0">
                        <span className="text-sm font-medium">{charge.name}</span>
                        {acct && <span className="text-xs text-muted-foreground">{acct.name}</span>}
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <span className="font-mono text-sm" data-testid={`text-charge-amount-${charge.id}`}>
                          {fmtNum(parseFloat(charge.amount))}
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
                  );
                })}
              </div>
            )}

            <div className="space-y-2 pt-2 border-t">
              <p className="text-xs font-medium text-muted-foreground">Add Charge</p>
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

              <Popover open={chargeAccountOpen} onOpenChange={setChargeAccountOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={chargeAccountOpen}
                    className="w-full justify-between font-normal"
                    data-testid="select-charge-account"
                  >
                    <span className="truncate text-left">
                      {chargeLedgerAccountId
                        ? (ledgerAccounts.find((a) => String(a.id) === chargeLedgerAccountId)?.name ??
                          "Select account...")
                        : chargeType !== "FREIGHT"
                          ? "Select account (required)..."
                          : "Select account (optional)..."}
                    </span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[320px] p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Search accounts..." data-testid="input-charge-account-search" />
                    <CommandList>
                      <CommandEmpty>No account found.</CommandEmpty>
                      <CommandGroup>
                        {ledgerAccounts.map((acct) => (
                          <CommandItem
                            key={acct.id}
                            value={`${acct.name} ${acct.code}`}
                            onSelect={() => {
                              setChargeLedgerAccountId(String(acct.id));
                              setChargeAccountOpen(false);
                            }}
                            data-testid={`option-account-${acct.id}`}
                          >
                            <Check
                              className={`mr-2 h-4 w-4 shrink-0 ${String(acct.id) === chargeLedgerAccountId ? "opacity-100" : "opacity-0"}`}
                            />
                            <span className="flex-1 truncate">{acct.name}</span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
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
                  data-testid="input-charge-amount"
                />
                <Button
                  variant="outline"
                  onClick={handleAddCharge}
                  disabled={
                    !chargeAmount || (chargeType !== "FREIGHT" && !chargeLedgerAccountId) || addChargeMutation.isPending
                  }
                  data-testid="button-add-charge"
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-2"></div>

        <div className="flex items-center gap-2">
          {isPending && (
            <Button
              onClick={() => setShowApproveDialog(true)}
              disabled={verifyMutation.isPending}
              data-testid="button-approve-verify"
            >
              <Check className="mr-2 h-4 w-4" />
              Approve & Verify
            </Button>
          )}
          {isVerified && isDeveloper && orderDetail?.invoiceNumber && (
            <Button
              variant="outline"
              onClick={() => setShowFixBalesDialog(true)}
              disabled={forceSyncMutation.isPending}
              data-testid="button-fix-bale-status"
            >
              <Wrench className="mr-2 h-4 w-4" />
              Fix Bale Statuses
            </Button>
          )}
          {isVerified && (
            <Button
              onClick={fetchFinalizePreview}
              disabled={finalizeMutation.isPending || previewLoading}
              data-testid="button-finalize-invoice"
            >
              <CheckCircle className="mr-2 h-4 w-4" />
              Finalize Invoice
            </Button>
          )}
        </div>
      </div>

      <FactoryPendingInvoiceVerifyDialog1 model={model} />

      <FactoryPendingInvoiceVerifyDialog2 model={model} />

      {/* ── Price warning dialog ─────────────────────────────────────────── */}
      <FactoryPendingInvoiceVerifyDialog3 model={model} />

      <FactoryPendingInvoiceVerifyDialog4 model={model} />

      <FactoryPendingInvoiceVerifyDialog5 model={model} />

      {/* View Proforma dialog */}
      {(() => {
        const activeProformaId = verification?.order?.proformaIdUsed ?? null;
        const activeProformaName =
          proformas.find((p) => p.id === activeProformaId)?.name ??
          (activeProformaId ? `Proforma #${activeProformaId}` : null);
        const proformaLines = verification?.proformaLines ?? [];
        return (
          <Dialog open={showViewProformaDialog} onOpenChange={setShowViewProformaDialog}>
            <DialogContent className="max-w-lg" data-testid="dialog-view-proforma">
              <DialogHeader>
                <DialogTitle>{activeProformaName ? `Proforma: ${activeProformaName}` : "Linked Proforma"}</DialogTitle>
              </DialogHeader>
              {!activeProformaId ? (
                <p className="text-sm text-muted-foreground italic" data-testid="text-no-proforma-linked">
                  No proforma is linked to this order.
                </p>
              ) : proformaLines.length === 0 ? (
                <p className="text-sm text-muted-foreground italic" data-testid="text-proforma-no-lines">
                  This proforma has no lines.
                </p>
              ) : (
                <div className="overflow-auto max-h-[60vh]">
                  <Table data-testid="table-view-proforma">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Article</TableHead>
                        <TableHead>Product</TableHead>
                        <TableHead className="text-right">Expected Qty</TableHead>
                        <TableHead className="text-right">Price / Bale</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {proformaLines.map((line, idx) => (
                        <TableRow key={idx} data-testid={`row-view-proforma-${line.articleCode}`}>
                          <TableCell className="font-mono text-sm">{line.articleCode}</TableCell>
                          <TableCell className="text-sm">{line.productName}</TableCell>
                          <TableCell className="text-right text-sm">{line.expectedQty}</TableCell>
                          <TableCell className="text-right text-sm font-medium">
                            ${fmtNum(parseFloat(line.pricePerBale) || 0)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              <div className="flex justify-end">
                <Button
                  variant="outline"
                  onClick={() => setShowViewProformaDialog(false)}
                  data-testid="button-close-view-proforma"
                >
                  Close
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        );
      })()}

      <FactoryPendingInvoiceVerifyDialog6 model={model} />

      <FactoryPendingInvoiceVerifyDialog7 model={model} />
    </div>
  );
}
