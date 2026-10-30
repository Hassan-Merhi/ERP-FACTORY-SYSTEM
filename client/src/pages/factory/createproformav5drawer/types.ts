/**
 * Types for the CreateProformaV5Drawer page.
 *
 * Extracted from CreateProformaV5Drawer.tsx during the Phase 4 god-file split.
 */

export interface ArticleRow {
  articleCode: string;
  productName: string;
  categoryName?: string;
  stockAvailable: number;
  totalLoaded: number;
  expectedToLoad: number;
  freeToPromise: number;
}

export interface FactoryCustomer {
  id: number;
  legalName: string;
}

export interface BaleProduct {
  id: number;
  code: string;
  articleCode: string | null;
  weightPerBaleKg: string | null;
  sellingPrice: string | null;
  productionPrice: string | null;
}

export interface Props {
  open: boolean;
  onClose: () => void;
  articleRows: ArticleRow[];
  onSuccess: () => void;
}

export interface Draft {
  customerId: string;
  proformaName: string;
  isActive: boolean;
  quantities: Record<string, string>;
  sellingPrices: Record<string, string>;
  sendToLoading: boolean;
  containerCount: string;
  containerNames: string[];
  savedAt: number;
}
