import { Button } from "@/components/ui/button";
import { FactoryMobileActionBar } from "@/components/ui/factory-mobile";
import { Badge } from "@/components/ui/badge";
import { PackageCheck } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageHeader } from "@/components/PageHeader";
import { useFactoryInvoiceCreateState } from "./useFactoryInvoiceCreateState";
import { FactoryInvoiceCreateSection } from "./FactoryInvoiceCreateSection";
import { FactoryInvoiceCreateContent } from "./FactoryInvoiceCreateContent";

export default function FactoryInvoiceCreate() {
  const {
    activeProforma,
    addBaleMutation,
    addChargeMutation,
    bales,
    chargeAmount,
    chargeLedgerAccountId,
    chargeName,
    chargeType,
    charges,
    customerId,
    customers,
    finalizeMutation,
    freightCharges,
    grandTotal,
    groupedBales,
    handleAddCharge,
    handleCustomerChange,
    handleDateChange,
    handleScan,
    ledgerAccounts,
    locations,
    orderDate,
    orderDetail,
    orderId,
    otherCharges,
    proformaSummaries,
    relinkVouchersMutation,
    removeBaleMutation,
    removeChargeMutation,
    repriceMutation,
    scanCode,
    scanInputClass,
    scannerRef,
    selectedCustomerId,
    selectedLocationId,
    setChargeAmount,
    setChargeLedgerAccountId,
    setChargeName,
    setChargeType,
    setScanCode,
    setSelectedLocationId,
    setShowFinalizeDialog,
    showFinalizeDialog,
    subtotal,
  } = useFactoryInvoiceCreateState();

  return (
    <div
      className={`flex h-full flex-col sm:p-4 lg:p-6 ${bales.length > 0 ? "pb-[calc(5.5rem+env(safe-area-inset-bottom))] sm:pb-4 lg:pb-6" : ""}`}
    >
      <div className="flex items-center justify-between gap-4 mb-4">
        <div>
          <PageHeader title="Create Invoice" subtitle="POS-style bale sales invoice" />
        </div>
        {orderId && (
          <Badge variant="secondary" data-testid="badge-draft-order">
            Draft #{orderId}
          </Badge>
        )}
      </div>

      <div className="flex flex-col lg:flex-row gap-4 flex-1 min-h-0">
        <FactoryInvoiceCreateContent
          activeProforma={activeProforma}
          bales={bales}
          groupedBales={groupedBales}
          removeBaleMutation={removeBaleMutation}
          subtotal={subtotal}
        />

        <FactoryInvoiceCreateSection
          activeProforma={activeProforma}
          addBaleMutation={addBaleMutation}
          addChargeMutation={addChargeMutation}
          bales={bales}
          chargeAmount={chargeAmount}
          chargeLedgerAccountId={chargeLedgerAccountId}
          chargeName={chargeName}
          chargeType={chargeType}
          charges={charges}
          customerId={customerId}
          customers={customers}
          finalizeMutation={finalizeMutation}
          freightCharges={freightCharges}
          grandTotal={grandTotal}
          handleAddCharge={handleAddCharge}
          handleCustomerChange={handleCustomerChange}
          handleDateChange={handleDateChange}
          handleScan={handleScan}
          ledgerAccounts={ledgerAccounts}
          locations={locations}
          orderDate={orderDate}
          orderDetail={orderDetail}
          orderId={orderId}
          otherCharges={otherCharges}
          proformaSummaries={proformaSummaries}
          relinkVouchersMutation={relinkVouchersMutation}
          removeChargeMutation={removeChargeMutation}
          repriceMutation={repriceMutation}
          scanCode={scanCode}
          scanInputClass={scanInputClass}
          scannerRef={scannerRef}
          selectedCustomerId={selectedCustomerId}
          selectedLocationId={selectedLocationId}
          setChargeAmount={setChargeAmount}
          setChargeLedgerAccountId={setChargeLedgerAccountId}
          setChargeName={setChargeName}
          setChargeType={setChargeType}
          setScanCode={setScanCode}
          setSelectedLocationId={setSelectedLocationId}
          setShowFinalizeDialog={setShowFinalizeDialog}
          subtotal={subtotal}
        />
      </div>

      {/* Phones: the finalize action stays reachable above the home indicator while bales are scanned. */}
      {bales.length > 0 && (
        <FactoryMobileActionBar
          className="min-[360px]:grid-cols-1 sm:hidden"
          data-testid="invoice-create-mobile-actions"
        >
          <Button
            size="lg"
            onClick={() => setShowFinalizeDialog(true)}
            disabled={!orderId || finalizeMutation.isPending}
            data-testid="button-finalize-mobile"
          >
            <PackageCheck className="mr-2 h-5 w-5" />
            Finalize Invoice ·{" "}
            {grandTotal.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
          </Button>
        </FactoryMobileActionBar>
      )}

      <Dialog open={showFinalizeDialog} onOpenChange={setShowFinalizeDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Finalize Invoice</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <p className="mb-4">
              Are you sure you want to finalize this invoice for{" "}
              <span className="font-semibold">{customers.find((c) => c.id === customerId)?.legalName}</span>?
            </p>
            <div className="bg-muted p-4 rounded-lg space-y-2">
              <div className="flex justify-between">
                <span>Total Bales:</span>
                <span className="font-mono">{bales.length}</span>
              </div>
              <div className="flex justify-between font-bold border-t pt-2">
                <span>Grand Total:</span>
                <span className="font-mono">
                  {grandTotal.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
                </span>
              </div>
            </div>
            <p className="text-sm text-muted-foreground mt-4 italic">
              Finalizing will assign the bales to this invoice and generate a permanent invoice number.
            </p>
          </div>
          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => setShowFinalizeDialog(false)} data-testid="button-cancel-finalize">
              Cancel
            </Button>
            <Button
              onClick={() => finalizeMutation.mutate()}
              disabled={finalizeMutation.isPending}
              data-testid="button-confirm-finalize"
            >
              Confirm & Finalize
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
