// Extracted from ./CombinedInventory.tsx to keep that module under the source-size cap.
import type { ReactNode } from "react";

interface ContainerPoItem {
  quantity?: string;
  rate?: string;
  stockItemName?: string;
  itemName?: string;
  stockItemId?: number | null;
  stockGroupId?: number | null;
  stockGroupName?: string;
}

export interface ContainerDetailPayload {
  pos?: { items?: ContainerPoItem[] }[];
}

export interface Container {
  id: number;
  status: string;
}

export interface InventoryRow {
  stockItemId: number;
  stockItemName: string;
  stockItemCode: string;
  quantity: string;
  averageRate: string;
  totalValue: string;
  stockGroupId: number | null;
  stockGroupName: string;
}

export interface StockItem {
  id: number;
  name: string;
  code?: string;
  stockGroupId?: number | null;
  stockGroupName?: string;
}

export interface CombinedRow {
  stockItemId: number | null;
  stockItemName: string;
  stockItemCode?: string | null;
  stockGroupId: number | null;
  stockGroupName: string;
  otwQty: number;
  inHandQty: number;
  totalQty: number;
  inHandValue: number;
  otwWeightedCostSum: number;
  avgRate: number;
  combinedValue: number;
}

export interface StockGroupSummary {
  stockGroupId: number | null;
  stockGroupName: string;
  itemCount: number;
  otwQty: number;
  inHandQty: number;
  totalQty: number;
  inHandValue: number;
  combinedValue: number;
}

export type ViewMode = "groups" | "all";

export interface CombinedInventoryProps {
  /** Extra page-level actions supplied by a host page (for example the OTW/Combined toggle). */
  headerActions?: ReactNode;
}
