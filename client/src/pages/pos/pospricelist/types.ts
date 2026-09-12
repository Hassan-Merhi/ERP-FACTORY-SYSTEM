/**
 * Types for the POSPriceList page.
 *
 * Extracted from POSPriceList.tsx during the Phase 4 god-file split.
 */

export interface Location {
  id: number;
  code: string;
  name: string;
  active?: boolean;
}

export interface PriceListRow {
  stockItemId: number;
  code: string;
  name: string;
  stockGroupName: string;
  baseSellingPrice: string | null;
  sellingPrice?: string | null;
  hasCustomPrice?: boolean;
  quantity?: string;
  masterPrices?: Record<number, string>;
  costPrice?: string | null;
  offloadingCost?: string | null;
}

export interface PriceListItem extends PriceListRow {
  hasCustomPrice: boolean;
  sellingPrice: string | null;
  quantity: string;
}

export interface MasterItem extends PriceListRow {
  masterPrices: Record<number, string>;
}

export interface MasterPriceListResponse {
  masters: { id: number; name: string }[];
  items: MasterItem[];
}

export interface POSPriceListProps {
  posUser?: unknown;
}
