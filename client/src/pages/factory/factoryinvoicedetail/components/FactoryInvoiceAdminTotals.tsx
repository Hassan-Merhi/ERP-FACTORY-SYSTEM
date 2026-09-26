const formatTotal = (value: number) =>
  value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/**
 * Admin-only invoice totals. The analytics "no charges" view shows the bale
 * subtotal alone; the normal view shows subtotal, charges and grand total.
 */
export function FactoryInvoiceAdminTotals({
  viewWithoutCharges,
  subtotal,
  totalCharges,
  grandTotal,
}: {
  viewWithoutCharges: boolean;
  subtotal: number;
  totalCharges: number;
  grandTotal: number;
}) {
  return viewWithoutCharges ? (
    <div className="flex items-center justify-between gap-2">
      <span className="font-semibold">Invoice Total (No Charges)</span>
      <span className="font-mono font-bold text-lg" data-testid="text-no-charges-total">
        {formatTotal(subtotal)}
      </span>
    </div>
  ) : (
    <>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span>Subtotal (Bales)</span>
        <span className="font-mono" data-testid="text-subtotal">
          {formatTotal(subtotal)}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span>Total Charges</span>
        <span className="font-mono" data-testid="text-total-charges">
          {formatTotal(totalCharges)}
        </span>
      </div>
      <div className="border-t pt-2 flex items-center justify-between gap-2">
        <span className="font-semibold">Grand Total</span>
        <span className="font-mono font-bold text-lg" data-testid="text-grand-total">
          {formatTotal(grandTotal)}
        </span>
      </div>
    </>
  );
}
