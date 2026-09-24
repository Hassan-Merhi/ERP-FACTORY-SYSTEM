/**
 * Types for the FactoryProformas page.
 *
 * Extracted from FactoryProformas.tsx during the Phase 4 god-file split.
 */

export interface CatalogStockItem {
  id: number;
  code?: string | null;
  name: string;
  uom?: string | null;
  stockGroup?: { name?: string | null } | null;
}

export interface ProformaLine {
  id: number;
  proformaId: number;
  articleCode: string;
  productName: string;
  quantity: number;
  pricePerBale: string;
  weightPerBaleKg?: string | null;
  pricingMode?: string | null;
  pricePerKg?: string | null;
}

export interface Proforma {
  code?: string | null;
  id: number;
  customerId: number;
  companyId: number;
  name: string;
  isActive: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  lines: ProformaLine[];
  // Compact list-profile metrics. Full detail responses may omit these because
  // the page can derive them from `lines` once an individual card is expanded.
  lineCount?: number;
  totalQty?: number;
  totalWeightKg?: number;
  totalAmount?: number;
}

export interface Customer {
  id: number;
  legalName: string;
  balance: number;
  balanceSide: string;
}
