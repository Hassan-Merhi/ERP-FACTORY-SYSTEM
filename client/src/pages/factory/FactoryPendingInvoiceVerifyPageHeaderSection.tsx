// Extracted from ./FactoryPendingInvoiceVerify.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ChevronDown,
  DollarSign,
  FileSpreadsheet,
  FileText,
  GitCompare,
  Hammer,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useFactoryPendingInvoiceVerifyModel } from "./factorypendinginvoiceverify/useFactoryPendingInvoiceVerifyModel";

export function useFactoryPendingInvoiceVerifyState() {
  const model = useFactoryPendingInvoiceVerifyModel();
  // View Only / Create Only roles review the loading but never approve, finalize, reprice or edit it.
  const recordChanges = useExistingRecordChangeAccess();
  const canChange = recordChanges.allowed;
  const {
    navigate,
    orderId,
    containerNumber,
    setContainerNumber,
    shippingCompany,
    setShippingCompany,
    containerNotes,
    setContainerNotes,
    bookingInfo,
    setBookingInfo,
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
    setShowApproveDialog,
    setShowReturnDialog,
    previewLoading,
    setShowFixBalesDialog,
    setShowProformaDialog,
    showViewProformaDialog,
    setShowViewProformaDialog,
    viewedMasterProforma,
    setSelectedProformaId,
    setShowRecoverDialog,
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
    applyProformaMutation,
    applyProductionPricesMutation,
    applySellingPricesMutation,
    fetchFinalizePreview,
    handleAddCharge,
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
  return {
    addChargeMutation,
    applyProductionPricesMutation,
    applyProformaMutation,
    applySellingPricesMutation,
    assignContainerMutation,
    bookingInfo,
    canChange,
    chargeAccountOpen,
    chargeAmount,
    chargeLedgerAccountId,
    chargeName,
    chargeType,
    charges,
    containerNotes,
    containerNumber,
    currentUser,
    destination,
    fetchFinalizePreview,
    finalizeMutation,
    forceSyncMutation,
    handleAddCharge,
    handleExportExcel,
    handleExportExcelNoCharges,
    handleExportLoadingStatus,
    handleExportPdf,
    handleExportPdfNoCharges,
    isAdminOrOwner,
    isDeveloper,
    isLoading,
    isLoadingStatus,
    isPending,
    isVerified,
    ledgerAccounts,
    model,
    navigate,
    orderDetail,
    orderId,
    previewLoading,
    proformas,
    recordChanges,
    removeChargeMutation,
    returnToLoadingMutation,
    setBookingInfo,
    setChargeAccountOpen,
    setChargeAmount,
    setChargeLedgerAccountId,
    setChargeName,
    setChargeType,
    setContainerNotes,
    setContainerNumber,
    setDestination,
    setSelectedProformaId,
    setShippingCompany,
    setShowApproveDialog,
    setShowFixBalesDialog,
    setShowProformaDialog,
    setShowRecoverDialog,
    setShowReturnDialog,
    setShowViewProformaDialog,
    shippingCompany,
    showViewProformaDialog,
    totalNotLoadedBales,
    totalNotLoadedWeight,
    verification,
    verificationLoading,
    verifyMutation,
    viewedMasterProforma,
  };
}

export function FactoryPendingInvoiceVerifyPageHeaderSection({
  applyProductionPricesMutation,
  applyProformaMutation,
  applySellingPricesMutation,
  canChange,
  handleExportExcel,
  handleExportExcelNoCharges,
  handleExportLoadingStatus,
  handleExportPdf,
  handleExportPdfNoCharges,
  isAdminOrOwner,
  isLoadingStatus,
  isVerified,
  navigate,
  orderId,
  returnToLoadingMutation,
  setSelectedProformaId,
  setShowProformaDialog,
  setShowReturnDialog,
  setShowViewProformaDialog,
}: Pick<
  ReturnType<typeof useFactoryPendingInvoiceVerifyState>,
  | "applyProductionPricesMutation"
  | "applyProformaMutation"
  | "applySellingPricesMutation"
  | "canChange"
  | "handleExportExcel"
  | "handleExportExcelNoCharges"
  | "handleExportLoadingStatus"
  | "handleExportPdf"
  | "handleExportPdfNoCharges"
  | "isAdminOrOwner"
  | "isLoadingStatus"
  | "isVerified"
  | "navigate"
  | "orderId"
  | "returnToLoadingMutation"
  | "setSelectedProformaId"
  | "setShowProformaDialog"
  | "setShowReturnDialog"
  | "setShowViewProformaDialog"
>) {
  return (
    <PageHeader
      title={`Verify Order #${orderId}`}
      subtitle="Review loaded bales against proforma"
      backTarget="/factory/invoicing?tab=invoices"
    >
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

                {isAdminOrOwner && canChange && (
                  <>
                    <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">Pricing</DropdownMenuLabel>
                    <DropdownMenuItem
                      onClick={() => applyProductionPricesMutation.mutate()}
                      disabled={applyProductionPricesMutation.isPending}
                      data-testid="menu-apply-production-prices"
                    >
                      <Hammer className={`h-4 w-4 ${applyProductionPricesMutation.isPending ? "animate-spin" : ""}`} />
                      Apply Production Prices
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => applySellingPricesMutation.mutate()}
                      disabled={applySellingPricesMutation.isPending}
                      data-testid="menu-apply-selling-prices"
                    >
                      <RefreshCw className={`h-4 w-4 ${applySellingPricesMutation.isPending ? "animate-spin" : ""}`} />
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
                  Export Excel
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleExportExcelNoCharges} data-testid="menu-export-excel-no-charges">
                  <FileSpreadsheet className="h-4 w-4" />
                  Export Excel (No Charges)
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleExportPdf} data-testid="menu-export-pdf">
                  <FileText className="h-4 w-4" />
                  Export PDF
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleExportPdfNoCharges} data-testid="menu-export-pdf-no-charges">
                  <FileText className="h-4 w-4" />
                  Export PDF (No Charges)
                </DropdownMenuItem>
                {isAdminOrOwner && (
                  <DropdownMenuItem onClick={handleExportLoadingStatus} data-testid="menu-export-loading-status">
                    <FileSpreadsheet className="h-4 w-4" />
                    Export Excel (Loading Status)
                  </DropdownMenuItem>
                )}

                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() => setShowReturnDialog(true)}
                  disabled={returnToLoadingMutation.isPending || !canChange}
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
                  disabled={returnToLoadingMutation.isPending || !canChange}
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
    </PageHeader>
  );
}
