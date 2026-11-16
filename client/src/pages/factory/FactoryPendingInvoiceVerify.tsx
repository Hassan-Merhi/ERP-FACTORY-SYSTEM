import { Button } from "@/components/ui/button";
import { FACTORY_MOBILE_ACTION_BAR_CLEARANCE, FactoryMobileActionBar } from "@/components/ui/factory-mobile";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Check, AlertTriangle, CheckCircle, Package, Wrench, RefreshCw } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtNum } from "./factorypendinginvoiceverify/utils";
import { FactoryPendingInvoiceVerifyDialog1 } from "./factorypendinginvoiceverify/components/FactoryPendingInvoiceVerifyDialog1";
import { FactoryPendingInvoiceVerifyDialog2 } from "./factorypendinginvoiceverify/components/FactoryPendingInvoiceVerifyDialog2";
import { FactoryPendingInvoiceVerifyDialog3 } from "./factorypendinginvoiceverify/components/FactoryPendingInvoiceVerifyDialog3";
import { FactoryPendingInvoiceVerifyDialog4 } from "./factorypendinginvoiceverify/components/FactoryPendingInvoiceVerifyDialog4";
import { FactoryPendingInvoiceVerifyDialog5 } from "./factorypendinginvoiceverify/components/FactoryPendingInvoiceVerifyDialog5";
import { FactoryPendingInvoiceVerifyDialog6 } from "./factorypendinginvoiceverify/components/FactoryPendingInvoiceVerifyDialog6";
import { FactoryPendingInvoiceVerifyDialog7 } from "./factorypendinginvoiceverify/components/FactoryPendingInvoiceVerifyDialog7";
import { FactoryPendingInvoiceVerifyDetailCard } from "./factorypendinginvoiceverify/components/FactoryPendingInvoiceVerifyDetailCard";
import {
  FactoryPendingInvoiceVerifySection,
  useFactoryPendingInvoiceVerifyState,
} from "./FactoryPendingInvoiceVerifySection";
import {
  FactoryPendingInvoiceVerifyCardSection,
  FactoryPendingInvoiceVerifyCardSection2,
  FactoryPendingInvoiceVerifySection3,
} from "./FactoryPendingInvoiceVerifyCardSection";

export default function FactoryPendingInvoiceVerify() {
  const {
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
  } = useFactoryPendingInvoiceVerifyState();

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
    <div
      className={`flex h-full flex-col overflow-y-auto sm:p-4 lg:p-6 ${isPending || isVerified ? `${FACTORY_MOBILE_ACTION_BAR_CLEARANCE} sm:pb-4 lg:pb-6` : ""}`}
    >
      <FactoryPendingInvoiceVerifySection
        applyProductionPricesMutation={applyProductionPricesMutation}
        applyProformaMutation={applyProformaMutation}
        applySellingPricesMutation={applySellingPricesMutation}
        canChange={canChange}
        handleExportExcel={handleExportExcel}
        handleExportExcelNoCharges={handleExportExcelNoCharges}
        handleExportLoadingStatus={handleExportLoadingStatus}
        handleExportPdf={handleExportPdf}
        handleExportPdfNoCharges={handleExportPdfNoCharges}
        isAdminOrOwner={isAdminOrOwner}
        isLoadingStatus={isLoadingStatus}
        isVerified={isVerified}
        navigate={navigate}
        orderId={orderId}
        returnToLoadingMutation={returnToLoadingMutation}
        setSelectedProformaId={setSelectedProformaId}
        setShowProformaDialog={setShowProformaDialog}
        setShowReturnDialog={setShowReturnDialog}
        setShowViewProformaDialog={setShowViewProformaDialog}
      />

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
          {isAdminOrOwner && canChange && (
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
        // An empty, active continuation is normal — it has not scanned yet.
        // Recovery is relevant only after the loading was submitted.
        !["LOADING", "DRAFT"].includes(verification?.order?.status || "") &&
        verification?.dataSource !== "order_lines" &&
        isAdminOrOwner &&
        canChange && (
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

      <FactoryPendingInvoiceVerifySection3
        totalNotLoadedBales={totalNotLoadedBales}
        totalNotLoadedWeight={totalNotLoadedWeight}
        verification={verification}
      />

      <FactoryPendingInvoiceVerifyDetailCard model={model} />

      <FactoryPendingInvoiceVerifyCardSection2
        assignContainerMutation={assignContainerMutation}
        bookingInfo={bookingInfo}
        canChange={canChange}
        containerNotes={containerNotes}
        containerNumber={containerNumber}
        destination={destination}
        recordChanges={recordChanges}
        setBookingInfo={setBookingInfo}
        setContainerNotes={setContainerNotes}
        setContainerNumber={setContainerNumber}
        setDestination={setDestination}
        setShippingCompany={setShippingCompany}
        shippingCompany={shippingCompany}
      />

      {(isPending || isVerified || isLoadingStatus) && (
        <FactoryPendingInvoiceVerifyCardSection
          addChargeMutation={addChargeMutation}
          canChange={canChange}
          chargeAccountOpen={chargeAccountOpen}
          chargeAmount={chargeAmount}
          chargeLedgerAccountId={chargeLedgerAccountId}
          chargeName={chargeName}
          chargeType={chargeType}
          charges={charges}
          handleAddCharge={handleAddCharge}
          ledgerAccounts={ledgerAccounts}
          recordChanges={recordChanges}
          removeChargeMutation={removeChargeMutation}
          setChargeAccountOpen={setChargeAccountOpen}
          setChargeAmount={setChargeAmount}
          setChargeLedgerAccountId={setChargeLedgerAccountId}
          setChargeName={setChargeName}
          setChargeType={setChargeType}
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-2"></div>

        {/* Phones pin the verification actions above the home indicator; sm+ keeps the inline row. */}
        <FactoryMobileActionBar
          className={`sm:items-center sm:gap-2 ${(isPending || isVerified) && canChange ? "" : "hidden sm:flex"}`}
          data-testid="verify-mobile-actions"
        >
          {isPending && canChange && (
            <Button
              onClick={() => setShowApproveDialog(true)}
              disabled={verifyMutation.isPending}
              data-testid="button-approve-verify"
            >
              <Check className="mr-2 h-4 w-4" />
              Approve & Verify
            </Button>
          )}
          {isVerified && isDeveloper && canChange && orderDetail?.invoiceNumber && (
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
          {isVerified && canChange && (
            <Button
              onClick={fetchFinalizePreview}
              disabled={finalizeMutation.isPending || previewLoading}
              data-testid="button-finalize-invoice"
            >
              <CheckCircle className="mr-2 h-4 w-4" />
              Finalize Invoice
            </Button>
          )}
        </FactoryMobileActionBar>
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
          viewedMasterProforma?.name ??
          proformas.find((p) => p.id === activeProformaId)?.name ??
          (activeProformaId ? `Proforma #${activeProformaId}` : null);
        const proformaLines = viewedMasterProforma?.lines ?? [];
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
              ) : !viewedMasterProforma ? (
                <p className="text-sm text-muted-foreground italic">Loading original proforma...</p>
              ) : proformaLines.length === 0 ? (
                <p className="text-sm text-muted-foreground italic" data-testid="text-proforma-no-lines">
                  This proforma has no lines.
                </p>
              ) : (
                <div className="overflow-auto max-h-[60vh]">
                  <Table mobileLayout="cards" data-testid="table-view-proforma">
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
                          <TableCell className="text-right text-sm">{line.quantity}</TableCell>
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
