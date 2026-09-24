/**
 * Types for the FactoryContainerLoadingScan page.
 *
 * Extracted from FactoryContainerLoadingScan.tsx during the Phase 4 god-file split.
 */

export interface Customer {
  id: number;
  legalName: string;
}

export interface Location {
  id: number;
  name: string;
  code?: string;
}

export interface ProformaLine {
  id: number;
  articleCode: string;
  productName: string;
  quantity: number;
  pricePerBale: string;
  weightPerBaleKg?: string | null;
}

export interface Proforma {
  id: number;
  customerId: number;
  name: string;
  isActive: boolean;
  lines: ProformaLine[];
}

export interface OrderBale {
  id: number;
  baleId: number;
  baleReference: string;
  articleCode: string;
  baleName: string;
  weight: string;
  priceUsed: string;
  scannedBy?: string | null;
  scannedAt?: string | null;
}

export interface OrderDetail {
  id: number;
  customerId: number;
  locationId: number;
  companyId: number;
  orderDate: string;
  status: string;
  proformaIdUsed: number | null;
  totalQtyBales: number;
  containerNotes: string | null;
  bales: OrderBale[];
  proformaRemainingLines?: ProformaLine[];
}

export interface BaleRemoval {
  id: number;
  orderId: number;
  baleId: number;
  referenceNumber: string;
  articleCode: string | null;
  productName: string | null;
  weightKg: string | null;
  removedByUsername: string | null;
  removedAt: string;
}

export interface CreateLoadingOrderInput {
  customerId: number;
  proformaIdUsed: number | null;
  locationId: number;
  orderDate: string;
  containerNotes?: string;
}
export interface CreateLoadingOrderResponse {
  id: number;
}
export interface AddLoadingBaleInput {
  scanCode: string;
  locationId: number;
  allowBypassProforma?: boolean;
  allowBypassOverload?: boolean;
}
export type AddLoadingBaleResponse = OrderDetail;
