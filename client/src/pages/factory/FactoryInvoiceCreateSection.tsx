// Extracted from ./FactoryInvoiceCreate.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { MobileBarcodeScanner } from "@/components/MobileBarcodeScanner";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MapPin, PackageCheck, RefreshCw, ScanLine } from "lucide-react";
import { useFactoryInvoiceCreateState } from "./useFactoryInvoiceCreateState";
import { FactoryInvoiceCreateSectionCard } from "./FactoryInvoiceCreateSectionCard";

export function FactoryInvoiceCreateSection({
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
  subtotal,
}: Pick<
  ReturnType<typeof useFactoryInvoiceCreateState>,
  | "activeProforma"
  | "addBaleMutation"
  | "addChargeMutation"
  | "bales"
  | "chargeAmount"
  | "chargeLedgerAccountId"
  | "chargeName"
  | "chargeType"
  | "charges"
  | "customerId"
  | "customers"
  | "finalizeMutation"
  | "freightCharges"
  | "grandTotal"
  | "handleAddCharge"
  | "handleCustomerChange"
  | "handleDateChange"
  | "handleScan"
  | "ledgerAccounts"
  | "locations"
  | "orderDate"
  | "orderDetail"
  | "orderId"
  | "otherCharges"
  | "proformaSummaries"
  | "relinkVouchersMutation"
  | "removeChargeMutation"
  | "repriceMutation"
  | "scanCode"
  | "scanInputClass"
  | "scannerRef"
  | "selectedCustomerId"
  | "selectedLocationId"
  | "setChargeAmount"
  | "setChargeLedgerAccountId"
  | "setChargeName"
  | "setChargeType"
  | "setScanCode"
  | "setSelectedLocationId"
  | "setShowFinalizeDialog"
  | "subtotal"
>) {
  return (
    <div className="lg:w-[40%] flex flex-col gap-4">
      <Card className="p-4 space-y-4">
        <div>
          <label className="text-sm font-medium mb-1 block">Customer</label>
          <Select value={selectedCustomerId} onValueChange={handleCustomerChange} disabled={!!orderId}>
            <SelectTrigger data-testid="select-customer">
              <SelectValue placeholder="Select customer..." />
            </SelectTrigger>
            <SelectContent>
              {customers.map((c) => (
                <SelectItem key={c.id} value={c.id.toString()} data-testid={`select-customer-option-${c.id}`}>
                  {c.legalName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <label className="text-sm font-medium mb-1 block">Date</label>
          <Input
            type="date"
            value={orderDate}
            onChange={(e) => handleDateChange(e.target.value)}
            data-testid="input-order-date"
          />
        </div>

        {activeProforma && (
          <div className="flex items-center gap-2">
            <Badge
              variant="default"
              className="bg-green-600 text-white no-default-hover-elevate no-default-active-elevate"
              data-testid="badge-active-proforma"
            >
              {activeProforma.name}
            </Badge>
            <span className="text-sm text-muted-foreground">{activeProforma.lines.length} price lines</span>
          </div>
        )}

        {customerId && !activeProforma && proformaSummaries.length === 0 && (
          <p className="text-sm text-destructive" data-testid="text-no-proforma">
            No active proforma found for this customer
          </p>
        )}

        <div>
          <label className="text-sm font-medium mb-1 block">
            <MapPin className="inline h-3 w-3 mr-1" />
            Picking Location
          </label>
          <Select value={selectedLocationId} onValueChange={setSelectedLocationId}>
            <SelectTrigger data-testid="select-location">
              <SelectValue placeholder="Select location..." />
            </SelectTrigger>
            <SelectContent>
              {locations.map((loc) => (
                <SelectItem key={loc.id} value={loc.id.toString()} data-testid={`select-location-option-${loc.id}`}>
                  {loc.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <label className="text-sm font-medium mb-1 block">
            <ScanLine className="inline h-3 w-3 mr-1" />
            Scan Bale
          </label>
          <Input
            ref={scannerRef}
            value={scanCode}
            onChange={(e) => setScanCode(e.target.value)}
            onKeyDown={handleScan}
            placeholder="Scan or type bale code..."
            disabled={!orderId || !selectedLocationId}
            className={scanInputClass}
            data-testid="input-scan-code"
          />
          <MobileBarcodeScanner
            onScan={(code) => {
              if (orderId && selectedLocationId && !addBaleMutation.isPending) {
                addBaleMutation.mutate({ scanCode: code, locationId: parseInt(selectedLocationId) });
              }
            }}
            disabled={!orderId || !selectedLocationId || addBaleMutation.isPending}
          />
          {(!orderId || !selectedLocationId) && (
            <p className="text-xs text-muted-foreground mt-1">
              {!orderId ? "Select a customer with an active proforma first" : "Select a location to start scanning"}
            </p>
          )}
        </div>
      </Card>

      <FactoryInvoiceCreateSectionCard
        addChargeMutation={addChargeMutation}
        chargeAmount={chargeAmount}
        chargeLedgerAccountId={chargeLedgerAccountId}
        chargeName={chargeName}
        charges={charges}
        chargeType={chargeType}
        handleAddCharge={handleAddCharge}
        ledgerAccounts={ledgerAccounts}
        orderDetail={orderDetail}
        orderId={orderId}
        relinkVouchersMutation={relinkVouchersMutation}
        removeChargeMutation={removeChargeMutation}
        setChargeAmount={setChargeAmount}
        setChargeLedgerAccountId={setChargeLedgerAccountId}
        setChargeName={setChargeName}
        setChargeType={setChargeType}
      />

      <Card className="p-4 space-y-2">
        <div className="flex items-center justify-between gap-2 text-sm">
          <span>Subtotal</span>
          <span className="font-mono" data-testid="text-summary-subtotal">
            {subtotal.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 text-sm">
          <span>Freight</span>
          <span className="font-mono" data-testid="text-summary-freight">
            {freightCharges.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 text-sm">
          <span>Other Charges</span>
          <span className="font-mono" data-testid="text-summary-other">
            {otherCharges.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
          </span>
        </div>
        <div className="border-t pt-2 flex items-center justify-between gap-2">
          <span className="font-semibold">Grand Total</span>
          <span className="font-mono font-bold text-lg" data-testid="text-grand-total">
            {grandTotal.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
          <span>Total Bales</span>
          <span data-testid="text-total-bales">{bales.length}</span>
        </div>
      </Card>

      {orderId && bales.length > 0 && (
        <Button
          variant="outline"
          className="w-full"
          onClick={() => repriceMutation.mutate()}
          disabled={repriceMutation.isPending}
          data-testid="button-apply-prices"
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${repriceMutation.isPending ? "animate-spin" : ""}`} />
          Apply Current Prices
        </Button>
      )}

      <Button
        className={`w-full ${bales.length > 0 ? "hidden sm:inline-flex" : ""}`}
        size="lg"
        onClick={() => setShowFinalizeDialog(true)}
        disabled={!orderId || bales.length === 0 || finalizeMutation.isPending}
        data-testid="button-finalize"
      >
        <PackageCheck className="mr-2 h-5 w-5" />
        Finalize Invoice
      </Button>
    </div>
  );
}
