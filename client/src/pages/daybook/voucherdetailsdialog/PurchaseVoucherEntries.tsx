/**
 * Purchase voucher body: supplier card, item lines and the charges summary.
 *
 * Split out of VoucherDetailsDialog.tsx unchanged, including the POS-user gate
 * that hides rates, totals, supplier balance and the charge breakdown.
 */
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ViewVoucherEntry } from ".././types";
import type { PurchaseOrderDialogData } from "./types";

export function PurchaseVoucherEntries({
  viewVoucherEntries,
  purchaseOrderData,
  poSupplierBalance,
  isPOSUser,
  formatAmount,
  onOpenChange,
  navigate,
}: {
  viewVoucherEntries: ViewVoucherEntry[];
  purchaseOrderData: PurchaseOrderDialogData | null;
  poSupplierBalance: string | null;
  isPOSUser: boolean;
  formatAmount: (amt: number | string | null | undefined) => string;
  onOpenChange: (open: boolean) => void;
  navigate: (path: string) => void;
}) {
  const purchaseItems = viewVoucherEntries.filter((e) => e.isPurchaseItem);
  const totalQty = purchaseItems.reduce((sum: number, e) => sum + parseFloat(e.quantity || "0"), 0);
  const charges = purchaseOrderData
    ? [
        { label: "Items Total", value: purchaseOrderData.itemsTotal },
        { label: "Freight", value: purchaseOrderData.freight },
        { label: "Fumigation", value: purchaseOrderData.fumigation },
        { label: "Surcharge", value: purchaseOrderData.surcharge },
        { label: "Document Charges", value: purchaseOrderData.documentCharges },
        { label: "Other Charges", value: purchaseOrderData.otherCharges },
        { label: "Discount", value: purchaseOrderData.discount },
      ].filter((c) => c.value != null && parseFloat(String(c.value)) !== 0)
    : [];
  const showCharges = !isPOSUser && purchaseOrderData && !(charges.length === 0 && totalQty === 0);

  return (
    <div>
      {/* Supplier card */}
      {purchaseOrderData && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 py-3 border-b bg-muted/20">
          <div>
            <p className="font-semibold text-sm">{purchaseOrderData.supplierName || "Unknown Supplier"}</p>
            {!isPOSUser && poSupplierBalance != null && (
              <p className="text-xs text-muted-foreground">
                Balance:{" "}
                <span className="font-mono">
                  ${" "}
                  {parseFloat(poSupplierBalance).toLocaleString(undefined, {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 0,
                  })}
                </span>
              </p>
            )}
            {purchaseOrderData.containerNumber && (
              <p className="text-xs text-muted-foreground">Container: {purchaseOrderData.containerNumber}</p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              onClick={() => {
                onOpenChange(false);
                navigate(`/containers/${purchaseOrderData.containerId}`);
              }}
              data-testid="button-open-po"
            >
              Open
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                onOpenChange(false);
                navigate(
                  `/containers/${purchaseOrderData.containerId}/verification?autoCompare=true&supplierId=${purchaseOrderData.supplierId}`
                );
              }}
              data-testid="button-compare-po"
            >
              Compare
            </Button>
            {!isPOSUser && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  onOpenChange(false);
                  navigate(`/purchase-orders/${purchaseOrderData.id}/edit`);
                }}
                data-testid="button-edit-po"
              >
                Edit PO
              </Button>
            )}
          </div>
        </div>
      )}
      {/* Items table */}
      <Table>
        <TableHeader className="sticky top-0 z-30 bg-background">
          <TableRow>
            <TableHead>Item Name</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            {!isPOSUser && <TableHead className="text-right">Rate</TableHead>}
            {!isPOSUser && <TableHead className="text-right">Total</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {purchaseItems.map((entry) => (
            <TableRow key={entry.id}>
              <TableCell className="font-medium">{entry.stockItemName || entry.accountName}</TableCell>
              <TableCell className="text-right font-mono">{parseFloat(entry.quantity || "0")}</TableCell>
              {!isPOSUser && (
                <TableCell className="text-right font-mono">
                  {entry.rate != null ? formatAmount(entry.rate) : "-"}
                </TableCell>
              )}
              {!isPOSUser && (
                <TableCell className="text-right font-mono">
                  {entry.totalAmount != null ? formatAmount(entry.totalAmount) : "-"}
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {/* Charges summary */}
      {showCharges && (
        <div className="border-t px-4 py-3 space-y-1">
          {totalQty > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Total Qty</span>
              <span className="font-mono">{totalQty.toLocaleString()}</span>
            </div>
          )}
          {charges.map((c) => (
            <div key={c.label} className="flex justify-between text-sm">
              <span className="text-muted-foreground">{c.label}</span>
              <span className="font-mono">{formatAmount(c.value)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
