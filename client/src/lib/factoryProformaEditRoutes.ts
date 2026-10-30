/** Navigation for editing an Invoicing proforma in the full-page Stock Allocation editor. */
export function invoicingProformaEditPath(
  proformaId: number,
  customerId: number | string | null | undefined
): string {
  const path = `/factory/invoicing/proformas/${proformaId}/edit`;
  const params = new URLSearchParams();
  if (customerId !== null && customerId !== undefined && String(customerId).trim()) {
    params.set("customerId", String(customerId));
  }
  return params.size ? `${path}?${params.toString()}` : path;
}

/** Save/cancel/back returns to the same customer and expanded proforma in Invoicing. */
export function invoicingProformaReturnPath(
  proformaId: number | null,
  customerId: string | null
): string {
  const params = new URLSearchParams({ tab: "proformas" });
  if (customerId && /^[1-9]\d*$/.test(customerId) && Number.isSafeInteger(Number(customerId))) {
    params.set("customerId", customerId);
  }
  if (proformaId !== null && Number.isSafeInteger(proformaId) && proformaId > 0) {
    params.set("expandProformaId", String(proformaId));
  }
  return `/factory/invoicing?${params.toString()}`;
}
