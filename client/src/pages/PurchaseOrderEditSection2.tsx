// Extracted from ./PurchaseOrderEdit.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCurrency } from "@/lib/formatNumber";
import { FreightAccountPicker } from "./purchaseorderedit/components/FreightAccountPicker";
import { usePurchaseOrderEditState } from "./usePurchaseOrderEditState";

export function PurchaseOrderEditSection2({
  chargesTotal,
  discount,
  documentCharges,
  freight,
  freightOwnAccountId,
  freightPaidBy,
  freightParentAccountId,
  fumigation,
  grandTotal,
  isFactory,
  itemsTotal,
  ledgerAccounts,
  otherCharges,
  parentFreightAccounts,
  priceSymbol,
  setDiscount,
  setDocumentCharges,
  setFreight,
  setFreightOwnAccountId,
  setFreightPaidBy,
  setFreightParentAccountId,
  setFumigation,
  setOtherCharges,
  setSurcharge,
  surcharge,
}: Pick<
  ReturnType<typeof usePurchaseOrderEditState>,
  | "chargesTotal"
  | "discount"
  | "documentCharges"
  | "freight"
  | "freightOwnAccountId"
  | "freightPaidBy"
  | "freightParentAccountId"
  | "fumigation"
  | "grandTotal"
  | "isFactory"
  | "itemsTotal"
  | "ledgerAccounts"
  | "otherCharges"
  | "parentFreightAccounts"
  | "priceSymbol"
  | "setDiscount"
  | "setDocumentCharges"
  | "setFreight"
  | "setFreightOwnAccountId"
  | "setFreightPaidBy"
  | "setFreightParentAccountId"
  | "setFumigation"
  | "setOtherCharges"
  | "setSurcharge"
  | "surcharge"
>) {
  return (
    <div className="space-y-4">
      <Label>Freight & Other Charges</Label>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
        <div className="space-y-2">
          <Label htmlFor="freight">Freight</Label>
          <Input
            id="freight"
            type="number"
            step="0.01"
            value={freight}
            onChange={(event) => setFreight(event.target.value)}
            className="text-right"
            data-testid="input-freight"
          />
          {parseFloat(freight) > 0 && (
            <div className="space-y-1.5">
              <div className="flex gap-1 flex-wrap">
                <Button
                  type="button"
                  size="sm"
                  variant={freightPaidBy === "supplier" ? "default" : "outline"}
                  onClick={() => {
                    setFreightPaidBy("supplier");
                    setFreightOwnAccountId(null);
                    setFreightParentAccountId(null);
                  }}
                  data-testid="button-freight-by-supplier"
                >
                  By Supplier
                </Button>
                {isFactory && (
                  <Button
                    type="button"
                    size="sm"
                    variant={freightPaidBy === "own" ? "default" : "outline"}
                    onClick={() => {
                      setFreightPaidBy("own");
                      setFreightParentAccountId(null);
                    }}
                    data-testid="button-freight-by-own"
                  >
                    Own Account
                  </Button>
                )}
                {!isFactory && (
                  <Button
                    type="button"
                    size="sm"
                    variant={freightPaidBy === "parent" ? "default" : "outline"}
                    onClick={() => {
                      setFreightPaidBy("parent");
                      setFreightOwnAccountId(null);
                    }}
                    data-testid="button-freight-by-parent"
                  >
                    Parent Co.
                  </Button>
                )}
              </div>
              {freightPaidBy === "own" && (
                <FreightAccountPicker
                  value={freightOwnAccountId?.toString() ?? ""}
                  onValueChange={(value) => setFreightOwnAccountId(value ? parseInt(value) : null)}
                  accounts={ledgerAccounts ?? []}
                />
              )}
              {freightPaidBy === "parent" && (
                <FreightAccountPicker
                  value={freightParentAccountId?.toString() ?? ""}
                  onValueChange={(value) => setFreightParentAccountId(value ? parseInt(value) : null)}
                  accounts={parentFreightAccounts ?? []}
                />
              )}
            </div>
          )}
        </div>
        <div>
          <Label htmlFor="surcharge">Surcharge</Label>
          <Input
            id="surcharge"
            type="number"
            step="0.01"
            value={surcharge}
            onChange={(event) => setSurcharge(event.target.value)}
            className="text-right"
            data-testid="input-surcharge"
          />
        </div>
        <div>
          <Label htmlFor="fumigation">Fumigation</Label>
          <Input
            id="fumigation"
            type="number"
            step="0.01"
            value={fumigation}
            onChange={(event) => setFumigation(event.target.value)}
            className="text-right"
            data-testid="input-fumigation"
          />
        </div>
        <div>
          <Label htmlFor="documentCharges">Document Charges</Label>
          <Input
            id="documentCharges"
            type="number"
            step="0.01"
            value={documentCharges}
            onChange={(event) => setDocumentCharges(event.target.value)}
            className="text-right"
            data-testid="input-document-charges"
          />
        </div>
        <div>
          <Label htmlFor="discount">Discount</Label>
          <Input
            id="discount"
            type="number"
            step="0.01"
            value={discount}
            onChange={(event) => setDiscount(event.target.value)}
            className="text-right"
            data-testid="input-discount"
          />
        </div>
        <div>
          <Label htmlFor="otherCharges">Other Charges</Label>
          <Input
            id="otherCharges"
            type="number"
            step="0.01"
            value={otherCharges}
            onChange={(event) => setOtherCharges(event.target.value)}
            className="text-right"
            data-testid="input-other-charges"
          />
        </div>
      </div>

      <div className="bg-muted/50 rounded-md p-4">
        <div className="flex justify-between items-center">
          <span className="font-medium">Grand Total:</span>
          <span className="text-xl font-bold font-mono">
            {priceSymbol}
            {formatCurrency(parseFloat(grandTotal))}
          </span>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Items ({priceSymbol}
          {formatCurrency(parseFloat(itemsTotal))}) + Charges ({priceSymbol}
          {formatCurrency(parseFloat(chargesTotal))})
        </p>
      </div>
    </div>
  );
}
