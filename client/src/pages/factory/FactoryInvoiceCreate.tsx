import { Button } from "@/components/ui/button";
import { FactoryMobileActionBar } from "@/components/ui/factory-mobile";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { Trash2, ScanLine, PackageCheck } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageHeader } from "@/components/PageHeader";
import { useFactoryInvoiceCreateState } from "./useFactoryInvoiceCreateState";
import { FactoryInvoiceCreateSection } from "./FactoryInvoiceCreateSection";

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
        <div className="lg:w-[60%] flex flex-col min-h-0">
          <Card className="flex-1 flex flex-col min-h-0 p-4">
            <div className="flex items-center justify-between gap-2 mb-3">
              <h2 className="font-semibold text-lg" data-testid="text-bales-header">
                Scanned Bales
              </h2>
              <Badge variant="secondary" data-testid="badge-bale-count">
                {bales.length} bales
              </Badge>
            </div>

            <div className="flex-1 overflow-y-auto">
              {Object.keys(groupedBales).length === 0 ? (
                <div
                  className="flex flex-col items-center justify-center py-12 text-muted-foreground"
                  data-testid="text-no-bales"
                >
                  <ScanLine className="h-12 w-12 mb-3 opacity-40" />
                  <p>No bales scanned yet</p>
                  <p className="text-sm mt-1">Select a customer and location, then scan bales</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {Object.values(groupedBales).map((group) => (
                    <div key={group.articleCode} data-testid={`group-article-${group.articleCode}`}>
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-2 px-1">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" data-testid={`badge-article-${group.articleCode}`}>
                            {group.articleCode}
                          </Badge>
                          <span className="text-sm font-medium">{group.productName}</span>
                        </div>
                        <div className="flex items-center gap-3 text-sm text-muted-foreground">
                          <span>Qty: {group.bales.length}</span>
                          <span>
                            Wt:{" "}
                            {group.totalWeight.toLocaleString(undefined, {
                              minimumFractionDigits: 0,
                              maximumFractionDigits: 2,
                            })}
                          </span>
                          {(() => {
                            const pfl = activeProforma?.lines.find((l) => l.articleCode === group.articleCode);
                            const isPerKg = pfl?.pricingMode === "per_kg";
                            return isPerKg ? (
                              <span className="font-mono text-xs text-muted-foreground">
                                @
                                {parseFloat(pfl?.pricePerKg || "0").toLocaleString(undefined, {
                                  minimumFractionDigits: 3,
                                  maximumFractionDigits: 3,
                                })}
                                /kg
                              </span>
                            ) : (
                              <span className="font-mono">
                                @
                                {group.pricePerBale.toLocaleString(undefined, {
                                  minimumFractionDigits: 0,
                                  maximumFractionDigits: 2,
                                })}
                              </span>
                            );
                          })()}
                          <span className="font-mono font-semibold text-foreground">
                            {group.totalPrice.toLocaleString(undefined, {
                              minimumFractionDigits: 0,
                              maximumFractionDigits: 2,
                            })}
                          </span>
                        </div>
                      </div>
                      {/* No header row: phone cards take their labels from the cells themselves. */}
                      <Table mobileLayout="cards">
                        <TableBody>
                          {group.bales.map((bale) => (
                            <TableRow key={bale.id} data-testid={`row-bale-${bale.id}`}>
                              <TableCell
                                className="font-mono text-sm"
                                data-label="Reference"
                                data-testid={`text-bale-ref-${bale.id}`}
                              >
                                {bale.referenceNumber}
                              </TableCell>
                              <TableCell className="text-right text-sm text-muted-foreground" data-label="Weight">
                                {parseFloat(bale.weight || "0").toLocaleString(undefined, {
                                  minimumFractionDigits: 0,
                                  maximumFractionDigits: 2,
                                })}{" "}
                                kg
                              </TableCell>
                              <TableCell
                                className="text-right font-mono text-sm"
                                data-label="Price"
                                data-testid={`text-bale-price-${bale.id}`}
                              >
                                {parseFloat(bale.totalPrice || "0").toLocaleString(undefined, {
                                  minimumFractionDigits: 0,
                                  maximumFractionDigits: 2,
                                })}
                              </TableCell>
                              <TableCell className="w-[40px]">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => removeBaleMutation.mutate(bale.id)}
                                  disabled={removeBaleMutation.isPending}
                                  aria-label={`Remove bale ${bale.referenceNumber}`}
                                  data-testid={`button-remove-bale-${bale.id}`}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {bales.length > 0 && (
              <div className="border-t pt-3 mt-3 flex items-center justify-between gap-2">
                <span className="font-medium">Subtotal</span>
                <span className="font-mono font-semibold text-lg" data-testid="text-subtotal">
                  {subtotal.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
                </span>
              </div>
            )}
          </Card>
        </div>

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
