/**
 * Supplier-invoice charges carried on a Supplier Partner container.
 *
 * Freight, surcharge, fumigation and document charges are stated by the
 * supplier on the container invoice (the PO Import Excel carries them per
 * container). They are part of the invoice total posted to Goods OTW, and at
 * offload each one becomes a landed-cost charge credited to SP Cost Clearing,
 * exactly like the "Invoice Freight (Cost Clearing)" charge a user used to add
 * by hand. The server derives these lines from the container row inside the
 * offload transaction; the offload dialog shows the same lines read-only.
 */

export const SP_CONTAINER_INVOICE_CHARGE_TYPE = "invoice_charge";

export interface SpContainerInvoiceChargeSource {
  freightEstimateUsd?: string | number | null;
  surchargeUsd?: string | number | null;
  fumigationUsd?: string | number | null;
  documentChargesUsd?: string | number | null;
}

export interface SpContainerInvoiceChargeLine {
  chargeType: typeof SP_CONTAINER_INVOICE_CHARGE_TYPE;
  /** Which invoice charge this is; stable key for display and tests. */
  kind: "freight" | "surcharge" | "fumigation" | "document_charges";
  description: string;
  amountUsd: number;
}

const INVOICE_CHARGE_FIELDS: ReadonlyArray<{
  field: keyof SpContainerInvoiceChargeSource;
  kind: SpContainerInvoiceChargeLine["kind"];
  label: string;
}> = [
  { field: "freightEstimateUsd", kind: "freight", label: "Freight" },
  { field: "surchargeUsd", kind: "surcharge", label: "Surcharge" },
  { field: "fumigationUsd", kind: "fumigation", label: "Fumigation" },
  { field: "documentChargesUsd", kind: "document_charges", label: "Document charges" },
];

function amountOf(value: string | number | null | undefined): number {
  const n = typeof value === "number" ? value : parseFloat(String(value ?? "0"));
  return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : 0;
}

/** The non-zero invoice charges of a container, in invoice order. */
export function spContainerInvoiceChargeLines(
  container: SpContainerInvoiceChargeSource
): SpContainerInvoiceChargeLine[] {
  const lines: SpContainerInvoiceChargeLine[] = [];
  for (const { field, kind, label } of INVOICE_CHARGE_FIELDS) {
    const amountUsd = amountOf(container[field]);
    if (amountUsd <= 0) continue;
    lines.push({
      chargeType: SP_CONTAINER_INVOICE_CHARGE_TYPE,
      kind,
      description: `${label} — container invoice`,
      amountUsd,
    });
  }
  return lines;
}

export function spContainerInvoiceChargesTotal(container: SpContainerInvoiceChargeSource): number {
  return spContainerInvoiceChargeLines(container).reduce((sum, line) => sum + line.amountUsd, 0);
}
