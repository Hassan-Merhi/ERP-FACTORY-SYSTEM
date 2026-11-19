// Extracted from ./InvoiceOrderRow.tsx
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { getFactoryInvoiceDate, getOverloadedBales, getRemainingBales } from "./invoiceCalculations";
import { type InvoiceOrderRowProps } from "./InvoiceOrderRowParts";

export function useInvoiceOrderRowState({
  order,
  formatDisplayDate,
}: Pick<InvoiceOrderRowProps, "order" | "formatDisplayDate">) {
  const recordChanges = useExistingRecordChangeAccess();
  const recordChangeReason = recordChanges.reason ?? undefined;
  const remaining = getRemainingBales(order);
  const expected = parseFloat(order.proformaExpectedBales || "0");
  const overloaded = getOverloadedBales(order);

  const dateForStatus = getFactoryInvoiceDate(order);
  const displayDate = dateForStatus ? formatDisplayDate(dateForStatus) : "-";
  return { recordChanges, recordChangeReason, remaining, expected, overloaded, displayDate };
}
