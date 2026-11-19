// Extracted from ./PurchaseOrderEdit.tsx
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, RefreshCw } from "lucide-react";
import { usePurchaseOrderEditState } from "./usePurchaseOrderEditState";

export function PurchaseOrderEditContent({
  currency,
  isFetchingNextPo,
  isNew,
  po,
  poNumber,
  refetchNextPo,
  setCurrency,
  setPoNumber,
  setStatus,
  status,
}: Pick<
  ReturnType<typeof usePurchaseOrderEditState>,
  | "currency"
  | "isFetchingNextPo"
  | "isNew"
  | "po"
  | "poNumber"
  | "refetchNextPo"
  | "setCurrency"
  | "setPoNumber"
  | "setStatus"
  | "status"
>) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <div>
        <Label htmlFor="poNumber">PO Number</Label>
        <div className="flex gap-2">
          <Input
            id="poNumber"
            value={poNumber}
            onChange={(event) => setPoNumber(event.target.value)}
            data-testid="input-po-number"
            placeholder={isNew ? "Auto-generating…" : undefined}
          />
          {isNew && (
            <Button
              type="button"
              size="icon"
              variant="outline"
              data-testid="button-generate-po-number"
              title="Generate a new PO number"
              onClick={() =>
                refetchNextPo().then((result) => {
                  if (result.data?.poNumber) setPoNumber(result.data.poNumber);
                })
              }
              disabled={isFetchingNextPo}
            >
              {isFetchingNextPo ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </Button>
          )}
        </div>
      </div>
      <div>
        <Label htmlFor="currency">Currency</Label>
        <Select value={currency} onValueChange={setCurrency} disabled={po?.currency === "ZMW"}>
          <SelectTrigger id="currency" data-testid="select-currency">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="USD">USD</SelectItem>
            <SelectItem value="EUR">EUR</SelectItem>
            <SelectItem value="GBP">GBP</SelectItem>
            <SelectItem value="CFA">CFA</SelectItem>
            {po?.currency === "ZMW" && <SelectItem value="ZMW">ZMW (locked)</SelectItem>}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label htmlFor="status">Status</Label>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger id="status" data-testid="select-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="Open">Open</SelectItem>
            <SelectItem value="Closed">Closed</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
