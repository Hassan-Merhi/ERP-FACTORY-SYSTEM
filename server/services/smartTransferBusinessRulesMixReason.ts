// Extracted from ./smartTransferBusinessRules.ts to keep that module under the source-size cap.
import { roundNumber } from "./smartTransferPerformance";
import type { BusinessItem } from "./smartTransferBusinessRulesAllocateWithSharedCaps";

export function mixReason(input: {
  item: BusinessItem;
  itemQty: number;
  categoryName: string;
  stockGroupName: string;
  categoryTargetShare: number;
  groupTargetShare: number;
  priorityCategory: boolean;
  priorityGroup: boolean;
  minItemQuantity: number;
}): string {
  const parts = [
    `Phase 3 priority ${input.item.businessPriorityScore}/100`,
    `item cap ${input.item.itemCap}`,
    `${input.categoryName} target mix ${roundNumber(input.categoryTargetShare * 100, 1)}%`,
    `${input.stockGroupName} target mix ${roundNumber(input.groupTargetShare * 100, 1)}%`,
    `final item quantity ${input.itemQty}`,
    `minimum meaningful item quantity ${input.minItemQuantity}`,
  ];
  if (input.priorityCategory) parts.push("priority category boost applied");
  if (input.priorityGroup) parts.push("priority stock-group boost applied");
  return parts.join("; ") + ".";
}
