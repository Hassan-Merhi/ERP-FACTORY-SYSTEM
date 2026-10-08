/**
 * Types for the FactoryInvoices page.
 *
 * Extracted from FactoryInvoices.tsx during the Phase 4 god-file split.
 */

export interface Customer {
  id: number;
  legalName: string;
  balance: number;
  balanceSide: string;
}

export interface CustomerOrder {
  id: number;
  companyId: number;
  customerId: number;
  orderDate: string;
  status: string;
  invoiceNumber?: string;
  subtotalBales: string;
  freightAmount: string;
  otherChargesTotal: string;
  grandTotal: string;
  totalQtyBales: number;
  totalWeightKg: string;
  proformaExpectedBales: string;
  loadedNotInProformaBales: string;
  customerName: string;
  containerNumber?: string | null;
  proformaName?: string | null;
  destination?: string | null;
  containerNotes?: string | null;
  bookingInfo?: string | null;
  isHidden?: boolean;
}

export type StatusFilter = "LOADING" | "VERIFIED" | "FINALIZED" | "ALL";
