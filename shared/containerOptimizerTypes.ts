// Extracted from ./containerOptimizer.ts

export type SuggestedContainerKind = "CUSTOMER" | "SINGLE_PRODUCT" | "MIXED";

export interface OptimizerStockRow {
  articleCode: string;
  productName: string;
  /** Free-to-promise bales, the same figure Phase 2 plans from. */
  availableQty: number;
}

export interface OptimizerDemandRow {
  customerId: number;
  customerName: string;
  orderId: number | null;
  articleCode: string;
  productName: string;
  demandQty: number;
  /** Higher wins. Defaults to 0, after which the larger order wins. */
  priority?: number;
}

export interface SuggestedLine {
  articleCode: string;
  productName: string;
  qty: number;
}

export interface SuggestedContainer {
  index: number;
  label: string;
  kind: SuggestedContainerKind;
  customerId: number | null;
  customerName: string | null;
  totalBales: number;
  fillPercent: number;
  isFull: boolean;
  lines: SuggestedLine[];
}

export interface UnservedDemandRow {
  customerId: number;
  customerName: string;
  articleCode: string;
  productName: string;
  shortfallQty: number;
}

export interface ContainerOptimizationPlan {
  capacity: number;
  containerCount: number;
  totalBales: number;
  plannedFromDemand: number;
  plannedFromFreeStock: number;
  unusedCapacity: number;
  averageFillPercent: number;
  fullContainers: number;
  customerContainers: number;
  singleProductContainers: number;
  mixedContainers: number;
  /** Containers that hold one customer's goods and nothing else. */
  shipReadyContainers: number;
  leftoverBales: number;
  unservedDemand: UnservedDemandRow[];
  containers: SuggestedContainer[];
}
