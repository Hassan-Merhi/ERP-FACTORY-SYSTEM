// Extracted from ./FactoryInvoiceCreate.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { MobileBarcodeScanner } from "@/components/MobileBarcodeScanner";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MapPin, PackageCheck, Plus, RefreshCw, ScanLine, Trash2 } from "lucide-react";
import { useFactoryInvoiceCreateState } from "./useFactoryInvoiceCreateState";

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

      <Card className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h3 className="font-semibold text-sm">Charges</h3>
          {orderDetail?.status === "FINALIZED" && charges.some((c) => !c.voucherId) && (
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

        {charges.length > 0 && (
          <div className="space-y-1">
            {charges.map((charge) => (
              <div
                key={charge.id}
                className="flex items-center justify-between gap-2"
                data-testid={`row-charge-${charge.id}`}
              >
                <span className="text-sm">{charge.name}</span>
                <div className="flex items-center gap-1">
                  <span className="font-mono text-sm" data-testid={`text-charge-amount-${charge.id}`}>
                    {parseFloat(charge.amount).toLocaleString(undefined, {
                      minimumFractionDigits: 0,
                      maximumFractionDigits: 2,
                    })}
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
            ))}
          </div>
        )}

        <div className="space-y-2">
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

          <Select value={chargeLedgerAccountId} onValueChange={setChargeLedgerAccountId}>
            <SelectTrigger data-testid="select-charge-ledger-account">
              <SelectValue
                placeholder={chargeType !== "FREIGHT" ? "Select account (required)..." : "Select account (optional)..."}
              />
            </SelectTrigger>
            <SelectContent>
              {ledgerAccounts.map((acc) => (
                <SelectItem key={acc.id} value={String(acc.id)}>
                  {acc.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
              disabled={!orderId}
              data-testid="input-charge-amount"
            />
            <Button
              variant="outline"
              onClick={handleAddCharge}
              disabled={
                !orderId ||
                !chargeAmount ||
                (chargeType !== "FREIGHT" && !chargeLedgerAccountId) ||
                addChargeMutation.isPending
              }
              data-testid="button-add-charge"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </Card>

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
