// Extracted from ./smartTransferBusinessRulesAllocateWithSharedCaps.ts
import type { SmartTransferPreviewOptions } from "./smartTransferAllocation";
import type {
  SmartTransferSourceOptimizedLine,
  SmartTransferSourceOptimizedResult,
} from "./smartTransferSourceOptimization";

export interface SmartTransferBusinessRuleOptions extends SmartTransferPreviewOptions {
  maxItemSharePct?: number;
  maxCategorySharePct?: number;
  maxStockGroupSharePct?: number;
  minItemQuantity?: number;
  preserveDestinationMix?: boolean;
  priorityCategoryIds?: number[];
  priorityStockGroupIds?: number[];
}

export interface SmartTransferBusinessRuleFields {
  categoryName: string;
  stockGroupName: string;
  businessPriorityScore: number;
  itemBusinessCapQty: number;
  categoryTargetSharePct: number;
  stockGroupTargetSharePct: number;
  finalCategorySharePct: number;
  finalStockGroupSharePct: number;
  mixAdjustmentReason: string;
}

export type SmartTransferBusinessRuleLine = SmartTransferSourceOptimizedLine & SmartTransferBusinessRuleFields;

export interface SmartTransferMixSummaryRow {
  id: number | null;
  name: string;
  targetSharePct: number;
  finalSharePct: number;
  quantity: number;
  historicalSalesQty: number;
  capped: boolean;
  priority: boolean;
}

export interface SmartTransferBusinessRuleResult extends Omit<SmartTransferSourceOptimizedResult, "lines"> {
  businessRulesVersion: 3;
  lines: SmartTransferBusinessRuleLine[];
  businessRules: {
    maxItemSharePct: number;
    maxCategorySharePct: number;
    maxStockGroupSharePct: number;
    minItemQuantity: number;
    preserveDestinationMix: boolean;
    priorityCategoryIds: number[];
    priorityStockGroupIds: number[];
  };
  businessRulesApplied: string[];
  categoryMix: SmartTransferMixSummaryRow[];
  stockGroupMix: SmartTransferMixSummaryRow[];
}

export interface SourceOption {
  line: SmartTransferSourceOptimizedLine;
  capacity: number;
}

export interface BusinessItem {
  stockItemId: number;
  representative: SmartTransferSourceOptimizedLine;
  sources: SourceOption[];
  capacity: number;
  itemCap: number;
  categoryKey: number;
  stockGroupKey: number;
  historicalSalesQty: number;
  weight: number;
  businessPriorityScore: number;
}

export interface MixTargets {
  shareByKey: Map<number, number>;
  historicalQtyByKey: Map<number, number>;
}
