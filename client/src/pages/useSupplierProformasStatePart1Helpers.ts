// Extracted from ./useSupplierProformasStatePart1.ts

export interface ProformaLine {
  id: number;
  proformaId: number;
  barcode: string;
  itemName: string;
  qty: number;
  weightPerBale: string;
  pricePerBale: string;
}

export interface Proforma {
  id: number;
  companyId: number;
  supplierId: number;
  reference: string;
  notes: string | null;
  isStarred: boolean;
  destinationCompanyId: number | null;
  createdAt: string;
  updatedAt: string;
  lines?: ProformaLine[];
}

export const parseFiniteNumber = (value: number | string | null | undefined) => {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
};

export const calculateLineTotal = (qty: number | string, pricePerBale: number | string) =>
  parseFiniteNumber(qty) * parseFiniteNumber(pricePerBale);
